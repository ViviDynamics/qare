import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, rmSync } from 'node:fs'
import { access, constants, cp, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseDurationMs } from './duration.js'
import { electronDisplayProblem, makeElectronFlowSession, type ElectronHost } from './flow-electron.js'
import type { ProfileClient } from './profile.js'

/**
 * Provisioning (#75): getting the application under test in front of its
 * driver, and taking it away again. One lifecycle whatever the client is:
 *
 *   obtain the artefact -> install it -> prove it is up -> (checks run) -> tear it down
 *
 * A server's implementation of it is the compose boot (`bootApp`): the
 * artefact is the recipe, installing is `compose up`, the health check is an
 * HTTP probe, the teardown is `compose down`. This module is the lifecycle
 * for a build the run installs and launches: a desktop archive today, a
 * device package behind the installer seam when its driver lands (#73, #74).
 *
 * A step that fails stops the lifecycle with a reason that names the
 * artefact. That is `blocked`, never a failed criterion: nothing was checked.
 */
export type ProvisionSide = 'head' | 'base'

export interface ProvisionCommandResult {
  code: number
  /** Both streams, in the order they arrived. */
  output: string
  /** The program is not on PATH. */
  missing?: boolean
}

/** Runs one provisioning command, spawned with no shell; a seam for tests and for a device's own tools. */
export type ProvisionCommandRunner = (
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<ProvisionCommandResult>

/** What an installer left behind, and how to take it away. */
export interface InstalledArtefact {
  /** Where it was installed: a directory for a desktop build, a device for a package. */
  location: string
  /** What the driver launches: an absolute path for a desktop build, an application id on a device. */
  executable: string
  /** Remove everything the install put there. Throws naming what is left. */
  uninstall: () => Promise<void>
}

export interface InstallInput {
  /** The artefact, as an absolute path the run has already held to the repository. */
  artefact: string
  /** What the profile names inside it: `client.artefact.executable`. */
  executable: string
  side: ProvisionSide
  /** Where a run's own install directories go. */
  installRoot: string
  /** Runs a command for the installer, bounded and in the environment provisioning runs in. */
  run: (command: string, args: string[]) => Promise<ProvisionCommandResult>
  /** One line into the provisioning log. */
  log: (line: string) => void
}

/**
 * The seam a client's platform plugs into (#75): put the artefact where the
 * driver can launch it, and say how to remove it. The desktop installers
 * below unpack into a directory of the run's own; a device installer
 * (#73, #74) installs a package on a device and uninstalls it by id.
 */
export interface ArtefactInstaller {
  install: (input: InstallInput) => Promise<{ ok: true; installed: InstalledArtefact } | { ok: false; reason: string }>
}

/**
 * Whether the installed build is up, asked by the harness (#75): the driver
 * launches it once and waits for the first thing a person would see. `lines`
 * is what the build wrote while it was asked.
 */
export type ClientHealthCheck = (input: {
  executable: string
  args: readonly string[]
  timeoutMs: number
}) => Promise<{ ok: true; lines: string[] } | { ok: false; reason: string; lines?: string[] }>

/** What a side was provisioned from: recorded in the result, so a reader knows which build the checks drove. */
export interface ProvisionedArtefact {
  side: ProvisionSide
  /** As the profile names it. */
  path: string
  kind: string
  /** `prebuilt` was already there; `built` was produced by the profile's build command in this run. */
  source: 'prebuilt' | 'built'
  /** Of the file that was installed; a directory has none. */
  sha256?: string
}

export type ClientProvision =
  | {
      kind: 'up'
      /** What the driver launches. */
      executable: string
      artefact: ProvisionedArtefact
      /** The log so far; the teardown appends to it. */
      log: () => string
      /** Uninstall, leaving nothing. Safe to call more than once. */
      teardown: () => Promise<{ ok: boolean; reason?: string }>
    }
  | { kind: 'blocked'; reason: string; log: () => string; artefact?: ProvisionedArtefact }

export interface ProvisionOpts {
  /** The side being provisioned; the head by default. */
  side?: ProvisionSide
  /** The repository the run checks: where both sides' artefact paths resolve from. */
  root: string
  /** The tree the side's build command runs in: the head checkout, or a checkout of the base. `root` by default. */
  buildRoot?: string
  /** The installers by artefact kind; the desktop ones by default. */
  installers?: Record<string, ArtefactInstaller>
  runCommand?: ProvisionCommandRunner
  /** The health check; the driver's own launch by default. */
  health?: ClientHealthCheck
  /** Where install directories are made; the system temp directory by default. */
  installRoot?: string
  /** What a build command and the build itself are run with: `minimal` on a host (#91). */
  environment?: 'inherit' | 'minimal'
  /** The host a desktop build opens its window on. */
  host?: ElectronHost
}

export const DEFAULT_PROVISION_TIMEOUT = '10m'
export const DEFAULT_CLIENT_HEALTH_TIMEOUT = '30s'

/** What a provisioning command's output is cut to: the command is pull request code, and its output is published. */
const MAX_OUTPUT_CHARACTERS = 256 * 1024
const KILL_GRACE_MS = 500

/**
 * The default command runner: no shell, both streams kept in order and
 * bounded, and a deadline the child does not outlive.
 */
export const runProvisionCommand: ProvisionCommandRunner = (command, args, opts) =>
  new Promise((done) => {
    let output = ''
    let cut = false
    const keep = (chunk: Buffer | string): void => {
      if (cut) return
      output += String(chunk)
      if (output.length > MAX_OUTPUT_CHARACTERS) {
        output = `${output.slice(0, MAX_OUTPUT_CHARACTERS)}\n[output cut at ${MAX_OUTPUT_CHARACTERS} characters]\n`
        cut = true
      }
    }
    let child: ReturnType<typeof spawn>
    try {
      // A group of its own, so the deadline ends whatever the command forked
      // and not just the process that was started.
      child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    } catch (error) {
      done({ code: -1, output: String(error) })
      return
    }
    const signal = (name: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, name)
        else child.kill(name)
      } catch {
        // The group is already gone.
      }
    }
    let timedOut = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let hardTimer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const settle = (result: ProvisionCommandResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      if (hardTimer !== undefined) clearTimeout(hardTimer)
      done(result)
    }
    const killedNote = (): string => `${output}\n[killed: it outlived its ${opts.timeoutMs} ms deadline]\n`
    const timer = setTimeout(() => {
      timedOut = true
      signal('SIGTERM')
      killTimer = setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS)
      // A descendant that escaped the group can still hold the pipes open, so
      // `close` may never come: the deadline settles the call regardless.
      hardTimer = setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        settle({ code: -1, output: killedNote() })
      }, KILL_GRACE_MS * 2)
    }, opts.timeoutMs)
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    child.on('error', (error) => {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
      settle({ code: -1, output: `${output}${String(error)}\n`, ...(missing ? { missing: true } : {}) })
    })
    child.on('close', (code) => {
      settle(timedOut ? { code: -1, output: killedNote() } : { code: code ?? -1, output })
    })
  })

