import { randomBytes } from 'node:crypto'
import { GATE_RELAY_PORT, type CarriedPort, type GateSummary } from './cell-gate.js'
import {
  defaultCellDocker,
  firstLine,
  GATE_READY_TIMEOUT_MS,
  GATE_STOP_SECONDS,
  SOCKET_DIR,
  summaryIn,
  trackLiveCell,
  type CellDocker,
  type CellProcess,
  type CellRecord,
} from './client-cell.js'

/**
 * The cell a contained named command runs in (#224, ADR-0006). It is the
 * client build's cell (cell-client, #223) with the build swapped for the
 * command: a gate container and a command container that has no network,
 * talking to the gate over the socket volume alone. The gate is the only
 * way out, so what the command reaches is what the run declares: the booted
 * app on the port it is published at, and each stub as the compose service
 * that provides it. The checkout is copied in and mounted read-only where
 * the command runs; only the paths the command declares as scratch are
 * writable, each a tmpfs of its own. This module is the run's side of it:
 * the docker calls that make the cell, the record read back when it is
 * disposed, and its removal.
 */

/**
 * Why a command cell cannot be made here, or undefined when it can (#224).
 * The image and daemon are the client cell's, checked the same way, so a
 * host that cannot contain a command refuses before anything boots.
 */
export { clientCellProblem } from './client-cell.js'

export interface CommandCellOptions {
  /** The image both containers run: the one the run itself is in. */
  image: string
  /** The hosts the run declares: the app the target names, and every stub's hosts. */
  hosts: readonly string[]
  /**
   * A declared host dialed as another name: a stub host as the compose
   * service that provides it on the compose project's network, or the app
   * as the address on the default bridge that answers the published port.
   * A host left out is dialled as itself.
   */
  map?: Readonly<Record<string, string>>
  /** The port the app is published on, and how it is read, when that is not the gate's own two. */
  app?: CarriedPort
  /** The compose project's network the gate joins to reach the stubs, when a stack is booted. */
  network?: string
  /** The absolute path the command runs from: the checkout, copied into the cell and mounted read-only. */
  checkout: string
  /** Paths under the checkout the command may write; each is mounted a writable tmpfs of its own. */
  scratch?: readonly string[]
  docker?: CellDocker
  uid?: number
  gid?: number
  id?: string
  readyTimeoutMs?: number
}

export interface CommandCell {
  /** Run the command inside the cell. The process is the docker run itself. */
  run(argv: string[], env?: Record<string, string>): CellProcess
  /** What the gate recorded. Only after `dispose`; throws when the record never arrived. */
  record(): CellRecord
  dispose(): Promise<void>
  /** Remove the cell at once, from a harness that is exiting. */
  reap(): void
}

