import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { expect, test } from 'vitest'
import { bootApp, loadProfile, stopApp, type QaProfile } from '../src/index.js'

const fixtureDir = new URL('../fixtures/qa-valid/.qa', import.meta.url)
const HEALTH_URL = ['http:', '//localhost:3000/up'].join('')

function deepMerge(base: unknown, overrides: Record<string, unknown>): QaProfile {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) {
    return overrides as never
  }
  const merged: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(overrides)) {
    merged[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? deepMerge(merged[key] ?? {}, value)
      : value
  }
  return merged as QaProfile
}

async function profileWith(overrides: Record<string, unknown>): Promise<QaProfile> {
  const profile = await loadProfile(fixtureDir.pathname)
  return deepMerge(profile, overrides)
}

test('healthy boot polls health and reports up', async () => {
  const profile = await profileWith({ app: { health: { timeout: '1s' } } })
  const composeArgs: string[][] = []
  const probedUrls: string[] = []

  const outcome = await bootApp(profile, {
    runCompose: async (args) => {
      composeArgs.push(args)
      return { code: 0, stdout: 'up out', stderr: 'up err' }
    },
    probe: async (url) => {
      probedUrls.push(url)
      return { ok: true }
    },
    pollIntervalMs: 1,
  })

  expect(outcome).toEqual({ kind: 'up', logs: 'up out' })
  expect(composeArgs).toEqual([['-f', 'compose.qa.yaml', 'up', '-d', '--wait', 'admin']])
  expect(probedUrls).toEqual([HEALTH_URL])
})

test('unhealthy boot blocks naming the health URL', async () => {
  const profile = await profileWith({ app: { health: { timeout: '1s' } } })

  const outcome = await bootApp(profile, {
    runCompose: async () => ({ code: 0, stdout: 'up out', stderr: '' }),
    probe: async () => ({ ok: false }),
    pollIntervalMs: 1,
  })

  expect(outcome.kind).toBe('blocked')
  expect(outcome.reason).toContain(HEALTH_URL)
  expect(outcome.reason).toContain('1s')
  expect(outcome.logs).toBe('up out')
})

test('compose failure blocks with the exit code and captured logs', async () => {
  const profile = await profileWith({ app: { health: { timeout: '1s' } } })

  const outcome = await bootApp(profile, {
    runCompose: async () => ({ code: 1, stdout: 'partial output', stderr: 'compose boom' }),
  })

  expect(outcome.kind).toBe('blocked')
  expect(outcome.reason).toContain('exited 1')
  expect(outcome.logs).toContain('compose boom')
})

test('watchdog blocks compose up that outlives the health deadline and attempts a down', async () => {
  const profile = await profileWith({ app: { health: { timeout: '1s' } } })
  const composeArgs: string[][] = []

  const outcome = await bootApp(profile, {
    runCompose: async (args) => {
      composeArgs.push(args)
      return new Promise<{ code: number; stdout: string; stderr: string }>(() => {})
    },
    pollIntervalMs: 1,
  })

  expect(outcome).toEqual({
    kind: 'blocked',
    reason: 'boot watchdog: compose up exceeded the health deadline',
    logs: '',
  })
  expect(composeArgs).toEqual([
    ['-f', 'compose.qa.yaml', 'up', '-d', '--wait', 'admin'],
    ['-f', 'compose.qa.yaml', 'down'],
  ])
})

test('probe errors keep polling until the deadline', async () => {
  const profile = await profileWith({ app: { health: { timeout: '30ms' } } })
  let probes = 0

  const outcome = await bootApp(profile, {
    runCompose: async () => ({ code: 0, stdout: 'up out', stderr: '' }),
    probe: async () => {
      probes += 1
      throw new Error('probe exploded')
    },
    pollIntervalMs: 1,
  })

  expect(outcome.kind).toBe('blocked')
  expect(outcome.reason).toContain('did not pass within')
  expect(outcome.reason).toContain('30ms')
  expect(probes).toBeGreaterThan(1)
  expect(outcome.logs).toBe('up out')
})

test('malformed health timeout blocks instead of crashing the boot', async () => {
  const profile = await profileWith({ app: { health: { timeout: 'bogus' } } })

  const outcome = await bootApp(profile, {
    runCompose: async () => ({ code: 0, stdout: 'up out', stderr: '' }),
  })

  expect(outcome.kind).toBe('blocked')
  expect(outcome.reason).toContain('app.health.timeout')
  expect(outcome.reason).toContain('bogus')
  expect(outcome.logs).toBe('')
})

test('stopApp brings the compose service down', async () => {
  const profile = await profileWith({ app: { health: { timeout: '1s' } } })
  const composeArgs: string[][] = []

  await stopApp(profile, {
    runCompose: async (args) => {
      composeArgs.push(args)
      return { code: 0, stdout: '', stderr: '' }
    },
  })

  expect(composeArgs).toEqual([['-f', 'compose.qa.yaml', 'down']])
})

test('the default compose runner calls docker compose, not bare docker', async () => {
  // A fake docker on PATH echoes its arguments, so this pins what the default
  // runner really spawns rather than what a test seam is handed.
  const bin = await mkdtemp(join(tmpdir(), 'qare-docker-'))
  await writeFile(join(bin, 'docker'), '#!/bin/sh\necho "$@"\n', { mode: 0o755 })
  const savedPath = process.env.PATH
  process.env.PATH = `${bin}${delimiter}${savedPath ?? ''}`
  try {
    const profile = await profileWith({ app: { health: { timeout: '1s' } } })
    const outcome = await bootApp(profile, { probe: async () => ({ ok: true }), pollIntervalMs: 1 })

    expect(outcome).toEqual({ kind: 'up', logs: 'compose -f compose.qa.yaml up -d --wait admin\n' })
  } finally {
    process.env.PATH = savedPath
    await rm(bin, { recursive: true, force: true })
  }
})
