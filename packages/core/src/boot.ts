import { spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import { existsSync } from 'node:fs'
import { realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { clientCellProblem, startClientCell, type ClientCell } from './client-cell.js'
import { electronDisplayProblem, type ElectronHost } from './flow-electron.js'
import { clientExecutableName, isCommandBoot, type CommandBoot, type ComposeBoot, type ProfileApp, type ProfileClient, type QaProfile } from './profile.js'
import { VERSION } from './version.js'
import { serviceFailed } from './result.js'
import { parseDurationMs } from './duration.js'
import { composeEnv, hasMintedProject, mintIsolation, type RunIsolation } from './isolation.js'
import { parseSinkRecord, type SinkRecord } from './egress-sink.js'
import {
  containedAddresses,
  containmentOf,
  containmentOverrideFile,
  NO_EGRESS_IMAGE,
  dnsOverride,
  dnsOverrideFile,
  EGRESS_DNS_SERVICE,
  EGRESS_MAP_FILE,
  EGRESS_RELAY_SERVICE,
  relayOverride,
  relayOverrideFile,
  type ComposeConfig,
  type RelayPlan,
} from './stack-egress.js'
import { defaultRunDocker } from './base-image.js'
import { DEFAULT_CLIENT_HEALTH_TIMEOUT, electronHealthCheck, provisionClient, type ProvisionOpts, type ProvisionSide, type ProvisionedArtefact } from './provision.js'

/**
 * The build a client profile's flows launch (#72, #75): where it is, what it
 * was provisioned from when the run installed it, and how it is taken away.
 */
/**
 * What a cell is made for (#223): the repository the run checks, the hosts
 * the profile declares, and the directory the build is launched from, which
 * is the one its executable is in or the one the run installed it to (#75).
 */
export interface CellRequest {
  repoPath: string
  hosts: readonly string[]
  install: string
}

/**
 * The executable of a build launched in place, links followed, and the
 * directory it is in: what a cell copies in and launches (#223). The probe
 * has already held the resolved path to being inside the repository.
 */
export async function inPlaceBuild(client: ProfileClient, root: string): Promise<{ executable: string; install: string }> {
  const executable = await realpath(clientExecutablePath(client, root))
  return { executable, install: dirname(executable) }
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
  /**
   * How a booted stack's egress was held (#382): contained on internal
   * networks with the run's resolver, or not, and why not. Absent for a
   * boot that booted no stack.
   */
  egress?: StackEgress
  /**
   * Each service of a stack that did not come up (#407), with the last
   * lines of its log, read before anything took the stack down. Absent when
   * the boot came up or nothing of the stack could be read.
   */
  services?: ServiceLog[]
  /**
   * What a contained stack that did not come up looked up before it failed
   * (#407), read from its resolver before anything took it down. Absent when
   * the stack was not contained or its record could not be read.
   */
  lookups?: SinkRecord
}

/** How a booted stack's egress was held (#382). */
export type StackEgress = { containment: 'contained' } | { containment: 'uncontained'; reason: string }

export interface BootOpts {
  /**
   * Runs `docker compose` with these arguments; args begin after the `compose`
   * subcommand and open with the run's `-p` project (#53). `env` is merged over
   * the harness environment, so a profile compose file can bind the run's port.
   */
  runCompose?: (args: string[], timeoutMs: number, env?: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }>
  probe?: (url: string) => Promise<{ ok: boolean }>
  /**
   * The opt-in buildx layer cache for the images the boot builds (#381):
   * `from` is a directory to read each building service's cache from, `to`
   * one to export it to. Absent, the boot builds with no cache, as before.
   */
  buildCache?: BuildCache
  /** Runs `docker` itself: how the base side pulls and inspects a prebuilt image (#381). The runner's docker by default. */
  runDocker?: (args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>
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
  /**
   * The image a booted stack's resolver and relay run from (#382): the one
   * the run is in (`QARE_IMAGE_REF`) by default. With none, the stack is
   * booted uncontained, and the boot says so.
   */
  egressImage?: string
  /** How long the stack's resolver has to say where it answers (#382); 30 seconds by default. */
  egressReadyTimeoutMs?: number
  /** How long each `ps` or `logs` call reading a failed stack's services may take (#407); 15 seconds by default. */
  serviceLogTimeoutMs?: number
}

const DEFAULT_POLL_INTERVAL_MS = 500
/** How long the image build may take when the profile does not say (`app.boot.build.timeout`). */
export const DEFAULT_BUILD_TIMEOUT = '15m'
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

/** An app whose boot is a compose file: the profile's own, or the one a command boot is written to. */
/** An app as compose boots it, with the override files the run adds (#381). */
type ComposeApp = ProfileApp & { boot: ComposeBoot; overrides?: string[] }

/** The service a command boot runs as (#379), the one service of its project. */
export const COMMAND_BOOT_SERVICE = 'app'
/** Where a command boot's checkout lands in its image, and where its command runs. */
export const COMMAND_BOOT_WORKDIR = '/app'

/** Where the run writes a command boot's compose project (#379): named for the project, so no two runs share one. */
export function commandBootFile(project: string): string {
  return join(tmpdir(), `${project}.compose.json`)
}

/** A string compose reads as itself: every `$` doubled, so no profile text is interpolated. */
function composeLiteral(text: string): string {
  return text.replaceAll('$', '$$$$')
}

/**
 * The compose project a command boot runs as (#379): one service, built
 * from the side's checkout on the named image, running the command from a
 * copy of the checkout with `PORT` set to the port it listens on, and
 * published on the run's port as a compose boot is. The image is built,
 * not mounted, so the app is the pull request's code and cannot write to
 * the runner's workspace. JSON, which compose reads as YAML. The run's
 * `QARE_APP_PORT` is the only thing compose interpolates.
 */
export function commandBootCompose(boot: CommandBoot, root: string): string {
  const port = String(boot.port)
  // A prebuilt image of the base (#381) is the build's result already: it
  // runs as it is, pulled by the run before the boot, never again here.
  const image =
    boot.prebuilt === undefined
      ? { build: { context: composeLiteral(root), dockerfile_inline: composeLiteral(`FROM ${boot.image}\nCOPY . ${COMMAND_BOOT_WORKDIR}\nWORKDIR ${COMMAND_BOOT_WORKDIR}\n`) } }
      : { image: composeLiteral(boot.prebuilt), pull_policy: 'never' }
  return `${JSON.stringify(
    {
      services: {
        [COMMAND_BOOT_SERVICE]: {
          ...image,
          command: ['sh', '-c', composeLiteral(boot.command)],
          environment: { PORT: port },
          ports: [`127.0.0.1:\${QARE_APP_PORT:-${port}}:${port}`],
        },
      },
    },
    null,
    2,
  )}\n`
}

/** Where the run writes a compose boot's base image override (#381): named for the project, so no two runs share one. */
export function baseImageOverrideFile(project: string): string {
  return join(tmpdir(), `${project}.base-image.yml`)
}

/**
 * The override that runs a prebuilt image as a compose boot's service
 * (#381): its image, its build reset (`!reset`, compose 2.24 or later), and
 * no pull, because the run pulled the image by its reference before it
 * checked whose commit it is. YAML, because JSON has no `!reset`; each value
 * is a JSON string, which YAML reads as the same string, with every `$`
 * doubled so compose interpolates nothing.
 */
export function baseImageOverride(service: string, image: string): string {
  return `services:\n  ${JSON.stringify(composeLiteral(service))}:\n    image: ${JSON.stringify(composeLiteral(image))}\n    pull_policy: never\n    build: !reset null\n`
}

/** Where a build cache is read from and written to (#381): one directory per service under each. */
export interface BuildCache {
  from?: string
  to?: string
}

/** Where the run writes a boot's build cache override (#381): named for the project, so no two runs share one. */
export function buildCacheOverrideFile(project: string): string {
  return join(tmpdir(), `${project}.build-cache.json`)
}

/** A compose service name the cache directory may be named for: a plain name, never a path. */
const PLAIN_SERVICE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * The override that gives each service that builds its cache (#381): read
 * from `<from>/<service>` when a cache is there (`has`), and exported to
 * `<to>/<service>` with every layer (`mode=max`). One directory per service,
 * because a local cache export replaces the index of the directory it
 * writes. Undefined when there is nothing to read or write.
 */
export function buildCacheOverride(services: string[], cache: BuildCache, has: (dir: string) => boolean = (dir) => existsSync(join(dir, 'index.json'))): { services: Record<string, { build: { cache_from?: string[]; cache_to?: string[] } }> } | undefined {
  const entries: Record<string, { build: { cache_from?: string[]; cache_to?: string[] } }> = {}
  for (const service of services) {
    if (!PLAIN_SERVICE.test(service)) continue
    const from = cache.from === undefined ? undefined : join(cache.from, service)
    const build = {
      ...(from !== undefined && has(from) ? { cache_from: [`type=local,src=${composeLiteral(from)}`] } : {}),
      ...(cache.to === undefined ? {} : { cache_to: [`type=local,dest=${composeLiteral(join(cache.to, service))},mode=max`] }),
    }
    if (Object.keys(build).length > 0) entries[composeLiteral(service)] = { build }
  }
  return Object.keys(entries).length === 0 ? undefined : { services: entries }
}

/**
 * The services the boot's compose files build, as compose itself resolves
 * them (#381). A compose that cannot say is a boot with no cache, never a
 * boot that fails for it: the cache is an optimisation.
 */
async function servicesThatBuild(app: ComposeApp, runCompose: NonNullable<BootOpts['runCompose']>, isolation: RunIsolation, env: Record<string, string> | undefined): Promise<string[]> {
  try {
    const config = await runCompose(['-p', isolation.project, ...composeFiles(app), 'config', '--format', 'json'], 60_000, env)
    if (config.code !== 0) return []
    const services = (JSON.parse(config.stdout) as { services?: Record<string, { build?: unknown }> }).services ?? {}
    return Object.entries(services)
      .filter(([, service]) => typeof service === 'object' && service !== null && service.build !== undefined && service.build !== null)
      .map(([name]) => name)
  } catch {
    return []
  }
}

/** The compose files a boot names, in order: the app's own, then the run's base image override. */
function composeFiles(app: ComposeApp): string[] {
  return ['-f', app.boot.compose, ...(app.overrides ?? []).flatMap((file) => ['-f', file])]
}

/**
 * The app as the compose boot runs it: a compose boot as it is, and a
 * command boot written to its project file first (#379). A compose boot
 * with a prebuilt image gets the override that runs it (#381).
 */
async function composeAppOf(app: ProfileApp, root: string, isolation: RunIsolation): Promise<ComposeApp> {
  if (!isCommandBoot(app.boot)) {
    if (app.boot.prebuilt === undefined) return app as ComposeApp
    const override = baseImageOverrideFile(isolation.project)
    await writeFile(override, baseImageOverride(app.boot.service, app.boot.prebuilt), { mode: 0o600 })
    return { ...(app as ComposeApp), overrides: [override] }
  }
  const file = commandBootFile(isolation.project)
  await writeFile(file, commandBootCompose(app.boot, resolve(root)), { mode: 0o600 })
  return { ...app, boot: { compose: file, service: COMMAND_BOOT_SERVICE, ...(app.boot.build === undefined ? {} : { build: app.boot.build }) } }
}

/** How long the stack's resolver has to say where it answers before the boot is blocked. */
const DEFAULT_EGRESS_READY_TIMEOUT_MS = 30_000
const EGRESS_POLL_MS = 250
/** A compose call the containment makes beside the boot: reading the stack, starting its resolver, reading its log. */
const EGRESS_CALL_TIMEOUT_MS = 120_000

/** How the boot runs `docker` itself. */
type RunDockerSeam = NonNullable<BootOpts['runDocker']>

/**
 * The address of each running container of the project on its contained
 * network, by compose service (#408), read from the daemon: a daemon may
 * answer no embedded DNS, so nothing of the containment looks a service up
 * by name. A service with no running container is not listed.
 */
async function readContainedAddresses(project: string, runDocker: RunDockerSeam): Promise<Record<string, string[]> | { problem: string }> {
  const listed = await runDocker(['ps', '-q', '--no-trunc', '--filter', `label=com.docker.compose.project=${project}`], EGRESS_CALL_TIMEOUT_MS)
  if (listed.code !== 0) return { problem: `docker ps exited ${listed.code}` }
  const ids = listed.stdout.split(/\s+/).filter((id) => id !== '')
  if (ids.length === 0) return {}
  const inspected = await runDocker(['inspect', ...ids], EGRESS_CALL_TIMEOUT_MS)
  if (inspected.code !== 0) return { problem: `docker inspect exited ${inspected.code}` }
  return containedAddresses(inspected.stdout, project) ?? { problem: 'docker inspect did not describe the containers' }
}

/**
 * Take a stack the run could not finish containing down (#408), and the
 * containment overrides with it, so it boots again as it is: a stack is
 * never booted half contained. The reason why is undefined when it is down.
 */
async function abandonContainment(app: ComposeApp, isolation: RunIsolation, runCompose: NonNullable<BootOpts['runCompose']>, env: Record<string, string> | undefined): Promise<{ problem: string; logs: string } | undefined> {
  const down = await runCompose(['-p', isolation.project, ...composeFiles(app), 'down'], EGRESS_CALL_TIMEOUT_MS, env)
  if (down.code !== 0) return { problem: `the stack could not be taken down to boot it uncontained: compose down exited ${down.code}`, logs: `${down.stdout}${down.stderr}` }
  for (const file of [containmentOverrideFile(isolation.project), dnsOverrideFile(isolation.project), relayOverrideFile(isolation.project)]) await rm(file, { force: true }).catch(() => {})
  return undefined
}

/** Contained, the forwards the relay is handed once the stack is up; or why the stack boots as it is; or what blocks the boot. */
type Contained = { app: ComposeApp; egress: StackEgress; forwards?: RelayPlan[] } | { blocked: string; logs: string }

/**
 * Contain the stack before it boots (#382): read it as compose resolves it,
 * write the override that makes its networks internal and moves its
 * published ports to the relay, start the resolver alone, and once it has
 * said its address, point every service's resolver at it. The services that
 * provide stubs start next, and the resolver is handed their addresses as
 * the daemon gives them (#408). A stack the run cannot hold to that boots as
 * it is, and says why; one it began to contain is taken down first. A
 * containment that fails part way and cannot be undone blocks the boot: a
 * stack is never booted half contained.
 */
async function containStack(
  app: ComposeApp,
  profile: QaProfile,
  opts: BootOpts,
  runCompose: NonNullable<BootOpts['runCompose']>,
  isolation: RunIsolation,
  env: Record<string, string> | undefined,
  timeoutMs: number,
): Promise<Contained> {
  const image = opts.egressImage ?? process.env.QARE_IMAGE_REF ?? ''
  // With no image to run the resolver from, the stack is not read at all: it boots as it is, and says so.
  if (image === '') return { app, egress: { containment: 'uncontained', reason: NO_EGRESS_IMAGE } }
  const read = await runCompose(['-p', isolation.project, ...composeFiles(app), 'config', '--format', 'json'], EGRESS_CALL_TIMEOUT_MS, env)
  let config: ComposeConfig
  try {
    if (read.code !== 0) throw new Error(`compose config exited ${read.code}`)
    config = JSON.parse(read.stdout) as ComposeConfig
  } catch (error) {
    return { blocked: `the stack could not be read to contain its egress: ${error instanceof Error ? error.message : String(error)}`, logs: read.stderr }
  }
  const plan = containmentOf(config, { image, stubs: profile.stubs ?? [] })
  if (plan.kind === 'uncontained') return { app, egress: { containment: 'uncontained', reason: plan.reason } }
  const first = containmentOverrideFile(isolation.project)
  await writeFile(first, plan.override, { mode: 0o600 })
  const held: ComposeApp = { ...app, overrides: [...(app.overrides ?? []), first] }
  const started = await runCompose(['-p', isolation.project, ...composeFiles(held), 'up', '-d', '--no-deps', EGRESS_DNS_SERVICE], EGRESS_CALL_TIMEOUT_MS, env)
  if (started.code !== 0) return { blocked: withErrorTail(`the stack's resolver did not start, so its egress could not be contained: compose up exited ${started.code}`, `${started.stdout}${started.stderr}`), logs: `${started.stdout}${started.stderr}` }
  const deadline = Date.now() + (opts.egressReadyTimeoutMs ?? DEFAULT_EGRESS_READY_TIMEOUT_MS)
  let address: string | undefined
  let said = ''
  for (;;) {
    const logs = await runCompose(['-p', isolation.project, 'logs', '--no-color', '--no-log-prefix', EGRESS_DNS_SERVICE], EGRESS_CALL_TIMEOUT_MS, env)
    said = `${logs.stdout}${logs.stderr}`
    address = parseSinkRecord(logs.stdout).address
    if (address !== undefined || Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, EGRESS_POLL_MS))
  }
  if (address === undefined) return { blocked: "the stack's resolver did not say where it answers, so its egress could not be contained", logs: said }
  const second = dnsOverrideFile(isolation.project)
  await writeFile(second, dnsOverride(plan.services, address), { mode: 0o600 })
  const resolving: ComposeApp = { ...held, overrides: [...(held.overrides ?? []), second] }
  const contained: Contained = { app: resolving, egress: { containment: 'contained' }, forwards: plan.forwards }
  if (plan.stubServices.length === 0) return contained

  // The stubs are up, and the resolver knows where they are, before anything that may dial them starts (#408).
  const uncontained = async (reason: string): Promise<Contained> => {
    const left = await abandonContainment(resolving, isolation, runCompose, env)
    if (left !== undefined) return { blocked: `${reason}, and ${left.problem}`, logs: left.logs }
    return { app, egress: { containment: 'uncontained', reason } }
  }
  const stubs = await runCompose(['-p', isolation.project, ...composeFiles(resolving), 'up', '-d', ...plan.stubServices], timeoutMs, env)
  if (stubs.code !== 0) return { blocked: withErrorTail(`the stack's stub services did not start, so its egress could not be contained: compose up exited ${stubs.code}`, `${stubs.stdout}${stubs.stderr}`), logs: `${stubs.stdout}${stubs.stderr}` }
  const found = await readContainedAddresses(isolation.project, opts.runDocker ?? defaultRunDocker)
  if ('problem' in found) return uncontained(`the run could not read the stack's addresses from the daemon: ${String(found.problem)}`)
  for (const service of plan.stubServices)
    if ((found[service] ?? []).length === 0) return uncontained(`the daemon gave the stub service ${service} no address on the stack's contained network, so the run's resolver could not answer for it`)
  const handed = await runCompose(
    [
      '-p',
      isolation.project,
      ...composeFiles(resolving),
      'exec',
      '-T',
      EGRESS_DNS_SERVICE,
      'qare',
      'cell',
      'egress-dns-map',
      '--map',
      EGRESS_MAP_FILE,
      ...plan.stubServices.flatMap((service) => ['--service', `${service}=${(found[service] ?? []).join(',')}`]),
    ],
    EGRESS_CALL_TIMEOUT_MS,
    env,
  )
  if (handed.code !== 0) return uncontained(`the run's resolver could not be handed the stub services' addresses: compose exec exited ${handed.code}`)
  return contained
}

/**
 * Start the relay of a contained stack that is up (#408): each published
 * port is carried to the address the daemon gives its service, never to its
 * name. `uncontained` is why the relay cannot be handed an address it
 * needs; `blocked` is a relay that did not start.
 */
async function startStackRelay(
  app: ComposeApp,
  forwards: readonly RelayPlan[],
  opts: BootOpts,
  runCompose: NonNullable<BootOpts['runCompose']>,
  isolation: RunIsolation,
  env: Record<string, string> | undefined,
): Promise<{ app: ComposeApp } | { uncontained: string } | { blocked: string; logs: string }> {
  const found = await readContainedAddresses(isolation.project, opts.runDocker ?? defaultRunDocker)
  if ('problem' in found) return { uncontained: `the run could not read the stack's addresses from the daemon: ${String(found.problem)}` }
  const relay = relayOverride(forwards, found)
  if ('missing' in relay) return { uncontained: `the daemon gave the service ${relay.missing} no address on the stack's contained network, so the relay could not carry the port it publishes` }
  if (relay.override === undefined) return { app }
  const file = relayOverrideFile(isolation.project)
  await writeFile(file, relay.override, { mode: 0o600 })
  const relayed: ComposeApp = { ...app, overrides: [...(app.overrides ?? []), file] }
  const started = await runCompose(['-p', isolation.project, ...composeFiles(relayed), 'up', '-d', '--no-deps', EGRESS_RELAY_SERVICE], EGRESS_CALL_TIMEOUT_MS, env)
  if (started.code !== 0) return { blocked: withErrorTail(`the stack's relay did not start, so the ports it publishes cannot be reached: compose up exited ${started.code}`, `${started.stdout}${started.stderr}`), logs: `${started.stdout}${started.stderr}` }
  return { app: relayed }
}

/**
 * What a contained stack looked up (#382), read back from its resolver's
 * log. Undefined when the log cannot be read: a run that cannot say what
 * the stack reached for does not say it reached for nothing.
 */
export async function readStackEgress(isolation: RunIsolation, opts: Pick<BootOpts, 'runCompose'> = {}): Promise<SinkRecord | undefined> {
  const runCompose = opts.runCompose ?? defaultRunCompose
  try {
    const logs = await runCompose(['-p', isolation.project, 'logs', '--no-color', '--no-log-prefix', EGRESS_DNS_SERVICE], EGRESS_CALL_TIMEOUT_MS, composeEnv(isolation))
    if (logs.code !== 0) return undefined
    const record = parseSinkRecord(logs.stdout)
    // The resolver says where it answers before anything else: a log without that line is not its log.
    return record.address === undefined ? undefined : record
  } catch {
    return undefined
  }
}

/**
 * One service of a stack that did not come up (#407): its state as compose
 * says (`running`, `exited`, `restarting`, ...), its exit code and health
 * when compose gives them, and the last lines of its log.
 */
export interface ServiceLog {
  service: string
  state: string
  exitCode?: number
  health?: string
  log: string
}

export { serviceFailed }

/** How many lines of each service's log a failed boot keeps (#407). */
export const SERVICE_LOG_LINES = 200
/** The most services a failed boot reads logs for: a stack is bounded like any other evidence. */
const MAX_SERVICE_LOGS = 32
/** How long one `ps` or `logs` call of the capture may take before the capture goes on without it. */
const DEFAULT_SERVICE_LOG_TIMEOUT_MS = 15_000

interface ServiceState {
  service: string
  state: string
  exitCode?: number
  health?: string
}

/**
 * The services `compose ps -a --format json` lists, one entry per service:
 * a compose that prints one object per line and one that prints an array
 * are both read. A service with several containers is the one that failed,
 * when one did. The run's own resolver and relay are not the stack's.
 */
export function parseComposePs(stdout: string): ServiceState[] {
  const text = stdout.trim()
  if (text === '') return []
  let entries: unknown[] = []
  try {
    const parsed: unknown = JSON.parse(text)
    entries = Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    for (const line of text.split('\n')) {
      try {
        entries.push(JSON.parse(line))
      } catch {
        // A line that is not an object of compose's says nothing about a service.
      }
    }
  }
  const found = new Map<string, ServiceState>()
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const service = record.Service
    if (typeof service !== 'string' || service === '' || service === EGRESS_DNS_SERVICE || service === EGRESS_RELAY_SERVICE) continue
    const state: ServiceState = {
      service,
      state: typeof record.State === 'string' && record.State !== '' ? record.State : 'unknown',
      ...(typeof record.ExitCode === 'number' && Number.isInteger(record.ExitCode) ? { exitCode: record.ExitCode } : {}),
      ...(typeof record.Health === 'string' && record.Health !== '' ? { health: record.Health } : {}),
    }
    const seen = found.get(service)
    if (seen === undefined || (!serviceFailed(seen) && serviceFailed(state))) found.set(service, state)
  }
  return [...found.values()]
}


/** A call that may never settle, bounded: undefined when it did not answer in time or threw. */
async function bounded<T>(call: () => Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs)
  })
  try {
    const started = call()
    void started.catch(() => {})
    return await Promise.race([started.catch(() => undefined), late])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Every service of a project that did not come up, with the last lines of
 * its log (#407), read before anything takes the stack down. The project is
 * addressed by name alone, as `compose logs` reads the resolver's record, so
 * a stack booted from any overrides is read the same way. A capture that
 * cannot read the stack returns nothing: it never stops the run.
 */
export async function captureServiceLogs(isolation: RunIsolation, opts: Pick<BootOpts, 'runCompose' | 'serviceLogTimeoutMs'> = {}): Promise<ServiceLog[]> {
  const runCompose = opts.runCompose ?? defaultRunCompose
  const timeoutMs = opts.serviceLogTimeoutMs ?? DEFAULT_SERVICE_LOG_TIMEOUT_MS
  const env = composeEnv(isolation)
  const listed = await bounded(() => runCompose(['-p', isolation.project, 'ps', '-a', '--format', 'json'], timeoutMs, env), timeoutMs)
  if (listed === undefined || listed.code !== 0) return []
  const services = parseComposePs(listed.stdout).slice(0, MAX_SERVICE_LOGS)
  const captured: ServiceLog[] = []
  for (const service of services) {
    const logs = await bounded(
      () => runCompose(['-p', isolation.project, 'logs', '--no-color', '--no-log-prefix', '--tail', String(SERVICE_LOG_LINES), service.service], timeoutMs, env),
      timeoutMs,
    )
    captured.push({ ...service, log: logs === undefined ? '' : `${logs.stdout}${logs.stderr}` })
  }
  return captured
}

/** The containment overrides a stack was booted with (#382), the ones its down must name too. */
function containmentFiles(project: string): string[] {
  return [containmentOverrideFile(project), dnsOverrideFile(project), relayOverrideFile(project)].filter((file) => existsSync(file))
}

async function captureComposeLogs(app: ComposeApp, opts: BootOpts, isolation: RunIsolation): Promise<string> {
  const runCompose = opts.runCompose ?? defaultRunCompose
  const logs = await runCompose(['-p', isolation.project, ...composeFiles(app), 'logs', '--no-color', app.boot.service], NO_DEADLINE_MS, composeEnv(isolation))
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
    const build = await inPlaceBuild(client, root)
    const health = opts.provision?.health ?? electronHealthCheck(opts.clientEnv, opts.clientEnvironment, contained ? () => startCell({ repoPath: root, hosts, install: build.install }) : undefined)
    const timeout = client.health.timeout ?? DEFAULT_CLIENT_HEALTH_TIMEOUT
    let healthy: Awaited<ReturnType<typeof health>>
    try {
      healthy = await health({ executable: contained ? build.executable : path, args: client.args, timeoutMs: parseDurationMs(timeout) })
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

type ComposeResult = { code: number; stdout: string; stderr: string }

/**
 * Whether compose itself refused `--with-dependencies` (#241). Its option
 * parser answers before any build starts: nothing on stdout, and the refusal
 * as the first thing on stderr. The same words further down a build's output
 * are some tool of the build's own talking, and that build failed.
 */
function flagUnknown(result: ComposeResult): boolean {
  return result.stdout.trim() === '' && /^unknown flag: --with-dependencies\b/.test(result.stderr.trimStart())
}

/**
 * Build the images the boot is about to start, before the health deadline
 * begins (#241). `compose up` builds a missing image itself, so on a runner
 * with no layer cache a cold build used to be timed by `app.health.timeout`
 * and a boot that would have come up was blocked as one that had not. The
 * build is its own step with its own bound, and what the deadline then times
 * is the boot.
 *
 * The service and what it depends on are built, which is what the `up` that
 * follows would have built. A compose that predates `--with-dependencies`
 * builds the service alone, and its dependencies are built by the `up`, as
 * they always were. A compose file that builds nothing has nothing to do
 * here, and says so at once.
 *
 * Returns nothing when the images are there, and what to block with when
 * they are not: the reason names the build, never the health check, and the
 * logs are what the build wrote.
 */
async function buildImages(
  app: ComposeApp,
  runCompose: NonNullable<BootOpts['runCompose']>,
  isolation: RunIsolation,
  env: Record<string, string> | undefined,
): Promise<{ reason: string; logs: string } | undefined> {
  const timeout = app.boot.build?.timeout ?? DEFAULT_BUILD_TIMEOUT
  let timeoutMs: number
  try {
    timeoutMs = parseDurationMs(timeout)
  } catch (error) {
    return { reason: `app.boot.build.timeout ${error instanceof Error ? error.message : String(error)}`, logs: '' }
  }
  const deadline = Date.now() + timeoutMs
  const attempt = async (args: string[]): Promise<ComposeResult | 'watchdog'> => {
    const remainingMs = Math.max(1, deadline - Date.now())
    let timer: ReturnType<typeof setTimeout> | undefined
    const watchdog = new Promise<'watchdog'>((resolve) => {
      timer = setTimeout(() => resolve('watchdog'), remainingMs)
    })
    const started = runCompose(['-p', isolation.project, ...composeFiles(app), 'build', ...args], remainingMs, env)
    void started.catch(() => {})
    try {
      const first = await Promise.race([watchdog, started])
      if (first !== 'watchdog') return first
      // The default runner kills its child at the deadline and settles with
      // what the build had written; a runner that never settles is waited
      // on for a grace only.
      const drained = new Promise<'watchdog'>((resolve) => {
        const grace = setTimeout(() => resolve('watchdog'), DRAIN_GRACE_MS)
        grace.unref()
      })
      return await Promise.race([started.catch(() => 'watchdog' as const), drained])
    } finally {
      clearTimeout(timer)
    }
  }
  const outOfTime = (logs: string): { reason: string; logs: string } => ({
    reason: `compose build exceeded its bound of ${timeout} (app.boot.build.timeout): the profile's images were not built, so nothing was booted`,
    logs,
  })
  let built: ComposeResult | 'watchdog'
  try {
    built = await attempt(['--with-dependencies', app.boot.service])
    if (built !== 'watchdog' && built.code !== 0 && flagUnknown(built)) built = await attempt([app.boot.service])
  } catch (error) {
    return { reason: `compose build failed to start: ${String(error)}`, logs: '' }
  }
  if (built === 'watchdog') return outOfTime('')
  const logs = `${built.stdout}${built.stderr}`
  if (built.code === 0) return undefined
  // A build the runner killed at the deadline settles as a failure; the
  // clock says which it was.
  if (Date.now() >= deadline) return outOfTime(logs)
  return {
    reason: withErrorTail(`compose build exited ${built.code}: the profile's images did not build, so nothing was booted`, logs),
    logs,
  }
}

/** How many lines of a failed compose call's output its reason quotes, and how long each may be (#412). */
const ERROR_TAIL_LINES = 5
const ERROR_TAIL_WIDTH = 240

// Compose's pull and start progress: the lines that drown the one that says
// what went wrong. An error line never matches them.
const PROGRESS = [
  /^\[\+\]\s/,
  /^[0-9a-f]{12}\s+(Pulling fs layer|Waiting|Downloading|Verifying Checksum|Download complete|Extracting|Pull complete|Already exists)\b/,
  /^(?:[✔⠿⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+)?(?:Container\s+|Network\s+|Volume\s+)?\S+\s+(Pulling|Pulled|Waiting|Creating|Created|Starting|Started|Running|Healthy|Recreate|Recreated|Built|Building)\s*(?:[\d.]+s)?$/,
]

/**
 * The last lines of a failed compose call's output worth quoting in its
 * reason (#412): colour stripped, pull and start progress dropped, at most
 * five, each cut to a readable length. A pull that failed is otherwise one
 * error line under a hundred lines of progress, and the reason said only the
 * exit code. The whole output stays in the logs.
 */
export function composeErrorTail(output: string): string[] {
  const lines = output
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .split(/\r?\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !PROGRESS.some((pattern) => pattern.test(line)))
  return lines.slice(-ERROR_TAIL_LINES).map((line) => (line.length > ERROR_TAIL_WIDTH ? `${line.slice(0, ERROR_TAIL_WIDTH)}…` : line))
}

/** A compose failure's reason with the last lines its output ended on, when it said anything but progress (#412). */
function withErrorTail(reason: string, output: string): string {
  const tail = composeErrorTail(output)
  return tail.length === 0 ? reason : `${reason}; its output ended: ${tail.join(' | ')}`
}

export async function bootApp(profile: QaProfile, opts: BootOpts = {}): Promise<BootOutcome> {
  if (profile.client !== undefined) return probeClient(profile.client, opts)
  if (profile.app === undefined) return probeTarget(profile, opts)
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
  // A command boot is written to a compose project of its own (#379), and
  // from here on it is booted as any compose boot is.
  let app: ComposeApp
  try {
    app = await composeAppOf(profile.app, opts.root ?? process.cwd(), isolation)
  } catch (error) {
    return { kind: 'blocked', reason: `the command boot's compose project could not be written: ${error instanceof Error ? error.message : String(error)}`, logs: '', isolation }
  }
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

  // The opt-in build cache (#381): each service that builds reads its
  // layers from the cache it is handed, and exports them when it is handed
  // somewhere to write. Bake asks for a write entitlement outside the build
  // context; the directory is the run's own, so the build is told it may.
  let buildEnv = env
  if (opts.buildCache !== undefined) {
    const override = buildCacheOverride(await servicesThatBuild(app, runCompose, isolation, env), opts.buildCache)
    if (override !== undefined) {
      const file = buildCacheOverrideFile(isolation.project)
      try {
        await writeFile(file, `${JSON.stringify(override, null, 2)}\n`, { mode: 0o600 })
        app = { ...app, overrides: [...(app.overrides ?? []), file] }
        if (opts.buildCache.to !== undefined) buildEnv = { ...(env ?? {}), BUILDX_BAKE_ENTITLEMENTS_FS: '0' }
      } catch (error) {
        console.error(`the build cache override could not be written, so the images build with no cache: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  // The images first, under their own bound (#241): the health deadline
  // below starts only once they are built, so it times the boot alone.
  const unbuilt = await buildImages(app, runCompose, isolation, buildEnv)
  if (unbuilt !== undefined) return { kind: 'blocked', ...unbuilt, isolation }

  // The stack's egress (#382): contained before anything of it starts.
  // A stack that did not come up is read before anything takes it down
  // (#407): each service's state and the last lines of its log, and when it
  // was contained, what it looked up before it failed.
  const failed = async (outcome: BootOutcome): Promise<BootOutcome> => {
    const services = await captureServiceLogs(isolation, { runCompose, ...(opts.serviceLogTimeoutMs === undefined ? {} : { serviceLogTimeoutMs: opts.serviceLogTimeoutMs }) })
    const lookups =
      outcome.egress?.containment === 'contained' ? await bounded(() => readStackEgress(isolation, { runCompose }), opts.serviceLogTimeoutMs ?? DEFAULT_SERVICE_LOG_TIMEOUT_MS) : undefined
    return { ...outcome, ...(services.length === 0 ? {} : { services }), ...(lookups === undefined ? {} : { lookups }) }
  }

  const contained = await containStack(app, profile, opts, runCompose, isolation, env, timeoutMs)
  if ('blocked' in contained) return failed({ kind: 'blocked', reason: contained.blocked, logs: contained.logs, isolation })
  const plain = app
  app = contained.app
  let egress = contained.egress

  const upStack = async (target: ComposeApp): Promise<{ up: { code: number; stdout: string; stderr: string } | 'watchdog'; started: Promise<unknown> } | { error: unknown }> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const watchdog = new Promise<'watchdog'>((resolve) => {
      timer = setTimeout(() => resolve('watchdog'), timeoutMs)
    })
    try {
      const started = runCompose(['-p', isolation.project, ...composeFiles(target), 'up', '-d', '--wait', target.boot.service], timeoutMs, env)
      // The losing branch of the race is drained, so a compose up that settles
      // late after the watchdog does not crash the process unhandled.
      void started.catch(() => {})
      return { up: await Promise.race([watchdog, started]), started }
    } catch (error) {
      return { error }
    } finally {
      clearTimeout(timer)
    }
  }

  let booted = await upStack(app)
  // A contained stack's relay starts once the stack is up, so the daemon can say where each service it carries to is (#408).
  if ('up' in booted && booted.up !== 'watchdog' && booted.up.code === 0 && contained.forwards !== undefined) {
    const relayed = await startStackRelay(app, contained.forwards, opts, runCompose, isolation, env)
    if ('blocked' in relayed) return failed({ kind: 'blocked', reason: relayed.blocked, logs: relayed.logs, isolation, egress })
    if ('uncontained' in relayed) {
      const left = await abandonContainment(app, isolation, runCompose, env)
      if (left !== undefined) return failed({ kind: 'blocked', reason: `${relayed.uncontained}, and ${left.problem}`, logs: left.logs, isolation, egress })
      app = plain
      egress = { containment: 'uncontained', reason: relayed.uncontained }
      booted = await upStack(app)
    } else app = relayed.app
  }
  if ('error' in booted) return { kind: 'blocked', reason: `boot command failed to start: ${String(booted.error)}`, logs: '', isolation }
  const { up, started } = booted

  if (up === 'watchdog') {
    // What the stack got as far as is read before the down is scheduled (#407).
    const read = await failed({ kind: 'blocked', reason: 'boot watchdog: compose up exceeded the health deadline', logs: '', isolation, egress })
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
    return read
  }

  if (up.code !== 0) {
    const logs = `${up.stdout}${up.stderr}`
    return failed({
      kind: 'blocked',
      reason: withErrorTail(`compose up exited ${up.code}`, `${up.stdout}${up.stderr}`),
      logs: logs || (await captureComposeLogs(app, opts, isolation)),
      isolation,
      egress,
    })
  }

  if (await waitForHealth(app.health.http, timeoutMs, opts)) return { kind: 'up', logs: up.stdout, isolation, egress }

  const logs = `${up.stdout}${up.stderr}`
  return failed({
    kind: 'blocked',
    reason: `health check at ${app.health.http} did not pass within ${app.health.timeout}`,
    logs: logs || (await captureComposeLogs(app, opts, isolation)),
    isolation,
    egress,
  })
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
  const boot = profile.app.boot
  if (isCommandBoot(boot)) {
    // A command boot's project is the run's alone (#379): downed by its
    // name, as reap downs it, with the file the run wrote for it removed.
    // Without an isolation there is no project a down could address.
    if (opts.isolation === undefined) return
    try {
      await runCompose(['-p', opts.isolation.project, 'down', '--volumes'], opts.downTimeoutMs ?? NO_DEADLINE_MS, composeEnv(opts.isolation))
    } catch (error) {
      console.error(`compose down failed: ${String(error)}`)
    }
    for (const file of [commandBootFile(opts.isolation.project), containmentOverrideFile(opts.isolation.project), dnsOverrideFile(opts.isolation.project), relayOverrideFile(opts.isolation.project)])
      await rm(file, { force: true }).catch(() => {})
    return
  }
  // A contained stack's resolver and relay are in its overrides alone (#382): the down names them, or it leaves them running.
  const held = opts.isolation === undefined ? [] : containmentFiles(opts.isolation.project).flatMap((file) => ['-f', file])
  try {
    await runCompose(
      [...(opts.isolation === undefined ? [] : ['-p', opts.isolation.project]), '-f', boot.compose, ...held, 'down'],
      opts.downTimeoutMs ?? NO_DEADLINE_MS,
      composeEnv(opts.isolation),
    )
  } catch (error) {
    console.error(`compose down failed: ${String(error)}`)
  }
  // The base image and build cache overrides go with the stack they booted (#381).
  if (opts.isolation !== undefined)
    for (const file of [
      baseImageOverrideFile(opts.isolation.project),
      buildCacheOverrideFile(opts.isolation.project),
      containmentOverrideFile(opts.isolation.project),
      dnsOverrideFile(opts.isolation.project),
      relayOverrideFile(opts.isolation.project),
    ])
      await rm(file, { force: true }).catch(() => {})
}
