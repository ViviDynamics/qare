import { describe, expect, test } from 'vitest'
import { blameEnvironment, blameMainFinding } from '../src/index.js'
import type { BlameRange, MainFinding, RangePull } from '../src/index.js'

// #154: who a finding on main names, decided in code from the pull requests
// merged since the ledger's last pass. No model has a say in it.

function finding(extra: Partial<MainFinding> = {}): MainFinding {
  return {
    kind: 'regression',
    fingerprint: 'mf-0123456789abcdef',
    criterionId: 'BIL-014',
    outcome: 'failed',
    evidence: ['checks/BIL-014/0/after.png'],
    checks: ['app/payouts', 'suite:billing'],
    lastProven: { run: 'run-9', at: '2026-09-28T04:17:00.000Z' },
    ...extra,
  }
}

function unproven(kind: MainFinding['kind']): MainFinding {
  const { lastProven: _dropped, ...rest } = finding({ kind })
  return rest
}

function pull(number: number, author: string, extra: Partial<RangePull> = {}): RangePull {
  return { number, title: `Change ${number}`, author: { login: author, bot: false }, approvers: [], files: [], ...extra }
}

function range(pulls: RangePull[], commits = pulls.length): BlameRange {
  return {
    head: 'a'.repeat(40),
    commits: Array.from({ length: commits }, (_, index) => ({ sha: String(index).padStart(40, '0'), subject: `commit ${index}` })),
    truncated: false,
    pulls,
  }
}

