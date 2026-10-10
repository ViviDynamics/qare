import { expect, test } from 'vitest'
import { stubIssueDraft, stubIssueMarker } from '@qare/core'
import type { RunResult } from '@qare/core'
import { GitHubClient } from '../src/github.js'
import { appendRegistryLine, fileRefusalStubs, GitHubStubIssuePoster } from '../src/stub-issues.js'
import { FAKE_TOKEN, startFakeGithub, type FakeGithub } from './fake-github.js'

const HOST = 'api.billing-vendor.example'

const refusedResult: RunResult = {
  schemaVersion: '1',
  verdict: 'refused',
  criteria: [
    { id: 'c1', outcome: 'unverified', reason: `refused: missing stub: ${HOST}:443 (https)` },
  ],
}

function makeClient(fake: FakeGithub): GitHubClient {
  return new GitHubClient({ repository: 'octocat/qare', apiRoot: fake.url, token: FAKE_TOKEN })
}

test('fileIfMissing returns the existing issue on a search hit and creates no duplicate', async () => {
  const fake = await startFakeGithub()
  try {
    fake.issueMeta.set(7, { state: 'open', labels: [], author: 'github-actions[bot]' })
    fake.issues.set(7, { number: 7, title: 'Stub needed for ' + HOST, body: `qare-stub: ${HOST}`, comments: [] })
    const poster = new GitHubStubIssuePoster(makeClient(fake))
    const issue = await poster.fileIfMissing(stubIssueDraft({ host: HOST, port: '443', protocol: 'https', count: 1 }))
    expect(issue).toBe(7)
    expect(fake.calls.some((call) => call.method === 'POST' && call.path.endsWith('/issues'))).toBe(false)
  } finally {
    await fake.close()
  }
})

test('fileIfMissing creates the issue when no stub issue exists yet', async () => {
  const fake = await startFakeGithub()
  try {
    const poster = new GitHubStubIssuePoster(makeClient(fake))
    const issue = await poster.fileIfMissing(stubIssueDraft({ host: HOST, port: '443', protocol: 'https', count: 1 }))
    expect(issue).toBe(100)
    expect(fake.issues.get(100)?.title).toBe(`Stub needed for ${HOST}`)
    expect(fake.issues.get(100)?.body).toContain(stubIssueMarker(HOST))
  } finally {
    await fake.close()
  }
})

for (const exactIssue of [undefined, 8]) {
  test(`fileIfMissing ignores a longer stub host and ${exactIssue === undefined ? 'creates the exact host' : 'finds the exact host later'}`, async () => {
    const fake = await startFakeGithub()
    try {
      fake.issueMeta.set(7, { state: 'open', labels: [], author: 'github-actions[bot]' })
      fake.issues.set(7, { number: 7, title: 'Longer host', body: stubIssueMarker(`${HOST}.au`), comments: [] })
      if (exactIssue !== undefined) {
        fake.issueMeta.set(exactIssue, { state: 'open', labels: [], author: 'github-actions[bot]' })
        fake.issues.set(exactIssue, { number: exactIssue, title: 'Exact host', body: stubIssueMarker(HOST), comments: [] })
      }
      const poster = new GitHubStubIssuePoster(makeClient(fake))
      expect(await poster.fileIfMissing(stubIssueDraft({ host: HOST, port: '443', protocol: 'https', count: 1 }))).toBe(exactIssue ?? 100)
      expect(fake.issues.get(7)?.body).toBe(stubIssueMarker(`${HOST}.au`))
    } finally {
      await fake.close()
    }
  })
}

