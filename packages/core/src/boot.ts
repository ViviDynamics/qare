import { spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { clientCellProblem, startClientCell, type ClientCell } from './client-cell.js'
import { electronDisplayProblem, type ElectronHost } from './flow-electron.js'
import { clientExecutableName, type ProfileApp, type ProfileClient, type QaProfile } from './profile.js'
import { VERSION } from './version.js'
import { parseDurationMs } from './duration.js'
import { composeEnv, hasMintedProject, mintIsolation, type RunIsolation } from './isolation.js'
import { DEFAULT_CLIENT_HEALTH_TIMEOUT, electronHealthCheck, provisionClient, type ProvisionOpts, type ProvisionSide, type ProvisionedArtefact } from './provision.js'

/**
 * The build a client profile's flows launch (#72, #75): where it is, what it
 * was provisioned from when the run installed it, and how it is taken away.
 */
/** What a cell is made for (#223): the repository, the hosts the profile declares, and the install when the build is not in the repository. */
export interface CellRequest {
  repoPath: string
  hosts: readonly string[]
  install?: string
}

/** How a run makes a cell: the caller's own way, or docker and the image the run is in. */
export function clientCellStarter(seam: BootOpts['clientCell']): (request: CellRequest) => Promise<ClientCell> {
  return seam?.start ?? ((request) => startClientCell({ ...request, image: process.env.QARE_IMAGE_REF ?? '' }))
}

export interface BootedClient {
  /** What the driver launches: the build in the checkout, or the one the run installed. */
  executable: string
  /** Where the run installed the build (#75), which a cell is handed to launch it from (#223); absent for a build launched in place. */
  install?: string
  /** What the side was provisioned from; absent for a build launched in place. */
  artefact?: ProvisionedArtefact
  /** The provisioning log so far; a teardown appends to it. */
  log: () => string
  /** Remove what the run installed, leaving nothing; a build launched in place has nothing to remove. */
  teardown: () => Promise<{ ok: boolean; reason?: string }>
}

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
  /** The build to launch, when the profile names a client and it came up (#75). */
  client?: BootedClient
  /** What a blocked provisioning got as far as obtaining (#75). */
  artefact?: ProvisionedArtefact
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
  /**
   * The deadline for a compose `down` this seam issues: the runner kills its
   * child at it. 0 (the default) sets no deadline; the cancellation path
   * always bounds its down, so a canceled run cannot hang past it on a compose
   * call that never settles (#53).
   */
  downTimeoutMs?: number
  /**
   * Where the run's check cache lives (#47). Off by default: a run without
   * one executes every check for real. The runner reads and writes it; the
   * boot only carries it, because every run-level option rides in here.
   */
  cacheDir?: string
  /**
   * Where a client profile's executable resolves from (#72): the repository
   * the run checks. The working directory when the caller names none.
   */
  root?: string
  /** The environment a client build is launched into (#72); the process's own by default. */
  clientEnv?: ElectronHost
  /** Which side of the comparison a client artefact is provisioned for (#75); the head by default. */
  side?: ProvisionSide
  /** The tree a side's build command runs in (#75): a checkout of the base for the base side. `root` by default. */
  buildRoot?: string
  /** What a build command and the health check's launch are run with (#91): `minimal` on a host. */
  clientEnvironment?: 'inherit' | 'minimal'
  /** The provisioning seams (#75): installers by kind, the command runner, the health check, where installs go. */
  provision?: Pick<ProvisionOpts, 'installers' | 'runCommand' | 'health' | 'installRoot'>
  /**
   * How a client build's cell is made (#223): whether this host can make one,
   * and the making. Docker and the process's own environment by default.
   */
  clientCell?: {
    problem?: () => Promise<string | undefined>
    start?: (opts: CellRequest) => Promise<ClientCell>
  }
}

