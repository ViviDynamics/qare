import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { detectExecution, type ExecutionKind } from './environment.js'
import { electronDisplayProblem } from './flow-electron.js'
import { describeHost, detectHost, requirementsOf, unmetRequirements, virtualisationProblem, type HostKind, type HostProbes, type Requirements } from './placement.js'
import { ProfileMissingError, loadProfile, type QaProfile } from './profile.js'
import { VERSION } from './version.js'
import { inspectRunnerSafety, type RunnerSafetyFinding, type RunnerSafetyProbes } from './runner-safety.js'

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
  checklist?: RunnerSafetyFinding['checklist']
  status?: RunnerSafetyFinding['status']
}

export interface DoctorReport {
  execution: ExecutionKind
  /** The kind of host this is (#76): what a run here would record in its evidence. */
  host: HostKind
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
  /** Why a desktop window cannot be shown on this host, or undefined when it can (#72). */
  display?: () => string | undefined
  /** The host a profile's requirements are held to (#76): its kind, its virtualisation, its devices, its cell. */
  host?: HostProbes
  runnerSafety?: RunnerSafetyProbes
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
 * and the chromium driver for a profile whose suites drive a browser. What
 * the profile requires of the host itself is the table a run refuses on
 * (#76): the operating system, hardware virtualisation and attached devices
 * it declares in `requires`, a cell for a contained client build (#223), and
 * a display for one launched on the host (#72). The host kind is reported
 * either way.
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

  // What the profile requires of the host (#76), from the one table a run
  // holds its host to: what it declares in `requires`, and what its shape
  // implies. The run refuses on exactly these, so this is where a host
  // learns it before a run does.
  const host = detectHost(probes.host)
  const unvirtualised = virtualisationProblem(host, probes.host)
  findings.push({
    name: 'host',
    ok: true,
    required: false,
    detail: `${describeHost(host)}; hardware virtualisation is ${unvirtualised === undefined ? 'usable' : `not usable (${unvirtualised})`}`,
  })
  const requirements: Requirements = profile === undefined ? {} : requirementsOf(profile)
  const held = async (requirement: Requirements, met: string, install: string): Promise<Omit<DoctorFinding, 'name'>> => {
    const [missing] = await unmetRequirements(requirement, host, probes.host)
    return missing === undefined ? { ok: true, required: true, detail: met } : { ok: false, required: true, detail: `this profile requires ${missing}`, install }
  }
  if (requirements.os !== undefined)
    findings.push({
      name: 'os',
      ...(await held(
        { os: requirements.os },
        `this host is ${host.os}, which the profile requires`,
        `run it on a ${requirements.os} host: an operating system is not something to install`,
      )),
    })
  if (requirements.virtualisation === true)
    findings.push({
      name: 'virtualisation',
      ...(await held(
        { virtualisation: true },
        'this host offers hardware virtualisation, which the profile requires',
        'use a Linux host whose /dev/kvm this user can open (enable KVM, and add the user to the kvm group)',
      )),
    })
  // A contained build is launched in a cell the docker daemon makes (#223).
  if (requirements.cell === true) {
    const [problem] = await unmetRequirements({ cell: true }, host, probes.host)
    findings.push(
      problem === undefined
        ? { name: 'cell', ok: true, required: true, detail: 'this host can make a cell for the build' }
        : {
            name: 'cell',
            ok: false,
            required: true,
            detail: problem,
            install: 'run it where a docker daemon holds the qare image the run is in (the pipeline does), or say client.egress: uncontained in the profile',
          },
    )
  }

  // A desktop build launched on the host opens real windows there (#72), so
  // it needs a display; the browser driver needs none, and a contained
  // build's windows open on its cell's display (#223).
  const displayProblem = requirements.display !== true ? undefined : (probes.display ?? ((): string | undefined => electronDisplayProblem()))()
  findings.push(
    requirements.display !== true
      ? {
          name: 'display',
          ok: true,
          required: false,
          detail:
            profile?.client === undefined
              ? 'no display is needed: the browser driver runs headless'
              : "no display is needed on this host: a contained build opens its windows on its cell's display",
        }
      : {
          name: 'display',
          ok: displayProblem === undefined,
          required: true,
          detail:
            displayProblem === undefined
              ? `a display is available for the ${profile?.client?.driver ?? 'client'} driver`
              : `${displayProblem} (this profile launches a desktop build, so a display is required)`,
          install: displayProblem === undefined ? undefined : 'install Xvfb, which the driver starts for each launch, or name a running display in DISPLAY',
        },
    // An archive the run installs is unpacked with the host's tar (#75); a
    // profile that installs nothing, or copies a directory, needs none.
    ...(profile?.client?.artefact?.kind !== 'archive'
      ? []
      : [
          ((): DoctorFinding => {
            const tar = which('tar')
            return {
              name: 'tar',
              ok: tar !== undefined,
              required: true,
              detail:
                tar !== undefined
                  ? `tar at ${tar}`
                  : 'tar is not on PATH (this profile installs an archive (client.artefact.kind), which is unpacked with tar)',
              install: tar !== undefined ? undefined : 'install tar, or name a build that is already unpacked with client.artefact.kind: directory',
            }
          })(),
        ]),
  )
  // Attached devices are required only by a profile that says so (#76);
  // otherwise they arrive through the MCP servers a profile registers.
  if (requirements.devices === undefined)
    findings.push({
      name: 'devices',
      ok: true,
      required: false,
      detail: 'no attached device is required (requires.devices declares none); devices a profile reaches through its MCP servers are not checked here',
    })
  for (const kind of requirements.devices ?? [])
    findings.push({
      name: 'devices',
      ...(await held(
        { devices: [kind] },
        `an attached ${kind} device is there, which the profile requires`,
        `attach an ${kind} device with USB debugging allowed, and install adb (the Android platform tools) on PATH`,
      )),
    })

  const safety = await inspectRunnerSafety(probes.host?.env, probes.runnerSafety)
  findings.push(...(safety ?? []).map(finding => ({ ...finding, name: `self-hosted ${finding.checklist}`, ok: finding.status !== 'finding', required: false })))

  return {
    execution,
    host,
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
