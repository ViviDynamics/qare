import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { connect } from 'node:net'
import { GATE_RELAY_PORT, type GateSummary, type ReachedHost } from './cell-gate.js'

/**
 * The cell a client build runs in (#223, ADR-0006), made through the docker
 * daemon the run already holds: a volume in memory, a gate, and the build's
 * own container with no network at all. This module is the run's side of
 * it: the docker calls that make a cell, the record read back when it is
 * disposed, and its removal. The gate and the launcher run in the two
 * containers (cell-gate.ts, cell-launch.ts).
 */

/** Where the shared volume is mounted in both containers. */
export const SOCKET_DIR = '/run/qare-cell'
export const GATE_READY_TIMEOUT_MS = 60_000
/** How long the gate is given to write its record once asked to stop. */
export const GATE_STOP_SECONDS = 10
const OPT_OUT =
  'a profile that must run uncontained says so: a build with client.egress: uncontained, a command with commands.<name>.egress: uncontained, and the evidence then says it too'

/** The part of a child process a cell uses: what the Electron driver reads its application through. */
export interface CellProcess {
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
  /** `close` is `exit` once both streams have been read to their end. */
  on(event: 'exit' | 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

/** The docker CLI, as far as a cell uses it, so a test can stand one in. */
export interface CellDocker {
  /** Run one docker command to its end. */
  run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>
  /** Start a docker command that stays attached to its container. */
  spawn(args: string[]): CellProcess
  /** Run one docker command without waiting on the event loop: the harness is exiting. */
  runSync(args: string[]): void
}

const DOCKER_CALL_TIMEOUT_MS = 60_000

export const defaultCellDocker: CellDocker = {
  run: (args) =>
    new Promise((resolve) => {
      const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => child.kill('SIGKILL'), DOCKER_CALL_TIMEOUT_MS)
      child.stdout.on('data', (chunk) => (stdout += String(chunk)))
      child.stderr.on('data', (chunk) => (stderr += String(chunk)))
      child.on('error', (error) => {
        clearTimeout(timer)
        resolve({ code: 127, stdout, stderr: error.message })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code: code ?? 1, stdout, stderr })
      })
    }),
  spawn: (args) => spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] }),
  runSync: (args) => {
    spawnSync('docker', args, { stdio: 'ignore', timeout: 20_000 })
  },
}

export const firstLine = (text: string): string => text.trim().split('\n')[0]?.trim() ?? ''

/** An image reference is an argument to docker, so it is held to looking like one. */
const IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/

/**
 * Why a cell cannot be made here, or undefined when it can (#223). Checked
 * once, before any check runs, so a host that cannot contain a client build
 * blocks the run by name instead of running the build uncontained.
 */
export async function clientCellProblem(env: NodeJS.ProcessEnv = process.env, docker: CellDocker = defaultCellDocker): Promise<string | undefined> {
  // The probe serves a contained build and a contained command alike (#224),
  // so the refusal names the requirement, not which of the two asked for it.
  const image = env.QARE_IMAGE_REF ?? ''
  if (image === '')
    return `a contained build or command runs in a cell made from the image the run is in, and QARE_IMAGE_REF names none (the pipeline's execute step sets it); ${OPT_OUT}`
  if (!IMAGE_REFERENCE.test(image)) return `a contained build or command runs in a cell made from the image the run is in, and QARE_IMAGE_REF is not an image reference; ${OPT_OUT}`
  const daemon = await docker.run(['version', '--format', '{{.Server.Version}}'])
  if (daemon.code !== 0)
    return `a contained build or command runs in a cell the docker daemon makes, and no daemon answered (${firstLine(daemon.stderr) || `docker exited ${daemon.code}`}); ${OPT_OUT}`
  const present = await docker.run(['image', 'inspect', '--format', '{{.Id}}', image])
  if (present.code !== 0)
    return `a contained build or command runs in a cell made from the image the run is in, and the docker daemon does not have ${image}; ${OPT_OUT}`
  return undefined
}

