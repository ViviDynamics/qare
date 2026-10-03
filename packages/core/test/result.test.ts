import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { RESULT_SCHEMA_VERSION, ResultValidationError, loadResult, parseResult } from '../src/result.js'

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8')

function resultError(run: () => unknown): ResultValidationError {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(ResultValidationError)
    return error as ResultValidationError
  }
  throw new Error('expected the loader to throw ResultValidationError')
}

test('result.valid.json loads to the exact expected object', () => {
  const result = loadResult(fixture('result.valid.json'))
  expect(result).toEqual({
    schemaVersion: RESULT_SCHEMA_VERSION,
    verdict: 'failed',
    criteria: [
      {
        id: 'payout-1099-notice',
        outcome: 'proven',
        evidence: [
          'evidence/payout-1099-notice/payout-tax-spec.log',
          'evidence/payout-1099-notice/payouts-page-1440-light.png',
        ],
      },
      {
        id: 'ledger-export-csv',
        outcome: 'failed',
        evidence: ['evidence/ledger-export-csv/ledger-export-actions.log'],
      },
      {
        id: 'multi-currency-totals',
        outcome: 'unverified',
        reason: 'the staging environment with multi-currency data was unreachable from the sandbox',
        evidence: ['evidence/multi-currency-totals/attempt.log'],
      },
    ],
  })
})

test('result.blocked.json loads with verdict blocked', () => {
  const result = loadResult(fixture('result.blocked.json'))
  expect(result.verdict).toBe('blocked')
  expect(result.schemaVersion).toBe(RESULT_SCHEMA_VERSION)
  expect(result.criteria).toHaveLength(2)
  expect(result.criteria[0]).toEqual({
    id: 'payout-1099-notice',
    outcome: 'unverified',
    reason: 'the app never became healthy under the pinned compose profile, so no check ran',
    evidence: ['evidence/boot/compose.log'],
  })
})

test('an unknown schemaVersion fails closed', () => {
  const error = resultError(() =>
    parseResult({
      schemaVersion: '9',
      verdict: 'passed',
      criteria: [{ id: 'c1', outcome: 'proven', evidence: ['evidence/c1/a.log'] }],
    }),
  )
  expect(error.name).toBe('ResultValidationError')
  expect(error.field).toBe('schemaVersion')
  expect(error.message).toContain('unknown schemaVersion "9"')
})

test('schema violations fail closed with named errors', () => {
  expect(
    resultError(() =>
      parseResult({
        schemaVersion: '1',
        verdict: 'no-such-verdict',
        criteria: [{ id: 'c1', outcome: 'proven', evidence: ['evidence/c1/a.log'] }],
      }),
    ).field,
  ).toBe('verdict')

  const error = resultError(() =>
    parseResult({
      schemaVersion: '1',
      verdict: 'passed',
      criteria: [{ id: 'c1', outcome: 'proven' }],
    }),
  )
  expect(error.field).toBe('criteria[0].evidence')
  expect(error.message).toContain('criterion "c1" is proven without evidence references')

  expect(
    resultError(() =>
      parseResult({
        schemaVersion: '1',
        verdict: 'failed',
        criteria: [{ id: 'c1', outcome: 'unverified' }],
      }),
    ).field,
  ).toBe('criteria[0].reason')

  expect(
    resultError(() =>
      parseResult({
        schemaVersion: '1',
        verdict: 'failed',
        criteria: [{ id: 'c1', outcome: 'failed', evidence: ['/etc/passwd'] }],
      }),
    ).field,
  ).toBe('criteria[0].evidence[0]')
})

test('a refused run with zero criterion outcomes loads', () => {
  const result = parseResult({ schemaVersion: '1', verdict: 'refused', criteria: [] })
  expect(result.verdict).toBe('refused')
  expect(result.criteria).toEqual([])
})

test('non-JSON text fails closed with a named error', () => {
  const error = resultError(() => loadResult('{not json'))
  expect(error.name).toBe('ResultValidationError')
  expect(error.field).toBe('json')
  expect(error.message).toContain('result.json is not valid JSON')
})

test('a missing schemaVersion fails closed', () => {
  const error = resultError(() =>
    parseResult({
      verdict: 'passed',
      criteria: [{ id: 'c1', outcome: 'proven', evidence: ['evidence/c1/a.log'] }],
    }),
  )
  expect(error.field).toBe('schemaVersion')
  expect(error.message).toContain('must carry a schemaVersion string')
})

