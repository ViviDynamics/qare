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

  expect(
    resultError(() =>
      parseResult({ schemaVersion: '1', verdict: 'passed', criteria: [] }),
    ).field,
  ).toBe('criteria')

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
