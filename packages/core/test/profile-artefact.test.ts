import { expect, test } from 'vitest'
import { ProfileValidationError, validateProfileConfig } from '../src/index.js'

const ARTEFACT = {
  kind: 'archive',
  executable: 'greeter/greeter',
  head: { path: 'artefacts/head.tar.gz' },
}

function client(artefact: unknown, extra: Record<string, unknown> = {}): unknown {
  return { client: { driver: 'electron', artefact, ...extra } }
}

function fieldOf(config: unknown): string {
  try {
    validateProfileConfig(config)
  } catch (error) {
    expect(error).toBeInstanceOf(ProfileValidationError)
    return (error as ProfileValidationError).field
  }
  throw new Error('expected the profile to be refused')
}

test('a client profile names an artefact to provision: its kind, the executable inside it, and the build of each side (#75)', () => {
  const profile = validateProfileConfig(
    client({ ...ARTEFACT, base: { path: 'artefacts/base.tar.gz' }, timeout: '5m' }, { args: ['--no-sandbox'], health: { timeout: '20s' } }),
  )
  expect(profile.client).toEqual({
    driver: 'electron',
    args: ['--no-sandbox'],
    artefact: {
      kind: 'archive',
      executable: 'greeter/greeter',
      head: { path: 'artefacts/head.tar.gz' },
      base: { path: 'artefacts/base.tar.gz' },
      timeout: '5m',
    },
    health: { timeout: '20s' },
  })
  // Nothing boots and nothing is stubbed, as for any client profile.
  expect(profile.app).toBeUndefined()
  expect(profile.stubs).toEqual([])
})

test('the head artefact is the only side a profile must name; a build command is optional on either (#75)', () => {
  const one = validateProfileConfig(client(ARTEFACT))
  expect(one.client?.artefact?.base).toBeUndefined()
  expect(one.client?.health).toBeUndefined()
  const built = validateProfileConfig(client({ ...ARTEFACT, kind: 'directory', head: { path: 'dist/unpacked', build: 'node scripts/package.mjs --out dist/unpacked' } }))
  expect(built.client?.artefact?.head).toEqual({ path: 'dist/unpacked', build: 'node scripts/package.mjs --out dist/unpacked' })
  expect(built.client?.artefact?.kind).toBe('directory')
})

test('a profile names the build one way: an executable already in the checkout, or an artefact to install (#75)', () => {
  expect(() => validateProfileConfig(client(ARTEFACT, { executable: 'dist/app/app' }))).toThrow(
    /client names the build one way: executable \(a build already in the checkout, launched in place\) or artefact \(a build the run installs\), not both/,
  )
  expect(() => validateProfileConfig({ client: { driver: 'electron' } })).toThrow(/client\.executable/)
  // The #72 shape is unchanged.
  expect(validateProfileConfig({ client: { driver: 'electron', executable: 'dist/app/app' } }).client).toEqual({ driver: 'electron', executable: 'dist/app/app', args: [] })
})

test('a malformed artefact is refused by field (#75)', () => {
  expect(fieldOf(client('artefacts/head.tar.gz'))).toBe('client.artefact')
  expect(fieldOf(client({ ...ARTEFACT, kind: undefined }))).toBe('client.artefact.kind')
  expect(fieldOf(client({ ...ARTEFACT, executable: undefined }))).toBe('client.artefact.executable')
  expect(fieldOf(client({ ...ARTEFACT, head: undefined }))).toBe('client.artefact.head')
  expect(fieldOf(client({ ...ARTEFACT, head: 'artefacts/head.tar.gz' }))).toBe('client.artefact.head')
  expect(fieldOf(client({ ...ARTEFACT, head: {} }))).toBe('client.artefact.head.path')
  expect(fieldOf(client({ ...ARTEFACT, base: { build: 'make base' } }))).toBe('client.artefact.base.path')
  expect(fieldOf(client({ ...ARTEFACT, timeout: 'soon' }))).toBe('client.artefact.timeout')
  // A field nobody knows is a misspelling, and a misspelt side would quietly drop the comparison.
  expect(() => validateProfileConfig(client({ ...ARTEFACT, bsae: { path: 'a' } }))).toThrow(/client\.artefact takes kind, executable, head, base and timeout, not "bsae"/)
  expect(() => validateProfileConfig(client({ ...ARTEFACT, head: { path: 'a', url: 'https://example.com/a' } }))).toThrow(/client\.artefact\.head takes path and build, not "url"/)
  expect(fieldOf(client(ARTEFACT, { health: '20s' }))).toBe('client.health')
  expect(fieldOf(client(ARTEFACT, { health: { timeout: 'soon' } }))).toBe('client.health.timeout')
  expect(() => validateProfileConfig(client(ARTEFACT, { health: { http: '/' } }))).toThrow(/client\.health takes timeout, not "http"/)
})

