import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { clientCellProblem } from './client-cell.js'
import { electronDisplayProblem } from './flow-electron.js'
import type { DeviceKind, HostOperatingSystem, ProfileRequires, QaProfile } from './profile.js'

/**
 * Where a run can execute (#76). Some clients cannot run anywhere: a
 * simulator needs macOS, an emulator needs hardware virtualisation, a
 * desktop build needs somewhere to open a window. A profile says what it
 * requires, its shape implies the rest, and a run holds the host to all of
 * it before anything is provisioned, so the answer is a refusal that names
 * what is missing instead of a failure halfway through.
 */

/**
 * Everything a run requires of its host: what the profile declares
 * (`requires`), and what its shape already implies. `cell` is a container
 * the docker daemon makes for a contained client build (#223); `display` is
 * somewhere a window can open, for a build launched on the host itself (#72).
 */
export interface Requirements extends ProfileRequires {
  cell?: true
  display?: true
}

/**
 * The requirement table. The browser, and so a profile that boots an app or
 * names a target, implies nothing: it runs headless on any host. A client
 * build implies where its windows open. A device driver (#73, #74) adds its
 * row here.
 */
export function requirementsOf(profile: QaProfile): Requirements {
  return {
    ...profile.requires,
    ...(profile.client === undefined ? {} : profile.client.egress === 'uncontained' ? { display: true as const } : { cell: true as const }),
  }
}

/** The runners a run can know it is on: what GitHub Actions calls its two kinds. */
export type RunnerKind = 'github-hosted' | 'self-hosted'

/**
 * The kind of host a run executed on, as the evidence names it (#76). `os`
 * is one of the three a profile can require, or the platform's own name when
 * it is none of them. `runner` is absent for a run nothing placed: one a
 * person started.
 */
export interface HostKind {
  os: HostOperatingSystem | (string & {})
  arch: string
  /** Whether hardware virtualisation is usable here. Detected on Linux only. */
  virtualisation: boolean
  runner?: RunnerKind
}

/**
 * The seams host detection runs through, so a test can be any machine. Every
 * one falls back to the real host.
 */
export interface HostProbes {
  platform?: NodeJS.Platform | (string & {})
  arch?: string
  env?: NodeJS.ProcessEnv
  /** Why hardware virtualisation is not usable on this Linux host, or undefined when it is. */
  virtualisation?: () => string | undefined
  /** The attached devices of a kind, and why there are none when there are none. */
  devices?: (kind: DeviceKind) => Promise<AttachedDevices>
  /** Why a cell cannot be made here (#223), or undefined when it can. */
  cell?: () => Promise<string | undefined>
  /** Why a window cannot open here (#72), or undefined when it can. */
  display?: () => string | undefined
}

export interface AttachedDevices {
  attached: string[]
  detail?: string
}

const PLATFORM_NAMES: Record<string, HostOperatingSystem> = { linux: 'linux', darwin: 'macos', win32: 'windows' }

const KVM = '/dev/kvm'

/** Why this Linux host offers no hardware virtualisation: an emulator opens /dev/kvm for reading and writing. */
function kvmProblem(): string | undefined {
  if (!existsSync(KVM)) return `${KVM} is not there, so this host offers no hardware virtualisation`
  try {
    accessSync(KVM, constants.R_OK | constants.W_OK)
    return undefined
  } catch {
    return `${KVM} is there, but this user cannot open it for reading and writing`
  }
}

function runnerOf(env: NodeJS.ProcessEnv): RunnerKind | undefined {
  // Inside the run's container the runner's own variables are not there: the
  // pipeline hands the one that matters in under qare's name.
  const named = env.QARE_RUNNER_ENVIRONMENT ?? env.RUNNER_ENVIRONMENT
  return named === 'github-hosted' || named === 'self-hosted' ? named : undefined
}

/** Read the host kind from the machine. Cheap, and asks nothing of any daemon or device. */
export function detectHost(probes: HostProbes = {}): HostKind {
  const platform = probes.platform ?? process.platform
  const os = PLATFORM_NAMES[platform] ?? platform
  const runner = runnerOf(probes.env ?? process.env)
  return {
    os,
    arch: probes.arch ?? process.arch,
    virtualisation: os === 'linux' && (probes.virtualisation ?? kvmProblem)() === undefined,
    ...(runner === undefined ? {} : { runner }),
  }
}