/** The cells this process still has: what a signal that ends it must take along. */
const liveCells = new Set<() => void>()

/** Keep a cell's removal for a cancelled run to call (#223). Returns the release, for when the cell is gone. */
export function trackLiveCell(reap: () => void): () => void {
  liveCells.add(reap)
  return () => void liveCells.delete(reap)
}

/** Remove every cell this process still has, at once. Synchronous: it runs as the process is being ended. */
export function reapLiveCells(): void {
  for (const reap of [...liveCells]) {
    liveCells.delete(reap)
    try {
      reap()
    } catch {
      // Nothing more can be done from a process that is ending.
    }
  }
}

/** What the gate recorded for one launch. `incomplete` says why the list is not the whole of it. */
export interface CellRecord {
  reached: ReachedHost[]
  incomplete?: string
}

/** A started cell, as the Electron driver uses it. */
export interface ClientCell {
  /** The port the build's DevTools endpoint listens on, inside the cell. */
  debuggingPort: number
  /** The user data directory the build is given, inside the cell and gone with it. */
  userDataDir: string
  /** Start the build inside the cell. */
  spawn(command: string, args: string[]): CellProcess
  /** The endpoint the build printed, as the address the driver reaches it at. */
  endpoint(printed: string): string
  /** What the gate recorded. Only after `dispose`; throws when the record never arrived. */
  record(): CellRecord
  dispose(): Promise<void>
  /** Remove the cell at once, from a harness that is exiting. */
  reap(): void
}

export interface ClientCellOptions {
  /** The image both containers run: the one the run itself is in. */
  image: string
  hosts: readonly string[]
  /**
   * The directory the build is launched from: the one its executable is in,
   * in the repository, or the one the run installed it to (#75). It is
   * copied into the cell at the same path, over the daemon's API, never
   * mounted. A copy need not be a path the daemon can see (the run's own
   * temporary directory is not, when the run is in a container), and it
   * holds no socket and nothing made after it was taken: a process outside
   * the cell cannot leave the build a way round the gate in the checkout.
   */
  install: string
  docker?: CellDocker
  uid?: number
  gid?: number
  id?: string
  readyTimeoutMs?: number
  /** Whether a TCP connection to an address opens; a real attempt by default. */
  canConnect?: (host: string, port: number) => Promise<boolean>
}

const RELAY_PROBE_TIMEOUT_MS = 2_000

function tcpAnswers(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const done = (answered: boolean): void => {
      clearTimeout(timer)
      socket.destroy()
      resolve(answered)
    }
    const timer = setTimeout(() => done(false), RELAY_PROBE_TIMEOUT_MS)
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

function isReached(value: unknown): value is ReachedHost {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry.host === 'string' && typeof entry.port === 'number' && typeof entry.protocol === 'string' && typeof entry.declared === 'boolean' && typeof entry.count === 'number'
}

/** The gate's record line, when the line is one. Shared with the command cell, which reads the same record. */
export function summaryIn(line: string): GateSummary | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const summary = parsed as Record<string, unknown>
  if (summary.event !== 'summary' || !Array.isArray(summary.reached) || !summary.reached.every(isReached)) return undefined
  return { event: 'summary', reached: summary.reached, capped: summary.capped === true }
}

