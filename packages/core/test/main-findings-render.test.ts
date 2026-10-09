import { describe, expect, test } from 'vitest'
import {
  BUILTIN_REDACTION_RULES,
  blameEnvironment,
  blameMainFinding,
  mainCriterionKey,
  mainFindingMarker,
  readMainFindingMarkers,
  renderEnvironmentIssue,
  renderEnvironmentRecovery,
  renderEnvironmentUpdate,
  renderMainFindingIssue,
  renderMainFindingRecovery,
  renderMainFindingUpdate,
  retireMainFindingMarkers,
  valueRules,
} from '../src/index.js'
import type { BlameRange, EnvironmentFinding, MainFinding, MainRunContext, RangePull } from '../src/index.js'

// #154: what the issue says. The criterion's text, the outcome, the verdict
// decided in code, the evidence and the range, all redacted, linking only to
// files that were uploaded, and mentioning only the people blame named.

const HEAD = 'c0ffee0123456789c0ffee0123456789c0ffee01'
// Assembled, never literal: no network marker sits as a literal in a test.
const web = (path: string): string => ['https:', `//github.example/${path}`].join('')
const RUN_URL = web('octocat/qare/actions/runs/77')
const SHOT_URL = web('octocat/qare/raw/qa-assets/runs/after.png')

function finding(extra: Partial<MainFinding> = {}): MainFinding {
  return {
    kind: 'regression',
    fingerprint: 'mf-0123456789abcdef',
    criterionId: 'BIL-014',
    text: 'A host paid over the threshold sees the 1099 notice.',
    outcome: 'failed',
    evidence: ['checks/BIL-014/0/actions.json', 'checks/BIL-014/0/after.png'],
    checks: ['app/payouts'],
    lastProven: { run: 'run-9', at: '2026-09-28T04:17:00.000Z' },
    ...extra,
  }
}

function pull(number: number, author: string, extra: Partial<RangePull> = {}): RangePull {
  return { number, title: `Change ${number}`, author: { login: author, bot: false }, approvers: [], files: [], ...extra }
}

function range(pulls: RangePull[], extra: Partial<BlameRange> = {}): BlameRange {
  return {
    head: HEAD,
    commits: pulls.map((entry, index) => ({ sha: String(index + 1).repeat(40).slice(0, 40), subject: `${entry.title} (#${entry.number})` })),
    truncated: false,
    pulls,
    ...extra,
  }
}

function context(extra: Partial<MainRunContext> = {}): MainRunContext {
  return { headSha: HEAD, verdict: 'failed', runUrl: RUN_URL, ...extra }
}