test('a proven criterion with zero evidence references fails closed', () => {
  const error = resultError(() =>
    parseResult({
      schemaVersion: '1',
      verdict: 'passed',
      criteria: [{ id: 'c1', outcome: 'proven', evidence: [] }],
    }),
  )
  expect(error.field).toBe('criteria[0].evidence')
  expect(error.message).toContain('criterion "c1" is proven with zero evidence references')
})

test('an unverified criterion without evidence loads', () => {
  const result = parseResult({
    schemaVersion: '1',
    verdict: 'failed',
    criteria: [{ id: 'c1', outcome: 'unverified', reason: 'the check never ran' }],
  })
  expect(result.criteria).toEqual([
    { id: 'c1', outcome: 'unverified', reason: 'the check never ran' },
  ])
})

test('UNC-style evidence references fail closed', () => {
  expect(
    resultError(() =>
      parseResult({
        schemaVersion: '1',
        verdict: 'failed',
        criteria: [{ id: 'c1', outcome: 'failed', evidence: ['\\\\host\\share\\a.log'] }],
      }),
    ).field,
  ).toBe('criteria[0].evidence[0]')

  expect(
    resultError(() =>
      parseResult({
        schemaVersion: '1',
        verdict: 'failed',
        criteria: [{ id: 'c1', outcome: 'failed', evidence: ['//host/share/a.log'] }],
      }),
    ).field,
  ).toBe('criteria[0].evidence[0]')
})

test('a failed criterion may say why, and the reason survives loading', () => {
  const result = parseResult({
    schemaVersion: RESULT_SCHEMA_VERSION,
    verdict: 'failed',
    criteria: [{ id: 'c1', outcome: 'failed', evidence: ['c1/out.txt'], reason: 'verifier: the evidence shows 0 rows' }],
  })
  expect(result.criteria).toEqual([
    { id: 'c1', outcome: 'failed', evidence: ['c1/out.txt'], reason: 'verifier: the evidence shows 0 rows' },
  ])
})

test('an empty reason on a failed criterion fails closed', () => {
  const error = resultError(() =>
    parseResult({
      schemaVersion: RESULT_SCHEMA_VERSION,
      verdict: 'failed',
      criteria: [{ id: 'c1', outcome: 'failed', evidence: ['c1/out.txt'], reason: ' ' }],
    }),
  )
  expect(error.field).toBe('criteria[0].reason')
})

test('the environment record round trips, and a result without one still loads', () => {
  const environment = { execution: 'native' as const, versions: { qare: '2026.9.0', node: '24.5.0', nareContract: 1 } }
  const parsed = parseResult({
    schemaVersion: RESULT_SCHEMA_VERSION,
    verdict: 'passed',
    criteria: [{ id: 'c1', outcome: 'proven', evidence: ['c1/out.txt'] }],
    environment,
  })
  expect(parsed.environment).toEqual(environment)
  expect(
    parseResult({
      schemaVersion: RESULT_SCHEMA_VERSION,
      verdict: 'passed',
      criteria: [{ id: 'c1', outcome: 'proven', evidence: ['c1/out.txt'] }],
    }).environment,
  ).toBeUndefined()
})

test('an environment record naming an unknown execution fails closed', () => {
  const error = resultError(() =>
    parseResult({
      schemaVersion: RESULT_SCHEMA_VERSION,
      verdict: 'passed',
      criteria: [{ id: 'c1', outcome: 'proven', evidence: ['c1/out.txt'] }],
      environment: { execution: 'simulated', versions: { qare: '2026.9.0', node: '24.5.0', nareContract: 1 } },
    }),
  )
  expect(error.field).toBe('environment.execution')
})

test('a several-app result carries the profile reference each app was checked with', () => {
  const result = parseResult({
    schemaVersion: '1',
    verdict: 'blocked',
    criteria: [{ id: 'c1', outcome: 'unverified', reason: 'the check never ran' }],
    profiles: [
      { name: 'admin', verdict: 'refused', criteria: ['c1'], profile: { path: '.qa/admin' } },
      { name: 'storefront', verdict: 'refused', criteria: [], profile: { inline: { target: { url: 'x' } } } },
    ],
  })
  expect(result.profiles).toEqual([
    { name: 'admin', verdict: 'refused', criteria: ['c1'], profile: { path: '.qa/admin' } },
    { name: 'storefront', verdict: 'refused', criteria: [], profile: { inline: { target: { url: 'x' } } } },
  ])
})

