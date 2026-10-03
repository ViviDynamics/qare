import { describe, expect, test } from 'vitest'
import { appendChange, mainFindingMarker, parseResult, valueRules, BUILTIN_REDACTION_RULES } from '@qare/core'
import type { LedgerChange, LedgerDocument, LedgerEntry, RunResult } from '@qare/core'
import { GitHubClient } from '../src/github.js'
import { publishMainFindings, type MainFindingsInput } from '../src/main-findings.js'
import { FAKE_TOKEN, startFakeGithub, type FakeGithub } from './fake-github.js'

// #154: findings on main become GitHub issues. Every test here files against
// the fake of GitHub's API: nothing opens an issue, or mentions anyone, on a
// real repository.

const QARE = 'github-actions[bot]'
const HEAD = 'c0ffee0123456789c0ffee0123456789c0ffee01'
const LAST_PASS = '2026-09-28T04:17:00.000Z'
// Assembled, never literal: no network marker sits as a literal in a test.
const web = (path: string): string => ['https:', `//github.example/${path}`].join('')

function client(fake: FakeGithub): GitHubClient {
  return new GitHubClient({ repository: 'octocat/qare', apiRoot: fake.url, token: FAKE_TOKEN })
}

function entry(criterion: string, extra: Partial<LedgerEntry> = {}): LedgerEntry {
  return { criterion, status: 'active', source: ['suite:billing'], proof: 'flow', ...extra }
}

function ledger(proven: string[] = ['BIL-014', 'BIL-021']): LedgerDocument {
  const changes: LedgerChange[] =
    proven.length === 0 ? [] : appendChange([], { kind: 'verify', actor: 'run-9', timestamp: LAST_PASS, reason: 'run run-9: pass', criteria: proven })
  return {
    entries: [entry('BIL-014', { text: 'A host paid over the threshold sees the 1099 notice.', checks: ['app/payouts'] }), entry('BIL-021'), entry('NEW-1')],
    changes,
  }
}

const failing = (): RunResult =>
  parseResult({
    schemaVersion: '1',
    verdict: 'failed',
    criteria: [
      { id: 'BIL-014', outcome: 'failed', evidence: ['checks/BIL-014/0/actions.json', 'checks/BIL-014/0/after.png'] },
      { id: 'BIL-021', outcome: 'proven', evidence: ['checks/BIL-021/0/stdout.txt'] },
    ],
  })

const passing = (): RunResult =>
  parseResult({
    schemaVersion: '1',
    verdict: 'passed',
    criteria: [
      { id: 'BIL-014', outcome: 'proven', evidence: ['checks/BIL-014/0/actions.json'] },
      { id: 'BIL-021', outcome: 'proven', evidence: ['checks/BIL-021/0/stdout.txt'] },
    ],
  })

const down = (): RunResult =>
  parseResult({
    schemaVersion: '1',
    verdict: 'blocked',
    criteria: [
      { id: 'BIL-014', outcome: 'unverified', reason: 'boot did not come up' },
      { id: 'BIL-021', outcome: 'unverified', reason: 'boot did not come up' },
    ],
  })

function input(result: RunResult, extra: Partial<MainFindingsInput> = {}): MainFindingsInput {
  return { result, ledger: ledger(), headSha: HEAD, author: QARE, runUrl: web('octocat/qare/actions/runs/77'), ...extra }
}

/** One human-authored pull request merged since the last pass. */
function mergeBy(fake: FakeGithub, number: number, login: string, files: string[] = ['app/payouts/notice.rb']): void {
  const sha = String(number % 10).repeat(40)
  fake.commitLog.push({ sha, message: `Change ${number} (#${number})`, date: '2026-09-29T00:00:00Z' })
  fake.commitPulls.set(sha, [number])
  fake.pullRecords.set(number, { title: `Change ${number}`, author: { login, type: 'User' }, mergedBy: { login, type: 'User' }, merged: true, files, reviews: [] })
}

function writes(fake: FakeGithub): string[] {
  return fake.calls.filter((call) => call.method !== 'GET').map((call) => `${call.method} ${call.path}`)
}

