import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { ProfileValidationError, loadProfile, validateProfileConfig } from '../src/index.js'

const CLIENT = { driver: 'electron', executable: 'dist/app/app' }

function fieldOf(config: unknown): string {
  try {
    validateProfileConfig(config)
  } catch (error) {
    expect(error).toBeInstanceOf(ProfileValidationError)
    return (error as ProfileValidationError).field
  }
  throw new Error('expected the profile to be refused')
}

test('a client profile names the driver, the executable and its arguments, and nothing to boot (#72)', () => {
  const profile = validateProfileConfig({ client: { ...CLIENT, args: ['--no-sandbox'] } })
  expect(profile.client).toEqual({ driver: 'electron', executable: 'dist/app/app', args: ['--no-sandbox'] })
  expect(profile.app).toBeUndefined()
  expect(profile.target).toBeUndefined()
  expect(profile.stubs).toEqual([])
  expect(profile.visual).toEqual({ widths: [], themes: [] })
  expect(profile.suites).toEqual([])
  // Arguments are optional: a build that needs none says nothing.
  expect(validateProfileConfig({ client: CLIENT }).client?.args).toEqual([])
})

test('a client profile is the whole profile: QA.md and config.yml, no fixtures and no stubs (#72)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qare-client-profile-'))
  writeFileSync(join(dir, 'QA.md'), '# QA\n')
  writeFileSync(join(dir, 'config.yml'), 'client:\n  driver: electron\n  executable: dist/app/app\n')
  const profile = await loadProfile(dir)
  expect(profile.client?.executable).toBe('dist/app/app')
  rmSync(dir, { recursive: true })
})

test('a client section that is malformed is refused by field (#72)', () => {
  expect(fieldOf({ client: 'electron' })).toBe('client')
  expect(fieldOf({ client: { executable: 'a' } })).toBe('client.driver')
  expect(() => validateProfileConfig({ client: { ...CLIENT, driver: 'tauri' } })).toThrow(/client\.driver must be one of electron, not "tauri"/)
  expect(fieldOf({ client: { driver: 'electron' } })).toBe('client.executable')
  expect(fieldOf({ client: { ...CLIENT, executable: 'a\nb' } })).toBe('client.executable')
  // The build is the repository's own: a path that leaves it names some other binary.
  expect(() => validateProfileConfig({ client: { ...CLIENT, executable: '/usr/bin/env' } })).toThrow(/client\.executable.*must be a path inside the repository the run checks, not an absolute one/)
  expect(() => validateProfileConfig({ client: { ...CLIENT, executable: 'dist/../../other/app' } })).toThrow(/client\.executable.*climbs out of the repository/)
  expect(fieldOf({ client: { ...CLIENT, executable: 'C:\\apps\\app.exe' } })).toBe('client.executable')
  expect(fieldOf({ client: { ...CLIENT, args: '--no-sandbox' } })).toBe('client.args')
  expect(fieldOf({ client: { ...CLIENT, args: [1] } })).toBe('client.args[0]')
  expect(fieldOf({ client: { ...CLIENT, binary: 'a' } })).toBe('client.binary')
})

test('the arguments the driver owns are not the profile\'s to pass (#72)', () => {
  expect(() => validateProfileConfig({ client: { ...CLIENT, args: ['--remote-debugging-port=9222'] } })).toThrow(
    /client\.args\[0\].*--remote-debugging-port.*the electron driver sets it/,
  )
  expect(fieldOf({ client: { ...CLIENT, args: ['--no-sandbox', '--user-data-dir=/tmp/x'] } })).toBe('client.args[1]')
  expect(fieldOf({ client: { ...CLIENT, args: ['--remote-debugging-pipe'] } })).toBe('client.args[0]')
})

test('a client profile is one shape of three: it boots no app and names no target (#72)', () => {
  const target = { url: ['https:', '//example.test'].join(''), health: { http: '/', timeout: '5s' } }
  expect(() => validateProfileConfig({ client: CLIENT, target })).toThrow(/app \(a stack qare boots\), target \(an app already running\) or client \(a build qare launches\)/)
  expect(fieldOf({ client: CLIENT, app: {} })).toBe('client')
  expect(fieldOf({ client: CLIENT, stubs: [{ service: 'a', hosts: ['a.example'], provided_by: { compose_service: 'a' } }] })).toBe('stubs')
  expect(() => validateProfileConfig({ client: CLIENT, base: { budget: '1m' } })).toThrow(/one side/)
})

test('a client profile declares what its driver cannot do, when the profile loads (#72)', () => {
  // The electron driver has no visual capture and no accessibility audit.
  expect(() => validateProfileConfig({ client: CLIENT, visual: { widths: [1440], themes: ['light'] } })).toThrow(
    /visual.*the electron driver declares no visual check/,
  )
  expect(() => validateProfileConfig({ client: CLIENT, a11y: { standard: 'wcag21aa' } })).toThrow(/a11y.*the electron driver declares no a11y check/)
  // One driver drives a flow: an MCP driver mapping beside a client is two.
  const mcp = [{ name: 'rig', command: 'rig', tools: ['tap'], steps: ['execute'], driver: { click: { tool: 'tap', args: { target: 'element' } } } }]
  expect(() => validateProfileConfig({ client: CLIENT, mcp })).toThrow(/one driver/)
  // What is not a driver's business stays available.
  const kept = validateProfileConfig({ client: CLIENT, visual: { widths: [], themes: [] }, redact: { masks: ['css=.secret'] }, suites: [{ name: 'unit', command: 'npm test', kind: 'command' }] })
  expect(kept.redact?.masks).toEqual(['css=.secret'])
  expect(kept.suites).toHaveLength(1)
  // Who a finding on main reaches is the repository's to say, whatever the client (#154).
  expect(validateProfileConfig({ client: CLIENT, findings: { fallback: 'octocat' } }).findings).toEqual({ fallback: 'octocat' })
  expect(fieldOf({ client: CLIENT, findings: { fallback: 'not a login' } })).toBe('findings.fallback')
})