const DEFAULT_POLL_INTERVAL_MS = 500
const NO_DEADLINE_MS = 0
// A killed child gets SIGTERM first; SIGKILL only if it is still running after
// this grace, mirroring the command-check runner.
const COMPOSE_KILL_GRACE_MS = 500
// A runner that never settles is waited on for a grace only, so the watchdog's
// down is never put off for longer than that. The grace outlives the kill
// grace, so the default runner's up — which settles only after its child is
// dead — wins the wait before the grace ever fires.
const DRAIN_GRACE_MS = COMPOSE_KILL_GRACE_MS + 250

// The cancellation down is bounded: a compose call that never settles — a hung
// docker daemon — cannot hold a canceled run's exit open past it (#53). The
// stack a timed-out down leaves behind is what `qare reap` is for.
export const CANCEL_DOWN_TIMEOUT_MS = 30_000

// The compose children the default runner still has in flight, keyed by the
// project name their args open with (`''` for a projectless call), so a cancel
// can kill exactly the canceled run's children (#53): one run's cancellation
// must not kill another run's compose child.
const activeComposeChildren = new Map<string, Set<ChildProcess>>()

function trackComposeChild(projectKey: string, child: ChildProcess): void {
  const children = activeComposeChildren.get(projectKey) ?? new Set()
  children.add(child)
  activeComposeChildren.set(projectKey, children)
}

function untrackComposeChild(projectKey: string, child: ChildProcess): void {
  const children = activeComposeChildren.get(projectKey)
  if (children === undefined) return
  children.delete(child)
  if (children.size === 0) activeComposeChildren.delete(projectKey)
}

/**
 * Kill the compose children the default runner still has in flight for
 * `project`. SIGKILL, so nothing survives to create resources the subsequent
 * down cannot see (#53). Without a project, every project's children are
 * killed.
 */
export function killActiveCompose(project?: string): void {
  for (const [key, children] of activeComposeChildren) {
    if (project !== undefined && project !== key) continue
    for (const child of children) child.kill('SIGKILL')
    children.clear()
    activeComposeChildren.delete(key)
  }
}

/**
 * The compose runner every compose call falls back to when the caller injects
 * no seam. `env`, when given, is merged over the harness environment, so a
 * profile compose file can bind `${QARE_APP_PORT}` (#53). A call never outlives
 * its deadline: the runner kills the child it spawned at it, so an up that
 * outlived the boot's health deadline stops provisioning resources a teardown
 * could then miss (#53).
 */
