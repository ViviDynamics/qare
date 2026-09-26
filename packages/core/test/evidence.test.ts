import { expect, test } from 'vitest'
import {
  RESULT_SCHEMA_VERSION,
  type FailedCriterionResult,
  type RunResult,
  type UnverifiedCriterionResult,
} from '../src/result.js'
import {
  renderCheckRun,
  renderComment,
  type CheckRunPayload,
  type EvidencePoster,
} from '../src/evidence.js'

function result(
  verdict: RunResult['verdict'],
  criteria: RunResult['criteria'],
  jobId?: string,
): RunResult {
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    verdict,
    criteria,
    ...(jobId === undefined ? {} : { job: { id: jobId } }),
  }
}

function failed(id: string, evidence: string[], reason?: string): FailedCriterionResult {
  return reason === undefined
    ? { id, outcome: 'failed', evidence }
    : { id, outcome: 'failed', evidence, reason } as FailedCriterionResult
}

function unverified(id: string, reason: string, evidence?: string[]): UnverifiedCriterionResult {
  return evidence === undefined
    ? { id, outcome: 'unverified', reason }
    : { id, outcome: 'unverified', reason, evidence }
}

const allProven = result('passed', [
  {
    id: 'payout-1099-notice',
    outcome: 'proven',
    evidence: ['checks/payout-1099-notice/1/stdout.txt', 'checks/payout-1099-notice/2/page.png'],
  },
], 'job-7')

const mixed = result('failed', [
  { id: 'payout-1099-notice', outcome: 'proven', evidence: ['checks/payout-1099-notice/1/stdout.txt'] },
  failed('ledger-export-csv', ['checks/ledger-export-csv/1/stdout.txt'], 'export wrote 0 rows | expected 3'),
  unverified('multi-currency-totals', 'staging unreachable | no vpn', ['checks/multi-currency-totals/1/attempt.log']),
], 'job-9')

const blocked = result('blocked', [
  unverified('boot-health', 'the app never became healthy under the pinned compose profile', ['evidence/boot/compose.log']),
])

test('an all-proven run renders the table, the passed verdict and a success check run', () => {
  const body = renderComment(allProven)
  expect(body).toContain('## QARE run: passed (job job-7)')
  expect(body).toContain('| criterion | outcome | reason |')
  expect(body).toContain('| payout-1099-notice | proven |  |')

  const checkRun = renderCheckRun(allProven)
  expect(checkRun).toEqual({
    title: 'QARE',
    summary: 'verdict passed: 1 proven, 0 failed, 0 unverified',
    conclusion: 'success',
  })
})

test('a mixed run populates the reason column and maps failed to failure', () => {
  const body = renderComment(mixed)
  expect(body).toContain('| ledger-export-csv | failed | export wrote 0 rows \\| expected 3 |')
  expect(body).toContain(
    '| multi-currency-totals | unverified | could not verify (environment): staging unreachable \\| no vpn |',
  )

  const checkRun = renderCheckRun(mixed)
  expect(checkRun).toEqual({
    title: 'QARE',
    summary: 'verdict failed: 1 proven, 1 failed, 1 unverified',
    conclusion: 'failure',
  })
})

test('blocked, refused and waived map to neutral check runs', () => {
  expect(renderCheckRun(blocked).conclusion).toBe('neutral')
  expect(renderCheckRun(result('refused', [])).conclusion).toBe('neutral')
  expect(renderCheckRun(result('waived', [])).conclusion).toBe('neutral')
})

