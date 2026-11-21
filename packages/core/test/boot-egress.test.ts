import { existsSync, readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { bootApp, loadProfile, readStackEgress, reapProjects, stopApp, type QaProfile, type RunIsolation } from '../src/index.js'
import { commandBootFile } from '../src/boot.js'
import { containmentOverrideFile, dnsOverrideFile, EGRESS_DNS_SERVICE, EGRESS_RELAY_SERVICE, NO_EGRESS_IMAGE } from '../src/stack-egress.js'

// #382: a booted stack runs on internal networks, with the run's resolver
// and relay beside it, so its only external routes are the declared stubs.

const fixtureDir = new URL('../fixtures/qa-valid/.qa', import.meta.url)
const IMAGE = 'ghcr.io/vividynamics/qare-core:2026.11.21'

function isolation(): RunIsolation {
  const runId = `egress-${Math.random().toString(36).slice(2)}`
  return { runId, project: `qare-${runId}`, startedAt: new Date().toISOString(), port: 41237 }
}

async function profile(): Promise<QaProfile> {
  const loaded = await loadProfile(fixtureDir.pathname)
  if (loaded.app === undefined) throw new Error('the fixture boots an app')
  return {
    ...loaded,
    stubs: [{ service: 'billing', hosts: ['api.billing-vendor.example'], provided_by: { compose_service: 'billing-stub' } }],
    app: { ...loaded.app, health: { ...loaded.app.health, timeout: '1s' } },
  }
}

const CONFIG = JSON.stringify({
  networks: { default: { name: 'x_default' } },
  services: {
    admin: { networks: { default: null }, ports: [{ target: 3000, published: '41237', host_ip: '127.0.0.1', protocol: 'tcp' }] },
    'billing-stub': { networks: { default: null } },
  },
})
const READY = '{"event":"ready","address":"192.0.2.2","port":53}\n'

interface Call {
  args: string[]
  files: Record<string, string>
}

function recorder(answers: { config?: string; logs?: string[]; upSink?: number } = {}): { calls: Call[]; runCompose: (args: string[], timeoutMs: number, env?: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }> } {
  const calls: Call[] = []
  const logs = [...(answers.logs ?? [READY])]
  return {
    calls,
    runCompose: async (args) => {
      const files = Object.fromEntries(args.filter((arg) => arg.endsWith('.yml') && existsSync(arg)).map((arg) => [arg, readFileSync(arg, 'utf8')]))
      calls.push({ args, files })
      if (args.includes('config')) return { code: 0, stdout: answers.config ?? CONFIG, stderr: '' }
      if (args.includes('logs')) return { code: 0, stdout: logs.length > 1 ? (logs.shift() as string) : (logs[0] ?? ''), stderr: '' }
      if (args.includes('--no-deps')) return { code: answers.upSink ?? 0, stdout: '', stderr: answers.upSink ? 'pull access denied' : '' }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
}

const boot = (run: RunIsolation, runCompose: ReturnType<typeof recorder>['runCompose'], extra: object = {}) =>
  profile().then((loaded) => bootApp(loaded, { runCompose, probe: async () => ({ ok: true }), pollIntervalMs: 1, isolation: run, egressImage: IMAGE, egressReadyTimeoutMs: 50, ...extra }))

test('a stack boots contained: read, its resolver started alone, then the stack with the relay (#382)', async () => {
  const run = isolation()
  const { calls, runCompose } = recorder()
  const outcome = await boot(run, runCompose)
  expect(outcome).toMatchObject({ kind: 'up', egress: { containment: 'contained' } })
  const first = containmentOverrideFile(run.project)
  const second = dnsOverrideFile(run.project)
  expect(calls.map((call) => call.args)).toEqual([
    ['-p', run.project, '-f', 'compose.qa.yaml', 'build', '--with-dependencies', 'admin'],
    ['-p', run.project, '-f', 'compose.qa.yaml', 'config', '--format', 'json'],
    ['-p', run.project, '-f', 'compose.qa.yaml', '-f', first, 'up', '-d', '--no-deps', EGRESS_DNS_SERVICE],
    ['-p', run.project, 'logs', '--no-color', '--no-log-prefix', EGRESS_DNS_SERVICE],
    ['-p', run.project, '-f', 'compose.qa.yaml', '-f', first, '-f', second, 'up', '-d', '--wait', 'admin', EGRESS_RELAY_SERVICE],
  ])
  // The resolver is handed the stub map; every service resolves through it.
  expect(calls[2]?.files[first]).toContain('"egress-dns","--host","api.billing-vendor.example=billing-stub"')
  expect(calls[4]?.files[second]).toContain('dns: !override ["192.0.2.2"]')
  // The down names the overrides, so the resolver and the relay go with the stack.
  calls.length = 0
  await stopApp(await profile(), { runCompose, isolation: run })
  expect(calls.map((call) => call.args)).toEqual([['-p', run.project, '-f', 'compose.qa.yaml', '-f', first, '-f', second, 'down']])
  expect(existsSync(first) || existsSync(second)).toBe(false)
})

test('the resolver is waited for until it says where it answers (#382)', async () => {
  const run = isolation()
  const { calls, runCompose } = recorder({ logs: ['', '', READY] })
  expect(await boot(run, runCompose, { egressReadyTimeoutMs: 5_000 })).toMatchObject({ kind: 'up' })
  expect(calls.filter((call) => call.args.includes('logs'))).toHaveLength(3)
  await stopApp(await profile(), { runCompose, isolation: run })
})

test('a resolver that never says where it answers blocks the boot: a stack is never booted half contained (#382)', async () => {
  const run = isolation()
  const { calls, runCompose } = recorder({ logs: ['starting'] })
  const outcome = await boot(run, runCompose)
  expect(outcome).toMatchObject({ kind: 'blocked', reason: "the stack's resolver did not say where it answers, so its egress could not be contained", logs: 'starting' })
  expect(calls.some((call) => call.args.includes('--wait'))).toBe(false)
  await stopApp(await profile(), { runCompose, isolation: run })
})

test('a resolver that cannot start blocks the boot, with what compose said (#382)', async () => {
  const run = isolation()
  const { runCompose } = recorder({ upSink: 1 })
  expect(await boot(run, runCompose)).toMatchObject({
    kind: 'blocked',
    reason: "the stack's resolver did not start, so its egress could not be contained: compose up exited 1",
    logs: 'pull access denied',
  })
  await stopApp(await profile(), { runCompose, isolation: run })
})

test('a stack the run cannot contain boots as it is, and the boot says why (#382)', async () => {
  const run = isolation()
  const { calls, runCompose } = recorder({ config: JSON.stringify({ services: { admin: { network_mode: 'host' } } }) })
  expect(await boot(run, runCompose)).toMatchObject({
    kind: 'up',
    egress: { containment: 'uncontained', reason: 'the service admin runs with network_mode host, which no network of the stack can contain' },
  })
  expect(calls.at(-1)?.args).toEqual(['-p', run.project, '-f', 'compose.qa.yaml', 'up', '-d', '--wait', 'admin'])
})

test('with no image to run the resolver from, the stack is not read, and boots uncontained by name (#382)', async () => {
  const run = isolation()
  const { calls, runCompose } = recorder()
  expect(await boot(run, runCompose, { egressImage: '' })).toMatchObject({ kind: 'up', egress: { containment: 'uncontained', reason: NO_EGRESS_IMAGE } })
  expect(calls.some((call) => call.args.includes('config'))).toBe(false)
})

test('a command boot is contained like any compose boot, and its down and reap take the overrides along (#382)', async () => {
  const run = isolation()
  const { calls, runCompose } = recorder({ config: JSON.stringify({ services: { app: { ports: [{ target: 3000, published: '41237', protocol: 'tcp' }] } } }) })
  const loaded = await profile()
  const command = { ...loaded, stubs: [], app: { ...loaded.app!, boot: { command: 'npm start', image: 'node:22', port: 3000 } } }
  expect(await bootApp(command, { runCompose, probe: async () => ({ ok: true }), pollIntervalMs: 1, isolation: run, egressImage: IMAGE, root: '/tmp' })).toMatchObject({ kind: 'up', egress: { containment: 'contained' } })
  expect(calls.at(-1)?.args).toEqual(['-p', run.project, '-f', commandBootFile(run.project), '-f', containmentOverrideFile(run.project), '-f', dnsOverrideFile(run.project), 'up', '-d', '--wait', 'app', EGRESS_RELAY_SERVICE])
  await reapProjects({ projects: [run.project], runCompose })
  expect(existsSync(containmentOverrideFile(run.project)) || existsSync(dnsOverrideFile(run.project))).toBe(false)
})

test('the record is read back from the resolver log, and a log that is not its log is no record (#382)', async () => {
  const run = isolation()
  const { calls, runCompose } = recorder({ logs: [`${READY}{"event":"lookup","host":"api.stripe.com","declared":false}\n`] })
  expect(await readStackEgress(run, { runCompose })).toEqual({ address: '192.0.2.2', lookups: [{ host: 'api.stripe.com', declared: false }], capped: false })
  expect(calls[0]?.args).toEqual(['-p', run.project, 'logs', '--no-color', '--no-log-prefix', EGRESS_DNS_SERVICE])
  expect(await readStackEgress(run, { runCompose: recorder({ logs: ['no such service'] }).runCompose })).toBeUndefined()
  expect(await readStackEgress(run, { runCompose: async () => ({ code: 1, stdout: READY, stderr: '' }) })).toBeUndefined()
})