test('a profile reference that is neither a path nor an inline profile fails closed', () => {
  expect(() =>
    parseResult({
      schemaVersion: '1',
      verdict: 'blocked',
      criteria: [{ id: 'c1', outcome: 'unverified', reason: 'r' }],
      profiles: [{ name: 'admin', verdict: 'refused', criteria: ['c1'], profile: 5 }],
    }),
  ).toThrow(/profile entry must be a JSON object|profile must be a YAML object/)
})

test('a result entry whose profile name would escape the .qa root fails closed', () => {
  expect(() =>
    parseResult({
      schemaVersion: '1',
      verdict: 'blocked',
      criteria: [{ id: 'c1', outcome: 'unverified', reason: 'r' }],
      profiles: [{ name: '../../outside', verdict: 'refused', criteria: ['c1'] }],
    }),
  ).toThrow(/must not contain path separators/)
})

test('a criterion result may carry the repairs the run recorded (#83)', () => {
  const loaded = loadResult(
    JSON.stringify({
      schemaVersion: RESULT_SCHEMA_VERSION,
      verdict: 'passed',
      criteria: [
        {
          id: 'flow-83',
          outcome: 'proven',
          evidence: ['checks/flow-83/0/actions.log', 'checks/flow-83/0/repairs.json'],
          repairs: [
            {
              check: 'sign-in flow',
              action: 1,
              reference: 'role=button name=Save at=document/main/form "Log in"/button "Save"',
              repaired: 'role=button name=Save at=document/main/form "Sign in"/button "Save"',
              identity: 'same role, same accessible name, same landmark ancestry (main/form)',
              status: 'applied',
            },
            {
              check: 'sign-in flow',
              action: 2,
              reference: 'role=button name=Send at=document/main/form "Log in"/button "Send"',
              identity: 'same role, same accessible name, same landmark ancestry (main/form)',
              status: 'refused',
              refusedReason: 'a different element sits there',
            },
          ],
        },
      ],
    }),
  )
  expect(loaded.verdict).toBe('passed')
  expect(loaded.criteria[0]?.repairs).toEqual([
    {
      check: 'sign-in flow',
      action: 1,
      reference: 'role=button name=Save at=document/main/form "Log in"/button "Save"',
      repaired: 'role=button name=Save at=document/main/form "Sign in"/button "Save"',
      identity: 'same role, same accessible name, same landmark ancestry (main/form)',
      status: 'applied',
    },
    {
      check: 'sign-in flow',
      action: 2,
      reference: 'role=button name=Send at=document/main/form "Log in"/button "Send"',
      identity: 'same role, same accessible name, same landmark ancestry (main/form)',
      status: 'refused',
      refusedReason: 'a different element sits there',
    },
  ])
})

test('a repair record without the fields the comment renders fails closed (#83)', () => {
  const base = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    verdict: 'passed',
    criteria: [
      {
        id: 'flow-83',
        outcome: 'proven',
        evidence: ['checks/flow-83/0/actions.log'],
        repairs: [{ check: 'sign-in flow', action: 1, reference: 'r', identity: 'i', status: 'applied' }],
      },
    ],
  }
  expect(() => loadResult(JSON.stringify(base))).toThrow(ResultValidationError)
  const refusedWithoutReason = structuredClone(base)
  refusedWithoutReason.criteria[0].repairs[0].status = 'refused'
  expect(() => loadResult(JSON.stringify(refusedWithoutReason))).toThrow(ResultValidationError)
})

test('a run carries its wall clock as a pair of ISO timestamps, both or neither (#51)', () => {
  const base = { schemaVersion: RESULT_SCHEMA_VERSION, verdict: 'passed', criteria: [] }
  const timed = parseResult({
    ...base,
    startedAt: '2026-09-29T10:00:00.000Z',
    finishedAt: '2026-09-29T10:01:00.000Z',
  })
  expect(timed.startedAt).toBe('2026-09-29T10:00:00.000Z')
  expect(timed.finishedAt).toBe('2026-09-29T10:01:00.000Z')
  // One without the other cannot say how long the run took, so it is refused.
  expect(() => parseResult({ ...base, startedAt: '2026-09-29T10:00:00.000Z' })).toThrow(ResultValidationError)
  expect(() => parseResult({ ...base, finishedAt: '2026-09-29T10:01:00.000Z' })).toThrow(ResultValidationError)
  // A timestamp that is not ISO 8601 is refused: the metrics record joins
  // timestamps it must be able to compare.
  expect(() => parseResult({ ...base, startedAt: 'yesterday', finishedAt: '2026-09-29T10:01:00.000Z' })).toThrow(ResultValidationError)
  // A result written before the field existed still loads.
  expect(parseResult(base).startedAt).toBeUndefined()
})

