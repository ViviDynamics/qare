import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { RESULT_SCHEMA_VERSION, type RunResult } from '@qare/core'
import { GitHubClient, GitHubClientError } from '../src/github.js'
import { main } from '../src/index.js'
import { GitHubQaAssetsPusher, screenshotsOf } from '../src/qa-assets.js'
import { CHECK_RUN_NAME, EVIDENCE_MARKER, GitHubEvidencePoster, postEvidence } from '../src/post-evidence.js'
import { FAKE_TOKEN, startFakeGithub, type FakeGithub } from './fake-github.js'

const SHA = 'a'.repeat(40)
const ARTIFACT = ['https:', '//github.com/octocat/qare/actions/runs/1/artifacts/2'].join('')

const failed: RunResult = {
  schemaVersion: RESULT_SCHEMA_VERSION,
  verdict: 'failed',
  criteria: [
    { id: 'export-csv', outcome: 'failed', evidence: ['checks/export-csv/0/stdout.txt'] },
    { id: 'totals', outcome: 'proven', evidence: ['checks/totals/0/stdout.txt'] },
  ],
}

let fake: FakeGithub
let client: GitHubClient

beforeEach(async () => {
  fake = await startFakeGithub()
  fake.issues.set(12, { number: 12, title: 'a pull request', body: '', comments: [] })
  client = new GitHubClient({ repository: 'octocat/qare', token: FAKE_TOKEN, apiRoot: fake.url })
})

afterEach(async () => {
  await fake.close()
})

test('posts one marked comment and a check run on the head commit', async () => {
  await postEvidence(new GitHubEvidencePoster(client, 12, SHA), failed, { artifactUrl: ARTIFACT })

  const [comment] = fake.issues.get(12)?.comments ?? []
  expect(comment?.startsWith(`${EVIDENCE_MARKER}\n## QARE run: failed`)).toBe(true)
  expect(comment).toContain(`qare checked ${SHA}`)
  expect(fake.checkRuns).toEqual([
    {
      name: CHECK_RUN_NAME,
      head_sha: SHA,
      status: 'completed',
      conclusion: 'failure',
      output: { title: 'QARE', summary: 'verdict failed: 1 proven, 1 failed, 0 unverified' },
    },
  ])
})

// Rule 4: a posted comment links to nothing that was not uploaded. The
// evidence paths are relative to a directory the pull request cannot see.
test('the posted comment links only to the uploaded artifact', async () => {
  await postEvidence(new GitHubEvidencePoster(client, 12, SHA), failed, { artifactUrl: ARTIFACT })

  const comment = fake.issues.get(12)?.comments[0] ?? ''
  expect(comment).toContain('`checks/export-csv/0/stdout.txt`')
  expect(comment.match(/\]\(<([^>]+)>\)/g)).toEqual([`](<${ARTIFACT}>)`])
})

test('a second run updates the comment in place rather than adding another', async () => {
  const poster = new GitHubEvidencePoster(client, 12, SHA)
  await postEvidence(poster, failed)
  await postEvidence(poster, { ...failed, verdict: 'passed' })

  expect(fake.issues.get(12)?.comments).toHaveLength(1)
  expect(fake.issues.get(12)?.comments[0]).toContain('## QARE run: passed')
  expect(fake.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1)
})

test('other comments on the pull request are left alone', async () => {
  fake.commentRecords.push({ id: 1, issue: 12, body: 'looks good to me', author: 'hana' })

  await postEvidence(new GitHubEvidencePoster(client, 12, SHA), failed)

  expect(fake.commentRecords.find((record) => record.id === 1)?.body).toBe('looks good to me')
  expect(fake.commentRecords).toHaveLength(2)
})

// Anyone can write the marker. Updating their comment would put qare's
// verdict somewhere they can edit it afterwards.
test('a marked comment someone else wrote is never updated; qare posts its own', async () => {
  fake.commentRecords.push({ id: 1, issue: 12, body: `${EVIDENCE_MARKER}\n## QARE run: passed`, author: 'mallory' })

  await postEvidence(new GitHubEvidencePoster(client, 12, SHA), failed)

  expect(fake.calls.filter((call) => call.method === 'PATCH')).toHaveLength(0)
  expect(fake.commentRecords[0]?.body).toBe(`${EVIDENCE_MARKER}\n## QARE run: passed`)
  expect(fake.commentRecords[1]?.body).toContain('## QARE run: failed')
})

