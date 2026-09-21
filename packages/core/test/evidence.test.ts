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