test('evidence links reference only files from the evidence arrays', () => {
  const body = renderComment(mixed)
  expect(body).toContain(
    '- payout-1099-notice: [stdout.txt](<checks/payout-1099-notice/1/stdout.txt>)',
  )
  expect(body).toContain('- ledger-export-csv: [stdout.txt](<checks/ledger-export-csv/1/stdout.txt>)')
  expect(body).toContain(
    '- multi-currency-totals: [attempt.log](<checks/multi-currency-totals/1/attempt.log>)',
  )
  const links = [...body.matchAll(/\]\(<([^)]+)>\)/g)].map(match => match[1])
  expect(links).toEqual([
    'checks/payout-1099-notice/1/stdout.txt',
    'checks/ledger-export-csv/1/stdout.txt',
    'checks/multi-currency-totals/1/attempt.log',
  ])
  expect(body).not.toMatch(/https?:\/\//)
})

test('a criterion with empty evidence renders no links', () => {
  const body = renderComment(result('blocked', [unverified('boot-health', 'compose never came up')]))
  expect(body).not.toContain('Details:')
  expect(body).not.toMatch(/\]\(/)
})

test('the comment never embeds environment secrets', () => {
  const previous = process.env.GITHUB_TOKEN
  process.env.GITHUB_TOKEN = 'ghs_supersecret_token'
  try {
    const body = renderComment(mixed)
    expect(body).not.toContain('ghs_supersecret_token')
  } finally {
    if (previous === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = previous
  }
})

class FakeEvidencePoster implements EvidencePoster {
  readonly commentBodies: string[] = []
  readonly payloads: CheckRunPayload[] = []

  async postComment(body: string): Promise<void> {
    this.commentBodies.push(body)
  }

  async createCheckRun(payload: CheckRunPayload): Promise<void> {
    this.payloads.push(payload)
  }
}

test('nothing posts on its own; the fake poster records exactly the rendered output', async () => {
  const poster = new FakeEvidencePoster()
  const body = renderComment(mixed)
  const payload = renderCheckRun(mixed)
  await poster.postComment(body)
  await poster.createCheckRun(payload)
  expect(poster.commentBodies).toEqual([body])
  expect(poster.payloads).toEqual([payload])
})

test('the rendered comment is pinned in full: regressions to order or wording fail', () => {
  expect(renderComment(mixed)).toBe(
    '## QARE run: failed (job job-9)\n' +
      '\n' +
      '| criterion | outcome | reason |\n' +
      '| --- | --- | --- |\n' +
      '| payout-1099-notice | proven |  |\n' +
      '| ledger-export-csv | failed | export wrote 0 rows \\| expected 3 |\n' +
      '| multi-currency-totals | unverified | could not verify (environment): staging unreachable \\| no vpn |\n' +
      '\n' +
      'Details:\n' +
      '\n' +
      '- payout-1099-notice: [stdout.txt](<checks/payout-1099-notice/1/stdout.txt>)\n' +
      '- ledger-export-csv: [stdout.txt](<checks/ledger-export-csv/1/stdout.txt>)\n' +
      '- multi-currency-totals: [attempt.log](<checks/multi-currency-totals/1/attempt.log>)\n' +
      '\n' +
      'Unverified criteria could not verify (environment) — that is not a code defect.',
  )
})

test('a verifier that could not check is not blamed on the environment', () => {
  const body = renderComment({
    schemaVersion: '1',
    verdict: 'blocked',
    criteria: [{ id: 'c1', outcome: 'unverified', reason: 'verifier did not answer: HTTP 524', evidence: ['c1/out.txt'] }],
  })
  expect(body).toContain('| c1 | unverified | not independently checked: verifier did not answer: HTTP 524 |')
  expect(body).toContain('the verifier could not review them')
  expect(body).not.toContain('(environment)')
})

test('a verifier finding shows as the failed criterion reason', () => {
  const body = renderComment({
    schemaVersion: '1',
    verdict: 'failed',
    criteria: [{ id: 'c1', outcome: 'failed', evidence: ['c1/out.txt'], reason: 'verifier: 0 rows exported' }],
  })
  expect(body).toContain('| c1 | failed | verifier: 0 rows exported |')
})

// Posted on a pull request, a relative path resolves to nothing. Rule 4: the
// only link is to what was uploaded, the run's evidence artifact.
test('a posted comment names evidence files and links only to the uploaded artifact', () => {
  const url = ['https:', '//github.com/octocat/qare/actions/runs/1/artifacts/2'].join('')
  const body = renderComment(mixed, { kind: 'artifact', url })

  expect(body).toContain('- `payout-1099-notice`: `checks/payout-1099-notice/1/stdout.txt`')
  expect(body).toContain(`[evidence artifact](<${url}>)`)
  expect(body).not.toContain('](<checks/')
  expect(body.match(/\]\(/g)).toHaveLength(1)
})

test('with no artifact uploaded, a posted comment links nothing and says so', () => {
  const body = renderComment(mixed, { kind: 'artifact' })

  expect(body).not.toContain('](')
  expect(body).toContain('named but not linked')
})

test('a backtick in an evidence path cannot break out of its code span', () => {
  const body = renderComment(
    result('passed', [{ id: 'c1', outcome: 'proven', evidence: [['checks/c1/a`](<https:', '//evil>)`.txt'].join('')] }]),
    { kind: 'artifact' },
  )

  // The path is shown exactly, fenced by more backticks than it contains.
  expect(body).toContain(['- `c1`: ``checks/c1/a`](<https:', '//evil>)`.txt``'].join(''))
})

// A reason can carry text a model wrote. On a pull request it must not
// render as a link, HTML or a mention: rule 4 allows one link, the artifact.
test('posted reasons and ids are inert: no link, HTML or mention renders from them', () => {
  const evil = ['see [proof](https:', '//evil.example) <a href="x">y</a> @someone | tail'].join('')
  const body = renderComment(
    result('failed', [{ id: 'c1', outcome: 'failed', evidence: ['c1/out.txt'], reason: evil } as FailedCriterionResult]),
    { kind: 'artifact', url: ['https:', '//github.com/o/r/actions/runs/1/artifacts/2'].join('') },
  )

  const row = body.split('\n').find(line => line.startsWith('| `c1`')) ?? ''
  expect(row).toBe(['| `c1` | failed | `see [proof](https:', '//evil.example) <a href="x">y</a> @someone \\| tail` |'].join(''))
})

test('the uploaded artifact is linked even when no criterion lists a file', () => {
  const url = ['https:', '//github.com/o/r/actions/runs/1/artifacts/2'].join('')
  const body = renderComment(result('refused', []), { kind: 'artifact', url })

  expect(body).toContain(`[evidence artifact](<${url}>)`)
})

// A screenshot pushed to the qa-assets branch links there, so it keeps
// resolving after the artifact expires (ADR-0002). Files that were not pushed
// have no entry, so they stay named but never linked (rule 4).
test('a pushed screenshot links to the branch; a file that was not pushed does not', () => {
  const url = ['https:', '//github.com/octocat/qare/actions/runs/1/artifacts/2'].join('')
  const screenshot = ['https:', '//github.com/octocat/qare/raw/qa-assets/runs/2026-09-25/abc/page.png'].join('')
  const body = renderComment(allProven, {
    kind: 'artifact',
    url,
    screenshots: { 'checks/payout-1099-notice/2/page.png': screenshot },
  })

  expect(body).toContain(`[page.png](<${screenshot}>)`)
  expect(body).toContain('`checks/payout-1099-notice/1/stdout.txt`, [page.png](')
  expect(body).not.toContain('`checks/payout-1099-notice/2/page.png`')
  expect(body.match(/\]\(/g)).toHaveLength(2)
})

test('a screenshot link text is escaped like the other link texts', () => {
  const screenshot = ['https:', '//github.com/octocat/qare/raw/qa-assets/runs/2026-09-25/x.png'].join('')
  const body = renderComment(
    result('failed', [failed('c1', ['checks/c1/0/pa[ge].png'])]),
    { kind: 'artifact', screenshots: { 'checks/c1/0/pa[ge].png': screenshot } },
  )

  expect(body).toContain(`[pa ge .png](<${screenshot}>)`)
})