test('a run carries the verifier model spend the judge stamps on it (#51)', () => {
  const base = { schemaVersion: RESULT_SCHEMA_VERSION, verdict: 'passed', criteria: [] }
  expect(parseResult({ ...base, judgeUsage: { inputTokens: 12, outputTokens: 3 } }).judgeUsage).toEqual({ inputTokens: 12, outputTokens: 3 })
  expect(parseResult(base).judgeUsage).toBeUndefined()
  expect(() => parseResult({ ...base, judgeUsage: { inputTokens: 'many' } })).toThrow(ResultValidationError)
  // A token count is a count: negative and non-finite numbers are refused,
  // the schema says at least 0 (#51).
  expect(() => parseResult({ ...base, judgeUsage: { inputTokens: -12, outputTokens: 3 } })).toThrow(/at least 0/)
  expect(() => parseResult({ ...base, judgeUsage: { inputTokens: Number.NaN, outputTokens: 3 } })).toThrow(/at least 0/)
})

test('a two-sided run carries what the base showed, per run and per criterion (#147)', () => {
  const result = parseResult({
    schemaVersion: RESULT_SCHEMA_VERSION,
    verdict: 'failed',
    base: { ref: 'origin/main', status: 'executed' },
    criteria: [
      { id: 'old', outcome: 'failed', evidence: ['head/checks/old/0/stdout.txt'], regression: true, base: { outcome: 'proven', evidence: ['base/checks/old/0/stdout.txt'] } },
      { id: 'new', outcome: 'failed', evidence: ['head/checks/new/0/stdout.txt'], regression: false, base: { outcome: 'failed', evidence: ['base/checks/new/0/stdout.txt'] } },
      { id: 'kept', outcome: 'proven', evidence: ['head/checks/kept/0/stdout.txt'], base: { outcome: 'not-compared', reason: 'not run at the base: the budget was spent' } },
    ],
  })
  expect(result.base).toEqual({ ref: 'origin/main', status: 'executed' })
  expect(result.criteria[0]).toMatchObject({ regression: true, base: { outcome: 'proven', evidence: ['base/checks/old/0/stdout.txt'] } })
  expect(result.criteria[1]).toMatchObject({ regression: false, base: { outcome: 'failed' } })
  expect(result.criteria[2]).toMatchObject({ base: { outcome: 'not-compared', reason: 'not run at the base: the budget was spent' } })
  expect('regression' in (result.criteria[2] as object)).toBe(false)
})

test('a base side that did not execute names why, and a result without one still loads (#147)', () => {
  const plain = { schemaVersion: RESULT_SCHEMA_VERSION, verdict: 'passed', criteria: [] }
  expect(parseResult(plain).base).toBeUndefined()
  expect(parseResult({ ...plain, base: { ref: 'main', status: 'not-executed', reason: 'the base did not boot' } }).base).toEqual({
    ref: 'main',
    status: 'not-executed',
    reason: 'the base did not boot',
  })
  expect(resultError(() => parseResult({ ...plain, base: { ref: 'main', status: 'not-executed' } })).field).toBe('base.reason')
  expect(resultError(() => parseResult({ ...plain, base: { ref: 'main', status: 'skipped' } })).field).toBe('base.status')
  expect(resultError(() => parseResult({ ...plain, base: { status: 'executed' } })).field).toBe('base.ref')
})