export function defaultRunCompose(args: string[], timeoutMs: number, env?: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['compose', ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } })
    // Every call the harness composes opens with `-p <project>` (#53); a
    // projectless call is keyed ''.
    const projectKey = args[0] === '-p' && args[1] !== undefined ? args[1] : ''
    trackComposeChild(projectKey, child)
    let stdout = ''
    let stderr = ''
    let killed = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    // A deadline of 0 (NO_DEADLINE_MS) sets no deadline.
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            killed = true
            child.kill('SIGTERM')
            killTimer = setTimeout(() => child.kill('SIGKILL'), COMPOSE_KILL_GRACE_MS)
          }, timeoutMs)
        : undefined
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      if (timer !== undefined) clearTimeout(timer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      untrackComposeChild(projectKey, child)
      resolve({ code: -1, stdout, stderr: `${stderr}${String(error)}` })
    })
    child.on('close', (code) => {
      if (timer !== undefined) clearTimeout(timer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      untrackComposeChild(projectKey, child)
      resolve({ code: killed ? -1 : (code ?? -1), stdout, stderr })
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

/** Where a client profile's executable is, resolved from the repository the run checks (#72). */
export function clientExecutablePath(client: ProfileClient, root: string = process.cwd()): string {
  return resolve(root, clientExecutableName(client))
}

/**
 * A client profile names a build the run launches (#72): nothing boots, and
 * each flow check starts the build for itself. What the launch needs is
 * checked once, here, so a build that is not there or a host that cannot show
 * a window blocks the run by name instead of leaving every check to find out.
 * A profile that names an artefact is provisioned instead (#75): obtained,
 * installed and proven up, with every step in the log the outcome carries.
 */
async function probeClient(client: ProfileClient, opts: BootOpts): Promise<BootOutcome> {
  // Fail closed (#223): a build runs contained or, when its profile says so
  // in as many words, uncontained. A host that cannot make a cell blocks the
  // run here, by name, before anything is built, installed or launched; it
  // never runs the build with the step's network because containing it
  // turned out to be inconvenient.
  const contained = client.egress !== 'uncontained'
  const cellProblem = async (): Promise<BootOutcome | undefined> => {
    if (!contained) return undefined
    const problem = await (opts.clientCell?.problem ?? ((): Promise<string | undefined> => clientCellProblem()))()
    return problem === undefined ? undefined : { kind: 'blocked', reason: problem, logs: '' }
  }
  const root = opts.root ?? process.cwd()
  const startCell = clientCellStarter(opts.clientCell)
  const hosts = client.hosts ?? []
  if (client.artefact !== undefined) {
    const uncontainable = await cellProblem()
    if (uncontainable !== undefined) return uncontainable
    const provision = await provisionClient(client, {
      root: opts.root ?? process.cwd(),
      ...(opts.side === undefined ? {} : { side: opts.side }),
      ...(opts.buildRoot === undefined ? {} : { buildRoot: opts.buildRoot }),
      ...(opts.clientEnvironment === undefined ? {} : { environment: opts.clientEnvironment }),
      ...(opts.clientEnv === undefined ? {} : { host: opts.clientEnv }),
      // The health check's launch is a launch like any other: in a cell.
      ...(contained ? { cell: (install: string) => startCell({ repoPath: root, hosts, install }) } : {}),
      ...opts.provision,
    })
    if (provision.kind === 'blocked')
      return { kind: 'blocked', reason: provision.reason, logs: provision.log(), ...(provision.artefact === undefined ? {} : { artefact: provision.artefact }) }
    return {
      kind: 'up',
      logs: provision.log(),
      client: { executable: provision.executable, install: provision.install, artefact: provision.artefact, log: provision.log, teardown: provision.teardown },
    }
  }
  const path = clientExecutablePath(client, opts.root)
  let isFile = false
  try {
    isFile = (await stat(path)).isFile()
  } catch {
    // Absent, or unreadable: either way there is nothing to launch.
  }
  // The path is inside the repository as written; what it resolves to must
  // be too. A link that leads out of the checkout is some other binary, and
  // the run launches the repository's build or nothing.
  if (isFile) {
    const [real, rootReal] = await Promise.all([realpath(path), realpath(opts.root ?? process.cwd())])
    const inside = relative(rootReal, real)
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside))
      return {
        kind: 'blocked',
        reason: `client.executable ${client.executable} resolves outside the repository the run checks (${real}): the run launches the repository's own build, never another binary on the host`,
        logs: '',
      }
  }
  if (!isFile)
    return {
      kind: 'blocked',
      reason: `the client build is not there to launch: client.executable ${client.executable} resolves to ${path}, which is not a file; building it is the project's own step, before the run`,
      logs: '',
    }
  // A build that is there is held to being containable before it is launched.
  const uncontainable = await cellProblem()
  if (uncontainable !== undefined) return uncontainable
  // An uncontained build opens its windows on this host; a contained one on
  // the display its cell starts.
  const display = contained ? undefined : electronDisplayProblem(opts.clientEnv)
  if (display !== undefined) return { kind: 'blocked', reason: display, logs: '' }
  // The health check a profile asks for (#75): the build is launched once
  // and held to opening its first window. A #72 profile that does not ask is
  // launched by its first flow check, as before.
  const lines: string[] = []
  if (client.health !== undefined) {
    const health = opts.provision?.health ?? electronHealthCheck(opts.clientEnv, opts.clientEnvironment, contained ? () => startCell({ repoPath: root, hosts }) : undefined)
    const timeout = client.health.timeout ?? DEFAULT_CLIENT_HEALTH_TIMEOUT
    let healthy: Awaited<ReturnType<typeof health>>
    try {
      healthy = await health({ executable: path, args: client.args, timeoutMs: parseDurationMs(timeout) })
    } catch (error) {
      healthy = { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
    for (const line of healthy.lines ?? []) lines.push(`[health] ${line}`)
    if (!healthy.ok) {
      lines.push(`[health] the build did not come up: ${healthy.reason}`)
      return {
        kind: 'blocked',
        reason: `the client build ${client.executable} is there, but it did not come up within ${timeout}: ${healthy.reason}`,
        logs: `${lines.join('\n')}\n`,
      }
    }
    lines.push(`[health] the build came up within ${timeout}`)
  }
  // Nothing was installed: the build is launched where it is, by path, and
  // there is nothing for a teardown to remove.
  return { kind: 'up', logs: lines.length === 0 ? '' : `${lines.join('\n')}\n` }
}

export async function bootApp(profile: QaProfile, opts: BootOpts = {}): Promise<BootOutcome> {
  if (profile.client !== undefined) return probeClient(profile.client, opts)
  if (profile.app === undefined) return probeTarget(profile, opts)
  const app = profile.app
  const runCompose = opts.runCompose ?? defaultRunCompose
  // One project per boot (#53): the caller's isolation when it carries one, a
  // minted one otherwise, so concurrent boots never share a project name,
  // network or volumes. Every compose call below opens with this `-p`.
  const isolation = opts.isolation ?? mintIsolation()
  // The boot seam is public: a caller-carried isolation naming a project
  // outside the harness namespace is refused before any compose call — the
  // same invariant the run refuses on — so `-p` never addresses a foreign
  // project (#53).
  if (opts.isolation !== undefined && !hasMintedProject(isolation)) {
    return {
      kind: 'blocked',
      reason: 'the run isolation does not carry a usable project: the compose project is qare-<run id>, so a leftover stack is always findable by reap and a project qare never minted is never touched',
      logs: '',
      isolation,
    }
  }
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
  let started: Promise<{ code: number; stdout: string; stderr: string }>
  try {
    started = runCompose(['-p', isolation.project, '-f', app.boot.compose, 'up', '-d', '--wait', app.boot.service], timeoutMs, env)
    // The losing branch of the race is drained, so a compose up that settles
    // late after the watchdog does not crash the process unhandled.
    void started.catch(() => {})
    up = await Promise.race([watchdog, started])
  } catch (error) {
    clearTimeout(timer)
    return { kind: 'blocked', reason: `boot command failed to start: ${String(error)}`, logs: '', isolation }
  }
  clearTimeout(timer)

  if (up === 'watchdog') {
    // The losing branch is drained before the down: a compose up that is
    // still provisioning must not resurrect the project after the down has
    // run (#53). The default runner kills its child at the deadline, so the
    // up settles shortly after it; a runner that never settles is waited on
    // for a grace only, so the down is never put off for longer than that.
    const drained = new Promise((resolve) => {
      const grace = setTimeout(resolve, DRAIN_GRACE_MS)
      grace.unref()
    })
    void Promise.race([started.then(() => undefined, () => undefined), drained]).then(() => {
      void stopApp(profile, { ...opts, isolation })
    })
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
 * runs projectless, as today. The stop seam is public, so a caller-carried
 * isolation whose project is not `qare-<run id>` is refused rather than
 * downed: a project outside the harness namespace is never a stop target.
 */
export async function stopApp(profile: QaProfile, opts: BootOpts = {}): Promise<void> {
  if (profile.app === undefined) return
  if (opts.isolation !== undefined && !hasMintedProject(opts.isolation)) {
    console.error(
      'compose down refused: the run isolation does not carry a usable project: the compose project is qare-<run id>, so a leftover stack is always findable by reap and a project qare never minted is never touched',
    )
    return
  }
  const runCompose = opts.runCompose ?? defaultRunCompose
  try {
    await runCompose(
      [...(opts.isolation === undefined ? [] : ['-p', opts.isolation.project]), '-f', profile.app.boot.compose, 'down'],
      opts.downTimeoutMs ?? NO_DEADLINE_MS,
      composeEnv(opts.isolation),
    )
  } catch (error) {
    console.error(`compose down failed: ${String(error)}`)
  }
}