test('an artefact kind is one the driver installs, and the refusal names the driver and the kinds (#75)', () => {
  expect(() => validateProfileConfig(client({ ...ARTEFACT, kind: 'apk' }))).toThrow(
    /client\.artefact\.kind: the electron driver installs an archive or a directory, not "apk"/,
  )
})

test('an artefact and the executable inside it stay where the run can vouch for them (#75)', () => {
  // The artefact is in the repository the run checks, like the #72 executable.
  expect(() => validateProfileConfig(client({ ...ARTEFACT, head: { path: '/tmp/head.tar.gz' } }))).toThrow(
    /client\.artefact\.head\.path.*must be a path inside the repository the run checks, not an absolute one/,
  )
  expect(() => validateProfileConfig(client({ ...ARTEFACT, base: { path: '../elsewhere/base.tar.gz' } }))).toThrow(/client\.artefact\.base\.path.*climbs out of the repository/)
  expect(fieldOf(client({ ...ARTEFACT, head: { path: 'a\nb' } }))).toBe('client.artefact.head.path')
  // The executable is inside the artefact: a path that leaves it is some other binary.
  expect(() => validateProfileConfig(client({ ...ARTEFACT, executable: '/usr/bin/env' }))).toThrow(/client\.artefact\.executable.*must be a path inside the installed artefact, not an absolute one/)
  expect(() => validateProfileConfig(client({ ...ARTEFACT, executable: '../env' }))).toThrow(/client\.artefact\.executable.*climbs out of the installed artefact/)
})

test('a build command is spawned with no shell, so it is held to what a declared command is (#75)', () => {
  expect(() => validateProfileConfig(client({ ...ARTEFACT, head: { path: 'a.tar.gz', build: 'make build && cp out a.tar.gz' } }))).toThrow(
    /client\.artefact\.head\.build.*carries "&", which a shell would interpret: the command is split on whitespace and spawned with no shell/,
  )
  expect(fieldOf(client({ ...ARTEFACT, head: { path: 'a.tar.gz', build: '' } }))).toBe('client.artefact.head.build')
})

test('a client profile bounds its base side once it names a base artefact, and never by a ledger it has no tree for (#75)', () => {
  const two = { ...ARTEFACT, base: { path: 'artefacts/base.tar.gz' } }
  expect(validateProfileConfig({ ...(client(two) as object), base: { criteria: 'none', budget: '5m' } }).base).toEqual({ criteria: 'none', budget: '5m' })
  expect(() => validateProfileConfig({ ...(client(two) as object), base: { criteria: 'ledger' } })).toThrow(
    /base\.criteria: a client profile's base side is installed from an artefact, with no base checkout to read a ledger from; use "all" or "none"/,
  )
  // With no base artefact there is one side, as in #72.
  expect(() => validateProfileConfig({ ...(client(ARTEFACT) as object), base: { budget: '5m' } })).toThrow(
    /base: a client profile that names no base artefact has one side only, so it has no base side to bound; name a build of the base in client\.artefact\.base, or remove the base section/,
  )
  expect(() => validateProfileConfig({ client: { driver: 'electron', executable: 'dist/app/app' }, base: { budget: '5m' } })).toThrow(/base: a client profile that names no base artefact has one side only/)
})
