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

test('addToRegistry appends the qare-refused line exactly once', async () => {
  const fake = await startFakeGithub()
  try {
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