test('the identity the comment is written as can be named, for an App or a token', async () => {
  fake.commentRecords.push({ id: 1, issue: 12, body: `${EVIDENCE_MARKER}\nearlier run`, author: 'qare-app[bot]' })

  await postEvidence(new GitHubEvidencePoster(client, 12, SHA, 'qare-app[bot]'), failed)

  expect(fake.calls.filter((call) => call.method === 'PATCH').map((call) => call.path)).toEqual([
    '/repos/octocat/qare/issues/comments/1',
  ])
})

test('a server error while updating is a failure, not a quiet second comment', async () => {
  fake.commentRecords.push({ id: 1, issue: 12, body: `${EVIDENCE_MARKER}\nearlier run`, failEditWith: 500 })

  await expect(postEvidence(new GitHubEvidencePoster(client, 12, SHA), failed)).rejects.toThrow(/responded 500/)
  expect(fake.commentRecords).toHaveLength(1)
})

// A 403 on an edit is a rate limit or a permission problem, not a reason to
// leave a stale verdict up beside a new one.
test('a 403 while updating is a failure too', async () => {
  fake.commentRecords.push({ id: 1, issue: 12, body: `${EVIDENCE_MARKER}\nearlier run`, failEditWith: 403 })

  await expect(postEvidence(new GitHubEvidencePoster(client, 12, SHA), failed)).rejects.toThrow(/responded 403/)
  expect(fake.commentRecords).toHaveLength(1)
})

test('a comment deleted since it was listed is posted afresh', async () => {
  fake.commentRecords.push({ id: 1, issue: 12, body: `${EVIDENCE_MARKER}\nearlier run`, failEditWith: 404 })

  await postEvidence(new GitHubEvidencePoster(client, 12, SHA), failed)

  expect(fake.commentRecords).toHaveLength(2)
})

test('a malformed head SHA or pull request number is refused before anything is posted', () => {
  expect(() => new GitHubEvidencePoster(client, 12, 'HEAD')).toThrow(GitHubClientError)
  expect(() => new GitHubEvidencePoster(client, 0, SHA)).toThrow(GitHubClientError)
})

async function resultFile(result: RunResult): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-post-'))
  const path = join(dir, 'judged-result.json')
  await writeFile(path, JSON.stringify(result), 'utf8')
  return path
}

function capture(): { lines: string[]; writer: { write: (chunk: string) => void } } {
  const lines: string[] = []
  return { lines, writer: { write: (chunk) => lines.push(chunk) } }
}

test('qare-action post-evidence posts from a judged result file', async () => {
  const out = capture()
  process.env.QARE_TEST_TOKEN = FAKE_TOKEN
  try {
    const code = await main(
      [
        'post-evidence', '--result', await resultFile(failed), '--pr', '12', '--sha', SHA,
        '--artifact-url', ARTIFACT, '--repository', 'octocat/qare', '--api-root', fake.url,
        '--token-env', 'QARE_TEST_TOKEN',
      ],
      out.writer,
      capture().writer,
    )
    expect(code).toBe(0)
  } finally {
    delete process.env.QARE_TEST_TOKEN
  }
  expect(out.lines.join('')).toContain('posted verdict failed on pull request #12')
  expect(fake.checkRuns).toHaveLength(1)
})

// A workflow expression for an artifact that was never uploaded is empty.
test('an empty --artifact-url means no link, and a non-https one is refused', async () => {
  process.env.QARE_TEST_TOKEN = FAKE_TOKEN
  const base = ['--pr', '12', '--sha', SHA, '--repository', 'octocat/qare', '--api-root', fake.url, '--token-env', 'QARE_TEST_TOKEN']
  try {
    const path = await resultFile(failed)
    expect(await main(['post-evidence', '--result', path, '--artifact-url', '', ...base], capture().writer, capture().writer)).toBe(0)
    expect(fake.issues.get(12)?.comments[0]).toContain('named but not linked')

    const err = capture()
    expect(
      await main(['post-evidence', '--result', path, '--artifact-url', 'javascript:alert(1)', ...base], capture().writer, err.writer),
    ).toBe(1)
    expect(err.lines.join('')).toContain('https URL')
  } finally {
    delete process.env.QARE_TEST_TOKEN
  }
})

