import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { RESULT_SCHEMA_VERSION, type RunResult } from '@qare/core'
import { GitHubClient, GitHubClientError } from '../src/github.js'
import { main } from '../src/index.js'
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
  await postEvidence(new GitHubEvidencePoster(client, 12, SHA), failed, { headSha: SHA, artifactUrl: ARTIFACT })

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
  await postEvidence(new GitHubEvidencePoster(client, 12, SHA), failed, { headSha: SHA, artifactUrl: ARTIFACT })

  const comment = fake.issues.get(12)?.comments[0] ?? ''
  expect(comment).toContain('`checks/export-csv/0/stdout.txt`')
  expect(comment.match(/\]\(<([^>]+)>\)/g)).toEqual([`](<${ARTIFACT}>)`])
})

test('a second run updates the comment in place rather than adding another', async () => {
  const poster = new GitHubEvidencePoster(client, 12, SHA)
  await postEvidence(poster, failed, { headSha: SHA })
  await postEvidence(poster, { ...failed, verdict: 'passed' }, { headSha: SHA })

  expect(fake.issues.get(12)?.comments).toHaveLength(1)
  expect(fake.issues.get(12)?.comments[0]).toContain('## QARE run: passed')
  expect(fake.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1)
})

test('other comments on the pull request are left alone', async () => {
  fake.commentRecords.push({ id: 1, issue: 12, body: 'looks good to me' })
  fake.issues.get(12)?.comments.push('looks good to me')

  await postEvidence(new GitHubEvidencePoster(client, 12, SHA), failed, { headSha: SHA })

  expect(fake.commentRecords.find((record) => record.id === 1)?.body).toBe('looks good to me')
  expect(fake.commentRecords).toHaveLength(2)
})

test('a marked comment this identity cannot edit gets a new one beside it, not a failure', async () => {
  fake.commentRecords.push({ id: 1, issue: 12, body: `${EVIDENCE_MARKER}\nquoted by a person`, foreign: true })

  await postEvidence(new GitHubEvidencePoster(client, 12, SHA), failed, { headSha: SHA })

  expect(fake.commentRecords).toHaveLength(2)
  expect(fake.commentRecords[0]?.body).toBe(`${EVIDENCE_MARKER}\nquoted by a person`)
})

test('a server error while updating is a failure, not a quiet second comment', async () => {
  fake.commentRecords.push({ id: 1, issue: 12, body: `${EVIDENCE_MARKER}\nearlier run`, failEditWith: 500 })

  await expect(postEvidence(new GitHubEvidencePoster(client, 12, SHA), failed, { headSha: SHA })).rejects.toThrow(
    /responded 500/,
  )
  expect(fake.commentRecords).toHaveLength(1)
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