/** The host kind in a sentence: what the comment says produced a result. */
export function describeHost(host: HostKind): string {
  const runner = host.runner === undefined ? '' : `, a ${host.runner === 'github-hosted' ? 'GitHub-hosted' : 'self-hosted'} runner`
  return `a ${host.os} ${host.arch} host${runner}`
}

const ADB_TIMEOUT_MS = 10_000

function adbDevices(): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile('adb', ['devices'], { timeout: ADB_TIMEOUT_MS }, (error, stdout) => {
      if (error === null) resolve({ code: 0, stdout: String(stdout) })
      else resolve({ code: typeof error.code === 'number' ? error.code : 127, stdout: String(stdout) })
    })
  })
}

/**
 * The Android devices attached to this host: what `adb devices` lists in the
 * `device` state. An emulator is left out, because it is not attached: it is
 * what `virtualisation` is required for, and starting one belongs to the
 * driver (#73).
 */
export async function attachedAndroidDevices(run: () => Promise<{ code: number; stdout: string }> = adbDevices): Promise<AttachedDevices> {
  const listed = await run()
  if (listed.code !== 0) return { attached: [], detail: `no adb answered (adb devices exited ${listed.code}), so no attached device can be seen` }
  const attached = listed.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial !== undefined && state === 'device' && !serial.startsWith('emulator-'))
    .map(([serial]) => serial as string)
  return attached.length === 0 ? { attached, detail: 'adb lists no attached device in the device state' } : { attached }
}

const DEVICE_PROBES: Record<DeviceKind, () => Promise<AttachedDevices>> = {
  android: () => attachedAndroidDevices(),
}

/**
 * What the host does not have, of what a run requires: one entry for each
 * thing that is missing, every one of them, so a refusal names the whole gap
 * at once. Empty when the run can execute here. Devices, the cell and the
 * display are asked about only when they are required.
 */
export async function unmetRequirements(requirements: Requirements, host: HostKind, probes: HostProbes = {}): Promise<string[]> {
  const missing: string[] = []
  if (requirements.os !== undefined && requirements.os !== host.os) missing.push(`a ${requirements.os} host (requires.os): this host is ${host.os}`)
  if (requirements.virtualisation === true && !host.virtualisation) {
    const why =
      host.os === 'linux'
        ? ((probes.virtualisation ?? kvmProblem)() ?? 'this host offers none')
        : `qare detects it on Linux only (${KVM}), and this host is ${host.os}`
    missing.push(`hardware virtualisation (requires.virtualisation): ${why}`)
  }
  for (const kind of requirements.devices ?? []) {
    const found = await (probes.devices ?? ((asked: DeviceKind) => DEVICE_PROBES[asked]()))(kind)
    if (found.attached.length === 0) missing.push(`an attached ${kind} device (requires.devices): ${found.detail ?? 'none is attached'}`)
  }
  if (requirements.cell === true) {
    const problem = await (probes.cell ?? ((): Promise<string | undefined> => clientCellProblem()))()
    if (problem !== undefined) missing.push(problem)
  }
  if (requirements.display === true) {
    const problem = (probes.display ?? ((): string | undefined => electronDisplayProblem()))()
    if (problem !== undefined) missing.push(problem)
  }
  return missing
}

/**
 * Why this run may not execute on the runner it landed on, or undefined when
 * it may (#76). A public repository keeps its runs on GitHub-hosted runners:
 * every job there gets a machine of its own, and a runner that outlives its
 * job keeps whatever a pull request left on it (rule 7). Self-hosted capacity
 * is opt in, in as many words. A private repository chooses its own runners,
 * and a run nothing placed (no runner, or a repository the run was not told
 * the visibility of) is somebody's own to place.
 */
export function placementProblem(host: HostKind, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (host.runner !== 'self-hosted') return undefined
  if (env.QARE_REPOSITORY_VISIBILITY !== 'public') return undefined
  if (env.QARE_SELF_HOSTED === 'allow') return undefined
  return 'this repository is public and the run landed on a self-hosted runner: a public repository keeps its runs on GitHub-hosted runners, because a runner that outlives its job keeps whatever a pull request left on it; to use your own capacity anyway, opt in with the pipeline input self-hosted: allow'
}
