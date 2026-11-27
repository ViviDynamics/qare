import { expect, test } from 'vitest'
import { bootApp, captureServiceLogs, loadProfile, serviceFailed, type QaProfile, type RunIsolation } from '../src/index.js'
import { parseComposePs, SERVICE_LOG_LINES } from '../src/boot.js'
import { EGRESS_DNS_SERVICE, EGRESS_RELAY_SERVICE } from '../src/stack-egress.js'

// #407: a stack that does not come up is read before anything takes it
// down: each service's state, its exit code, and the last lines of its log.

const fixtureDir = new URL('../fixtures/qa-valid/.qa', import.meta.url)
const IMAGE = 'ghcr.io/vividynamics/qare-core:2026.11.21'

function isolation(): RunIsolation {
  const runId = `services-${Math.random().toString(36).slice(2)}`
  return { runId, project: `qare-${runId}`, startedAt: new Date().toISOString(), port: 41238 }
}

async function profile(): Promise<QaProfile> {
  const loaded = await loadProfile(fixtureDir.pathname)
  if (loaded.app === undefined) throw new Error('the fixture boots an app')
  return { ...loaded, app: { ...loaded.app, health: { ...loaded.app.health, timeout: '1s' } } }
}

const PS_LINES = [
  JSON.stringify({ Service: 'web', State: 'exited', ExitCode: 1, Health: '' }),
  JSON.stringify({ Service: 'db', State: 'running', ExitCode: 0, Health: 'healthy' }),
  JSON.stringify({ Service: EGRESS_DNS_SERVICE, State: 'running', ExitCode: 0 }),
  JSON.stringify({ Service: EGRESS_RELAY_SERVICE, State: 'running', ExitCode: 0 }),
].join('\n')

test('compose ps is read one object per line or as an array, and the run\'s own services are left out', () => {
  const expected = [
    { service: 'web', state: 'exited', exitCode: 1 },
    { service: 'db', state: 'running', exitCode: 0, health: 'healthy' },
  ]
  expect(parseComposePs(PS_LINES)).toEqual(expected)
  expect(parseComposePs(`[${PS_LINES.split('\n').join(',')}]`)).toEqual(expected)
  expect(parseComposePs('')).toEqual([])
  expect(parseComposePs('not json\n')).toEqual([])
})

test('a service with several containers is the one that failed', () => {
  const ps = [JSON.stringify({ Service: 'worker', State: 'running', ExitCode: 0 }), JSON.stringify({ Service: 'worker', State: 'exited', ExitCode: 137 })].join('\n')
  expect(parseComposePs(ps)).toEqual([{ service: 'worker', state: 'exited', exitCode: 137 }])
})

test('a service failed when it exited non-zero, is unhealthy, or is in any state but running', () => {
  expect(serviceFailed({ state: 'exited', exitCode: 1 })).toBe(true)
  expect(serviceFailed({ state: 'exited', exitCode: 0 })).toBe(false)
  expect(serviceFailed({ state: 'running', health: 'unhealthy' })).toBe(true)
  expect(serviceFailed({ state: 'running', health: 'healthy' })).toBe(false)
  expect(serviceFailed({ state: 'restarting', exitCode: 1 })).toBe(true)
  expect(serviceFailed({ state: 'created' })).toBe(true)
})

test('each service\'s last lines are read by the project\'s name alone', async () => {
  const run = isolation()
  const calls: string[][] = []
  const services = await captureServiceLogs(run, {
    runCompose: async (args) => {
      calls.push(args)
      if (args.includes('ps')) return { code: 0, stdout: PS_LINES, stderr: '' }
      const service = args[args.length - 1]
      return { code: 0, stdout: `${service} says goodbye\n`, stderr: service === 'web' ? 'web: database unreachable\n' : '' }
    },
  })
  expect(calls).toEqual([
    ['-p', run.project, 'ps', '-a', '--format', 'json'],
    ['-p', run.project, 'logs', '--no-color', '--no-log-prefix', '--tail', String(SERVICE_LOG_LINES), 'web'],
    ['-p', run.project, 'logs', '--no-color', '--no-log-prefix', '--tail', String(SERVICE_LOG_LINES), 'db'],
  ])
  expect(SERVICE_LOG_LINES).toBe(200)
  expect(services).toEqual([
    { service: 'web', state: 'exited', exitCode: 1, log: 'web says goodbye\nweb: database unreachable\n' },
    { service: 'db', state: 'running', exitCode: 0, health: 'healthy', log: 'db says goodbye\n' },
  ])
})

