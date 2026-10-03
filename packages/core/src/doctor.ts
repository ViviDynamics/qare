import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { detectExecution, type ExecutionKind } from './environment.js'
import { ProfileMissingError, loadProfile, type QaProfile } from './profile.js'
import { VERSION } from './version.js'

/**
 * One thing `qare doctor` looks at: what was found, whether the run needs it,
 * and how to install it when it is missing. An informational finding is never
 * required, so it can never fail the host.
 */
export interface DoctorFinding {
  name: string
  ok: boolean
  required: boolean
  detail: string
  /** How to install it, named when the finding is required and not ok. */
  install?: string
}

export interface DoctorReport {
  execution: ExecutionKind
  /** Every required finding is ok. Informational findings cannot fail it. */
  ready: boolean
  findings: DoctorFinding[]
}

/**
 * The seams the probes behind `runDoctor` run through, so a test can fake the
 * machine: a PATH lookup, the docker daemon and the browser driver. Every
 * probe falls back to its real implementation.
 */
export interface DoctorProbes {
  which?: (name: string) => string | undefined
  dockerInfo?: () => Promise<{ ok: boolean; detail: string }>
  chromium?: () => Promise<{ ok: boolean; detail: string }>
  /** The python3 on PATH: its version when one answered, and what was seen. */
  python?: () => Promise<{ version?: string; detail: string }>
}

export interface DoctorOpts {
  /** The profile directory whose shape decides what the host must have. */
  profilePath?: string
  /** An explicit nare binary, as the run commands take; resolved on PATH otherwise. */
  nare?: string
  probes?: DoctorProbes
}

const NODE_MINIMUM = 22

/**
 * The oldest python the pinned nare installs under. The core image is built
 * on this python (images/core/Dockerfile), and a host installing nare needs it
 * too: an older interpreter makes pip refuse the wheel (#204).
 */
export const NARE_PYTHON_MINIMUM = '3.12'

const NARE_INSTALL = `install the pinned nare beside qare (needs python ${NARE_PYTHON_MINIMUM} or newer: python3 -m pip install --user <pinned nare wheel>)`

/**
 * `qare doctor`: what this host has, what the profile needs, and how to
 * install what is missing (issue #91). The same host runs a containerised qare
 * or a native one, and the checks are the checks a native install needs:
 * node, the pinned nare, the docker daemon for a profile that boots an app,
 * and the chromium driver for a profile whose suites drive a browser. Display
 * and devices are reported but never required: the browser driver runs
 * headless, and devices arrive through the profile's registered MCP servers.
 */
export async function runDoctor(opts: DoctorOpts = {}): Promise<DoctorReport> {
  const probes = opts.probes ?? {}
  const which = probes.which ?? whichOnPath
  const dockerInfo = probes.dockerInfo ?? dockerDaemon
  const chromium = probes.chromium ?? chromiumDriver
  const python = probes.python ?? python3Version
  const execution = detectExecution()
  const nare = await nareFinding(opts.nare, which)

  const findings: DoctorFinding[] = [
    {
      name: 'qare',
      ok: true,
      required: true,
      detail: `qare ${VERSION}`,
    },
    {
      name: 'node',
      ok: nodeMajor() >= NODE_MINIMUM,
      required: true,
      detail: `node ${process.versions.node} (qare needs node ${NODE_MINIMUM} or newer)`,
      install: nodeMajor() >= NODE_MINIMUM ? undefined : 'install Node.js 22 or newer',
    },
    nare,
    pythonFinding(await python(), !nare.ok),
  ]

  let profile: QaProfile | undefined
  if (opts.profilePath !== undefined) {
    try {
      profile = await loadProfile(resolve(opts.profilePath))
    } catch (error) {
      if (!(error instanceof ProfileMissingError)) throw error
      findings.push({
        name: 'profile',
        ok: true,
        required: false,
        detail: `no usable .qa/ profile at ${resolve(opts.profilePath)}, so the requirements it would add are not checked`,
      })
    }
  }

  const docker = await dockerInfo()
  findings.push({
    name: 'docker',
    ok: docker.ok,
    required: profile?.app !== undefined,
    detail: docker.ok ? docker.detail : `${docker.detail}${profile?.app !== undefined ? ' (this profile boots an app, so the daemon is required)' : ''}`,
    install: docker.ok ? undefined : 'install Docker and start its daemon',
  })

  const browser = await chromium()
  const browserRequired =
    profile !== undefined &&
    (profile.suites.some((suite) => suite.kind === 'flow' || suite.kind === 'visual') ||
      profile.visual.widths.length > 0 ||
      profile.visual.themes.length > 0)
  findings.push({
    name: 'chromium',
    ok: browser.ok,
    required: browserRequired,
    detail: browser.detail,
    install: browser.ok ? undefined : 'install playwright-core beside qare and run npx playwright install chromium',
  })

  findings.push(
    {
      name: 'display',
      ok: true,
      required: false,
      detail: 'no display is needed: the browser driver runs headless',
    },
    {
      name: 'devices',
      ok: true,
      required: false,
      detail: 'devices arrive through the MCP servers a profile registers, so none are checked here',
    },
  )

  return {
    execution,
    ready: findings.every((finding) => !finding.required || finding.ok),
    findings,
  }
}

