import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { bootApp, loadProfile, reapProjects, stopApp, type QaProfile, type RunIsolation } from '../src/index.js'
import { buildCacheOverride, buildCacheOverrideFile } from '../src/boot.js'

// #381: an opt-in buildx layer cache for the images a boot builds. The run
// reads the services that build from compose itself, and writes an override
// that reads each one's cache from the directory it is handed and, when it
// is also handed one to write, exports the layers there.

const fixtureDir = new URL('../fixtures/qa-valid/.qa', import.meta.url)
const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-build-cache-'))
  dirs.push(dir)
  return dir
}

function isolation(): RunIsolation {
  const runId = `buildcache-${Math.random().toString(36).slice(2)}`
  return { runId, project: `qare-${runId}`, startedAt: new Date().toISOString(), port: 41236 }
}

async function profile(): Promise<QaProfile> {
  const loaded = await loadProfile(fixtureDir.pathname)
  if (loaded.app === undefined) throw new Error('the fixture boots an app')
  return { ...loaded, app: { ...loaded.app, health: { ...loaded.app.health, timeout: '1s' } } }
}

// compose config, as compose answers it: two services build, one pulls.
const CONFIG = JSON.stringify({ services: { admin: { build: { context: '/x' } }, worker: { build: { context: '/y' } }, db: { image: 'postgres:16' } } })

function recorder(config = CONFIG): { calls: Array<{ args: string[]; env?: Record<string, string>; override?: unknown }>; runCompose: (args: string[], timeoutMs: number, env?: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }> } {
  const calls: Array<{ args: string[]; env?: Record<string, string>; override?: unknown }> = []
  return {
    calls,
    runCompose: async (args, _timeoutMs, env) => {
      const file = args.find((arg) => arg.endsWith('.build-cache.json'))
      calls.push({ args, ...(env === undefined ? {} : { env }), ...(file !== undefined && existsSync(file) ? { override: JSON.parse(readFileSync(file, 'utf8')) } : {}) })
      if (args.includes('config')) return { code: 0, stdout: config, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
}

test('a boot handed a cache to read builds every service that builds from it, where one is there (#381)', async () => {
  const from = await scratch()
  await mkdir(join(from, 'admin'))
  await writeFile(join(from, 'admin', 'index.json'), '{}')
  const run = isolation()
  const { calls, runCompose } = recorder()
  const outcome = await bootApp(await profile(), { runCompose, probe: async () => ({ ok: true }), pollIntervalMs: 1, isolation: run, buildCache: { from } })
  expect(outcome).toMatchObject({ kind: 'up' })
  const override = buildCacheOverrideFile(run.project)
  expect(calls.map((call) => call.args)).toEqual([
    ['-p', run.project, '-f', 'compose.qa.yaml', 'config', '--format', 'json'],
    ['-p', run.project, '-f', 'compose.qa.yaml', '-f', override, 'build', '--with-dependencies', 'admin'],
    ['-p', run.project, '-f', 'compose.qa.yaml', '-f', override, 'up', '-d', '--wait', 'admin'],
  ])
  // Only a cache that is there is read: worker has none yet. Nothing is written.
  expect(calls[1]?.override).toEqual({ services: { admin: { build: { cache_from: [`type=local,src=${join(from, 'admin')}`] } } } })
  // Reading needs no entitlement, so the build's environment is the run's own.
  expect(calls[1]?.env).toEqual({ QARE_RUN_ID: run.runId, QARE_APP_PORT: '41236' })
  await stopApp(await profile(), { runCompose, isolation: run })
  expect(existsSync(override)).toBe(false)
})

test('a boot handed a cache to write exports every service that builds, one directory each (#381)', async () => {
  const from = await scratch()
  const to = await scratch()
  const run = isolation()
  const { calls, runCompose } = recorder()
  await bootApp(await profile(), { runCompose, probe: async () => ({ ok: true }), pollIntervalMs: 1, isolation: run, buildCache: { from, to } })
  const build = calls.find((call) => call.args.includes('build'))
  expect(build?.override).toEqual({
    services: {
      admin: { build: { cache_to: [`type=local,dest=${join(to, 'admin')},mode=max`] } },
      worker: { build: { cache_to: [`type=local,dest=${join(to, 'worker')},mode=max`] } },
    },
  })
  // Bake asks for a write entitlement outside the build context; the cache
  // directory is the run's own, so the build is told it may.
  expect(build?.env).toMatchObject({ BUILDX_BAKE_ENTITLEMENTS_FS: '0' })
  expect(calls.find((call) => call.args.includes('up'))?.env).not.toHaveProperty('BUILDX_BAKE_ENTITLEMENTS_FS')
  await stopApp(await profile(), { runCompose, isolation: run })
})

test('the override reads services as data: a service name that is not a plain name gets no cache (#381)', () => {
  expect(buildCacheOverride(['web', '../up', 'a b'], { to: '/c' }, () => false)).toEqual({ services: { web: { build: { cache_to: ['type=local,dest=/c/web,mode=max'] } } } })
  expect(buildCacheOverride(['web'], { from: '/c' }, () => false)).toBeUndefined()
})

test('a compose that cannot say its services builds as before, with no cache (#381)', async () => {
  const run = isolation()
  const { calls, runCompose } = recorder('not json')
  const outcome = await bootApp(await profile(), { runCompose, probe: async () => ({ ok: true }), pollIntervalMs: 1, isolation: run, buildCache: { to: await scratch() } })
  expect(outcome).toMatchObject({ kind: 'up' })
  expect(calls[1]?.args).toEqual(['-p', run.project, '-f', 'compose.qa.yaml', 'build', '--with-dependencies', 'admin'])
  await stopApp(await profile(), { runCompose, isolation: run })
})

test('without a cache the boot asks compose nothing more (#381)', async () => {
  const run = isolation()
  const { calls, runCompose } = recorder()
  await bootApp(await profile(), { runCompose, probe: async () => ({ ok: true }), pollIntervalMs: 1, isolation: run })
  expect(calls.map((call) => call.args[4] ?? call.args[3])).not.toContain('config')
  expect(calls[0]?.args).toEqual(['-p', run.project, '-f', 'compose.qa.yaml', 'build', '--with-dependencies', 'admin'])
})

test('reaping removes the cache override the run wrote (#381)', async () => {
  const run = isolation()
  const { runCompose } = recorder()
  await bootApp(await profile(), { runCompose, probe: async () => ({ ok: true }), pollIntervalMs: 1, isolation: run, buildCache: { to: await scratch() } })
  expect(existsSync(buildCacheOverrideFile(run.project))).toBe(true)
  await reapProjects({ projects: [run.project], runCompose })
  expect(existsSync(buildCacheOverrideFile(run.project))).toBe(false)
})
