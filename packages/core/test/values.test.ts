import { expect, test } from 'vitest'
import { mintRunValues, substituteValues, validateValueReferences } from '../src/values.js'
import { JobValidationError } from '../src/job.js'

test('minted values carry a run id, a timestamp and a mail address shaped from the id', () => {
  const values = mintRunValues()
  expect(values.id).toMatch(/^[0-9a-f-]{36}$/)
  expect(values.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  expect(values.mail_address).toBe(`qare-${values.id}@localhost`)
})

test('two runs never share a mail address, so concurrent runs cannot see each other\'s mail', () => {
  const first = mintRunValues()
  const second = mintRunValues()
  expect(first.mail_address).not.toBe(second.mail_address)
  expect(first.id).not.toBe(second.id)
})

test('substitution replaces every minted reference in one string and leaves plain text untouched', () => {
  const values = { id: 'r1', started_at: 't1', mail_address: 'qare-r1@localhost' }
  expect(
    substituteValues('{{run.id}} wrote to {{run.mail_address}} at {{run.started_at}}', values),
  ).toBe('r1 wrote to qare-r1@localhost at t1')
  expect(substituteValues('no references here', values)).toBe('no references here')
  expect(substituteValues('{{}}', values)).toBe('{{}}')
})

test('validation accepts every minted name', () => {
  const values = mintRunValues()
  expect(() => validateValueReferences('{{run.id}} {{run.started_at}} {{run.mail_address}}', values, 'x.run')).not.toThrow()
})

test('validation names the field and the unknown value', () => {
  const values = mintRunValues()
  const error = jobError(() => validateValueReferences('echo {{run.bogus}}', values, 'criteria[0].checks[0].run'))
  expect(error.field).toBe('criteria[0].checks[0].run')
  expect(error.message).toContain('{{run.bogus}}')
})

test('inherited Object.prototype names are unknown values, not minted ones', () => {
  const values = mintRunValues()
  expect(() => validateValueReferences('{{run.constructor}}', values, 'x.run')).toThrow(JobValidationError)
  expect(() => validateValueReferences('{{run.toString}}', values, 'x.run')).toThrow(JobValidationError)
  expect(substituteValues('{{run.constructor}}', values)).toBe('{{run.constructor}}')
  expect(substituteValues('{{id}}', values)).toBe('{{id}}')
})

test('an unterminated reference is refused, not passed through as prose', () => {
  const values = mintRunValues()
  expect(() => validateValueReferences('echo {{oops', values, 'x.run')).toThrow(JobValidationError)
  expect(() => validateValueReferences('echo {{run.id}} then {{oops', values, 'x.run')).toThrow(JobValidationError)
  expect(() => validateValueReferences('{{a{{run.id}}', values, 'x.run')).toThrow(JobValidationError)
})

function jobError(run: () => unknown): JobValidationError {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(JobValidationError)
    return error as JobValidationError
  }
  throw new Error('expected validation to throw JobValidationError')
}