async function nareFinding(
  explicit: string | undefined,
  which: (name: string) => string | undefined,
): Promise<DoctorFinding> {
  if (explicit !== undefined) {
    let usable = false
    try {
      accessSync(explicit, constants.X_OK)
      usable = true
    } catch {}
    return {
      name: 'nare',
      ok: usable,
      required: true,
      detail: usable ? `nare at ${explicit}` : `the --nare binary ${explicit} is not an executable file`,
      install: usable ? undefined : NARE_INSTALL,
    }
  }
  const found = which('nare')
  return {
    name: 'nare',
    ok: found !== undefined,
    required: true,
    detail: found === undefined ? 'nare is not on PATH' : `nare at ${found}`,
    install: found === undefined ? NARE_INSTALL : undefined,
  }
}

/**
 * The python3 that would install nare. It is required only while nare is
 * missing: an installed nare may run under its own interpreter (pipx, a venv),
 * so an older python3 on PATH says nothing about it. While nare is missing, an
 * interpreter below the floor is the reason the install would fail, so it is
 * named before pip refuses the wheel (#204).
 */
function pythonFinding(found: { version?: string; detail: string }, nareMissing: boolean): DoctorFinding {
  const ok = found.version !== undefined && atLeast(found.version, NARE_PYTHON_MINIMUM)
  return {
    name: 'python',
    ok,
    required: nareMissing,
    detail: `${found.detail} (the pinned nare needs python ${NARE_PYTHON_MINIMUM} or newer)`,
    install:
      ok || !nareMissing
        ? undefined
        : `install Python ${NARE_PYTHON_MINIMUM} or newer and put it first on PATH as python3 (on a GitHub Actions runner, actions/setup-python with python-version '${NARE_PYTHON_MINIMUM}')`,
  }
}

/** Whether a dotted version is at or above a dotted floor, compared numerically. */
function atLeast(version: string, floor: string): boolean {
  const have = version.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const need = floor.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let i = 0; i < need.length; i += 1) {
    const a = have[i] ?? 0
    const b = need[i] ?? 0
    if (a !== b) return a > b
  }
  return true
}

function python3Version(): Promise<{ version?: string; detail: string }> {
  return new Promise((resolvePromise) => {
    execFile('python3', ['--version'], { timeout: 10000 }, (error, stdout, stderr) => {
      // Python 2 and some older 3.x print the version on stderr.
      const version = /Python (\d+(?:\.\d+)*)/.exec(`${String(stdout)} ${String(stderr)}`)?.[1]
      if (error !== null || version === undefined) resolvePromise({ detail: 'no python3 on PATH answered python3 --version' })
      else resolvePromise({ version, detail: `python3 ${version}` })
    })
  })
}

function nodeMajor(): number {
  return Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10) || 0
}

function whichOnPath(name: string): string | undefined {
  const path = process.env.PATH ?? ''
  for (const dir of path.split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  return undefined
}

function dockerDaemon(): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolvePromise) => {
    execFile('docker', ['info', '--format', 'server {{.ServerVersion}}'], { timeout: 10000 }, (error, stdout) => {
      // execFile passes null, not undefined, when the command succeeds (#206).
      if (error === null) resolvePromise({ ok: true, detail: `docker daemon reachable (${String(stdout).trim()})` })
      else resolvePromise({ ok: false, detail: 'docker daemon not reachable' })
    })
  })
}

async function chromiumDriver(): Promise<{ ok: boolean; detail: string }> {
  try {
    const playwright = await import('playwright-core')
    const executable = playwright.chromium.executablePath()
    if (existsSync(executable)) return { ok: true, detail: `chromium driver at ${executable}` }
    return { ok: false, detail: 'playwright-core is installed, but the chromium browser is not downloaded' }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ERR_MODULE_NOT_FOUND')
      return { ok: false, detail: 'playwright-core is not installed' }
    return { ok: false, detail: `playwright-core failed to load: ${String(error)}` }
  }
}