test('a regression is only ever claimed over a base that proved the criterion (#147)', () => {
  const withCriterion = (criterion: unknown) => ({ schemaVersion: RESULT_SCHEMA_VERSION, verdict: 'failed', criteria: [criterion] })
  // No base record at all: nothing ran at the base, so nothing regressed.
  expect(resultError(() => parseResult(withCriterion({ id: 'c', outcome: 'failed', evidence: ['a.txt'], regression: true }))).field).toBe('criteria[0].regression')
  // The base failed too: that is behaviour that does not work yet.
  expect(
    resultError(() => parseResult(withCriterion({ id: 'c', outcome: 'failed', evidence: ['a.txt'], regression: true, base: { outcome: 'failed' } }))).field,
  ).toBe('criteria[0].regression')
  // A head that proved the criterion did not regress it.
  expect(
    resultError(() => parseResult(withCriterion({ id: 'c', outcome: 'proven', evidence: ['a.txt'], regression: true, base: { outcome: 'proven' } }))).field,
  ).toBe('criteria[0].regression')
  // Not compared says why, and base evidence stays inside the evidence directory.
  expect(resultError(() => parseResult(withCriterion({ id: 'c', outcome: 'proven', evidence: ['a.txt'], base: { outcome: 'not-compared' } }))).field).toBe(
    'criteria[0].base.reason',
  )
  expect(
    resultError(() => parseResult(withCriterion({ id: 'c', outcome: 'proven', evidence: ['a.txt'], base: { outcome: 'proven', evidence: ['../x'] } }))).field,
  ).toBe('criteria[0].base.evidence[0]')
  expect(resultError(() => parseResult(withCriterion({ id: 'c', outcome: 'proven', evidence: ['a.txt'], base: { outcome: 'unverified' } }))).field).toBe(
    'criteria[0].base.outcome',
  )
  // A waived criterion keeps the executed fact: it regressed, and the waiver does not cover that.
  expect(
    parseResult(withCriterion({ id: 'c', outcome: 'unverified', reason: 'waived by human', regression: true, base: { outcome: 'proven' } })).criteria[0],
  ).toMatchObject({ regression: true })
})

test('a criterion result may carry what its accessibility audits counted (#149)', () => {
  const withCriterion = (criterion: unknown) => ({ schemaVersion: RESULT_SCHEMA_VERSION, verdict: 'passed', criteria: [criterion] })
  const counts = { new: 0, existing: 2, accepted: 1, reported: 3, uncompared: 0 }
  expect(parseResult(withCriterion({ id: 'c', outcome: 'proven', evidence: ['a11y.json'], a11y: counts })).criteria[0]?.a11y).toEqual(counts)
  // Absent on a criterion nothing audited.
  expect('a11y' in parseResult(withCriterion({ id: 'c', outcome: 'proven', evidence: ['a.txt'] })).criteria[0]!).toBe(false)
  // A count is a count.
  expect(resultError(() => parseResult(withCriterion({ id: 'c', outcome: 'proven', evidence: ['a.txt'], a11y: 'two' }))).field).toBe('criteria[0].a11y')
  expect(resultError(() => parseResult(withCriterion({ id: 'c', outcome: 'proven', evidence: ['a.txt'], a11y: { ...counts, existing: -1 } }))).field).toBe('criteria[0].a11y.existing')
  expect(resultError(() => parseResult(withCriterion({ id: 'c', outcome: 'proven', evidence: ['a.txt'], a11y: { new: 1 } }))).field).toBe('criteria[0].a11y.existing')
})

test('a criterion result may carry the messages its mail checks read (#65)', () => {
  const withCriterion = (criterion: unknown) => ({ schemaVersion: RESULT_SCHEMA_VERSION, verdict: 'passed', criteria: [criterion] })
  const mail = [{ check: 'confirmation', from: 'App <no-reply@app.test>', subject: 'Confirm', excerpt: 'Hello.', links: ['/confirm'] }]
  expect(parseResult(withCriterion({ id: 'c', outcome: 'proven', evidence: ['message.json'], mail })).criteria[0]?.mail).toEqual(mail)
  // Absent on a criterion that read no mail.
  expect('mail' in parseResult(withCriterion({ id: 'c', outcome: 'proven', evidence: ['a.txt'] })).criteria[0]!).toBe(false)
  const field = (broken: unknown) => resultError(() => parseResult(withCriterion({ id: 'c', outcome: 'proven', evidence: ['a.txt'], mail: broken }))).field
  expect(field('a message')).toBe('criteria[0].mail')
  expect(field([{ ...mail[0], subject: 7 }])).toBe('criteria[0].mail[0].subject')
  expect(field([{ ...mail[0], links: ['ok', 3] }])).toBe('criteria[0].mail[0].links')
  expect(field([{ check: 'confirmation' }])).toBe('criteria[0].mail[0].from')
})
