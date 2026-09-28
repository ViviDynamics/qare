import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { ProfileValidationError, loadProfile, validateProfileConfig } from '../src/index.js'

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

test('a redact section loads its mask selectors (#119)', async () => {
  const dir = copiedProfile()
  writeFileSync(
    join(dir, 'config.yml'),
    `${fixtureConfig()}\nredact:\n  masks:\n    - css=.fixture-banner\n    - 'text="jane@pilot.example"'\n`,
  )

  const profile = await loadProfile(dir)

  expect(profile.redact?.masks).toEqual(['css=.fixture-banner', 'text="jane@pilot.example"'])
  rmSync(dir, { recursive: true })
})

test('a mask selector that does not parse fails the profile when it loads, naming redact (#119)', async () => {
  const dir = copiedProfile()
  writeFileSync(join(dir, 'config.yml'), `${fixtureConfig()}\nredact:\n  masks:\n    - foo=.fixture-banner\n`)

  const error = await profileError(() => loadProfile(dir))
  expect(error.field).toBe('redact')
  expect(error.message).toContain('foo=.fixture-banner')
  rmSync(dir, { recursive: true })
})

const LOGIN_TOTP_YAML = `login:
    fixture: fixtures/users.yml
    role: admin
    totp:
      secret: GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ`

const LOGIN_FULL_TOTP_YAML = `login:
    fixture: fixtures/users.yml
    role: admin
    totp:
      secret: GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
      digits: 8
      period: 60
      algorithm: SHA256`

const LOGIN_BAD_DIGITS_YAML = `login:
    fixture: fixtures/users.yml
    role: admin
    totp:
      secret: GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
      digits: 5`

const LOGIN_BACKUP_ONLY_YAML = `login:
    fixture: fixtures/users.yml
    role: admin
    backupCode:
      value: 4321-9876`

test('a login.totp section loads with sane defaults for digits, period and algorithm (#64)', async () => {
  const dir = copiedProfile()
  writeFileSync(join(dir, 'config.yml'), fixtureConfig().replace('login: { fixture: fixtures/users.yml, role: admin }', LOGIN_TOTP_YAML.trimEnd()))

  const profile = await loadProfile(dir)
  expect(profile.app?.login.totp).toEqual({
    secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
  })

  rmSync(dir, { recursive: true })
})

test('a login.totp section honors the digits, period and algorithm it declares (#64)', async () => {
  const dir = copiedProfile()
  writeFileSync(join(dir, 'config.yml'), fixtureConfig().replace('login: { fixture: fixtures/users.yml, role: admin }', LOGIN_FULL_TOTP_YAML.trimEnd()))

  const profile = await loadProfile(dir)
  expect(profile.app?.login.totp).toEqual({
    secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    digits: 8,
    period: 60,
    algorithm: 'SHA256',
  })

  rmSync(dir, { recursive: true })
})

test('a login.totp with a nonsensical digit count fails naming the field (#64)', async () => {
  const dir = copiedProfile()
  writeFileSync(join(dir, 'config.yml'), fixtureConfig().replace('login: { fixture: fixtures/users.yml, role: admin }', LOGIN_BAD_DIGITS_YAML.trimEnd()))

  const error = await profileError(() => loadProfile(dir))
  expect(error.field).toBe('app.login.totp.digits')

  rmSync(dir, { recursive: true })
})

test('a backup code without a totp section fails: it is an alternative, not a substitute (#64)', async () => {
  const dir = copiedProfile()
  writeFileSync(join(dir, 'config.yml'), fixtureConfig().replace('login: { fixture: fixtures/users.yml, role: admin }', LOGIN_BACKUP_ONLY_YAML.trimEnd()))

  const error = await profileError(() => loadProfile(dir))
  expect(error.field).toBe('app.login.backupCode')

  rmSync(dir, { recursive: true })
})

const MCP_HEALTH = { url: ['http:', '//staging.example.test'].join(''), health: { http: '/health', timeout: '1s' } }
const MCP_COMMAND_SERVER = { name: 'rig', command: 'node rig.mjs', tools: ['power_on'], steps: ['plan'] }

test('a profile registers a host MCP server to start or reach, with its allowlist and steps (#93)', async () => {
  const dir = copiedProfile()
  writeFileSync(
    join(dir, 'config.yml'),
    [
      fixtureConfig(),
      'mcp:',
      '  - name: rig',
      '    command: node rig.mjs --port 8080',
      '    tools: [power_on, read_led]',
      '    steps: [plan]',
    ].join('\n'),
  )
  const profile = await loadProfile(dir)
  expect(profile.mcp).toEqual([
    { name: 'rig', command: 'node rig.mjs --port 8080', tools: ['power_on', 'read_led'], steps: ['plan'] },
  ])

  writeFileSync(
    join(dir, 'config.yml'),
    [
      fixtureConfig(),
      'mcp:',
      '  - name: hosted',
      `    url: ${['http:', '//tools.hosted.internal/mcp'].join('')}`,
      '    tools: [ping]',
      '    steps: [plan, execute]',
    ].join('\n'),
  )
  const hosted = await loadProfile(dir)
  expect(hosted.mcp).toEqual([
    { name: 'hosted', url: ['http:', '//tools.hosted.internal/mcp'].join(''), tools: ['ping'], steps: ['plan', 'execute'] },
  ])

  rmSync(dir, { recursive: true })
})

