import { spawn } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import type { QaProfile } from './profile.js'

export interface BootOutcome {
  kind: 'up' | 'blocked'
  reason?: string
  logs: string
}

export interface BootOpts {
  runCompose?: (args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>
  probe?: (url: string) => Promise<{ ok: boolean }>
  pollIntervalMs?: number
}

const DEFAULT_POLL_INTERVAL_MS = 500
const NO_DEADLINE_MS = 0

function parseTimeoutMs(timeout: string): number {
  const match = /^(\d+)(ms|s|m)$/.exec(timeout.trim())
  if (!match) {
    throw new Error(`app.health.timeout "${timeout}" is not a duration like 120s`)
  }
  const value = Number(match[1])
  if (match[2] === 'ms') return value
  if (match[2] === 's') return value * 1000
  return value * 60000
}

function defaultRunCompose(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  void timeoutMs
  return new Promise((resolve) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      resolve({ code: -1, stdout, stderr: `${stderr}${String(error)}` })
    })
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

function defaultProbe(url: string, timeoutMs: number): Promise<{ ok: boolean }> {
  return new Promise((resolve) => {
    const request = new URL(url)
    const isHttps = request.protocol === 'https:'
    const mod = isHttps ? https : http
    const req = mod.request(
      request,
      { method: 'GET', timeout: timeoutMs },
      (res: { resume: () => void; statusCode?: number }) => {
        res.resume()
        resolve({ ok: res.statusCode === 200 })
      },
    )
    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false })
    })
    req.on('error', () => {
      resolve({ ok: false })
    })
    req.end()
  })
}

async function captureComposeLogs(profile: QaProfile, opts: BootOpts): Promise<string> {
  const runCompose = opts.runCompose ?? defaultRunCompose
  const logs = await runCompose(
    ['-f', profile.app.boot.compose, 'logs', '--no-color', profile.app.boot.service],
    NO_DEADLINE_MS,
  )
  return logs.stdout + logs.stderr
}

export async function bootApp(profile: QaProfile, opts: BootOpts = {}): Promise<BootOutcome> {
  const runCompose = opts.runCompose ?? defaultRunCompose
  const probe = opts.probe ?? ((url: string) => defaultProbe(url, 1000))
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  let timeoutMs: number
  try {
    timeoutMs = parseTimeoutMs(profile.app.health.timeout)
  } catch (error) {
    return {
      kind: 'blocked',
      reason: error instanceof Error ? error.message : String(error),
      logs: '',
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const watchdog = new Promise<'watchdog'>((resolve) => {
    timer = setTimeout(() => resolve('watchdog'), timeoutMs)
  })
  let up: { code: number; stdout: string; stderr: string } | 'watchdog'
  try {
    up = await Promise.race([
      watchdog,
      runCompose(
        ['-f', profile.app.boot.compose, 'up', '-d', '--wait', profile.app.boot.service],
        timeoutMs,
      ),
    ])
  } catch (error) {
    clearTimeout(timer)
    return { kind: 'blocked', reason: `boot command failed to start: ${String(error)}`, logs: '' }
  }
  clearTimeout(timer)

  if (up === 'watchdog') {
    void stopApp(profile, opts)
    return { kind: 'blocked', reason: 'boot watchdog: compose up exceeded the health deadline', logs: '' }
  }

  if (up.code !== 0) {
    const logs = `${up.stdout}${up.stderr}`
    return {
      kind: 'blocked',
      reason: `compose up exited ${up.code}`,
      logs: logs || (await captureComposeLogs(profile, opts)),
    }
  }

  const deadline = Date.now() + timeoutMs
  let lastProbe = { ok: false }
  while (Date.now() < deadline) {
    try {
      lastProbe = await probe(profile.app.health.http)
    } catch (error) {
      lastProbe = { ok: false }
      void error
    }
    if (lastProbe.ok) {
      return { kind: 'up', logs: up.stdout }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }

  const logs = `${up.stdout}${up.stderr}`
  return {
    kind: 'blocked',
    reason: `health check at ${profile.app.health.http} did not pass within ${profile.app.health.timeout}`,
    logs: logs || (await captureComposeLogs(profile, opts)),
  }
}

export async function stopApp(profile: QaProfile, opts: BootOpts = {}): Promise<void> {
  const runCompose = opts.runCompose ?? defaultRunCompose
  try {
    await runCompose(['-f', profile.app.boot.compose, 'down'], NO_DEADLINE_MS)
  } catch (error) {
    console.error(`compose down failed: ${String(error)}`)
  }
}
