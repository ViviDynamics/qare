import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { bootApp, loadProfile, reapProjects, stopApp, type QaProfile, type RunIsolation } from '../src/index.js'
import { baseImageOverride, baseImageOverrideFile } from '../src/boot.js'

// #381: on the base side, a prebuilt image the run has shown to be the base
// commit's runs as the app's service in place of the build. Both boot forms
// take it: a compose boot through an override file the run writes, a command
// boot (#379) through the project the run already writes for it.

const fixtureDir = new URL('../fixtures/qa-valid/.qa', import.meta.url)
const IMAGE = `ghcr.io/acme/app@sha256:${'c'.repeat(64)}`

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function isolation(): RunIsolation {
  const runId = `baseimage-${Math.random().toString(36).slice(2)}`
  return { runId, project: `qare-${runId}`, startedAt: new Date().toISOString(), port: 41235 }
}

async function composeProfile(prebuilt?: string): Promise<QaProfile> {
  const profile = await loadProfile(fixtureDir.pathname)
  if (profile.app === undefined) throw new Error('the fixture boots an app')
  return { ...profile, app: { ...profile.app, boot: { ...profile.app.boot, ...(prebuilt === undefined ? {} : { prebuilt }) }, health: { ...profile.app.health, timeout: '1s' } } }
}

function recorder(): { calls: Array<{ args: string[]; files: string[] }>; runCompose: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }> } {
  const calls: Array<{ args: string[]; files: string[] }> = []
  return {
    calls,
    runCompose: async (args) => {
      const files = args.flatMap((arg, index) => (args[index - 1] === '-f' && existsSync(arg) ? [readFileSync(arg, 'utf8')] : []))
      calls.push({ args, files })
      return { code: 0, stdout: '', stderr: '' }
    },
  }
}

test('a compose boot runs the prebuilt image as its service: the build is reset, nothing is pulled again (#381)', async () => {
  const run = isolation()
  const { calls, runCompose } = recorder()
  const outcome = await bootApp(await composeProfile(IMAGE), { runCompose, probe: async () => ({ ok: true }), pollIntervalMs: 1, isolation: run })
  expect(outcome).toMatchObject({ kind: 'up' })
  const override = baseImageOverrideFile(run.project)
  // The service's dependencies are still built; the service itself has no build left to run.
  expect(calls.map((call) => call.args)).toEqual([
    ['-p', run.project, '-f', 'compose.qa.yaml', '-f', override, 'build', '--with-dependencies', 'admin'],
    ['-p', run.project, '-f', 'compose.qa.yaml', '-f', override, 'up', '-d', '--wait', 'admin'],
  ])
  expect(calls[0]?.files[0]).toBe(baseImageOverride('admin', IMAGE))
  expect(baseImageOverride('admin', IMAGE)).toBe(`services:\n  "admin":\n    image: "${IMAGE}"\n    pull_policy: never\n    build: !reset null\n`)
  // The override is the run's own, and goes with the stack.
  await stopApp(await composeProfile(IMAGE), { runCompose, isolation: run })
  expect(existsSync(override)).toBe(false)
})

test('the override is literal: compose interpolates nothing in the service name or the image (#381)', () => {
  expect(baseImageOverride('a$b', 'reg/x:$TAG')).toBe('services:\n  "a$$b":\n    image: "reg/x:$$TAG"\n    pull_policy: never\n    build: !reset null\n')
})

test('a command boot names the prebuilt image in its project in place of the build (#381)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qare-base-image-'))
  roots.push(root)
  const run = isolation()
  const profile = await loadProfile(fixtureDir.pathname)
  if (profile.app === undefined) throw new Error('the fixture boots an app')
  const command: QaProfile = { ...profile, stubs: [], app: { ...profile.app, boot: { command: 'npm start', image: 'node:22', port: 3000, prebuilt: IMAGE }, health: { ...profile.app.health, timeout: '1s' } } }
  const { calls, runCompose } = recorder()
  const outcome = await bootApp(command, { runCompose, probe: async () => ({ ok: true }), pollIntervalMs: 1, isolation: run, root })
  expect(outcome).toMatchObject({ kind: 'up' })
  const file = join(tmpdir(), `${run.project}.compose.json`)
  expect(calls[0]?.args).toEqual(['-p', run.project, '-f', file, 'build', '--with-dependencies', 'app'])
  expect(JSON.parse(calls[0]?.files[0] ?? '{}')).toEqual({
    services: {
      app: {
        image: IMAGE,
        pull_policy: 'never',
        command: ['sh', '-c', 'npm start'],
        environment: { PORT: '3000' },
        ports: ['127.0.0.1:${QARE_APP_PORT:-3000}:3000'],
      },
    },
  })
  await stopApp(command, { runCompose, isolation: run })
})

test('without a prebuilt image a compose boot writes no override (#381)', async () => {
  const run = isolation()
  const { calls, runCompose } = recorder()
  await bootApp(await composeProfile(), { runCompose, probe: async () => ({ ok: true }), pollIntervalMs: 1, isolation: run })
  expect(calls[0]?.args).toEqual(['-p', run.project, '-f', 'compose.qa.yaml', 'build', '--with-dependencies', 'admin'])
  expect(existsSync(baseImageOverrideFile(run.project))).toBe(false)
})

test('reaping a base side\'s project removes the override the run wrote for it (#381)', async () => {
  const run = isolation()
  const { runCompose } = recorder()
  await bootApp(await composeProfile(IMAGE), { runCompose, probe: async () => ({ ok: true }), pollIntervalMs: 1, isolation: run })
  expect(existsSync(baseImageOverrideFile(run.project))).toBe(true)
  expect(await reapProjects({ projects: [run.project], runCompose })).toEqual({ reaped: [run.project], failures: [] })
  expect(existsSync(baseImageOverrideFile(run.project))).toBe(false)
})
