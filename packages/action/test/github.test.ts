import { expect, test } from 'vitest'
import { GitHubClient, GitHubApiError, GitHubClientError } from '../src/github.js'
import { FAKE_TOKEN, startFakeGithub, type FakeGithub } from './fake-github.js'

const OPTIONS = { repository: 'octocat/qare', token: FAKE_TOKEN }

test('GitHubClient creates issues and returns the new number', async () => {
  const fake: FakeGithub = await startFakeGithub()
  try {
    const client = new GitHubClient({ ...OPTIONS, apiRoot: fake.url })
    const issue = await client.createIssue('Stub needed for api.example.com', 'qare-stub: api.example.com')
    expect(issue.number).toBe(100)
    expect(fake.issues.get(100)).toEqual({ number: 100, title: 'Stub needed for api.example.com', body: 'qare-stub: api.example.com', comments: [] })
    const createCall = fake.calls.find((call) => call.method === 'POST')
    expect(createCall?.path).toBe('/repos/octocat/qare/issues')
    expect(createCall?.body).toEqual({ title: 'Stub needed for api.example.com', body: 'qare-stub: api.example.com' })
  } finally {
    await fake.close()
  }
})

test('GitHubClient searches issues by phrase and gets issues by number', async () => {
  const fake = await startFakeGithub()
  try {
    fake.issues.set(7, { number: 7, title: 'Stub needed for b.example.net', body: 'qare-stub: b.example.net', comments: [] })
    const client = new GitHubClient({ ...OPTIONS, apiRoot: fake.url })
    const hits = await client.searchIssues('repo:octocat/qare in:body "qare-stub: b.example.net"')
    expect(hits).toEqual([{ number: 7, title: 'Stub needed for b.example.net', body: 'qare-stub: b.example.net', comments: [] }])
    const searchCall = fake.calls.find((call) => call.path === '/search/issues')
    expect(searchCall?.query).toContain('repo%3Aoctocat%2Fqare')
    expect(await client.getIssue(7)).toMatchObject({ number: 7 })
  } finally {
    await fake.close()
  }
})

test('GitHubClient posts and lists issue comments and patches bodies', async () => {
  const fake = await startFakeGithub()
  try {
    fake.issues.set(9, { number: 9, title: 't', body: 'b', comments: [] })
    const client = new GitHubClient({ ...OPTIONS, apiRoot: fake.url })
    await client.postIssueComment(9, 're-queued')
    expect(await client.listIssueComments(9)).toEqual([{ body: 're-queued' }])
    await client.patchIssueBody(9, 'b2')
    expect(fake.issues.get(9)?.body).toBe('b2')
    const patch = fake.calls.find((call) => call.method === 'PATCH')
    expect(patch?.path).toBe('/repos/octocat/qare/issues/9')
  } finally {
    await fake.close()
  }
})

test('GitHubClient lists open pull requests', async () => {
  const fake = await startFakeGithub()
  try {
    fake.pulls.push({ number: 3, title: 'add stub', state: 'open' })
    const client = new GitHubClient({ ...OPTIONS, apiRoot: fake.url })
    expect(await client.listOpenPullRequests()).toEqual([{ number: 3, title: 'add stub', state: 'open' }])
  } finally {
    await fake.close()
  }
})

test('non-2xx responses become named GitHubApiError carrying status and endpoint', async () => {
  const fake = await startFakeGithub()
  try {
    fake.status = 404
    const client = new GitHubClient({ ...OPTIONS, apiRoot: fake.url })
    const error = await client.getIssue(7).catch((caught) => caught)
    expect(error).toBeInstanceOf(GitHubApiError)
    expect(error.name).toBe('GitHubApiError')
    expect(error.status).toBe(404)
    expect(error.endpoint).toBe('GET /repos/octocat/qare/issues/7')
    expect(error.message).toContain('GET /repos/octocat/qare/issues/7')
    expect(error.message).toContain('404')
  } finally {
    await fake.close()
  }
})

test('missing credentials surface as a named, actionable error', async () => {
  const fake = await startFakeGithub()
  const savedRepository = process.env.GITHUB_REPOSITORY
  try {
    fake.status = undefined
    delete process.env.QA_MISSING_TOKEN
    delete process.env.GITHUB_REPOSITORY
    expect(() => new GitHubClient({ repository: 'octocat/qare', apiRoot: fake.url, tokenEnv: 'QA_MISSING_TOKEN' })).toThrow(
      GitHubClientError,
    )
    expect(() => new GitHubClient({ repository: 'octocat/qare', apiRoot: fake.url, tokenEnv: 'QA_MISSING_TOKEN' })).toThrow(
      /GitHub token/,
    )
    expect(() => new GitHubClient({ apiRoot: fake.url, token: FAKE_TOKEN })).toThrow(GitHubClientError)
  } finally {
    if (savedRepository !== undefined) process.env.GITHUB_REPOSITORY = savedRepository
    await fake.close()
  }
})
