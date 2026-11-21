import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { bootApp, loadProfile, reapProjects, stopApp, type QaProfile, type RunIsolation } from '../src/index.js'

const fixtureDir = new URL('../fixtures/qa-valid/.qa', import.meta.url)

/** The fixture profile booted by a start command (#379). */
async function commandProfile(command = 'npm start', image = 'node:22', port = 3000): Promise<QaProfile> {
  const profile = await loadProfile(fixtureDir.pathname)
  if (profile.app === undefined) throw new Error('the fixture boots an app')
  return { ...profile, stubs: [], app: { ...profile.app, boot: { command, image, port }, health: { ...profile.app.health, timeout: '1s' } } }
}

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function checkout(name = 'qare-command-boot-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), name))
  roots.push(root)
  return root
}

function isolation(): RunIsolation {
  const runId = `command-${Math.random().toString(36).slice(2)}`
  return { runId, project: `qare-${runId}`, startedAt: new Date().toISOString(), port: 41234 }
}

interface Call {
  args: string[]
  env?: Record<string, string>
  /** The generated project file as it was when compose was handed it. */
  file?: unknown
}

function recorder(code = 0): { calls: Call[]; runCompose: (args: string[], timeoutMs: number, env?: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }> } {
  const calls: Call[] = []
  return {
    calls,
    runCompose: async (args, _timeoutMs, env) => {
      const at = args.indexOf('-f')
      const path = at === -1 ? undefined : args[at + 1]
      calls.push({ args, ...(env === undefined ? {} : { env }), ...(path === undefined ? {} : { file: JSON.parse(readFileSync(path, 'utf8')) }) })
      return { code: args.includes('up') ? code : 0, stdout: args.includes('logs') ? 'app-1 | listening' : '', stderr: '' }
    },
  }
}

test('a command boot runs as the one service of a compose project the run writes for itself (#379)', async () => {
  const root = await checkout()
  const run = isolation()
  const { calls, runCompose } = recorder()
  const outcome = await bootApp(await commandProfile(), { runCompose, probe: async () => ({ ok: true }), pollIntervalMs: 1, isolation: run, root })

  expect(outcome).toMatchObject({ kind: 'up', isolation: run })
  const file = join(tmpdir(), `${run.project}.compose.json`)
  // The same calls a compose boot makes, under the run's project, against
  // the file the run wrote, with the run's port handed to compose.
  expect(calls.map((call) => call.args)).toEqual([
    ['-p', run.project, '-f', file, 'build', '--with-dependencies', 'app'],
    ['-p', run.project, '-f', file, 'up', '-d', '--wait', 'app'],
  ])
  expect(calls[1]?.env).toEqual({ QARE_RUN_ID: run.runId, QARE_APP_PORT: '41234' })
  // The checkout is copied into the named image, not mounted, and the
  // command runs there with the port it is published on as PORT.
  expect(calls[0]?.file).toEqual({
    services: {
      app: {
        build: { context: root, dockerfile_inline: 'FROM node:22\nCOPY . /app\nWORKDIR /app\n' },
        command: ['sh', '-c', 'npm start'],
        environment: { PORT: '3000' },
        ports: ['127.0.0.1:${QARE_APP_PORT:-3000}:3000'],
      },
    },
  })
})

test('a command boot escapes every $ but the run port, so compose interpolates nothing of the profile (#379)', async () => {
  const root = await checkout('qare-$HOME-')
  const run = isolation()
  const { calls, runCompose } = recorder()
  await bootApp(await commandProfile('rails s -b 0.0.0.0 -p $PORT', 'registry.example/ruby:${TAG}', 8080), {
    runCompose,
    probe: async () => ({ ok: true }),
    pollIntervalMs: 1,
    isolation: run,
    root,
  })
  const service = (calls[0]?.file as { services: { app: Record<string, unknown> } }).services.app
  expect(service.command).toEqual(['sh', '-c', 'rails s -b 0.0.0.0 -p $$PORT'])
  expect(service.build).toEqual({ context: root.replaceAll('$', () => '$$'), dockerfile_inline: 'FROM registry.example/ruby:$${TAG}\nCOPY . /app\nWORKDIR /app\n' })
  expect(service.ports).toEqual(['127.0.0.1:${QARE_APP_PORT:-8080}:8080'])
  expect(service.environment).toEqual({ PORT: '8080' })
})

test('a command boot that does not come up is blocked with the service log, read from the project the run wrote (#379)', async () => {
  const root = await checkout()
  const run = isolation()
  const { calls, runCompose } = recorder()
  const outcome = await bootApp(await commandProfile(), { runCompose, probe: async () => ({ ok: false }), pollIntervalMs: 1, isolation: run, root })
  expect(outcome).toMatchObject({ kind: 'blocked', logs: 'app-1 | listening' })
  // The service's log is read through the file the run wrote; the per-service capture after it (#407) addresses the project alone.
  expect(calls.find((call) => call.args.includes('logs'))?.args).toEqual(['-p', run.project, '-f', join(tmpdir(), `${run.project}.compose.json`), 'logs', '--no-color', 'app'])
})

test('stopping a command boot downs its project by name and removes the file the run wrote (#379)', async () => {
  const root = await checkout()
  const run = isolation()
  const { calls, runCompose } = recorder()
  const profile = await commandProfile()
  await bootApp(profile, { runCompose, probe: async () => ({ ok: true }), pollIntervalMs: 1, isolation: run, root })
  const file = join(tmpdir(), `${run.project}.compose.json`)
  expect(existsSync(file)).toBe(true)

  calls.length = 0
  await stopApp(profile, { runCompose, isolation: run })
  // Downed by project alone, as reap downs it, so the down needs no file.
  expect(calls.map((call) => call.args)).toEqual([['-p', run.project, 'down', '--volumes']])
  expect(existsSync(file)).toBe(false)
})

test('a command boot with no isolation to stop has nothing a down could address (#379)', async () => {
  const { calls, runCompose } = recorder()
  await stopApp(await commandProfile(), { runCompose })
  expect(calls).toEqual([])
})

test('reaping a command boot downs its project and removes the file the run wrote for it (#379)', async () => {
  const run = isolation()
  const file = join(tmpdir(), `${run.project}.compose.json`)
  const { calls, runCompose } = recorder()
  await bootApp(await commandProfile(), { runCompose, probe: async () => ({ ok: true }), pollIntervalMs: 1, isolation: run, root: await checkout() })
  expect(existsSync(file)).toBe(true)
  calls.length = 0
  const outcome = await reapProjects({ projects: [run.project], runCompose })
  expect(outcome).toEqual({ reaped: [run.project], failures: [] })
  expect(calls.map((call) => call.args)).toEqual([['-p', run.project, 'down', '--volumes']])
  expect(existsSync(file)).toBe(false)
})