test('addToRegistry appends the qare-refused line exactly once', async () => {
  const fake = await startFakeGithub()
  try {
    fake.issueMeta.set(7, { state: 'open', labels: [], author: 'github-actions[bot]' })
    fake.issues.set(7, { number: 7, title: 't', body: `qare-stub: ${HOST}`, comments: [] })
    const poster = new GitHubStubIssuePoster(makeClient(fake))
    await poster.addToRegistry(7, 11)
    expect(fake.issues.get(7)?.body).toContain('qare-refused: #11')
    const patchesAfterFirst = fake.calls.filter((call) => call.method === 'PATCH').length
    await poster.addToRegistry(7, 11)
    const patchesAfterSecond = fake.calls.filter((call) => call.method === 'PATCH').length
    expect(patchesAfterSecond).toBe(patchesAfterFirst)
    const bodies = fake.issues.get(7)?.body.match(/qare-refused: #11/g) ?? []
    expect(bodies).toHaveLength(1)
  } finally {
    await fake.close()
  }
})

test('comment posts on the refused PR', async () => {
  const fake = await startFakeGithub()
  try {
    fake.issues.set(11, { number: 11, title: 'pr', body: '', comments: [] })
    const poster = new GitHubStubIssuePoster(makeClient(fake))
    await poster.comment(11, 'stub issue: #7')
    expect(fake.issues.get(11)?.comments).toEqual(['stub issue: #7'])
    expect(fake.calls.some((call) => call.path === '/repos/octocat/qare/issues/11/comments')).toBe(true)
  } finally {
    await fake.close()
  }
})

test('fileRefusalStubs files, registers and comments for refused results; idempotent on re-run', async () => {
  const fake = await startFakeGithub()
  try {
    fake.issues.set(11, { number: 11, title: 'pr', body: '', comments: [] })
    const poster = new GitHubStubIssuePoster(makeClient(fake))
    const filed = await fileRefusalStubs(poster, refusedResult, 11)
    expect(filed).toEqual([{ key: HOST, issue: 100 }])
    expect(fake.issues.get(100)?.body).toContain('qare-refused: #11')
    expect(fake.issues.get(11)?.comments[0]).toContain('#100')
    expect(fake.issues.get(11)?.comments[0]).toContain(stubIssueMarker(HOST))

    const createdAfterFirst = fake.issues.size
    const patchesAfterFirst = fake.calls.filter((call) => call.method === 'PATCH').length
    const filedAgain = await fileRefusalStubs(poster, refusedResult, 11)
    expect(filedAgain).toEqual(filed)
    expect(fake.issues.size).toBe(createdAfterFirst)
    expect(fake.calls.filter((call) => call.method === 'PATCH')).toHaveLength(patchesAfterFirst)
  } finally {
    await fake.close()
  }
})

test('fileRefusalStubs does nothing unless the verdict is refused', async () => {
  const fake = await startFakeGithub()
  try {
    const poster = new GitHubStubIssuePoster(makeClient(fake))
    const filed = await fileRefusalStubs(poster, { ...refusedResult, verdict: 'passed' }, 11)
    expect(filed).toEqual([])
    expect(fake.issues.size).toBe(0)
  } finally {
    await fake.close()
  }
})

test('appendRegistryLine is deterministic and parseable', () => {
  const patched = appendRegistryLine(`qare-stub: ${HOST}`, 11)
  expect(patched).toBe(`qare-stub: ${HOST}\n\nqare-refused: #11`)
  expect(appendRegistryLine(patched, 3)).toBe(`${patched}\n\nqare-refused: #3`)
})

for (const author of ['someone-else', undefined]) {
  test(`fileIfMissing ignores a marker issue with author ${author ?? 'unread'}`, async () => {
    const fake = await startFakeGithub()
    try {
      const body = stubIssueMarker(HOST)
      fake.issues.set(7, { number: 7, title: 'A marker', body, comments: [] })
      if (author !== undefined) fake.issueMeta.set(7, { state: 'open', labels: [], author })
      const poster = new GitHubStubIssuePoster(makeClient(fake))
      expect(await poster.fileIfMissing(stubIssueDraft({ host: HOST, port: '443', protocol: 'https', count: 1 }))).toBe(100)
      expect(fake.issues.get(7)?.body).toBe(body)
    } finally {
      await fake.close()
    }
  })

  test(`addToRegistry refuses an issue with author ${author ?? 'unread'} before any patch`, async () => {
    const fake = await startFakeGithub()
    try {
      fake.issues.set(7, { number: 7, title: 'A marker', body: stubIssueMarker(HOST), comments: [] })
      if (author !== undefined) fake.issueMeta.set(7, { state: 'open', labels: [], author })
      await expect(new GitHubStubIssuePoster(makeClient(fake)).addToRegistry(7, 11)).rejects.toThrow(/not owned/)
      expect(fake.calls.filter((call) => call.method === 'PATCH')).toEqual([])
    } finally {
      await fake.close()
    }
  })
}
