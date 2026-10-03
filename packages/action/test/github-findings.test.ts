import { expect, test } from 'vitest'
import { GitHubClient } from '../src/github.js'
import { FAKE_TOKEN, startFakeGithub } from './fake-github.js'

// #154: what filing a finding on main asks of GitHub, against the fake. No
// test here, or anywhere, files against a real repository.

const OPTIONS = { repository: 'octocat/qare', token: FAKE_TOKEN }

test('an issue is created with labels, by the identity, open, and can be closed and reopened', async () => {
  const fake = await startFakeGithub()
  try {
    const client = new GitHubClient({ ...OPTIONS, apiRoot: fake.url })
    const created = await client.createIssue('QA regression on main: BIL-014', 'body', ['qa-regression'])
    expect(created.state).toBe('open')
    expect(created.user?.login).toBe('github-actions[bot]')
    expect(fake.issueMeta.get(created.number)).toMatchObject({ state: 'open', labels: ['qa-regression'], author: 'github-actions[bot]' })
    expect(fake.calls.at(-1)?.body).toEqual({ title: 'QA regression on main: BIL-014', body: 'body', labels: ['qa-regression'] })

    await client.setIssueState(created.number, 'closed', 'completed')
    expect(fake.issueMeta.get(created.number)).toMatchObject({ state: 'closed', stateReason: 'completed' })
    // Closing leaves the body alone.
    expect(fake.issues.get(created.number)?.body).toBe('body')
    expect((await client.getIssue(created.number)).state).toBe('closed')

    await client.setIssueState(created.number, 'open', 'reopened')
    expect(fake.issueMeta.get(created.number)).toMatchObject({ state: 'open', stateReason: 'reopened' })
  } finally {
    await fake.close()
  }
})

test('a search can ask for open or closed issues only', async () => {
  const fake = await startFakeGithub()
  try {
    const client = new GitHubClient({ ...OPTIONS, apiRoot: fake.url })
    const open = await client.createIssue('one', 'marker-a')
    const closed = await client.createIssue('two', 'marker-a')
    await client.setIssueState(closed.number, 'closed', 'completed')
    expect((await client.searchIssues('repo:octocat/qare is:issue is:open in:body "marker-a"')).map((issue) => issue.number)).toEqual([open.number])
    expect((await client.searchIssues('repo:octocat/qare is:issue is:closed in:body "marker-a"')).map((issue) => issue.number)).toEqual([closed.number])
    expect(await client.searchIssues('repo:octocat/qare is:issue in:body "marker-a"')).toHaveLength(2)
  } finally {
    await fake.close()
  }
})

test('the commits since a moment are listed newest first, up to a limit, saying when there are more', async () => {
  const fake = await startFakeGithub()
  try {
    const head = 'a'.repeat(40)
    fake.commitLog.push(
      { sha: '1'.repeat(40), message: 'Older than the last pass', date: '2026-09-27T00:00:00Z' },
      { sha: '2'.repeat(40), message: 'Add the notice (#12)\n\nA body that is not the subject.', date: '2026-09-29T00:00:00Z' },
      { sha: '3'.repeat(40), message: 'Tune the threshold (#13)', date: '2026-09-30T00:00:00Z' },
    )
    const client = new GitHubClient({ ...OPTIONS, apiRoot: fake.url })
    const listed = await client.listCommitsSince(head, '2026-09-28T04:17:00.000Z', 100)
    expect(listed).toEqual({
      commits: [
        { sha: '3'.repeat(40), subject: 'Tune the threshold (#13)' },
        { sha: '2'.repeat(40), subject: 'Add the notice (#12)' },
      ],
      truncated: false,
    })
    const call = fake.calls.at(-1)
    expect(call?.path).toBe('/repos/octocat/qare/commits')
    expect(call?.query).toContain(`sha=${head}`)
    expect(call?.query).toContain('since=2026-09-28T04%3A17%3A00.000Z')
    expect(await client.listCommitsSince(head, '2026-09-28T04:17:00.000Z', 1)).toEqual({
      commits: [{ sha: '3'.repeat(40), subject: 'Tune the threshold (#13)' }],
      truncated: true,
    })
  } finally {
    await fake.close()
  }
})

test('a commit names the merged pull requests that brought it, and a pull request who opened, merged and approved it and what it changed', async () => {
  const fake = await startFakeGithub()
  try {
    fake.commitPulls.set('2'.repeat(40), [12, 40])
    fake.pullRecords.set(12, {
      title: 'Add the notice',
      author: { login: 'dependabot[bot]', type: 'Bot' },
      mergedBy: { login: 'carol', type: 'User' },
      merged: true,
      files: ['app/payouts/notice.rb', 'docs/a.md'],
      reviews: [
        { user: { login: 'erin', type: 'User' }, state: 'COMMENTED' },
        { user: { login: 'dave', type: 'User' }, state: 'APPROVED' },
      ],
    })
    // Opened against the commit and never merged: it brought nothing to main.
    fake.pullRecords.set(40, { title: 'An open one', author: { login: 'zed', type: 'User' }, merged: false, files: [], reviews: [] })
    const client = new GitHubClient({ ...OPTIONS, apiRoot: fake.url })
    expect(await client.listMergedPullsForCommit('2'.repeat(40))).toEqual([12])
    expect(await client.listMergedPullsForCommit('9'.repeat(40))).toEqual([])
    expect(await client.getPull(12)).toEqual({
      number: 12,
      title: 'Add the notice',
      author: { login: 'dependabot[bot]', bot: true },
      mergedBy: { login: 'carol', bot: false },
    })
    expect(await client.listPullFiles(12, 300)).toEqual(['app/payouts/notice.rb', 'docs/a.md'])
    expect(await client.listPullApprovers(12)).toEqual([{ login: 'dave', bot: false }])
  } finally {
    await fake.close()
  }
})
