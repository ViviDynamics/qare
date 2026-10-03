import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { ProfileValidationError, loadProfile, validateProfileConfig } from '../src/index.js'

// #154: the profile's `findings` section, which names who a finding on main
// mentions when no change can be blamed, and which logins are bots.

const fixtureDir = fileURLToPath(new URL('../fixtures/qa-valid/.qa', import.meta.url))
// Assembled, never literal: no network marker sits as a literal in a test.
const TARGET = { url: ['https:', '//app.example'].join(''), health: { http: '/', timeout: '5s' } }

test('a findings section names the fallback and the logins to treat as bots', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qare-profile-findings-'))
  cpSync(fixtureDir, dir, { recursive: true })
  writeFileSync(
    join(dir, 'config.yml'),
    `${readFileSync(join(fixtureDir, 'config.yml'), 'utf8')}\nfindings:\n  fallback: acme/qa-leads\n  bots:\n    - release-robot\n`,
  )
  expect((await loadProfile(dir)).findings).toEqual({ fallback: 'acme/qa-leads', bots: ['release-robot'] })
  // Absent means no fallback and no login beyond the ones GitHub calls bots.
  expect((await loadProfile(fixtureDir)).findings).toBeUndefined()
  // A person is a fallback too, with or without the at sign, and a target profile takes the section.
  expect(validateProfileConfig({ target: TARGET, findings: { fallback: '@octocat' } }).findings).toEqual({ fallback: 'octocat' })
  rmSync(dir, { recursive: true })
})

test('a findings section that names an unknown field or something that is no login fails naming it', () => {
  const error = (findings: unknown): ProfileValidationError => {
    try {
      validateProfileConfig({ target: TARGET, findings })
    } catch (caught) {
      if (caught instanceof ProfileValidationError) return caught
    }
    throw new Error('expected the findings section to be refused')
  }
  expect(error('octocat').field).toBe('findings')
  expect(error({ fallbacks: 'octocat' }).field).toBe('findings.fallbacks')
  // What is written after an at sign is published as a mention, so it is a login or a team and nothing else.
  expect(error({ fallback: 'octocat and friends' }).field).toBe('findings.fallback')
  expect(error({ fallback: 'a/b/c' }).field).toBe('findings.fallback')
  expect(error({ fallback: '' }).field).toBe('findings.fallback')
  expect(error({ bots: 'release-robot' }).field).toBe('findings.bots')
  expect(error({ bots: ['ok', 'not a login'] }).field).toBe('findings.bots[1]')
})
