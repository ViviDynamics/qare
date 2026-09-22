import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { stubIssueMarker } from '@qare/core'
import type { RunResult } from '@qare/core'
import { GitHubClient } from '../src/github.js'
import { requeueUnblocked, stubKeysFromDiffText, REQUEUE_COMMENT } from '../src/requeue.js'
import { main } from '../src/index.js'
import { FAKE_TOKEN, startFakeGithub, type FakeGithub } from './fake-github.js'

const HOST_A = 'api.billing-vendor.example'
const HOST_B = 'smtp.postmark.example'

function seedStubIssue(fake: FakeGithub, key: string, prs: number[]): number {
  const number = 100 + fake.issues.size
  fake.issues.set(number, {
    number,
    title: `Stub needed for ${key}`,
    body: [stubIssueMarker(key), ...prs.map((pr) => `qare-refused: #${pr}`)].join('\n'),
    comments: [],
  })
  return number
}

function makeClient(fake: FakeGithub): GitHubClient {
  return new GitHubClient({ repository: 'octocat/qare', apiRoot: fake.url, token: FAKE_TOKEN })
}

test('stubKeysFromDiffText reads hosts from added lines only, deduped and sorted', () => {
  const diff = [
    'diff --git a/.qa/config.yml b/.qa/config.yml',
    '--- a/.qa/config.yml',
    '+++ b/.qa/config.yml',
    '@@ -1,3 +1,4 @@',
    ' stubs:',
    '   - service: billing',
    '+    hosts: ["' + HOST_A + '", "api.stripe.example"]',
    '+    provided_by: { compose_service: billing-stub }',
    '   - service: mail',
    '-    hosts: ["' + HOST_B + '"]',
    '+    hosts: ["smtp.mailpit.example"]',
  ].join('\n')
  expect(stubKeysFromDiffText(diff)).toEqual([HOST_A, 'api.stripe.example', 'smtp.mailpit.example'])
})

test('stubKeysFromDiffText returns nothing for diffs without stub hosts', () => {
  const diff = '+app:\n+  boot: { compose: compose.qa.yaml }\n'
  expect(stubKeysFromDiffText(diff)).toEqual([])
  expect(stubKeysFromDiffText('')).toEqual([])
})

test('requeueUnblocked posts /qa exactly to the refused PRs whose keys intersect', async () => {
  const fake = await startFakeGithub()
  try {
    seedStubIssue(fake, HOST_A, [11, 5])
    seedStubIssue(fake, HOST_B, [3])
    fake.issues.set(11, { number: 11, title: 'pr', body: '', comments: [] })
    fake.issues.set(5, { number: 5, title: 'pr', body: '', comments: [] })
    fake.issues.set(3, { number: 3, title: 'pr', body: '', comments: [] })
    const targets = await requeueUnblocked(makeClient(fake), [HOST_A])
    expect(targets).toEqual([5, 11])
    expect(fake.issues.get(11)?.comments).toEqual([REQUEUE_COMMENT])
    expect(fake.issues.get(5)?.comments).toEqual([REQUEUE_COMMENT])
    expect(fake.issues.get(3)?.comments).toEqual([])
  } finally {
    await fake.close()
  }
})

test('requeueUnblocked posts nothing when merged keys are disjoint from every registry', async () => {
  const fake = await startFakeGithub()
  try {
    seedStubIssue(fake, HOST_A, [11])
    const targets = await requeueUnblocked(makeClient(fake), ['unrelated.example.com'])
    expect(targets).toEqual([])
    expect(fake.calls.some((call) => call.method === 'POST' && call.path.endsWith('/comments'))).toBe(false)
  } finally {
    await fake.close()
  }
})

test('qare-action requeue posts /qa from --keys through the CLI', async () => {
  const fake = await startFakeGithub()
  const savedToken = process.env.QA_TEST_TOKEN
  try {
    seedStubIssue(fake, HOST_A, [11])
    fake.issues.set(11, { number: 11, title: 'pr', body: '', comments: [] })
    process.env.QA_TEST_TOKEN = FAKE_TOKEN
    const lines: string[] = []
    const code = await main(
      ['requeue', '--keys', HOST_A, '--api-root', fake.url, '--repository', 'octocat/qare', '--token-env', 'QA_TEST_TOKEN'],
      { write: (chunk) => lines.push(chunk) },
    )
    expect(code).toBe(0)
    expect(lines.join('')).toBe('re-queued pull request #11\n')
    expect(fake.issues.get(11)?.comments).toEqual([REQUEUE_COMMENT])
  } finally {
    if (savedToken !== undefined) process.env.QA_TEST_TOKEN = savedToken
    else delete process.env.QA_TEST_TOKEN
    await fake.close()
  }
})

test('qare-action stub-issues files from a refused result.json through the CLI', async () => {
  const fake = await startFakeGithub()
  const savedToken = process.env.QA_TEST_TOKEN
  try {
    fake.issues.set(11, { number: 11, title: 'pr', body: '', comments: [] })
    process.env.QA_TEST_TOKEN = FAKE_TOKEN
    const result: RunResult = {
      schemaVersion: '1',
      verdict: 'refused',
      criteria: [{ id: 'c1', outcome: 'unverified', reason: `refused: missing stub: ${HOST_A}:443 (https)` }],
    }
    const dir = await mkdtemp(join(tmpdir(), 'qare-action-'))
    const resultPath = join(dir, 'result.json')
    await writeFile(resultPath, JSON.stringify(result, null, 2), 'utf8')
    const lines: string[] = []
    const code = await main(
      ['stub-issues', '--result', resultPath, '--pr', '11', '--api-root', fake.url, '--repository', 'octocat/qare', '--token-env', 'QA_TEST_TOKEN'],
      { write: (chunk) => lines.push(chunk) },
    )
    expect(code).toBe(0)
    expect(lines.join('')).toContain(`filed stub issue #100 for ${HOST_A}`)
    expect(fake.issues.get(100)?.body).toContain('qare-refused: #11')
    expect(fake.issues.get(11)?.comments[0]).toContain('#100')
  } finally {
    if (savedToken !== undefined) process.env.QA_TEST_TOKEN = savedToken
    else delete process.env.QA_TEST_TOKEN
    await fake.close()
  }
})

test('qare-action CLI reports named errors on bad invocations', async () => {
  const fake = await startFakeGithub()
  try {
    const errors: string[] = []
    const code = await main(['stub-issues', '--pr', '11'], { write: () => {} }, { write: (chunk) => errors.push(chunk) })
    expect(code).toBe(1)
    expect(errors.join('')).toContain('--result')
  } finally {
    await fake.close()
  }
})
