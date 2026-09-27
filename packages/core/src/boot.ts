import { spawn } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import type { ProfileApp, QaProfile } from './profile.js'
import { VERSION } from './version.js'
import { parseDurationMs } from './duration.js'
import { composeEnv, mintIsolation, type RunIsolation } from './isolation.js'

export interface BootOutcome {
  kind: 'up' | 'blocked'
  reason?: string
  logs: string
  /**
   * The isolation the boot ran under (#53): the caller's, or the one minted
   * when it carried none, so a caller that did not carry one can still stop
   * the project this boot created. A target boot booted nothing, so it names
   * no isolation.
   */
  isolation?: RunIsolation
}

export interface BootOpts {
  /**
   * Runs `docker compose` with these arguments; args begin after the `compose`
   * subcommand and open with the run's `-p` project (#53). `env` is merged over
   * the harness environment, so a profile compose file can bind the run's port.
   */
  runCompose?: (args: string[], timeoutMs: number, env?: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }>
  probe?: (url: string) => Promise<{ ok: boolean }>
  pollIntervalMs?: number
  /**
   * The run's compose isolation (#53): the `-p` project every call addresses.
   * When the caller does not carry one, the boot mints its own, so two boots
   * never share a project name, network or volumes.
   */
  isolation?: RunIsolation
}

const DEFAULT_POLL_INTERVAL_MS = 500
const NO_DEADLINE_MS = 0

/**
 * The compose runner every compose call falls back to when the caller injects
 * no seam. `env`, when given, is merged over the harness environment, so a
 * profile compose file can bind `${QARE_APP_PORT}` (#53).
 */
export function defaultRunCompose(args: string[], timeoutMs: number, env?: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  void timeoutMs
  return new Promise((resolve) => {
    const child = spawn('docker', ['compose', ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } })
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
      // Named, because public sites refuse an anonymous client (#122).
      { method: 'GET', timeout: timeoutMs, headers: { 'user-agent': `qare/${VERSION} (health check)` } },
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

async function captureComposeLogs(app: ProfileApp, opts: BootOpts, isolation: RunIsolation): Promise<string> {
  const runCompose = opts.runCompose ?? defaultRunCompose
  const logs = await runCompose(['-p', isolation.project, '-f', app.boot.compose, 'logs', '--no-color', app.boot.service], NO_DEADLINE_MS, composeEnv(isolation))
  return logs.stdout + logs.stderr
}

const LOCAL_PROBE_TIMEOUT_MS = 1000
// A remote target can take longer than a local stack to send its headers.
const REMOTE_PROBE_TIMEOUT_MS = 10000

/**
 * Poll the health URL until it answers 200 or the deadline passes. Redirects
 * are not followed: the health URL names the page that answers.
 */
async function waitForHealth(url: string, timeoutMs: number, opts: BootOpts, probeTimeoutMs = LOCAL_PROBE_TIMEOUT_MS): Promise<boolean> {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const deadline = Date.now() + timeoutMs
  // No probe outlives the deadline: a target that accepts and never answers
  // is blocked when its timeout says, not a probe later.
  const probe = opts.probe ?? ((target: string) => defaultProbe(target, Math.max(1, Math.min(probeTimeoutMs, deadline - Date.now()))))
  while (Date.now() < deadline) {
    try {
      if ((await probe(url)).ok) return true
    } catch {
      // A probe that throws is a probe that did not pass.
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
  return false
}

/**
 * A target profile names an app that is already running (#122): nothing boots,
 * and the health check alone proves the target is up. A target that never
 * answers is blocked, naming the URL, so no criterion is read as failed.
 */
async function probeTarget(profile: QaProfile, opts: BootOpts): Promise<BootOutcome> {
  const target = profile.target
  if (target === undefined) return { kind: 'blocked', reason: 'the profile names neither app nor target', logs: '' }
  let timeoutMs: number
  try {
    timeoutMs = parseDurationMs(target.health.timeout)
  } catch (error) {
    return { kind: 'blocked', reason: `target.health.timeout ${error instanceof Error ? error.message : String(error)}`, logs: '' }
  }
  if (await waitForHealth(target.health.http, timeoutMs, opts, Math.min(timeoutMs, REMOTE_PROBE_TIMEOUT_MS))) return { kind: 'up', logs: '' }
  return {
    kind: 'blocked',
    reason: `target ${target.url} is not reachable: its health check at ${target.health.http} did not pass within ${target.health.timeout}`,
    logs: '',
  }
}

export async function bootApp(profile: QaProfile, opts: BootOpts = {}): Promise<BootOutcome> {
  if (profile.app === undefined) return probeTarget(profile, opts)
  const app = profile.app
  const runCompose = opts.runCompose ?? defaultRunCompose
  // One project per boot (#53): the caller's isolation when it carries one, a
  // minted one otherwise, so concurrent boots never share a project name,
  // network or volumes. Every compose call below opens with this `-p`.
  const isolation = opts.isolation ?? mintIsolation()
  const env = composeEnv(isolation)
  let timeoutMs: number
  try {
    timeoutMs = parseDurationMs(app.health.timeout)
  } catch (error) {
    return {
      kind: 'blocked',
      reason: `app.health.timeout ${error instanceof Error ? error.message : String(error)}`,
      logs: '',
      isolation,
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
      runCompose(['-p', isolation.project, '-f', app.boot.compose, 'up', '-d', '--wait', app.boot.service], timeoutMs, env),
    ])
  } catch (error) {
    clearTimeout(timer)
    return { kind: 'blocked', reason: `boot command failed to start: ${String(error)}`, logs: '', isolation }
  }
  clearTimeout(timer)

  if (up === 'watchdog') {
    void stopApp(profile, { ...opts, isolation })
    return { kind: 'blocked', reason: 'boot watchdog: compose up exceeded the health deadline', logs: '', isolation }
  }

  if (up.code !== 0) {
    const logs = `${up.stdout}${up.stderr}`
    return {
      kind: 'blocked',
      reason: `compose up exited ${up.code}`,
      logs: logs || (await captureComposeLogs(app, opts, isolation)),
      isolation,
    }
  }

  if (await waitForHealth(app.health.http, timeoutMs, opts)) return { kind: 'up', logs: up.stdout, isolation }

  const logs = `${up.stdout}${up.stderr}`
  return {
    kind: 'blocked',
    reason: `health check at ${app.health.http} did not pass within ${app.health.timeout}`,
    logs: logs || (await captureComposeLogs(app, opts, isolation)),
    isolation,
  }
}

/**
 * Tear the booted stack down; a target profile booted nothing, so there is
 * nothing to stop. The caller passes the isolation the boot used, so `down`
 * addresses the same `-p` project `up` did (#53); with none passed, the down
 * runs projectless, as today.
 */
export async function stopApp(profile: QaProfile, opts: BootOpts = {}): Promise<void> {
  if (profile.app === undefined) return
  const runCompose = opts.runCompose ?? defaultRunCompose
  try {
    await runCompose(
      [...(opts.isolation === undefined ? [] : ['-p', opts.isolation.project]), '-f', profile.app.boot.compose, 'down'],
      NO_DEADLINE_MS,
      composeEnv(opts.isolation),
    )
  } catch (error) {
    console.error(`compose down failed: ${String(error)}`)
  }
}
