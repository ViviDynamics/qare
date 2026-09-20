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
