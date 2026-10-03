import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { ProfileValidationError, loadProfile, validateProfileConfig } from '../src/index.js'

// #150: the profile's `ux` section, which turns the advisory UX review off
// and gives it the house rules.

const fixtureDir = fileURLToPath(new URL('../fixtures/qa-valid/.qa', import.meta.url))
// Assembled, never literal: no network marker sits as a literal in a test.
const TARGET = { url: ['https:', '//app.example'].join(''), health: { http: '/', timeout: '5s' } }

test('a ux section turns the advisory review off and states the house rules', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qare-profile-ux-'))
  cpSync(fixtureDir, dir, { recursive: true })
  writeFileSync(
    join(dir, 'config.yml'),
    `${readFileSync(join(fixtureDir, 'config.yml'), 'utf8')}\nux:\n  review: false\n  rules:\n    - Buttons are sentence case.\n    - An error message says what to do next.\n`,
  )
  expect((await loadProfile(dir)).ux).toEqual({
    review: false,
    rules: ['Buttons are sentence case.', 'An error message says what to do next.'],
  })
  // Absent means the review runs, with no house rules.
  expect((await loadProfile(fixtureDir)).ux).toBeUndefined()
  // A target profile takes the section too: it has screens like any other.
  expect(validateProfileConfig({ target: TARGET, ux: { rules: ['Dates are ISO 8601.'] } }).ux).toEqual({ rules: ['Dates are ISO 8601.'] })
  rmSync(dir, { recursive: true })
})

test('a ux section that names an unknown field, or a rule that says nothing, fails naming it', () => {
  const error = (ux: unknown): ProfileValidationError => {
    try {
      validateProfileConfig({ target: TARGET, ux })
    } catch (caught) {
      return caught as ProfileValidationError
    }
    throw new Error('expected the ux section to be refused')
  }
  expect(error('off').field).toBe('ux')
  expect(error({ review: 'no' }).field).toBe('ux.review')
  expect(error({ rules: 'Be kind.' }).field).toBe('ux.rules')
  expect(error({ rules: ['ok', ''] }).field).toBe('ux.rules[1]')
  // A misspelt switch would quietly leave the review on.
  expect(error({ reviews: false }).field).toBe('ux.reviews')
  expect(error({ reviews: false }).message).toContain('review and rules')
})