test('post-evidence names what is missing', async () => {
  const err = capture()
  expect(await main(['post-evidence', '--pr', '12', '--sha', SHA], capture().writer, err.writer)).toBe(1)
  expect(err.lines.join('')).toContain('--result')
})

test('qare-action post-evidence pushes the evidence screenshots with --evidence, on the named branch', async () => {
  process.env.QARE_TEST_TOKEN = FAKE_TOKEN
  try {
    const dir = await evidenceDirWith({ 'checks/export-csv/1/final.png': 'png bytes' })
    const code = await main(
      [
        'post-evidence', '--result', await resultFile(WITH_SCREENSHOT), '--pr', '12', '--sha', SHA,
        '--artifact-url', ARTIFACT, '--evidence', dir, '--branch', 'qa-assets-staging',
        '--repository', 'octocat/qare', '--api-root', fake.url, '--token-env', 'QARE_TEST_TOKEN',
      ],
      capture().writer,
      capture().writer,
    )
    expect(code).toBe(0)
  } finally {
    delete process.env.QARE_TEST_TOKEN
  }
  const comment = fake.issues.get(12)?.comments[0] ?? ''
  expect(comment).toContain('/raw/qa-assets-staging/runs/')
  expect(comment).toContain('/final.png>)')
  expect(fake.refs.get('refs/heads/qa-assets-staging')).toBeDefined()
})

// With no --evidence, nothing is pushed and the comment is the artifact-only
// comment of today.
test('post-evidence without --evidence pushes nothing', async () => {
  process.env.QARE_TEST_TOKEN = FAKE_TOKEN
  try {
    const path = await resultFile(WITH_SCREENSHOT)
    const code = await main(
      ['post-evidence', '--result', path, '--pr', '12', '--sha', SHA, '--repository', 'octocat/qare', '--api-root', fake.url, '--token-env', 'QARE_TEST_TOKEN'],
      capture().writer,
      capture().writer,
    )
    expect(code).toBe(0)
  } finally {
    delete process.env.QARE_TEST_TOKEN
  }
  expect(fake.refs.get('refs/heads/qa-assets')).toBeUndefined()
  expect(fake.issues.get(12)?.comments[0]).toContain('`checks/export-csv/1/final.png`')
})

test('a secret in a reason is redacted before the comment is posted (#52)', async () => {
  const token = ['ghp', '_', 'Qq7'.repeat(12)].join('')
  const leaky: RunResult = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    verdict: 'blocked',
    criteria: [{ id: 'boot', outcome: 'unverified', reason: `compose up rejected ${token}` }],
  }

  await postEvidence(new GitHubEvidencePoster(client, 12, SHA), leaky, { artifactUrl: ARTIFACT })

  const [comment] = fake.issues.get(12)?.comments ?? []
  expect(comment).toContain('compose up rejected [redacted]')
  expect(comment).not.toContain(token)
})

const WITH_SCREENSHOT: RunResult = {
  schemaVersion: RESULT_SCHEMA_VERSION,
  verdict: 'failed',
  criteria: [
    {
      id: 'export-csv',
      outcome: 'failed',
      reason: 'export wrote 0 rows',
      evidence: ['checks/export-csv/1/final.png', 'checks/export-csv/1/stdout.txt'],
    },
  ],
}

// The evidence directory the judge downloaded, holding the screenshot the
// result lists.
async function evidenceDirWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-assets-'))
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name, '..'), { recursive: true })
    await writeFile(join(dir, name), content, 'utf8')
  }
  return dir
}