export async function startClientCell(opts: ClientCellOptions): Promise<ClientCell> {
  const docker = opts.docker ?? defaultCellDocker
  const id = opts.id ?? randomBytes(6).toString('hex')
  const uid = opts.uid ?? process.getuid?.() ?? 1000
  const gid = opts.gid ?? process.getgid?.() ?? 1000
  const volume = `qare-cell-${id}`
  const gateName = `${volume}-gate`
  const appName = `${volume}-app`
  const buildVolume = `${volume}-build`
  const loadName = `${volume}-load`
  if (typeof opts.install !== 'string' || !/^\/[^\0]*$/.test(opts.install)) throw new Error("the cell could not be made: the build's directory is not an absolute path")
  // From the first thing made to the last thing removed, the cell is one a
  // signal that ends the harness takes with it.
  const reap = (): void => {
    docker.runSync(['rm', '-f', appName, gateName, loadName])
    docker.runSync(['volume', 'rm', '-f', volume, buildVolume])
  }
  const untrack = trackLiveCell(reap)
  // What both containers share: no capability, no way to gain one, the
  // run's own user, and the volume that holds the two sockets.
  const common = ['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '-u', `${uid}:${gid}`, '-e', 'HOME=/tmp', '-v', `${volume}:${SOCKET_DIR}`]

  const made = await docker.run(['volume', 'create', '--driver', 'local', '--opt', 'type=tmpfs', '--opt', 'device=tmpfs', '--opt', `o=size=1m,uid=${uid},gid=${gid},mode=0700`, volume])
  if (made.code !== 0) {
    untrack()
    throw new Error(`the cell could not be made: docker volume create failed: ${firstLine(made.stderr) || `exit ${made.code}`}`)
  }

  const gate = docker.spawn([
    'run', '--rm', '--name', gateName, ...common,
    // The driver's relay, published on the machine's loopback and nowhere else.
    '-p', `127.0.0.1::${GATE_RELAY_PORT}`,
    opts.image, 'qare', 'cell', 'gate', '--socket-dir', SOCKET_DIR, ...opts.hosts.flatMap((host) => ['--host', host]),
  ]) // prettier-ignore
  let gateExit: string | undefined
  let gateErrors = ''
  let summary: GateSummary | undefined
  let onGateLine: ((line: string) => void) | undefined
  let partial = ''
  gate.stdout?.on('data', (chunk) => {
    const parts = (partial + String(chunk)).split('\n')
    partial = parts.pop() ?? ''
    for (const line of parts) {
      summary = summaryIn(line) ?? summary
      onGateLine?.(line)
    }
  })
  gate.stderr?.on('data', (chunk) => {
    gateErrors = `${gateErrors}${String(chunk)}`.slice(-2_000)
  })
  const gateGone = new Promise<void>((resolve) => {
    // Closed, not merely exited: the record is the last line the gate writes.
    gate.on('close', (code, signal) => {
      gateExit = code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`
      resolve()
    })
    gate.on('error', (error) => {
      gateExit = `could not be started: ${error.message}`
      resolve()
    })
  })

  const remove = async (): Promise<void> => {
    await docker.run(['rm', '-f', gateName])
    await docker.run(['volume', 'rm', '-f', volume])
    await docker.run(['volume', 'rm', '-f', buildVolume])
    untrack()
  }
  const unmade = async (why: string): Promise<never> => {
    await remove()
    throw new Error(`the cell could not be made: ${why}`)
  }

  const ready = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), opts.readyTimeoutMs ?? GATE_READY_TIMEOUT_MS)
    onGateLine = (line) => {
      if (!line.includes('"ready"')) return
      clearTimeout(timer)
      resolve(true)
    }
    void gateGone.then(() => {
      clearTimeout(timer)
      resolve(false)
    })
  })
  onGateLine = undefined
  if (!ready) {
    const said = firstLine(gateErrors)
    return unmade(gateExit === undefined ? 'the gate was not ready in time' : `the gate exited with ${gateExit} before it was ready${said === '' ? '' : `: ${said}`}`)
  }
  // Where the driver reaches the relay. The published port is on the
  // loopback of the machine the daemon runs on, which is this one on a
  // runner. A daemon inside a VM (a desktop install) publishes on a loopback
  // a run in a container on its network does not share, and there the gate's
  // own address on the default bridge is where it answers. Whichever answers
  // is used, and a relay that answers at neither is on another machine.
  const published = await docker.run(['port', gateName, `${GATE_RELAY_PORT}/tcp`])
  const inspected = await docker.run(['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}', gateName])
  const publishedPort = /^127\.0\.0\.1:(\d+)$/m.exec(published.stdout)?.[1]
  const address = inspected.stdout.split(/\s+/).find((entry) => /^\d{1,3}(\.\d{1,3}){3}$/.test(entry))
  const candidates = [
    ...(publishedPort === undefined ? [] : [{ host: '127.0.0.1', port: Number(publishedPort) }]),
    ...(address === undefined ? [] : [{ host: address, port: GATE_RELAY_PORT }]),
  ]
  if (candidates.length === 0) return unmade("the gate's relay for the driver has no address to be reached at")
  const canConnect = opts.canConnect ?? tcpAnswers
  let relay: { host: string; port: number } | undefined
  for (const candidate of candidates) {
    if (await canConnect(candidate.host, candidate.port)) {
      relay = candidate
      break
    }
  }
  if (relay === undefined)
    return unmade(
      `the gate's relay for the driver answered at neither ${candidates.map((candidate) => `${candidate.host}:${candidate.port}`).join(' nor ')}, so the docker daemon is not on the machine the run is on`,
    )
  const relayAt = `${relay.host}:${relay.port}`

  // The build's directory is copied in: a volume of its own, filled through
  // a container that is created and never started.
  {
    const steps: string[][] = [
      ['volume', 'create', buildVolume],
      ['create', '--name', loadName, '-v', `${buildVolume}:/build`, opts.image, 'true'],
      ['cp', `${opts.install}/.`, `${loadName}:/build`],
    ]
    let failed: string | undefined
    for (const step of steps) {
      const ran = await docker.run(step)
      if (ran.code === 0) continue
      failed = firstLine(ran.stderr) || `docker ${step[0]} exited ${ran.code}`
      break
    }
    await docker.run(['rm', '-f', loadName])
    if (failed !== undefined) return unmade(`the installed build could not be copied into it: ${failed}`)
  }
  // What the build is launched from: its own directory, as copied, read-only,
  // at the path the driver was told. Nothing of the machine's filesystem is
  // mounted into the cell.
  const source = ['-v', `${buildVolume}:${opts.install}:ro`, '-w', opts.install]

  let disposed: Promise<void> | undefined
  return {
    debuggingPort: GATE_RELAY_PORT,
    userDataDir: `/tmp/qare-electron-${id}`,
    spawn: (command, args) =>
      docker.spawn([
        'run', '--rm', '--name', appName, ...common,
        // The whole of the containment: no interface but loopback, and a resolver on it.
        // No search domain: the runner's own would have every name asked for a second
        // time with the runner's suffix, which names the runner to the build and
        // puts a host nobody reached for in the record.
        '--network', 'none', '--dns', '127.0.0.1', '--dns-search', '.',
        ...source,
        opts.image, 'qare', 'cell', 'launch', '--socket-dir', SOCKET_DIR, '--cdp-port', String(GATE_RELAY_PORT), '--',
        command, ...args,
      ]), // prettier-ignore
    endpoint: (printed) => printed.replace(/^ws:\/\/[^/]+/, `ws://${relayAt}`),
    record: () => {
      if (disposed === undefined || gateExit === undefined) throw new Error('the cell has not been disposed, so its gate has not written its record')
      if (summary === undefined) throw new Error(`the gate stopped (${gateExit}) without writing its record, so what the build reached is not known`)
      return {
        reached: summary.reached,
        ...(summary.capped ? { incomplete: 'the build reached for more distinct destinations than the gate records, so the record was cut' } : {}),
      }
    },
    dispose: () => {
      disposed ??= (async () => {
        // The build first: what it reaches for while it dies is still recorded.
        await docker.run(['rm', '-f', appName])
        await docker.run(['stop', '-t', String(GATE_STOP_SECONDS), gateName])
        await Promise.race([gateGone, new Promise((resolve) => setTimeout(resolve, 5_000))])
        if (gateExit === undefined) {
          gate.kill('SIGKILL')
          gateExit = 'killed: it did not stop'
        }
        await remove()
      })()
      return disposed
    },
    reap: () => {
      untrack()
      reap()
    },
  }
}
