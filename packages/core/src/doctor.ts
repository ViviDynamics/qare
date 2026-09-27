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
  const execution = detectExecution()

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
    await nareFinding(opts.nare, which),
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
      install: usable ? undefined : 'install the pinned nare beside qare (python3 -m pip install --user <pinned nare wheel>)',
    }
  }
  const found = which('nare')
  return {
    name: 'nare',
    ok: found !== undefined,
    required: true,
    detail: found === undefined ? 'nare is not on PATH' : `nare at ${found}`,
    install: found === undefined ? 'install the pinned nare beside qare (python3 -m pip install --user <pinned nare wheel>)' : undefined,
  }
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
      if (error === undefined) resolvePromise({ ok: true, detail: `docker daemon reachable (${String(stdout).trim()})` })
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