test('a registered MCP server is refused when it says nothing about how to reach it, or both ways at once (#93)', async () => {
  expect(() => validateProfileConfig({ target: MCP_HEALTH, mcp: [{ name: 'rig', tools: ['x'], steps: ['plan'] }] })).toThrow(
    /must say how to start or reach it/,
  )
  expect(() =>
    validateProfileConfig({
      target: MCP_HEALTH,
      mcp: [{ name: 'rig', command: 'node rig.mjs', url: ['http:', '//x.internal'].join(''), tools: ['x'], steps: ['plan'] }],
    }),
  ).toThrow(/one of command/)
})

test('an MCP server with no tools, an unknown step or a duplicate name is refused (#93)', async () => {
  const base = { command: 'node rig.mjs' }
  expect(() => validateProfileConfig({ target: MCP_HEALTH, mcp: [{ name: 'rig', ...base, tools: [], steps: ['plan'] }] })).toThrow(
    /at least one tool/,
  )
  expect(() => validateProfileConfig({ target: MCP_HEALTH, mcp: [{ name: 'rig', ...base, tools: ['x'], steps: ['deploy'] }] })).toThrow(
    /unknown step "deploy"/,
  )
  expect(() => validateProfileConfig({ target: MCP_HEALTH, mcp: [{ name: 'rig', ...base, tools: ['x'], steps: [] }] })).toThrow(
    /must name the steps/,
  )
  expect(() =>
    validateProfileConfig({
      target: MCP_HEALTH,
      mcp: [
        { name: 'rig', ...base, tools: ['x'], steps: ['plan'] },
        { name: 'rig', url: ['http:', '//x.internal'].join(''), tools: ['x'], steps: ['plan'] },
      ],
    }),
  ).toThrow(/already registered/)
})

test('a server name that could not be addressed as server.tool is refused (#93)', async () => {
  const base = { command: 'node rig.mjs', tools: ['x'], steps: ['plan'] }
  expect(() => validateProfileConfig({ target: MCP_HEALTH, mcp: [{ name: 'a/b', ...base }] })).toThrow(/server name/)
  expect(() => validateProfileConfig({ target: MCP_HEALTH, mcp: [{ name: '..', ...base }] })).toThrow(/server name/)
})

test('two servers whose names and tools build the same channel name are refused (#93)', () => {
  expect(() =>
    validateProfileConfig({
      target: MCP_HEALTH,
      mcp: [
        { name: 'a', command: 'node a.mjs', tools: ['b.c'], steps: ['plan'] },
        { name: 'a.b', command: 'node ab.mjs', tools: ['c'], steps: ['plan'] },
      ],
    }),
  ).toThrow(/names "a\.b\.c" twice/)
  // Different tools on different servers build different names, and are fine.
  expect(() =>
    validateProfileConfig({
      target: MCP_HEALTH,
      mcp: [
        { name: 'a', command: 'node a.mjs', tools: ['c'], steps: ['plan'] },
        { name: 'a.b', command: 'node ab.mjs', tools: ['d'], steps: ['plan'] },
      ],
    }),
  ).not.toThrow()
})

test('a command that a shell would interpret is refused, like command checks are (#93)', async () => {
  expect(() =>
    validateProfileConfig({ target: MCP_HEALTH, mcp: [{ name: 'rig', command: 'node rig.mjs && rm -rf /', tools: ['x'], steps: ['plan'] }] }),
  ).toThrow(/shell would interpret/)
})

test('a server that needs a credential is refused in the step that runs pull request code, by name (#93)', () => {
  const run = () =>
    validateProfileConfig({
      target: MCP_HEALTH,
      mcp: [{ ...MCP_COMMAND_SERVER, steps: ['plan', 'execute'], credential: 'rig-token' }],
    })
  expect(run).toThrow(ProfileValidationError)
  expect(run).toThrow(/cannot run in the execute step/)
  expect(run).toThrow(/pull request code/)
  expect(run).toThrow(/rig-token/)
  // The same server in the plan step alone is fine: the planner holds no secret.
  expect(() => validateProfileConfig({ target: MCP_HEALTH, mcp: [{ ...MCP_COMMAND_SERVER, credential: 'rig-token' }] })).not.toThrow()
})