/** The mentions a reader of the Markdown is notified by: at signs outside code spans. */
function mentionsIn(markdown: string): string[] {
  const visible = markdown.replace(/(`+)[\s\S]*?\1/g, '')
  return [...visible.matchAll(/@([A-Za-z0-9][A-Za-z0-9/._-]*)/g)].map((match) => match[1] ?? '')
}

function onlyIssue(fake: FakeGithub): { number: number; title: string; body: string; comments: string[] } {
  expect(fake.issues.size).toBe(1)
  const issue = [...fake.issues.values()][0]
  if (issue === undefined) throw new Error('no issue was filed')
  return issue
}

describe('a sweep that finds a regression on main', () => {
  test('opens one qa-regression issue with the evidence and the range, mentioning the author of the pull request that caused it', async () => {
    const fake = await startFakeGithub()
    try {
      mergeBy(fake, 12, 'alice')
      const outcome = await publishMainFindings(client(fake), input(failing()))
      const issue = onlyIssue(fake)
      expect(outcome.actions).toEqual([{ action: 'opened', kind: 'regression', criterion: 'BIL-014', fingerprint: expect.stringMatching(/^mf-/) as string, issue: issue.number, mentions: ['alice'] }])
      expect(fake.issueMeta.get(issue.number)).toMatchObject({ state: 'open', labels: ['qa-regression'], author: QARE })
      expect(issue.title).toBe('QA regression on main: BIL-014')
      expect(issue.body).toContain('`A host paid over the threshold sees the 1099 notice.`')
      expect(issue.body).toContain('`checks/BIL-014/0/actions.json`')
      expect(issue.body).toContain('2222222222222222222222222222222222222222')
      expect(issue.body).toContain('#12 `Change 12`, opened by @alice')
      expect(issue.body).toContain('The evidence points most at #12')
      expect(mentionsIn(issue.body)).toEqual(['alice'])
      // The range was read from the last pass the ledger records, up to the revision checked.
      const commits = fake.calls.find((call) => call.path === '/repos/octocat/qare/commits')
      expect(commits?.query).toContain(`sha=${HEAD}`)
      expect(commits?.query).toContain('since=2026-09-28T04%3A17%3A00.000Z')
    } finally {
      await fake.close()
    }
  })

  test('with several pull requests in the range, mentions each author and says which one the evidence points at and why', async () => {
    const fake = await startFakeGithub()
    try {
      mergeBy(fake, 12, 'alice', ['docs/a.md'])
      mergeBy(fake, 13, 'bob', ['app/payouts/notice.rb'])
      await publishMainFindings(client(fake), input(failing()))
      const issue = onlyIssue(fake)
      expect(mentionsIn(issue.body).sort()).toEqual(['alice', 'bob'])
      expect(issue.body).toContain('The evidence points most at #13: it touched 1 file(s) the failing checks cover (`app/payouts/notice.rb`)')
    } finally {
      await fake.close()
    }
  })

  test('links the screenshots that were pushed and names the files that were not', async () => {
    const fake = await startFakeGithub()
    try {
      mergeBy(fake, 12, 'alice')
      const pushed: RunResult[] = []
      const push = {
        push: (result: RunResult): Promise<Record<string, string>> => {
          pushed.push(result)
          return Promise.resolve({ 'checks/BIL-014/0/after.png': web('raw/qa-assets/after.png') })
        },
      }
      await publishMainFindings(client(fake), input(failing(), { push, evidenceDir: '/evidence' }))
      const issue = onlyIssue(fake)
      expect(issue.body).toContain(`![after.png](<${web('raw/qa-assets/after.png')}>)`)
      expect(issue.body).toContain('`checks/BIL-014/0/actions.json`')
      // Only the failing criteria's screenshots are pushed: a finding links nothing else.
      expect(pushed[0]?.criteria.map((criterion) => criterion.id)).toEqual(['BIL-014'])
    } finally {
      await fake.close()
    }
  })

  test('redacts what it publishes with the rules it is given', async () => {
    const fake = await startFakeGithub()
    try {
      mergeBy(fake, 12, 'alice')
      fake.pullRecords.get(12)!.title = 'Seed the hunter2 fixture'
      const result = parseResult({
        schemaVersion: '1',
        verdict: 'failed',
        criteria: [{ id: 'BIL-014', outcome: 'failed', reason: 'verifier saw hunter2 on the page', evidence: ['checks/BIL-014/0/actions.json'] }],
      })
      await publishMainFindings(client(fake), input(result, { rules: [...BUILTIN_REDACTION_RULES, ...valueRules(['hunter2'])] }))
      const issue = onlyIssue(fake)
      expect(issue.body).not.toContain('hunter2')
      expect(issue.body).toContain('[redacted]')
    } finally {
      await fake.close()
    }
  })
})

test('a regression brought in by a bot-authored pull request mentions the person who merged it', async () => {
  const fake = await startFakeGithub()
  try {
    mergeBy(fake, 12, 'alice')
    fake.pullRecords.set(12, {
      title: 'Bump stripe',
      author: { login: 'dependabot[bot]', type: 'Bot' },
      mergedBy: { login: 'carol', type: 'User' },
      merged: true,
      files: ['Gemfile.lock'],
      reviews: [],
    })
    const outcome = await publishMainFindings(client(fake), input(failing()))
    const issue = onlyIssue(fake)
    expect(outcome.actions[0]).toMatchObject({ action: 'opened', mentions: ['carol'] })
    expect(issue.body).toContain('opened by the bot `dependabot[bot]` and merged by @carol')
    expect(mentionsIn(issue.body)).toEqual(['carol'])
  } finally {
    await fake.close()
  }
})

test('a pull request an orchestrator opened and a bot merged mentions the person who approved it', async () => {
  const fake = await startFakeGithub()
  try {
    mergeBy(fake, 12, 'alice')
    fake.pullRecords.set(12, {
      title: 'Ship the notice',
      author: { login: 'ship-robot', type: 'User' },
      mergedBy: { login: 'merge-queue[bot]', type: 'Bot' },
      merged: true,
      files: [],
      reviews: [{ user: { login: 'dave', type: 'User' }, state: 'APPROVED' }],
    })
    await publishMainFindings(client(fake), input(failing(), { findings: { bots: ['ship-robot'] } }))
    expect(mentionsIn(onlyIssue(fake).body)).toEqual(['dave'])
  } finally {
    await fake.close()
  }
})

describe('a regression with no blameable change', () => {
  test("mentions the profile's fallback and says why no author is named", async () => {
    const fake = await startFakeGithub()
    try {
      // The ledger never recorded a pass of NEW-1.
      const result = parseResult({ schemaVersion: '1', verdict: 'failed', criteria: [{ id: 'NEW-1', outcome: 'failed', evidence: ['checks/NEW-1/0/stdout.txt'] }] })
      const outcome = await publishMainFindings(client(fake), input(result, { findings: { fallback: 'acme/qa-leads' } }))
      const issue = onlyIssue(fake)
      expect(outcome.actions[0]).toMatchObject({ action: 'opened', kind: 'failure', mentions: ['acme/qa-leads'] })
      expect(fake.issueMeta.get(issue.number)?.labels).toEqual(['qa-failure'])
      expect(issue.body).toContain("@acme/qa-leads is the fallback this repository's profile names")
      expect(issue.body).toContain('No author is named because the ledger has no record of this criterion ever passing')
      // No range to read: GitHub is not asked for one.
      expect(fake.calls.some((call) => call.path.endsWith('/commits'))).toBe(false)
    } finally {
      await fake.close()
    }
  })

  test('a recorded pass with no pull request since falls back too, and with no fallback nobody is mentioned', async () => {
    const fake = await startFakeGithub()
    try {
      fake.commitLog.push({ sha: '7'.repeat(40), message: 'Pushed straight to main', date: '2026-09-29T00:00:00Z' })
      await publishMainFindings(client(fake), input(failing()))
      const issue = onlyIssue(fake)
      expect(fake.issueMeta.get(issue.number)?.labels).toEqual(['qa-regression'])
      expect(issue.body).toContain('Nobody is mentioned: no pull request brought the 1 commit(s)')
      expect(mentionsIn(issue.body)).toEqual([])
    } finally {
      await fake.close()
    }
  })
})

test('the next sweep, still failing, comments on that issue, opens no new one and mentions nobody again', async () => {
  const fake = await startFakeGithub()
  try {
    mergeBy(fake, 12, 'alice')
    await publishMainFindings(client(fake), input(failing()))
    const issue = onlyIssue(fake)
    const before = fake.calls.length
    const outcome = await publishMainFindings(client(fake), input(failing(), { runUrl: web('octocat/qare/actions/runs/78') }))
    expect(outcome.actions).toEqual([{ action: 'updated', criterion: 'BIL-014', fingerprint: expect.stringMatching(/^mf-/) as string, issue: issue.number }])
    expect(fake.issues.size).toBe(1)
    expect(issue.comments).toHaveLength(1)
    expect(issue.comments[0]).toContain('Still failing on `main`')
    expect(issue.comments[0]).toContain(web('octocat/qare/actions/runs/78'))
    expect(issue.comments[0]).toContain('`checks/BIL-014/0/actions.json`')
    expect(mentionsIn(issue.comments[0] ?? '')).toEqual([])
    // An update reads no range: nobody new can be blamed by it.
    expect(fake.calls.slice(before).some((call) => call.path.endsWith('/commits'))).toBe(false)
  } finally {
    await fake.close()
  }
})

describe('closing the loop', () => {
  test('a sweep in which it passes again comments with the passing run and closes the issue', async () => {
    const fake = await startFakeGithub()
    try {
      mergeBy(fake, 12, 'alice')
      await publishMainFindings(client(fake), input(failing()))
      const issue = onlyIssue(fake)
      const outcome = await publishMainFindings(client(fake), input(passing(), { runUrl: web('octocat/qare/actions/runs/79') }))
      expect(outcome.actions).toEqual([{ action: 'closed', criterion: 'BIL-014', issue: issue.number }])
      expect(fake.issueMeta.get(issue.number)).toMatchObject({ state: 'closed', stateReason: 'completed' })
      expect(issue.comments.at(-1)).toContain('Criterion `BIL-014` is proven again on `main`')
      expect(issue.comments.at(-1)).toContain(`[the run](<${web('octocat/qare/actions/runs/79')}>)`)
    } finally {
      await fake.close()
    }
  })

  test('the same problem coming back after a recovery opens a new issue, with its own range', async () => {
    const fake = await startFakeGithub()
    try {
      mergeBy(fake, 12, 'alice')
      await publishMainFindings(client(fake), input(failing()))
      await publishMainFindings(client(fake), input(passing()))
      const outcome = await publishMainFindings(client(fake), input(failing()))
      expect(outcome.actions[0]).toMatchObject({ action: 'opened' })
      expect(fake.issues.size).toBe(2)
    } finally {
      await fake.close()
    }
  })

  test('an issue a person closed by hand while the criterion still fails is reopened, with the evidence, and mentions nobody', async () => {
    const fake = await startFakeGithub()
    try {
      mergeBy(fake, 12, 'alice')
      await publishMainFindings(client(fake), input(failing()))
      const issue = onlyIssue(fake)
      // A person closes it; qare did not, so the marker still stands.
      fake.issueMeta.set(issue.number, { ...fake.issueMeta.get(issue.number)!, state: 'closed', stateReason: 'not_planned' })
      const outcome = await publishMainFindings(client(fake), input(failing()))
      expect(outcome.actions).toEqual([{ action: 'reopened', criterion: 'BIL-014', fingerprint: expect.stringMatching(/^mf-/) as string, issue: issue.number }])
      expect(fake.issues.size).toBe(1)
      expect(fake.issueMeta.get(issue.number)).toMatchObject({ state: 'open', stateReason: 'reopened' })
      expect(issue.comments.at(-1)).toContain('Reopened: this issue was closed while the criterion still fails')
      expect(issue.comments.at(-1)).toContain('`checks/BIL-014/0/actions.json`')
      expect(mentionsIn(issue.comments.at(-1) ?? '')).toEqual([])
    } finally {
      await fake.close()
    }
  })

  test('a criterion that neither passed nor failed leaves its issue as it is', async () => {
    const fake = await startFakeGithub()
    try {
      mergeBy(fake, 12, 'alice')
      await publishMainFindings(client(fake), input(failing()))
      const issue = onlyIssue(fake)
      const flaky = parseResult({
        schemaVersion: '1',
        verdict: 'blocked',
        criteria: [
          { id: 'BIL-014', outcome: 'unverified', reason: 'quarantined (2026-09-30T00:00:00.000Z): failed then passed', evidence: ['checks/BIL-014/0/quarantined.json'] },
          { id: 'BIL-021', outcome: 'proven', evidence: ['checks/BIL-021/0/stdout.txt'] },
        ],
      })
      const outcome = await publishMainFindings(client(fake), input(flaky))
      expect(outcome.actions).toEqual([])
      expect(outcome.flaky).toEqual(['BIL-014'])
      expect(fake.issueMeta.get(issue.number)?.state).toBe('open')
      expect(issue.comments).toEqual([])
    } finally {
      await fake.close()
    }
  })
})

describe('kinds are kept apart', () => {
  test('a sweep in which nothing boots opens one qa-environment issue, not one per criterion', async () => {
    const fake = await startFakeGithub()
    try {
      const outcome = await publishMainFindings(client(fake), input(down(), { findings: { fallback: 'octocat' } }))
      const issue = onlyIssue(fake)
      expect(outcome.actions).toEqual([{ action: 'opened', kind: 'environment', fingerprint: 'mf-environment', issue: issue.number, mentions: ['octocat'] }])
      expect(fake.issueMeta.get(issue.number)?.labels).toEqual(['qa-environment'])
      expect(issue.title).toBe('QA environment down on main')
      expect(issue.body).toContain('2 criterion(s) could not be checked')
      expect(mentionsIn(issue.body)).toEqual(['octocat'])
    } finally {
      await fake.close()
    }
  })

  test('an environment that stays down is commented on once per run, and closed when a check executes again', async () => {
    const fake = await startFakeGithub()
    try {
      await publishMainFindings(client(fake), input(down(), { findings: { fallback: 'octocat' } }))
      const issue = onlyIssue(fake)
      const again = await publishMainFindings(client(fake), input(down(), { findings: { fallback: 'octocat' } }))
      expect(again.actions).toEqual([{ action: 'updated', fingerprint: 'mf-environment', issue: issue.number }])
      expect(issue.comments).toHaveLength(1)
      expect(mentionsIn(issue.comments[0] ?? '')).toEqual([])
      const up = await publishMainFindings(client(fake), input(passing()))
      expect(up.actions).toEqual([{ action: 'closed', issue: issue.number }])
      expect(fake.issueMeta.get(issue.number)?.state).toBe('closed')
      expect(issue.comments.at(-1)).toContain('The environment is up again on `main`')
    } finally {
      await fake.close()
    }
  })

  test('an environment that is down leaves an open regression issue alone: nothing ran, so nothing recovered', async () => {
    const fake = await startFakeGithub()
    try {
      mergeBy(fake, 12, 'alice')
      await publishMainFindings(client(fake), input(failing()))
      const regression = onlyIssue(fake)
      await publishMainFindings(client(fake), input(down()))
      expect(fake.issueMeta.get(regression.number)?.state).toBe('open')
      expect(regression.comments).toEqual([])
      expect(fake.issues.size).toBe(2)
    } finally {
      await fake.close()
    }
  })
})

test('a marker anyone else wrote finds nothing: only an issue this identity opened is qare\'s own', async () => {
  const fake = await startFakeGithub()
  try {
    mergeBy(fake, 12, 'alice')
    await publishMainFindings(client(fake), input(failing()))
    const own = onlyIssue(fake)
    const fingerprint = /qare:main-finding (mf-[0-9a-f]+)/.exec(own.body)?.[1] ?? ''
    fake.issues.delete(own.number)
    // Someone copies the marker into an issue of their own.
    fake.issues.set(7, { number: 7, title: 'mine', body: mainFindingMarker(fingerprint), comments: [] })
    fake.issueMeta.set(7, { state: 'open', labels: [], author: 'mallory' })
    const outcome = await publishMainFindings(client(fake), input(failing()))
    expect(outcome.actions[0]).toMatchObject({ action: 'opened' })
    expect(fake.issues.get(7)?.comments).toEqual([])
    expect(fake.issueMeta.get(7)?.state).toBe('open')
  } finally {
    await fake.close()
  }
})

test('a dry run says what it would do and writes nothing', async () => {
  const fake = await startFakeGithub()
  try {
    mergeBy(fake, 12, 'alice')
    const outcome = await publishMainFindings(client(fake), input(failing(), { dryRun: true }))
    expect(outcome.dryRun).toBe(true)
    expect(outcome.actions).toEqual([{ action: 'opened', kind: 'regression', criterion: 'BIL-014', fingerprint: expect.stringMatching(/^mf-/) as string, mentions: ['alice'] }])
    expect(writes(fake)).toEqual([])
    expect(fake.issues.size).toBe(0)
  } finally {
    await fake.close()
  }
})