export async function startCommandCell(opts: CommandCellOptions): Promise<CommandCell> {
  const docker = opts.docker ?? defaultCellDocker
  const id = opts.id ?? randomBytes(6).toString('hex')
  const uid = opts.uid ?? process.getuid?.() ?? 1000
  const gid = opts.gid ?? process.getgid?.() ?? 1000
  const volume = `qare-cell-${id}`
  const gateName = `${volume}-gate`
  const volumeName = `${volume}-build`
  const loadName = `${volume}-load`
  const commandName = `${volume}-command`
  const checkout = opts.checkout.replace(/\/$/, '')
  if (!/^\/[^\0]*$/.test(checkout)) throw new Error("the cell could not be made: the command's directory is not an absolute path")
  for (const entry of opts.scratch ?? []) {
    if (entry === '' || entry.startsWith('/') || entry.includes('..')) throw new Error('the cell could not be made: a scratch path is not a path under the checkout')
  }
  // From the first thing made to the last thing removed, the cell is one a
  // signal that ends the harness takes with it.
  const reap = (): void => {
    docker.runSync(['rm', '-f', commandName, gateName, loadName])
    docker.runSync(['volume', 'rm', '-f', volume, volumeName])
    if (opts.network !== undefined) docker.runSync(['network', 'rm', '-f', opts.network])
  }
  const untrack = trackLiveCell(reap)
  // What the two containers share: no capability, no way to gain one, the
  // run's own user, and the volume that holds the two sockets.
  const common = ['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '-u', `${uid}:${gid}`, '-e', 'HOME=/tmp', '-v', `${volume}:${SOCKET_DIR}`]

  const made = await docker.run(['volume', 'create', '--driver', 'local', '--opt', 'type=tmpfs', '--opt', 'device=tmpfs', '--opt', `o=size=1m,uid=${uid},gid=${gid},mode=0700`, volume])
  if (made.code !== 0) {
    untrack()
    throw new Error(`the cell could not be made: docker volume create failed: ${firstLine(made.stderr) || `exit ${made.code}`}`)
  }

  // The gate, on the default bridge: the app is published on the machine's
  // own port, and the bridge's gateway is where a container reaches it.
  const appPort = opts.app !== undefined ? ['--port', String(opts.app.port), opts.app.protocol] : []
  const mapArgs = Object.entries(opts.map ?? {}).flatMap(([host, name]) => ['--map', `${host}=${name}`])
  const gate = docker.spawn([
    'run', '--rm', '--name', gateName, ...common,
    opts.image, 'qare', 'cell', 'gate', '--socket-dir', SOCKET_DIR, ...opts.hosts.flatMap((host) => ['--host', host]), ...appPort, ...mapArgs,
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
    await docker.run(['rm', '-f', commandName, gateName])
    await docker.run(['volume', 'rm', '-f', volume, volumeName])
    if (opts.network !== undefined) await docker.run(['network', 'rm', '-f', opts.network])
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

  // The stubs are on the compose project's network; a second interface is
  // the only way the gate dials one by the service's name.
  if (opts.network !== undefined) {
    const joined = await docker.run(['network', 'connect', opts.network, gateName])
    if (joined.code !== 0) return unmade(`the gate could not join the stack's network (${opts.network}): ${firstLine(joined.stderr) || `exit ${joined.code}`}`)
  }

  // Where a container reaches the machine the daemon runs on: the default
  // bridge's gateway. The app is published there, on the port the run gave.
  const inspected = await docker.run(['inspect', '--format', '{{(index .NetworkSettings.Networks "bridge").Gateway}}', gateName])
  const gateway = inspected.stdout.trim().split(/\s+/)[0]
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(gateway ?? '')) return unmade('the address the app is published at is not known: the gate has no default bridge')

  // The checkout is copied in through a container that is created and never
  // started, the way the client build's directory is. A copy holds no socket
  // and nothing made after it was taken, so no way round the gate rides along.
  {
    const steps: string[][] = [
      ['volume', 'create', volumeName],
      ['create', '--name', loadName, '-v', `${volumeName}:/checkout`, opts.image, 'true'],
      ['cp', `${checkout}/.`, `${loadName}:/checkout`],
    ]
    let failed: string | undefined
    for (const step of steps) {
      const ran = await docker.run(step)
      if (ran.code === 0) continue
      failed = firstLine(ran.stderr) || `docker ${step[0]} exited ${ran.code}`
      break
    }
    await docker.run(['rm', '-f', loadName])
    if (failed !== undefined) return unmade(`the checkout could not be copied into the cell: ${failed}`)
  }
  // What the command runs in: its checkout, read-only, at the path it runs
  // from, with the scratch paths writable over the copy and nothing else.
  const scratch = (opts.scratch ?? []).flatMap((entry) => ['--tmpfs', `${checkout}/${entry}:uid=${uid},gid=${gid},mode=0700`])
  let disposed: Promise<void> | undefined
  return {
    run: (argv, env) =>
      docker.spawn([
        'run', '--rm', '--name', commandName, ...common,
        // The whole of the containment: no interface but loopback, and a resolver on it.
        // No search domain: the runner's own would have every name asked for a second
        // time with the runner's suffix, which names the runner to the command and
        // puts a host nobody reached for in the record.
        '--network', 'none', '--dns', '127.0.0.1', '--dns-search', '.',
        '-v', `${volumeName}:${checkout}:ro`,
        '-w', checkout,
        ...scratch,
        ...Object.entries(env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
        opts.image, 'qare', 'cell', 'launch', '--socket-dir', SOCKET_DIR, '--cdp-port', String(GATE_RELAY_PORT), ...(opts.app === undefined ? [] : ['--port', String(opts.app.port), opts.app.protocol]), '--',
        argv[0] ?? 'true', ...argv.slice(1),
      ]), // prettier-ignore
    record: () => {
      if (disposed === undefined || gateExit === undefined) throw new Error('the cell has not been disposed, so its gate has not written its record')
      if (summary === undefined) throw new Error(`the gate stopped (${gateExit}) without writing its record, so what the command reached is not known`)
      return {
        reached: summary.reached,
        ...(summary.capped ? { incomplete: 'the command reached for more distinct destinations than the gate records, so the record was cut' } : {}),
      }
    },
    dispose: () => {
      disposed ??= (async () => {
        // The command first: what it reaches for while it dies is still recorded.
        await docker.run(['rm', '-f', commandName])
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
      void reap()
    },
  }
}
