import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { ProfileValidationError, loadProfile } from '../src/index.js'

const fixtureDir = fileURLToPath(new URL('../fixtures/qa-valid/.qa', import.meta.url))
const HEALTH_URL = ['http:', '//localhost:3000/up'].join('')

const fixtureConfig = () => readFileSync(join(fixtureDir, 'config.yml'), 'utf8')

function copiedProfile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qare-profile-'))
  cpSync(fixtureDir, dir, { recursive: true })
  return dir
}

async function profileError(run: () => Promise<unknown>): Promise<ProfileValidationError> {
  try {
    await run()
  } catch (error) {
    expect(error).toBeInstanceOf(ProfileValidationError)
    return error as ProfileValidationError
  }
  throw new Error('expected the loader to throw ProfileValidationError')
}

test('the valid .qa/ fixture loads with the expected profile shape', async () => {
  const profile = await loadProfile(fixtureDir)

  expect(profile.app).toEqual({
    boot: { compose: 'compose.qa.yaml', service: 'admin' },
    health: { http: HEALTH_URL, timeout: '120s' },
    seed: { command: 'bin/rails db:seed:qa' },
    login: { fixture: 'fixtures/users.yml', role: 'admin' },
  })
  expect(profile.stubs).toEqual([
    { service: 'billing', hosts: ['api.billing-vendor.example'], provided_by: { compose_service: 'billing-stub' } },
    { service: 'mail', hosts: ['api.mailgun.net'], provided_by: { compose_service: 'mailpit' } },
  ])
  expect(profile.visual).toEqual({ widths: [1440, 390], themes: ['light', 'dark'] })
  expect(profile.suites).toEqual([
    { name: 'browser-e2e', command: 'npm --prefix e2e test', kind: 'flow' },
  ])
})

test('a profile without QA.md fails naming QA.md', async () => {
  const dir = copiedProfile()
  rmSync(join(dir, 'QA.md'))

  const error = await profileError(() => loadProfile(dir))
  // Absence is the more specific ProfileMissingError (#107), which is still a
  // ProfileValidationError so every existing handler catches it.
  expect(error).toBeInstanceOf(ProfileValidationError)
  expect(error.name).toBe('ProfileMissingError')
  expect(error.field).toBe('QA.md')
  expect(error.message).toContain('QA.md')

  rmSync(dir, { recursive: true })
})

test('a config.yml with non-numeric visual widths fails naming the field', async () => {
  const dir = copiedProfile()
  writeFileSync(
    join(dir, 'config.yml'),
    fixtureConfig().replace('widths: [1440, 390]', 'widths: [wide, narrow]'),
  )

  const error = await profileError(() => loadProfile(dir))
  expect(error.name).toBe('ProfileValidationError')
  expect(error.field).toBe('visual.widths[0]')
  expect(error.message).toContain('visual.widths[0]')
  expect(error.message).toContain('must be a number')

  rmSync(dir, { recursive: true })
})

test('a config.yml with an unknown suite kind fails naming the field', async () => {
  const dir = copiedProfile()
  writeFileSync(
    join(dir, 'config.yml'),
    fixtureConfig().replace('kind: flow', 'kind: screenshot'),
  )

  const error = await profileError(() => loadProfile(dir))
  expect(error.name).toBe('ProfileValidationError')
  expect(error.field).toBe('suites[0].kind')
  expect(error.message).toContain('unknown suite kind "screenshot"')

  rmSync(dir, { recursive: true })
})

test('a redact section loads its values and patterns', async () => {
  const dir = copiedProfile()
  writeFileSync(
    join(dir, 'config.yml'),
    `${fixtureConfig()}\nredact:\n  values: [jane@pilot.example]\n  patterns: ['CUST-\\d{6}']\n`,
  )

  const profile = await loadProfile(dir)

  expect(profile.redact).toEqual({ values: ['jane@pilot.example'], patterns: ['CUST-\\d{6}'] })
  rmSync(dir, { recursive: true })
})

test('a profile with no redact section has none', async () => {
  expect((await loadProfile(fixtureDir)).redact).toBeUndefined()
})

test('a redact pattern that does not compile fails the profile, naming redact', async () => {
  const dir = copiedProfile()
  writeFileSync(join(dir, 'config.yml'), `${fixtureConfig()}\nredact:\n  patterns: ['(unclosed']\n`)

  const error = await profileError(() => loadProfile(dir))
  expect(error.field).toBe('redact')
  expect(error.message).toContain('(unclosed')
  rmSync(dir, { recursive: true })
})

test('a redact section that is not a mapping fails naming it', async () => {
  const dir = copiedProfile()
  writeFileSync(join(dir, 'config.yml'), `${fixtureConfig()}\nredact: [a]\n`)

  expect((await profileError(() => loadProfile(dir))).field).toBe('redact')
  rmSync(dir, { recursive: true })
})