// The install directories this process still has, removed outright when it
// exits: a run that is cancelled has no time to ask, and an install must not
// outlive the run that made it.
const liveInstalls = new Set<string>()
let exitHookInstalled = false

function trackInstall(dir: string): void {
  liveInstalls.add(dir)
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', removeLiveInstalls)
}

/** Remove every install directory this process still has. Synchronous: it runs as the process exits. */
export function removeLiveInstalls(): void {
  for (const dir of liveInstalls) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Nothing more can be done from an exiting process.
    }
  }
  liveInstalls.clear()
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}

/** Whether `path`, links followed, is inside `root`. */
async function isInside(root: string, path: string): Promise<boolean> {
  const [realRoot, real] = await Promise.all([realpath(root), realpath(path)])
  const rel = relative(realRoot, real)
  // `..` as a path segment climbs out; a name that merely starts with two dots does not.
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? ''
}

/**
 * A desktop build is installed into a directory of the run's own, outside
 * the checkout and the evidence, so the project's artefact is never the copy
 * that runs and removing the install removes everything.
 */
function desktopInstaller(unpack: (input: InstallInput, dir: string) => Promise<string | undefined>): ArtefactInstaller {
  return {
    install: async (input) => {
      const dir = await mkdtemp(join(input.installRoot, `qare-install-${input.side}-`))
      trackInstall(dir)
      const remove = async (): Promise<void> => {
        await rm(dir, { recursive: true, force: true, maxRetries: 3 })
        liveInstalls.delete(dir)
        if (await exists(dir)) throw new Error(`${dir} is still there`)
      }
      // A failed install leaves nothing, and when it cannot be cleared the
      // reason says what is still there instead of hiding it.
      const refuse = async (reason: string): Promise<{ ok: false; reason: string }> => {
        try {
          await remove()
        } catch (error) {
          const left = `its install directory could not be removed (${error instanceof Error ? error.message : String(error)})`
          input.log(left)
          return { ok: false, reason: `${reason}; ${left}` }
        }
        return { ok: false, reason }
      }
      let problem: string | undefined
      try {
        problem = await unpack(input, dir)
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error)
      }
      if (problem !== undefined) return refuse(problem)
      const executable = resolve(dir, input.executable)
      const isFile = (await stat(executable).catch(() => undefined))?.isFile() ?? false
      if (!isFile) return refuse(`it carries no executable at ${input.executable} (client.artefact.executable)`)
      // What the artefact unpacked may link anywhere: the run launches what
      // it installed, never another binary on the host.
      if (!(await isInside(dir, executable))) return refuse(`its executable ${input.executable} resolves outside the installed artefact`)
      const runnable = await access(executable, constants.X_OK).then(
        () => true,
        () => false,
      )
      if (!runnable) return refuse(`its executable ${input.executable} is not executable`)
      input.log(`installed at ${dir}, executable ${input.executable}`)
      return { ok: true, installed: { location: dir, executable, uninstall: remove } }
    },
  }
}