/** The mentions a reader of the rendered Markdown is notified by: at signs outside code spans. */
function mentionsIn(markdown: string): string[] {
  const visible = markdown.replace(/(`+)[\s\S]*?\1/g, '')
  return [...visible.matchAll(/@([A-Za-z0-9][A-Za-z0-9/._-]*)/g)].map((match) => match[1] ?? '')
}

describe('the issue a finding becomes', () => {
  test('says the criterion, the outcome, the verdict decided in code, the range and who it is for', () => {
    const pulls = [pull(12, 'alice', { files: ['docs/a.md'] }), pull(13, 'bob', { files: ['app/payouts/notice.rb'] })]
    const blamed = range(pulls)
    const issue = renderMainFindingIssue(finding(), blameMainFinding(finding(), blamed, undefined), blamed, context())
    expect(issue.title).toBe('QA regression on main: BIL-014')
    expect(issue.labels).toEqual(['qa-regression'])
    expect(issue.body).toContain(mainFindingMarker('mf-0123456789abcdef'))
    expect(issue.body).toContain(`<!-- qare:main-criterion ${mainCriterionKey('BIL-014')} -->`)
    expect(issue.body).toContain('`A host paid over the threshold sees the 1099 notice.`')
    expect(issue.body).toContain('Outcome: failed')
    expect(issue.body).toContain("Verdict of the run: failed, decided by qare's code from the checks it executed")
    expect(issue.body).toContain(`[the run](<${RUN_URL}>)`)
    expect(issue.body).toContain(HEAD)
    expect(issue.body).toContain('It last passed in run `run-9` at `2026-09-28T04:17:00.000Z`')
    // The commits since, and the pull requests that brought them.
    expect(issue.body).toContain('1111111111111111111111111111111111111111')
    expect(issue.body).toContain('#12 `Change 12`, opened by @alice')
    expect(issue.body).toContain('#13 `Change 13`, opened by @bob')
    expect(issue.body).toContain('The evidence points most at #13: it touched 1 file(s) the failing checks cover (`app/payouts/notice.rb`)')
    expect(mentionsIn(issue.body)).toEqual(['alice', 'bob'])
    // The hand-off: the label is the signal, and qare stops there.
    expect(issue.body).toContain('`qa-regression` label')
    expect(issue.body).toContain('qare does not fix it and does not merge anything')
  })

  test('links a file only when it was uploaded, and names the rest', () => {
    const blamed = range([pull(12, 'alice')])
    const blame = blameMainFinding(finding(), blamed, undefined)
    const pushed = renderMainFindingIssue(finding(), blame, blamed, context({ screenshots: { 'checks/BIL-014/0/after.png': SHOT_URL }, artifactUrl: web('artifact/1') }))
    expect(pushed.body).toContain(`![after.png](<${SHOT_URL}>)`)
    expect(pushed.body).toContain('`checks/BIL-014/0/actions.json`')
    expect(pushed.body).not.toContain('](<checks/')
    expect(pushed.body).toContain(`[evidence artifact](<${web('artifact/1')}>)`)
    const bare = renderMainFindingIssue(finding(), blame, blamed, context({ runUrl: undefined }))
    expect(bare.body).toContain('`checks/BIL-014/0/after.png`')
    expect(bare.body).not.toContain('![')
    expect(bare.body).toContain("The run's evidence was not uploaded, so these files are named but not linked.")
    expect(bare.body).not.toContain('[the run]')
  })

  test('a pushed screenshot whose name carries an at sign shows the picture and mentions nobody', () => {
    const named = finding({ evidence: ['checks/BIL-014/0/after@mallory.png'] })
    const blamed = range([pull(12, 'alice')])
    const issue = renderMainFindingIssue(named, blameMainFinding(named, blamed, undefined), blamed, context({ screenshots: { 'checks/BIL-014/0/after@mallory.png': SHOT_URL } }))
    expect(issue.body).toContain(`](<${SHOT_URL}>)`)
    expect(mentionsIn(issue.body)).toEqual(['alice'])
  })

  test('redacts what it publishes, and nothing in the text of a run renders or mentions', () => {
    const noisy = finding({
      reason: 'verifier found password=hunter2 on the page, cc @mallory [click](javascript:x)',
      text: 'The page never shows hunter2 to @mallory.',
    })
    const blamed = range([pull(12, 'alice', { title: 'Use token ghp_abcdefghijklmnopqrstuvwxyz0123 for @everyone' })])
    const issue = renderMainFindingIssue(noisy, blameMainFinding(noisy, blamed, undefined), blamed, context(), [...BUILTIN_REDACTION_RULES, ...valueRules(['hunter2'])])
    expect(issue.body).not.toContain('hunter2')
    expect(issue.body).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123')
    expect(issue.body).toContain('[redacted]')
    expect(mentionsIn(issue.body)).toEqual(['alice'])
  })

  test('a failure nothing shows ever passed is not handed off as a regression, and the fallback is told why', () => {
    const never = finding({ kind: 'failure' })
    delete never.lastProven
    const issue = renderMainFindingIssue(never, blameMainFinding(never, undefined, { fallback: 'acme/qa-leads' }), undefined, context())
    expect(issue.title).toBe('QA failure on main: BIL-014')
    expect(issue.labels).toEqual(['qa-failure'])
    expect(issue.body).not.toContain('`qa-regression` label')
    expect(issue.body).toContain('@acme/qa-leads is the fallback this repository\'s profile names (`findings.fallback`)')
    expect(issue.body).toContain('No author is named because the ledger has no record of this criterion ever passing')
    expect(mentionsIn(issue.body)).toEqual(['acme/qa-leads'])
  })

  // #298: several names, each a real mention, and nothing else in the issue is one.
  test('a fallback of several names mentions each of them once, and the sentence names them all', () => {
    const never = finding({ kind: 'failure' })
    delete never.lastProven
    const two = renderMainFindingIssue(never, blameMainFinding(never, undefined, { fallback: ['acme/employees', 'acme/giobytes'] }), undefined, context())
    expect(two.body).toContain("@acme/employees and @acme/giobytes are the fallback this repository's profile names (`findings.fallback`)")
    expect(mentionsIn(two.body)).toEqual(['acme/employees', 'acme/giobytes'])
    const three = renderMainFindingIssue(never, blameMainFinding(never, undefined, { fallback: ['acme/employees', 'octocat', 'acme/giobytes'] }), undefined, context())
    expect(three.body).toContain("@acme/employees, @octocat and @acme/giobytes are the fallback this repository's profile names (`findings.fallback`)")
    expect(mentionsIn(three.body)).toEqual(['acme/employees', 'octocat', 'acme/giobytes'])
  })

  test('with nobody to blame and no fallback it mentions nobody and says how to name one', () => {
    const blamed = range([], { commits: [] })
    const issue = renderMainFindingIssue(finding(), blameMainFinding(finding(), blamed, undefined), blamed, context())
    expect(mentionsIn(issue.body)).toEqual([])
    expect(issue.body).toContain('Nobody is mentioned: no commit landed on the checked revision since the criterion last passed')
    expect(issue.body).toContain('`findings.fallback`')
  })

  test("a bot's pull request names the person who merged it, and says why", () => {
    const blamed = range([pull(12, 'dependabot[bot]', { author: { login: 'dependabot[bot]', bot: true }, mergedBy: { login: 'carol', bot: false } })])
    const issue = renderMainFindingIssue(finding(), blameMainFinding(finding(), blamed, undefined), blamed, context())
    expect(issue.body).toContain('#12 `Change 12`, opened by the bot `dependabot[bot]` and merged by @carol, who is mentioned because a bot cannot act on a notification')
    expect(mentionsIn(issue.body)).toEqual(['carol'])
  })

  test('says so when the range was cut short or people were left unmentioned', () => {
    const pulls = Array.from({ length: 12 }, (_, index) => pull(100 + index, `dev-${index}`))
    const blamed = range(pulls, { truncated: true })
    const issue = renderMainFindingIssue(finding(), blameMainFinding(finding(), blamed, undefined), blamed, context())
    expect(mentionsIn(issue.body)).toHaveLength(10)
    expect(issue.body).toContain('2 more people are in the range and are not mentioned')
    expect(issue.body).toContain('The range is longer than what was read')
  })
})

describe('the comments on an open issue', () => {
  test('an update carries the new run and its evidence, and mentions nobody', () => {
    const comment = renderMainFindingUpdate(finding({ reason: 'verifier saw @mallory' }), context({ screenshots: { 'checks/BIL-014/0/after.png': SHOT_URL } }), { reopened: false })
    expect(comment).toContain('Still failing on `main`')
    expect(comment).toContain(`[the run](<${RUN_URL}>)`)
    expect(comment).toContain(HEAD)
    expect(comment).toContain(`![after.png](<${SHOT_URL}>)`)
    expect(mentionsIn(comment)).toEqual([])
  })

  test('a reopened issue says why it is open again, with the evidence', () => {
    const comment = renderMainFindingUpdate(finding(), context(), { reopened: true })
    expect(comment).toContain('Reopened: this issue was closed while the criterion still fails')
    expect(comment).toContain('`checks/BIL-014/0/actions.json`')
    expect(mentionsIn(comment)).toEqual([])
  })

  test('a recovery links the run that proved the criterion again', () => {
    const comment = renderMainFindingRecovery('BIL-014', context({ verdict: 'passed' }))
    expect(comment).toContain('Criterion `BIL-014` is proven again on `main`')
    expect(comment).toContain(`[the run](<${RUN_URL}>)`)
    expect(comment).toContain('Closing')
  })
})

describe('the environment issue', () => {
  const environment: EnvironmentFinding = {
    kind: 'environment',
    fingerprint: 'mf-environment',
    reasons: ['boot did not come up: token=abc123secretvalue'],
    criteria: ['BIL-014', 'BIL-021', 'BIL-030'],
  }

  test('mentions every name of a fallback list (#298)', () => {
    const down = renderEnvironmentIssue(environment, blameEnvironment({ fallback: ['acme/employees', 'acme/giobytes'] }), context({ verdict: 'blocked' }))
    expect(mentionsIn(down.body)).toEqual(['acme/employees', 'acme/giobytes'])
  })

  test('is one issue for the whole run, labelled qa-environment, for the fallback', () => {
    const issue = renderEnvironmentIssue(environment, blameEnvironment({ fallback: 'octocat' }), context({ verdict: 'blocked' }))
    expect(issue.title).toBe('QA environment down on main')
    expect(issue.labels).toEqual(['qa-environment'])
    expect(issue.body).toContain(mainFindingMarker('mf-environment'))
    expect(issue.body).toContain('3 criterion(s) could not be checked')
    expect(issue.body).toContain('boot did not come up')
    expect(issue.body).not.toContain('abc123secretvalue')
    expect(issue.body).toContain('No author is named because an environment that is down is no change of anyone')
    expect(mentionsIn(issue.body)).toEqual(['octocat'])
  })

  test('is updated and recovered without a mention', () => {
    const update = renderEnvironmentUpdate(environment, context({ verdict: 'blocked' }), { reopened: false })
    expect(update).toContain('Still down on `main`')
    expect(mentionsIn(update)).toEqual([])
    const recovery = renderEnvironmentRecovery(context({ verdict: 'passed' }))
    expect(recovery).toContain('The environment is up again on `main`')
    expect(recovery).toContain(`[the run](<${RUN_URL}>)`)
  })
})

describe('the markers an issue is found by', () => {
  test('are read back from a body, and retired when qare closes the issue', () => {
    const body = `${mainFindingMarker('mf-0123456789abcdef')}\n<!-- qare:main-criterion ${mainCriterionKey('BIL-014')} -->\nwords`
    expect(readMainFindingMarkers(body)).toEqual({ fingerprint: 'mf-0123456789abcdef', criterion: mainCriterionKey('BIL-014') })
    const retired = retireMainFindingMarkers(body)
    // A retired marker finds nothing: the same problem coming back opens a new issue, with a new range.
    expect(readMainFindingMarkers(retired)).toEqual({})
    expect(retired).toContain('qare:main-finding-recovered mf-0123456789abcdef')
    expect(retired).toContain('words')
    expect(readMainFindingMarkers('no marker here')).toEqual({})
    expect(mainCriterionKey('BIL-014')).toMatch(/^mc-[0-9a-f]{16}$/)
  })
})
