import { spawn } from 'node:child_process'
import { constants } from 'node:os'
import { startGate } from './cell-gate.js'
import { startShim, type Shim, type ShimOptions } from './cell-shim.js'
import { hostName } from './cell-wire.js'
import { startVirtualDisplay, xvfbOnPath } from './flow-electron.js'

/**
 * What runs inside the two containers of a client build's cell (#223,
 * ADR-0006), as `qare cell gate` and `qare cell launch`. Neither is a
 * command a person runs: the run starts both, from the image it is in.
 *
 * The launcher is the build's container's first process. It sets up the
 * cell's loopback network and a virtual display, starts the build with its
 * own streams, hands it the signals it is sent, and exits as the build did.
 */

/** The launcher's own failure, distinct from any code a build is likely to exit with. */
const LAUNCH_FAILED = 70

/** The part of a child process the launcher uses. */
interface BuildProcess {
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

/** Where signals arrive: the process, or a test's stand-in. */
interface SignalSource {
  on(event: string, listener: () => void): unknown
  off(event: string, listener: () => void): unknown
}

const FORWARDED: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP']

export interface CellLaunchOptions {
  command: string
  args: string[]
  socketDir: string
  cdpPort: number
  env?: NodeJS.ProcessEnv
  /** Where the launcher's own failures are said: its standard error, which the run reads as the build's. */
  err: (line: string) => void
  signals?: SignalSource
  startShim?: (opts: ShimOptions) => Promise<Shim>
  /** The port where the run's booted app answers, and how; the shim intercepts it for the build (#224). */
  appPort?: number
  appScheme?: 'http' | 'https'
  /**
   * A declared stub host and the port its service answers on (#224): the
   * shim intercepts the pair by the host's own address, so a command dials
   * the stub on the port the profile names and the gate asks about it.
   */
  stubPorts?: { host: string; port: number }[]
  /** A command check needs no display: the launcher asks for no Xvfb and starts none (#224). */
  noDisplay?: boolean
  xvfb?: () => string | undefined
  startDisplay?: (xvfb: string) => Promise<{ display: string; stop: () => Promise<void> }>
  spawnBuild?: (command: string, args: string[], env: NodeJS.ProcessEnv) => BuildProcess
}

export async function launchInCell(opts: CellLaunchOptions): Promise<number> {
  const env = opts.env ?? process.env
  const signals = opts.signals ?? process
  let shim: Shim
  try {
    shim = await (opts.startShim ?? startShim)({
      socketDir: opts.socketDir,
      cdpPort: opts.cdpPort,
      ...(opts.appPort === undefined ? {} : { appPort: opts.appPort }),
      ...(opts.appScheme === undefined ? {} : { appScheme: opts.appScheme }),
      ...(opts.stubPorts === undefined ? {} : { stubPorts: opts.stubPorts }),
    })
  } catch (error) {
    opts.err(`qare cell: the cell's network could not be set up: ${(error as Error).message}`)
    return LAUNCH_FAILED
  }
  let display: { display: string; stop: () => Promise<void> } | undefined
  const cleanUp = async (): Promise<void> => {
    await display?.stop().catch(() => {})
    await shim.stop().catch(() => {})
  }
  if (opts.noDisplay !== true) {
    const xvfb = (opts.xvfb ?? ((): string | undefined => xvfbOnPath(env)))()
    if (xvfb === undefined) {
      await cleanUp()
      opts.err('qare cell: no Xvfb is on PATH to start a virtual display for the build; the web image ships it')
      return LAUNCH_FAILED
    }
    try {
      display = await (opts.startDisplay ?? startVirtualDisplay)(xvfb)
    } catch (error) {
      await cleanUp()
      opts.err(`qare cell: ${(error as Error).message}`)
      return LAUNCH_FAILED
    }
  }

  const spawnBuild = opts.spawnBuild ?? ((command: string, args: string[], buildEnv: NodeJS.ProcessEnv): BuildProcess => spawn(command, args, { env: buildEnv, stdio: 'inherit' }))
  const childEnv = display === undefined ? env : { ...env, DISPLAY: display.display }
  const code = await new Promise<number>((resolve) => {
    let child: BuildProcess
    try {
      child = spawnBuild(opts.command, opts.args, childEnv)
    } catch (error) {
      opts.err(`qare cell: the build could not be started: ${(error as Error).message}`)
      return resolve(LAUNCH_FAILED)
    }
    // Stopping is the build's to do: it is handed every signal the launcher gets.
    const forwards = FORWARDED.map((signal) => {
      const forward = (): void => void child.kill(signal)
      signals.on(signal, forward)
      return (): void => void signals.off(signal, forward)
    })
    const done = (exit: number): void => {
      for (const stop of forwards) stop()
      resolve(exit)
    }
    child.on('error', (error) => {
      opts.err(`qare cell: the build could not be started: ${error.message}`)
      done(LAUNCH_FAILED)
    })
    child.on('exit', (exit, signal) => done(exit ?? 128 + (signal === null ? 0 : (constants.signals[signal] ?? 0))))
  })
  await cleanUp()
  return code
}

const USAGE =
  'usage: qare cell gate --socket-dir <dir> [--host <name>]... [--port <port> <scheme>] [--map <host>=<name>]... [--stub <host>:<port>]... [--app <host>:<port>[:<dial-port>]] | qare cell launch --socket-dir <dir> --cdp-port <port> [--no-display] [--stub <host>:<port>]... -- <command> [args...]'

/** The `--port <port> <scheme>` flags, named by both the gate and the launcher for the app the run boots (#224). */
function parsePorts(flags: string[], who: string): { ports: { port: number; protocol: 'http' | 'https' }[]; error: string | undefined } {
  const ports: { port: number; protocol: 'http' | 'https' }[] = []
  for (let index = 0; index < flags.length; index++) {
    if (flags[index] !== '--port') continue
    const port = Number(flags[index + 1])
    const protocol = flags[index + 2]
    if (!Number.isInteger(port) || port <= 0 || port > 65_535 || (protocol !== 'http' && protocol !== 'https')) {
      return { ports, error: `${who}: --port must be a port and a scheme, http or https` }
    }
    ports.push({ port, protocol })
  }
  return { ports, error: undefined }
}

/** The `--stub <host>:<port>` flags a launch carries: a declared host and the port its service answers on (#224). */
function parseStubPorts(flags: string[], who: string): { stubPorts: { host: string; port: number }[]; error: string | undefined } {
  const stubPorts: { host: string; port: number }[] = []
  for (let index = 0; index < flags.length; index++) {
    if (flags[index] !== '--stub') continue
    const at = (flags[index + 1] ?? '').lastIndexOf(':')
    const host = at === -1 ? '' : flags[index + 1]?.slice(0, at) ?? ''
    const name = hostName(host)
    const port = Number(flags[index + 1]?.slice(at + 1))
    if (at === -1 || name === undefined || !Number.isInteger(port) || port <= 0 || port > 65_535) {
      return { stubPorts, error: `${who}: --stub must be a <host>:<port> pair, the host a declared stub is dialed by and the port its service answers on` }
    }
    stubPorts.push({ host: name, port })
  }
  return { stubPorts, error: undefined }
}

export interface CellCommandIo {
  /** One line of standard output: the gate's lines, which the run reads. */
  out: (line: string) => void
  err: (line: string) => void
  signals?: SignalSource
}

/** `qare cell gate` and `qare cell launch`. Exit 4 is a call that was not understood, as elsewhere in the CLI. */
export async function runCellCommand(argv: string[], io: CellCommandIo): Promise<number> {
  const [verb, ...rest] = argv
  if (verb !== 'gate' && verb !== 'launch') {
    io.err(USAGE)
    return 4
  }
  const split = rest.indexOf('--')
  const flags = split === -1 ? rest : rest.slice(0, split)
  const command = split === -1 ? [] : rest.slice(split + 1)
  const values = (name: string): string[] => flags.flatMap((flag, index) => (flag === name && flags[index + 1] !== undefined ? [flags[index + 1] as string] : []))
  const socketDir = values('--socket-dir')[0]
  const signals = io.signals ?? process

  if (verb === 'launch') {
    if (command.length === 0) {
      io.err('qare cell launch: no command to launch after --')
      return 4
    }
    const cdpPort = Number(values('--cdp-port')[0])
    if (socketDir === undefined) {
      io.err('qare cell launch: --socket-dir is required')
      return 4
    }
    if (!Number.isInteger(cdpPort) || cdpPort <= 0 || cdpPort > 65_535) {
      io.err('qare cell launch: --cdp-port must be a port')
      return 4
    }
    const parsed = parsePorts(flags, 'qare cell launch')
    if (parsed.error !== undefined) {
      io.err(parsed.error)
      return 4
    }
    if (parsed.ports.length > 1) {
      io.err('qare cell launch: one --port is all a launch carries')
      return 4
    }
    const parsedStubs = parseStubPorts(flags, 'qare cell launch')
    if (parsedStubs.error !== undefined) {
      io.err(parsedStubs.error)
      return 4
    }
    const app = parsed.ports[0]
    return launchInCell({
      command: command[0] as string,
      args: command.slice(1),
      socketDir,
      cdpPort,
      ...(app === undefined ? {} : { appPort: app.port, appScheme: app.protocol }),
      ...(parsedStubs.stubPorts.length === 0 ? {} : { stubPorts: parsedStubs.stubPorts }),
      ...(flags.includes('--no-display') ? { noDisplay: true } : {}),
      err: io.err,
      signals,
    })
  }

  if (socketDir === undefined) {
    io.err('qare cell gate: --socket-dir is required')
    return 4
  }
  const hosts = values('--host')
  // The list is the profile's, already held to being names; the gate holds it to that again.
  const bad = hosts.find((host) => hostName(host.replace(/^\*\./, '')) === undefined)
  if (bad !== undefined) {
    io.err(`qare cell gate: ${JSON.stringify(bad)} is not a host name`)
    return 4
  }
  // A port the run booted the app on, carried beside the gate's own two (#224).
  const parsedPorts = parsePorts(flags, 'qare cell gate')
  if (parsedPorts.error !== undefined) {
    io.err(parsedPorts.error)
    return 4
  }
  const ports = parsedPorts.ports
  // A port a declared stub names, beside the gate's own two (#224): the gate
  // holds a mapped host to them, whether or not the shim's bindings hold.
  const parsedStubs = parseStubPorts(flags, 'qare cell gate')
  if (parsedStubs.error !== undefined) {
    io.err(parsedStubs.error)
    return 4
  }
  // A declared host dialed as the name that answers: the compose service that
  // provides a stub, or the address the run's bridge answers the app at (#224).
  const map: Record<string, string> = {}
  for (const entry of values('--map')) {
    const at = entry.indexOf('=')
    const name = at === -1 ? '' : entry.slice(0, at)
    if (at === -1 || name === '' || entry.slice(at + 1) === '' || hostName(name.replace(/^\*\./, '')) === undefined) {
      io.err(`qare cell gate: ${JSON.stringify(entry)} is not a <host>=<name> mapping`)
      return 4
    }
    map[name] = entry.slice(at + 1)
  }
  const relayPort = values('--relay-port')[0]
  // The run's app, when the stack booted one: the host it is asked for by,
  // the port it is published at, and the port inside the stack the published
  // port leads to (#224).
  let app: { host: string; port: number; dialPort?: number } | undefined
  const appFlag = values('--app')[0]
  if (appFlag !== undefined) {
    const parts = appFlag.split(':')
    const port = Number(parts[1])
    const dialPort = parts[2] === undefined ? undefined : Number(parts[2])
    const carried = (value: number | undefined): boolean => value !== undefined && Number.isInteger(value) && value > 0 && value <= 65_535
    const name = parts.length > 1 && parts.length < 4 ? hostName(parts[0] ?? '') : undefined
    if (name === undefined || !carried(port) || (dialPort !== undefined && !carried(dialPort))) {
      io.err(`qare cell gate: ${JSON.stringify(appFlag)} is not an <host>:<port>[:<dial-port>] app`)
      return 4
    }
    app = { host: name, port, ...(dialPort === undefined ? {} : { dialPort }) }
  }
  let gate
  try {
    gate = await startGate({
      hosts,
      socketDir,
      write: io.out,
      ...(relayPort === undefined ? {} : { relayPort: Number(relayPort) }),
      ...(ports.length === 0 ? {} : { ports }),
      ...(parsedStubs.stubPorts.length === 0 ? {} : { stubPorts: parsedStubs.stubPorts }),
      ...(Object.keys(map).length === 0 ? {} : { map }),
      ...(app === undefined ? {} : { app }),
    })
  } catch (error) {
    io.err(`qare cell gate: could not start: ${(error as Error).message}`)
    return 4
  }
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      for (const signal of FORWARDED) signals.off(signal, stop)
      resolve()
    }
    for (const signal of FORWARDED) signals.on(signal, stop)
  })
  await gate.stop()
  return 0
}