/** The installers a desktop driver ships (#75): a tar archive, or a directory that is already unpacked. */
export const DESKTOP_INSTALLERS: Record<string, ArtefactInstaller> = {
  archive: desktopInstaller(async (input, dir) => {
    if (!(await stat(input.artefact)).isFile()) return 'client.artefact.kind says archive, and it is a directory'
    input.log(`tar -xf ${input.artefact} -C ${dir}`)
    const unpacked = await input.run('tar', ['-xf', input.artefact, '-C', dir])
    for (const line of unpacked.output.split('\n')) if (line.trim() !== '') input.log(line)
    if (unpacked.missing === true) return 'tar is not on PATH here, and an archive is unpacked with it'
    if (unpacked.code !== 0) return `tar exited ${unpacked.code}${firstLine(unpacked.output) === '' ? '' : `: ${firstLine(unpacked.output)}`}`
    return undefined
  }),
  directory: desktopInstaller(async (input, dir) => {
    if (!(await stat(input.artefact)).isDirectory()) return 'client.artefact.kind says directory, and it is a file'
    input.log(`copy ${input.artefact} to ${dir}`)
    try {
      await cp(input.artefact, dir, { recursive: true, verbatimSymlinks: true })
    } catch (error) {
      return `it could not be copied: ${error instanceof Error ? error.message : String(error)}`
    }
    return undefined
  }),
}

/** The health check of a desktop build (#75): the driver starts it, attaches, and sees its first window. */
export function electronHealthCheck(host: ElectronHost = {}, environment: 'inherit' | 'minimal' = 'inherit'): ClientHealthCheck {
  return async ({ executable, args, timeoutMs }) => {
    try {
      const session = await makeElectronFlowSession({ executable, args, ...host, environment, launchTimeoutMs: timeoutMs })
      await session.dispose()
      return { ok: true, lines: session.console() }
    } catch (error) {
      // The driver quotes what the build wrote in its reason.
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }
}

function sha256Of(path: string): Promise<string> {
  return new Promise((done, fail) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', fail)
      .on('end', () => done(hash.digest('hex')))
  })
}

/** PATH and HOME, and nothing else of the host's: a build command is pull request code (#91). */
function commandEnvironment(environment: 'inherit' | 'minimal'): NodeJS.ProcessEnv {
  if (environment === 'inherit') return { ...process.env }
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '' }
}

/**
 * Provision one side of a client profile's artefact (#75). Every step is
 * written to the log, which the run publishes swept; the first step that
 * fails blocks, naming the artefact, with whatever was installed removed.
 */