test('screenshots are pushed to qa-assets and linked from the comment; the rest names the artifact', async () => {
  const dir = await evidenceDirWith({ 'checks/export-csv/1/final.png': 'png bytes', 'checks/export-csv/1/stdout.txt': 'log' })
  const pusher = new GitHubQaAssetsPusher(client, SHA, { today: () => '2026-09-25' })
  const screenshotUrl = [
    'https:', '//github.com/octocat/qare/raw/qa-assets/runs/2026-09-25/', SHA, '/checks/export-csv/1/final.png',
  ].join('')

  await postEvidence(new GitHubEvidencePoster(client, 12, SHA), WITH_SCREENSHOT, {
    artifactUrl: ARTIFACT,
    push: pusher,
    evidenceDir: dir,
  })

  const comment = fake.issues.get(12)?.comments[0] ?? ''
  expect(comment).toContain(`[final.png](<${screenshotUrl}>)`)
  // The non-screenshot file is named, and the artifact it lives in is linked.
  expect(comment).toContain('`checks/export-csv/1/stdout.txt`')
  expect(comment).not.toContain('`checks/export-csv/1/final.png`')
  const links = comment.match(/\]\(<([^>]+)>\)/g) ?? []
  const linkOf = (url: string): string => '](<' + url + '>)'
  expect(links).toEqual([linkOf(screenshotUrl), linkOf(ARTIFACT)])
  expect(fake.refs.get('refs/heads/qa-assets')).toBeDefined()
})

test('the branch is created on the first run and the second commit chains onto it', async () => {
  const dir = await evidenceDirWith({ 'checks/export-csv/1/final.png': 'png bytes' })
  const pusher = new GitHubQaAssetsPusher(client, SHA, { today: () => '2026-09-25' })

  await postEvidence(new GitHubEvidencePoster(client, 12, SHA), WITH_SCREENSHOT, { push: pusher, evidenceDir: dir })
  const first = fake.refs.get('refs/heads/qa-assets')
  expect(first).toBeDefined()

  await postEvidence(new GitHubEvidencePoster(client, 12, SHA), WITH_SCREENSHOT, { push: pusher, evidenceDir: dir })
  const second = fake.refs.get('refs/heads/qa-assets')
  expect(second).not.toBe(first)
  expect(fake.commits.get(second ?? '')?.parents).toEqual([first])
  // The two runs name the same file on the branch, so the branch grows by
  // commits, not by rewrites.
  expect(fake.commits.size).toBe(2)
})

test('a png listed but not on disk is named, never pushed and never linked', async () => {
  const dir = await evidenceDirWith({ 'checks/export-csv/1/stdout.txt': 'log' })
  const pusher = new GitHubQaAssetsPusher(client, SHA, { today: () => '2026-09-25' })

  await postEvidence(new GitHubEvidencePoster(client, 12, SHA), WITH_SCREENSHOT, {
    artifactUrl: ARTIFACT,
    push: pusher,
    evidenceDir: dir,
  })

  expect(fake.refs.get('refs/heads/qa-assets')).toBeUndefined()
  const comment = fake.issues.get(12)?.comments[0] ?? ''
  expect(comment).toContain('`checks/export-csv/1/final.png`')
  expect(comment).not.toContain('raw/qa-assets')
})

test('a push failure fails the step and posts no comment', async () => {
  fake.status = 500
  const dir = await evidenceDirWith({ 'checks/export-csv/1/final.png': 'png bytes' })
  const pusher = new GitHubQaAssetsPusher(client, SHA)

  await expect(
    postEvidence(new GitHubEvidencePoster(client, 12, SHA), WITH_SCREENSHOT, { push: pusher, evidenceDir: dir }),
  ).rejects.toThrow(/responded 500/)
  expect(fake.issues.get(12)?.comments ?? []).toHaveLength(0)
  expect(fake.checkRuns).toHaveLength(0)
})

test('screenshotsOf takes the png paths the result lists, deduplicated and in order', () => {
  expect(
    screenshotsOf({
      schemaVersion: RESULT_SCHEMA_VERSION,
      verdict: 'failed',
      criteria: [
        { id: 'a', outcome: 'failed', evidence: ['checks/a/0/final.png', 'checks/a/0/stdout.txt', 'checks/a/0/final.png'] },
        { id: 'b', outcome: 'failed', evidence: ['checks/b/0/shot.PNG'] },
      ],
    }),
  ).toEqual(['checks/a/0/final.png', 'checks/b/0/shot.PNG'])
  expect(screenshotsOf(WITH_SCREENSHOT)).toEqual(['checks/export-csv/1/final.png'])
})