test('a capture that cannot read the stack returns nothing, and a call that never settles is bounded', async () => {
  const run = isolation()
  expect(await captureServiceLogs(run, { runCompose: async () => ({ code: 1, stdout: '', stderr: 'no such project' }) })).toEqual([])
  expect(await captureServiceLogs(run, { runCompose: () => new Promise(() => {}), serviceLogTimeoutMs: 20 })).toEqual([])
  const hung = await captureServiceLogs(run, {
    runCompose: (args) => (args.includes('ps') ? Promise.resolve({ code: 0, stdout: PS_LINES, stderr: '' }) : new Promise(() => {})),
    serviceLogTimeoutMs: 20,
  })
  expect(hung.map((service) => [service.service, service.log])).toEqual([
    ['web', ''],
    ['db', ''],
  ])
  expect(await captureServiceLogs(run, { runCompose: async () => Promise.reject(new Error('docker is gone')) })).toEqual([])
})

/** A compose whose up exits 1 the way a stack with a dead service does, and whose ps and logs say so. */
function exitingStack(upCode: number): (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }> {
  return async (args) => {
    if (args.includes('ps')) return { code: 0, stdout: PS_LINES, stderr: '' }
    if (args.includes('logs')) return { code: 0, stdout: args.includes('web') ? 'boot: connecting\nActiveRecord::ConnectionNotEstablished: Network is unreachable\n' : '', stderr: '' }
    if (args.includes('up')) return { code: upCode, stdout: '', stderr: upCode === 0 ? '' : 'container qare-x-web-1 exited (1)\n' }
    return { code: 0, stdout: '', stderr: '' }
  }
}

test('a compose up that exits names each service\'s state and log, read before any down', async () => {
  const run = isolation()
  const verbs: string[] = []
  const stack = exitingStack(1)
  const outcome = await bootApp(await profile(), {
    isolation: run,
    runCompose: async (args) => {
      verbs.push(args.find((arg) => ['build', 'up', 'ps', 'logs', 'down'].includes(arg)) ?? '')
      return stack(args)
    },
    egressImage: '',
  })
  expect(outcome.kind).toBe('blocked')
  expect(outcome.reason).toBe('compose up exited 1; its output ended: container qare-x-web-1 exited (1)')
  expect(outcome.services).toEqual([
    { service: 'web', state: 'exited', exitCode: 1, log: 'boot: connecting\nActiveRecord::ConnectionNotEstablished: Network is unreachable\n' },
    { service: 'db', state: 'running', exitCode: 0, health: 'healthy', log: '' },
  ])
  // The stack is not contained, so there is no resolver record to read.
  expect(outcome.lookups).toBeUndefined()
  expect(verbs).not.toContain('down')
})

test('a health check that does not pass reads the services too', async () => {
  const outcome = await bootApp(await profile(), { isolation: isolation(), runCompose: exitingStack(0), probe: async () => ({ ok: false }), pollIntervalMs: 1, egressImage: '' })
  expect(outcome.reason).toContain('did not pass within')
  expect(outcome.services?.map((service) => service.service)).toEqual(['web', 'db'])
})

test('a watchdog that fires reads what the stack got as far as before the down', async () => {
  const run = isolation()
  const outcome = await bootApp(await profile(), {
    isolation: run,
    runCompose: (args) => {
      if (args.includes('up')) return new Promise(() => {})
      return exitingStack(0)(args)
    },
    egressImage: '',
    pollIntervalMs: 1,
  })
  expect(outcome.reason).toBe('boot watchdog: compose up exceeded the health deadline')
  expect(outcome.services?.[0]).toMatchObject({ service: 'web', state: 'exited', exitCode: 1 })
})

test('a stack that booted nothing readable carries no services', async () => {
  const outcome = await bootApp(await profile(), {
    isolation: isolation(),
    runCompose: async (args) => ({ code: args.includes('up') ? 1 : 0, stdout: '', stderr: '' }),
    egressImage: '',
  })
  expect(outcome.kind).toBe('blocked')
  expect('services' in outcome).toBe(false)
})

test('a contained stack that fails is read for the names it looked up before it failed', async () => {
  const run = isolation()
  const config = JSON.stringify({ networks: { default: {} }, services: { admin: { networks: { default: null } } } })
  const record = [
    '{"event":"ready","address":"192.0.2.2","port":53}',
    '{"event":"lookup","host":"db.crash-app.example","declared":false}',
  ].join('\n')
  const outcome = await bootApp(await profile(), {
    isolation: run,
    egressImage: IMAGE,
    runDocker: async () => ({ code: 0, stdout: '', stderr: '' }),
    runCompose: async (args) => {
      if (args.includes('config')) return { code: 0, stdout: config, stderr: '' }
      if (args.includes('logs') && args.includes(EGRESS_DNS_SERVICE)) return { code: 0, stdout: `${record}\n`, stderr: '' }
      if (args.includes('up') && args.includes('--wait')) return { code: 1, stdout: '', stderr: 'container exited (1)' }
      return exitingStack(0)(args)
    },
  })
  expect(outcome.kind).toBe('blocked')
  expect(outcome.egress).toEqual({ containment: 'contained' })
  expect(outcome.lookups?.lookups).toEqual([{ host: 'db.crash-app.example', declared: false }])
  expect(outcome.services?.[0]).toMatchObject({ service: 'web', exitCode: 1 })
})