export async function provisionClient(client: ProfileClient, opts: ProvisionOpts): Promise<ClientProvision> {
  const side = opts.side ?? 'head'
  const lines: string[] = []
  const log = (): string => (lines.length === 0 ? '' : `${lines.join('\n')}\n`)
  const note = (step: string, text: string): void => {
    for (const line of text.split('\n')) if (line.trim() !== '') lines.push(`[${step}] ${line.replace(/\r$/, '')}`)
  }
  const artefact = client.artefact
  const entry = side === 'base' ? artefact?.base : artefact?.head
  if (artefact === undefined || entry === undefined) {
    const reason = `the profile names no ${side} artefact to provision (client.artefact.${side})`
    note('blocked', reason)
    return { kind: 'blocked', reason, log }
  }
  const named = `the ${side} artefact ${entry.path}`
  lines.push(`provisioning the ${side} side from ${entry.path} (${artefact.kind})`)
  const state: { artefact?: ProvisionedArtefact } = {}
  const blocked = (reason: string): ClientProvision => {
    note('blocked', reason)
    return { kind: 'blocked', reason, log, ...(state.artefact === undefined ? {} : { artefact: state.artefact }) }
  }

  let timeoutMs: number
  let healthTimeout: string
  let healthTimeoutMs: number
  try {
    timeoutMs = parseDurationMs(artefact.timeout ?? DEFAULT_PROVISION_TIMEOUT)
    healthTimeout = client.health?.timeout ?? DEFAULT_CLIENT_HEALTH_TIMEOUT
    healthTimeoutMs = parseDurationMs(healthTimeout)
  } catch (error) {
    return blocked(`${named} cannot be provisioned: ${error instanceof Error ? error.message : String(error)}`)
  }
  const environment = opts.environment ?? 'inherit'
  const runCommand = opts.runCommand ?? runProvisionCommand
  const path = resolve(opts.root, entry.path)

  // A desktop window needs somewhere to open: said before anything is
  // installed, so a host that cannot show one is told once and plainly.
  // A caller that brings its own health check and names no host is not
  // launching through the driver, and is asked nothing about a display.
  if (client.driver === 'electron' && (opts.health === undefined || opts.host !== undefined)) {
    const display = electronDisplayProblem(opts.host)
    if (display !== undefined) return blocked(display)
  }

  // Obtain: the artefact the pipeline already produced, or the build the
  // profile declares for a side that has none yet.
  let source: ProvisionedArtefact['source'] = 'prebuilt'
  if (!(await exists(path))) {
    if (entry.build === undefined)
      return blocked(
        `${named} is not there to install: it resolves to ${path}, which does not exist; producing it is the project's own pipeline step before the run, or the profile declares the command that builds it (client.artefact.${side}.build)`,
      )
    const [command, ...args] = entry.build.split(/\s+/).filter((token) => token !== '') as [string, ...string[]]
    const cwd = opts.buildRoot ?? opts.root
    note('build', `${entry.build} (in ${cwd})`)
    const built = await runCommand(command, args, { cwd, env: { ...commandEnvironment(environment), QARE_ARTEFACT: path, QARE_SIDE: side }, timeoutMs })
    note('build', built.output)
    if (built.missing === true) return blocked(`${named} could not be built: \`${entry.build}\` could not be started, because ${command} is not on PATH`)
    if (built.code !== 0) return blocked(`${named} could not be built: \`${entry.build}\` exited ${built.code}`)
    if (!(await exists(path))) return blocked(`${named} could not be built: \`${entry.build}\` exited 0 and left nothing at ${path} (the command is told where to write in QARE_ARTEFACT)`)
    source = 'built'
  }
  // The path is inside the repository as written; what it resolves to must
  // be too, or the run would install some other file on the host.
  if (!(await isInside(opts.root, path)))
    return blocked(`${named} resolves outside the repository the run checks (${await realpath(path)}): the run installs the repository's own artefact, never another file on the host`)
  const info = await stat(path)
  let sha256: string | undefined
  if (info.isFile()) sha256 = await sha256Of(path)
  const provisioned: ProvisionedArtefact = { side, path: entry.path, kind: artefact.kind, source, ...(sha256 === undefined ? {} : { sha256 }) }
  state.artefact = provisioned
  note('obtain', `${entry.path} is there${source === 'built' ? ', built by this run' : ''}: ${info.isFile() ? `${info.size} bytes, sha256 ${sha256}` : 'a directory'}`)

  // Install.
  const installer = (opts.installers ?? DESKTOP_INSTALLERS)[artefact.kind]
  if (installer === undefined) return blocked(`${named} could not be installed: no installer is registered for the artefact kind ${JSON.stringify(artefact.kind)}`)
  const installRoot = opts.installRoot ?? tmpdir()
  let installing: Awaited<ReturnType<ArtefactInstaller['install']>>
  try {
    installing = await installer.install({
      artefact: path,
      executable: artefact.executable,
      side,
      installRoot,
      run: (command, args) => runCommand(command, args, { cwd: installRoot, env: commandEnvironment(environment), timeoutMs }),
      log: (line) => note('install', line),
    })
  } catch (error) {
    installing = { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  if (!installing.ok) return blocked(`${named} could not be installed: ${installing.reason}`)
  const installed = installing.installed

  let tornDown: { ok: boolean; reason?: string } | undefined
  const teardown = async (): Promise<{ ok: boolean; reason?: string }> => {
    if (tornDown !== undefined) return tornDown
    try {
      await installed.uninstall()
      note('teardown', `removed ${installed.location}; nothing is left`)
      tornDown = { ok: true }
    } catch (error) {
      const reason = `${named} could not be uninstalled from ${installed.location}: ${error instanceof Error ? error.message : String(error)}`
      note('teardown', reason)
      tornDown = { ok: false, reason }
    }
    return tornDown
  }

  // Health: asked by the harness, of the build as installed.
  const health = opts.health ?? electronHealthCheck(opts.host, environment)
  let healthy: Awaited<ReturnType<ClientHealthCheck>>
  try {
    healthy = await health({ executable: installed.executable, args: client.args, timeoutMs: healthTimeoutMs })
  } catch (error) {
    healthy = { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  note('health', (healthy.lines ?? []).join('\n'))
  if (!healthy.ok) {
    note('health', `the build did not come up: ${healthy.reason}`)
    await teardown()
    return blocked(`${named} was installed, but the build did not come up within ${healthTimeout}: ${healthy.reason}`)
  }
  note('health', `the build came up within ${healthTimeout}`)
  return { kind: 'up', executable: installed.executable, artefact: provisioned, log, teardown }
}
