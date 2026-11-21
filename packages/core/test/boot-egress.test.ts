import { existsSync, readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { bootApp, loadProfile, readStackEgress, reapProjects, stopApp, type QaProfile, type RunIsolation } from '../src/index.js'
import { commandBootFile } from '../src/boot.js'
import { CONTAINED_NETWORK, containmentOverrideFile, dnsOverrideFile, EGRESS_DNS_SERVICE, EGRESS_MAP_FILE, EGRESS_RELAY_SERVICE, NO_EGRESS_IMAGE, relayOverrideFile } from '../src/stack-egress.js'

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

function recorder(answers: { config?: string; logs?: string[]; upSink?: number; upStubs?: number; exec?: number; down?: number } = {}): { calls: Call[]; runCompose: (args: string[], timeoutMs: number, env?: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }> } {
  const calls: Call[] = []
  const logs = [...(answers.logs ?? [READY])]
  return {
    calls,
    runCompose: async (args) => {
      const files = Object.fromEntries(args.filter((arg) => arg.endsWith('.yml') && existsSync(arg)).map((arg) => [arg, readFileSync(arg, 'utf8')]))
      calls.push({ args, files })
      if (args.includes('config')) return { code: 0, stdout: answers.config ?? CONFIG, stderr: '' }
      if (args.includes('logs')) return { code: 0, stdout: logs.length > 1 ? (logs.shift() as string) : (logs[0] ?? ''), stderr: '' }
      if (args.includes('--no-deps') && args.includes(EGRESS_DNS_SERVICE)) return { code: answers.upSink ?? 0, stdout: '', stderr: answers.upSink ? 'pull access denied' : '' }
      if (args.includes('billing-stub') && args.includes('up')) return { code: answers.upStubs ?? 0, stdout: '', stderr: answers.upStubs ? 'stub image missing' : '' }
      if (args.includes('exec')) return { code: answers.exec ?? 0, stdout: '', stderr: answers.exec ? 'exec failed' : '' }
      if (args.includes('down')) return { code: answers.down ?? 0, stdout: '', stderr: answers.down ? 'daemon gone' : '' }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
}

/** A container as `docker inspect` describes it: its compose labels and its address on each network. */
function container(project: string, service: string, contained: string | undefined) {
  return {
    Config: { Labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': service } },
    NetworkSettings: { Networks: { [`${project}_default`]: { IPAddress: '198.18.89.2' }, ...(contained === undefined ? {} : { [`${project}_${CONTAINED_NETWORK}`]: { IPAddress: contained } }) } },
  }
}

/**
 * The daemon the run reads addresses from (#408): each `docker ps` lists the
 * project's running containers, and each `docker inspect` describes them.
 * `states` is what each successive ps and inspect sees.
 */
function daemon(project: string, states: Array<Record<string, string | undefined>>, codes: { ps?: number } = {}): { calls: string[][]; runDocker: (args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }> } {
  const calls: string[][] = []
  let seen = 0
  return {
    calls,
    runDocker: async (args) => {
      calls.push(args)
      const state = states[Math.min(seen, states.length - 1)] ?? {}
      if (args[0] === 'ps') return { code: codes.ps ?? 0, stdout: Object.keys(state).map((service) => `id-${service}`).join('\n'), stderr: codes.ps ? 'cannot connect' : '' }
      seen += 1
      return { code: 0, stdout: JSON.stringify(Object.entries(state).map(([service, address]) => container(project, service, address))), stderr: '' }
    },
  }
}

/** Each address the daemon gives: the stub once it is up, then the app beside it. */
const STUB_UP = { [EGRESS_DNS_SERVICE]: '198.18.0.2', 'billing-stub': '198.18.0.3' }
const APP_UP = { ...STUB_UP, admin: '198.18.0.4' }

const boot = (run: RunIsolation, runCompose: ReturnType<typeof recorder>['runCompose'], extra: object = {}) =>
  profile().then((loaded) =>
    bootApp(loaded, { runCompose, runDocker: daemon(run.project, [STUB_UP, APP_UP]).runDocker, probe: async () => ({ ok: true }), pollIntervalMs: 1, isolation: run, egressImage: IMAGE, egressReadyTimeoutMs: 50, ...extra }),
  )

test('a stack boots contained: read, its resolver alone, its stubs, their addresses handed over, the stack, then the relay by address (#382, #408)', async () => {
  const run = isolation()
  const { calls, runCompose } = recorder()
  const docker = daemon(run.project, [STUB_UP, APP_UP])
  const outcome = await boot(run, runCompose, { runDocker: docker.runDocker })
  expect(outcome).toMatchObject({ kind: 'up', egress: { containment: 'contained' } })
  const first = containmentOverrideFile(run.project)
  const second = dnsOverrideFile(run.project)
  const third = relayOverrideFile(run.project)
  expect(calls.map((call) => call.args)).toEqual([
    ['-p', run.project, '-f', 'compose.qa.yaml', 'build', '--with-dependencies', 'admin'],
    ['-p', run.project, '-f', 'compose.qa.yaml', 'config', '--format', 'json'],
    ['-p', run.project, '-f', 'compose.qa.yaml', '-f', first, 'up', '-d', '--no-deps', EGRESS_DNS_SERVICE],
    ['-p', run.project, 'logs', '--no-color', '--no-log-prefix', EGRESS_DNS_SERVICE],
    ['-p', run.project, '-f', 'compose.qa.yaml', '-f', first, '-f', second, 'up', '-d', 'billing-stub'],
    ['-p', run.project, '-f', 'compose.qa.yaml', '-f', first, '-f', second, 'exec', '-T', EGRESS_DNS_SERVICE, 'qare', 'cell', 'egress-dns-map', '--map', EGRESS_MAP_FILE, '--service', 'billing-stub=198.18.0.3'],
    ['-p', run.project, '-f', 'compose.qa.yaml', '-f', first, '-f', second, 'up', '-d', '--wait', 'admin'],
    ['-p', run.project, '-f', 'compose.qa.yaml', '-f', first, '-f', second, '-f', third, 'up', '-d', '--no-deps', EGRESS_RELAY_SERVICE],
  ])
  // The addresses come from the daemon, by the project's own label, never from a name lookup.
  expect(docker.calls).toEqual([
    ['ps', '-q', '--no-trunc', '--filter', `label=com.docker.compose.project=${run.project}`],
    ['inspect', `id-${EGRESS_DNS_SERVICE}`, 'id-billing-stub'],
    ['ps', '-q', '--no-trunc', '--filter', `label=com.docker.compose.project=${run.project}`],
    ['inspect', `id-${EGRESS_DNS_SERVICE}`, 'id-billing-stub', 'id-admin'],
  ])
  // The resolver is handed the stub map; every service resolves through it; the relay dials the app's address.
  expect(calls[2]?.files[first]).toContain('"--host","api.billing-vendor.example=billing-stub"')
  expect(calls[4]?.files[second]).toContain('dns: !override ["192.0.2.2"]')
  expect(calls[7]?.files[third]).toContain('"egress-relay","--forward","20000=198.18.0.4:3000"')
  // The down names the overrides, so the resolver and the relay go with the stack.
  calls.length = 0
  await stopApp(await profile(), { runCompose, isolation: run })
  expect(calls.map((call) => call.args)).toEqual([['-p', run.project, '-f', 'compose.qa.yaml', '-f', first, '-f', second, '-f', third, 'down']])
  expect(existsSync(first) || existsSync(second) || existsSync(third)).toBe(false)
})

test('a stub the daemon gives no contained address is not booted half contained: the stack is taken down and boots uncontained, with the reason (#408)', async () => {
  const run = isolation()
  const { calls, runCompose } = recorder()
  const outcome = await boot(run, runCompose, { runDocker: daemon(run.project, [{ ...STUB_UP, 'billing-stub': undefined }]).runDocker })
  expect(outcome).toMatchObject({
    kind: 'up',
    egress: { containment: 'uncontained', reason: "the daemon gave the stub service billing-stub no address on the stack's contained network, so the run's resolver could not answer for it" },
  })
  const first = containmentOverrideFile(run.project)
  const second = dnsOverrideFile(run.project)
  expect(calls.slice(-2).map((call) => call.args)).toEqual([
    ['-p', run.project, '-f', 'compose.qa.yaml', '-f', first, '-f', second, 'down'],
    ['-p', run.project, '-f', 'compose.qa.yaml', 'up', '-d', '--wait', 'admin'],
  ])
  expect(calls.some((call) => call.args.includes('exec'))).toBe(false)
  expect(existsSync(first) || existsSync(second)).toBe(false)
})

test('an app the daemon gives no contained address is taken down and booted again uncontained, never left half contained (#408)', async () => {
  const run = isolation()
  const { calls, runCompose } = recorder()
  const outcome = await boot(run, runCompose, { runDocker: daemon(run.project, [STUB_UP, { ...APP_UP, admin: undefined }]).runDocker })
  expect(outcome).toMatchObject({
    kind: 'up',
    egress: { containment: 'uncontained', reason: "the daemon gave the service admin no address on the stack's contained network, so the relay could not carry the port it publishes" },
  })
  const first = containmentOverrideFile(run.project)
  const second = dnsOverrideFile(run.project)
  expect(calls.slice(-3).map((call) => call.args)).toEqual([
    ['-p', run.project, '-f', 'compose.qa.yaml', '-f', first, '-f', second, 'up', '-d', '--wait', 'admin'],
    ['-p', run.project, '-f', 'compose.qa.yaml', '-f', first, '-f', second, 'down'],
    ['-p', run.project, '-f', 'compose.qa.yaml', 'up', '-d', '--wait', 'admin'],
  ])
  expect(calls.some((call) => call.args.includes(EGRESS_RELAY_SERVICE))).toBe(false)
  expect(existsSync(relayOverrideFile(run.project))).toBe(false)
})

test('a daemon the run cannot read addresses from, or a resolver that cannot be handed them, leaves the stack uncontained with the reason (#408)', async () => {
  const unread = isolation()
  expect(await boot(unread, recorder().runCompose, { runDocker: daemon(unread.project, [STUB_UP], { ps: 1 }).runDocker })).toMatchObject({
    kind: 'up',
    egress: { containment: 'uncontained', reason: "the run could not read the stack's addresses from the daemon: docker ps exited 1" },
  })
  const unhanded = isolation()
  expect(await boot(unhanded, recorder({ exec: 126 }).runCompose)).toMatchObject({
    kind: 'up',
    egress: { containment: 'uncontained', reason: "the run's resolver could not be handed the stub services' addresses: compose exec exited 126" },
  })
})

test('a half contained stack that cannot be taken down blocks the boot, and stub services that cannot start block it too (#408)', async () => {
  const stuck = isolation()
  expect(await boot(stuck, recorder({ down: 1 }).runCompose, { runDocker: daemon(stuck.project, [{ ...STUB_UP, 'billing-stub': undefined }]).runDocker })).toMatchObject({
    kind: 'blocked',
    reason: "the daemon gave the stub service billing-stub no address on the stack's contained network, so the run's resolver could not answer for it, and the stack could not be taken down to boot it uncontained: compose down exited 1",
    logs: 'daemon gone',
  })
  const stubs = isolation()
  expect(await boot(stubs, recorder({ upStubs: 1 }).runCompose)).toMatchObject({
    kind: 'blocked',
    reason: "the stack's stub services did not start, so its egress could not be contained: compose up exited 1",
    logs: 'stub image missing',
  })
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
  const runDocker = daemon(run.project, [{ app: '198.18.0.4' }]).runDocker
  expect(await bootApp(command, { runCompose, runDocker, probe: async () => ({ ok: true }), pollIntervalMs: 1, isolation: run, egressImage: IMAGE, root: '/tmp' })).toMatchObject({ kind: 'up', egress: { containment: 'contained' } })
  expect(calls.at(-1)?.args).toEqual(['-p', run.project, '-f', commandBootFile(run.project), '-f', containmentOverrideFile(run.project), '-f', dnsOverrideFile(run.project), '-f', relayOverrideFile(run.project), 'up', '-d', '--no-deps', EGRESS_RELAY_SERVICE])
  await reapProjects({ projects: [run.project], runCompose })
  expect(existsSync(containmentOverrideFile(run.project)) || existsSync(dnsOverrideFile(run.project)) || existsSync(relayOverrideFile(run.project))).toBe(false)
})

test('the record is read back from the resolver log, and a log that is not its log is no record (#382)', async () => {
  const run = isolation()
  const { calls, runCompose } = recorder({ logs: [`${READY}{"event":"lookup","host":"api.stripe.com","declared":false}\n`] })
  expect(await readStackEgress(run, { runCompose })).toEqual({ address: '192.0.2.2', lookups: [{ host: 'api.stripe.com', declared: false }], capped: false })
  expect(calls[0]?.args).toEqual(['-p', run.project, 'logs', '--no-color', '--no-log-prefix', EGRESS_DNS_SERVICE])
  expect(await readStackEgress(run, { runCompose: recorder({ logs: ['no such service'] }).runCompose })).toBeUndefined()
  expect(await readStackEgress(run, { runCompose: async () => ({ code: 1, stdout: READY, stderr: '' }) })).toBeUndefined()
})