describe('blaming the change', () => {
  test('one pull request in the range: its author is mentioned, and it is the one pointed at', () => {
    const blame = blameMainFinding(finding(), range([pull(12, 'alice')]), undefined)
    expect(blame.mentions).toEqual(['alice'])
    expect(blame.people).toEqual([{ pull: 12, login: 'alice', role: 'author' }])
    expect(blame.pointed).toEqual({ pull: 12, why: 'it is the only pull request merged since the criterion last passed' })
    expect(blame.fallback).toBeUndefined()
  })

  test('several pull requests: each author is mentioned once, and the one that touched the files the check covers is pointed at', () => {
    const blame = blameMainFinding(
      finding(),
      range([
        pull(12, 'alice', { files: ['docs/README.md'] }),
        pull(13, 'bob', { files: ['app/payouts/notice.rb', 'app/payouts/threshold.rb', 'lib/tax.rb'] }),
        pull(14, 'alice', { files: ['app/payouts'] }),
      ]),
      undefined,
    )
    expect(blame.mentions).toEqual(['alice', 'bob'])
    expect(blame.pointed?.pull).toBe(13)
    expect(blame.pointed?.why).toContain('2 file(s)')
    expect(blame.pointed?.why).toContain('app/payouts/notice.rb')
  })

  test('several pull requests the files cannot tell apart: all are mentioned, none is singled out, and the issue says why', () => {
    const tied = blameMainFinding(finding(), range([pull(12, 'alice', { files: ['app/payouts/a.rb'] }), pull(13, 'bob', { files: ['app/payouts/b.rb'] })]), undefined)
    expect(tied.mentions).toEqual(['alice', 'bob'])
    expect(tied.pointed).toBeUndefined()
    expect(tied.unpointed).toContain('#12 and #13')
    const untouched = blameMainFinding(finding(), range([pull(12, 'alice', { files: ['docs/a.md'] }), pull(13, 'bob', { files: ['docs/b.md'] })]), undefined)
    expect(untouched.unpointed).toContain('none of them touched')
    const unmapped = blameMainFinding(finding({ checks: ['suite:billing'] }), range([pull(12, 'alice'), pull(13, 'bob')]), undefined)
    expect(unmapped.unpointed).toContain('name no repository path')
  })

  test("a bot's pull request: the person who merged it is mentioned, else one who approved it, never the bot", () => {
    const merged = blameMainFinding(
      finding(),
      range([pull(12, 'dependabot[bot]', { author: { login: 'dependabot[bot]', bot: true }, mergedBy: { login: 'carol', bot: false }, approvers: [{ login: 'dave', bot: false }] })]),
      undefined,
    )
    expect(merged.mentions).toEqual(['carol'])
    expect(merged.people).toEqual([{ pull: 12, login: 'carol', role: 'merged', bot: 'dependabot[bot]' }])
    const approved = blameMainFinding(
      finding(),
      range([pull(12, 'ship-robot', { mergedBy: { login: 'github-actions[bot]', bot: true }, approvers: [{ login: 'dave', bot: false }] })]),
      // An orchestrator that opens pull requests with a person's token is a bot because the profile says so.
      { bots: ['Ship-Robot'] },
    )
    expect(approved.mentions).toEqual(['dave'])
    expect(approved.people).toEqual([{ pull: 12, login: 'dave', role: 'approved', bot: 'ship-robot' }])
  })

  test('a range of nothing but bots falls back, saying why', () => {
    const blame = blameMainFinding(
      finding(),
      range([pull(12, 'dependabot[bot]', { author: { login: 'dependabot[bot]', bot: true }, mergedBy: { login: 'merge-queue[bot]', bot: true } })]),
      { fallback: 'acme/qa-leads' },
    )
    expect(blame.mentions).toEqual(['acme/qa-leads'])
    expect(blame.fallback?.why).toContain('no person opened, merged or approved')
    expect(blame.people).toEqual([{ pull: 12, role: 'nobody', bot: 'dependabot[bot]' }])
  })

  test('no record of a pass: the fallback is mentioned and the issue says why no author is named', () => {
    const never = blameMainFinding(unproven('failure'), undefined, { fallback: 'octocat' })
    expect(never.mentions).toEqual(['octocat'])
    expect(never.fallback).toEqual({ login: 'octocat', why: 'the ledger has no record of this criterion ever passing, so there is no change to blame' })
    const unrecorded = blameMainFinding(unproven('regression'), undefined, { fallback: 'octocat' })
    expect(unrecorded.fallback?.why).toBe("the ledger has no record of this criterion's last pass, so there is no range of commits to read")
  })

  test('a range that holds no pull request falls back, and no fallback means nobody is mentioned', () => {
    const direct = blameMainFinding(finding(), range([], 2), { fallback: 'octocat' })
    expect(direct.mentions).toEqual(['octocat'])
    expect(direct.fallback?.why).toContain('no pull request brought the 2 commit(s)')
    const quiet = blameMainFinding(finding(), range([], 0), undefined)
    expect(quiet.mentions).toEqual([])
    expect(quiet.fallback).toEqual({ why: 'no commit landed on the checked revision since the criterion last passed (run `run-9`, `2026-09-28T04:17:00.000Z`)' })
  })

  test('at most ten people are mentioned on one issue, and the rest are counted', () => {
    const pulls = Array.from({ length: 13 }, (_, index) => pull(100 + index, `dev-${index}`))
    const blame = blameMainFinding(finding(), range(pulls), undefined)
    expect(blame.mentions).toHaveLength(10)
    expect(blame.unmentioned).toBe(3)
  })

  test('a login that is no login is never written as a mention', () => {
    const blame = blameMainFinding(finding(), range([pull(12, 'alice](x) @everyone')]), { fallback: 'octocat' })
    expect(blame.mentions).toEqual(['octocat'])
    expect(blame.people).toEqual([{ pull: 12, role: 'nobody' }])
  })

  test('an environment that is down blames no change', () => {
    expect(blameEnvironment({ fallback: 'acme/qa-leads' })).toEqual({
      mentions: ['acme/qa-leads'],
      people: [],
      unmentioned: 0,
      fallback: { login: 'acme/qa-leads', why: 'an environment that is down is no change of anyone, so there is no author to name' },
    })
  })
})
