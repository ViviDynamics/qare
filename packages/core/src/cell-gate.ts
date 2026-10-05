import { connect, createServer, type Server, type Socket } from 'node:net'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { matchesStub } from './egress.js'
import { hostName } from './cell-wire.js'

/**
 * The gate of a client build's cell (#223, ADR-0006). The build runs in a
 * container with no network; this is the only thing it can talk to, over a
 * unix socket, and the only place that decides what it reaches. It answers
 * two requests, one JSON line each:
 *
 *   {"op":"resolve","host":H}          is H declared?
 *   {"op":"connect","host":H,"port":P} connect me to H, and carry the bytes
 *
 * and replies with one line, `{"ok":true}` or `{"ok":false,"reason":...}`.
 * After an accepted connect the socket is the connection.
 *
 * Whatever sits on the other end of the socket runs beside pull request
 * code, so nothing it sends is trusted: a name is held to being a name, a
 * port to being one the gate carries, and the record is the gate's own
 * count of what it was asked for, written when it stops.
 */

/** The socket the cell asks the gate on, in the directory the two share. */
export const GATE_SOCKET = 'gate.sock'
/** The socket the cell exposes the build's DevTools endpoint on. */
export const CDP_SOCKET = 'cdp.sock'
/** The port the gate relays the driver to that endpoint on. */
export const GATE_RELAY_PORT = 9222

/** The ports the gate connects to: the two a connection names its host on. */
const CARRIED_PORTS: Record<number, string> = { 80: 'http', 443: 'https' }

/** A refusal names the ports the gate carries, as a list in words. */
function carriedPortsNote(ports: number[]): string {
  const sorted = [...ports].sort((a, b) => a - b)
  if (sorted.length <= 1) return sorted.map(String).join('')
  const head = sorted.slice(0, -1).map(String).join(', ')
  return `${head} and ${sorted[sorted.length - 1]}`
}
/** A request is one short line; a longer one is not a request. */
const MAX_REQUEST_BYTES = 1_024
/** The distinct destinations one launch may put in the record before it is cut. */
const DEFAULT_MAX_ENTRIES = 500
const DIAL_TIMEOUT_MS = 15_000

/** One destination the build reached for, and how often. `declared` is the gate's own decision. */
export interface ReachedHost {
  host: string
  port: number
  protocol: string
  declared: boolean
  count: number
}

/** The gate's record, written as its last line. `capped` means destinations were dropped. */
export interface GateSummary {
  event: 'summary'
  reached: ReachedHost[]
  capped: boolean
}

export interface GateOptions {
  /** The hosts the profile declares, as `client.hosts` writes them. */
  hosts: readonly string[]
  /**
   * A declared host dialed as another name (#224): a stub host as the compose
   * service that provides it on the project's network, or the booted app's
   * own name as the address that answers the run's bridge. The record keeps
   * the name the cell asked for.
   */
  map?: Readonly<Record<string, string>>
  /**
   * The ports the gate carries beyond its own 80 and 443 (#224): a booted
   * stack publishes the app on the port the run gave it, not on either of
   * those two.
   */
  ports?: readonly CarriedPort[]
  /**
   * A port a declared stub names, beside the gate's own two (#224). The gate
   * is asked over the socket it mounts, and the shim's bindings are not the
   * gate's to trust, so a mapped stub host is dialled on its declared ports
   * alone, and on no other port whatever answers there.
   */
  stubPorts?: readonly { host: string; port: number }[]
  /** The directory the gate and the cell share. */
  socketDir: string
  relayPort?: number
  relayHost?: string
  /**
   * The run's app, when the stack booted one: the host it is asked for by,
   * the port it is published at, and the port inside the stack the published
   * port leads to (#224). The app is one service at one port: its host is
   * answered on the published port alone, and dialled as the compose service
   * the map names it, at the port the service answers at.
   */
  app?: { host: string; port: number; dialPort?: number }
  /** Where the gate's lines go: standard output, which the run reads. */
  write: (line: string) => void
  /** Connects to a declared host; the network by default. */
  dial?: (host: string, port: number) => Socket
  maxEntries?: number
}

/** One port the gate carries for a declared host, and how the connection is read. */
export interface CarriedPort {
  port: number
  protocol: 'http' | 'https'
}

export interface Gate {
  relayPort: number
  /** Close everything and write the record. Returns it; a second call returns the same. */
  stop: () => Promise<GateSummary>
}

function listen(server: Server, ...where: [string] | [number, string]): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    const listening = (): void => {
      server.off('error', reject)
      resolve()
    }
    if (where.length === 1) server.listen(where[0], listening)
    else server.listen(where[0], where[1], listening)
  })
}

export async function startGate(opts: GateOptions): Promise<Gate> {
  const stubs = [{ hosts: [...opts.hosts] }]
  // The ports the gate carries: its own two, and any the run hands it for the
  // stack it booted (#224).
  const carried: Record<number, string> = { ...CARRIED_PORTS }
  for (const entry of opts.ports ?? []) carried[entry.port] = entry.protocol
  const carriedNote = carriedPortsNote(Object.keys(carried).map(Number))
  // A declared host may be dialed under another name (#224): the stub as the
  // compose service that provides it, the app as the address the bridge answers.
  // A mapping may be a pattern (`*.vendor.example`), the way a stub's declared
  // hosts are, and then it names every host the pattern matches.
  const dialAs = (host: string): string => {
    const map = opts.map ?? {}
    // The concrete host is the lowercase name the request resolved to; the
    // map is the profile's own casing, so it is resolved with the same
    // normalization the declarations are matched by (#224).
    const exact = Object.keys(map).find((key) => (hostName(key) ?? key.toLowerCase()) === host)
    if (exact !== undefined) return map[exact] ?? host
    const pattern = Object.keys(map).find((key) => key.startsWith('*.') && matchesStub(host, [{ hosts: [key] }]))
    return pattern === undefined ? host : (map[pattern] ?? host)
  }
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES
  const dial = opts.dial ?? ((host: string, port: number): Socket => connect({ host, port }))
  // The app, with its host named the way requests name hosts: lowercase.
  const app = opts.app === undefined ? undefined : { ...opts.app, host: hostName(opts.app.host) ?? opts.app.host }
  // Whether the port is one the gate's own two, or one a declared stub
  // names for the host: the two ways a mapped host answers (#224). A name
  // matches its stub's own, or the pattern the stub declares, the way every
  // declaration is matched.
  const stubDeclares = (host: string, port: number): boolean =>
    port === 80 || port === 443 || (opts.stubPorts ?? []).some((entry) => entry.port === port && matchesStub(host, [{ hosts: [entry.host] }]))
  const reached = new Map<string, ReachedHost>()
  let capped = false
  const open = new Set<Socket>()
  const track = (socket: Socket): Socket => {
    open.add(socket)
    socket.on('close', () => open.delete(socket))
    // Either end may vanish mid-stream; that is the connection ending, not the gate failing.
    socket.on('error', () => {})
    return socket
  }

  const record = (host: string, port: number, protocol: string, declared: boolean): void => {
    const key = `${host}:${port} (${protocol})`
    const entry = reached.get(key)
    if (entry !== undefined) {
      entry.count += 1
      return
    }
    if (reached.size >= maxEntries) {
      capped = true
      return
    }
    reached.set(key, { host, port, protocol, declared, count: 1 })
  }

  const answer = (socket: Socket, reply: { ok: true } | { ok: false; reason: string }, end: boolean): void => {
    socket.write(`${JSON.stringify(reply)}\n`)
    if (end) socket.end()
  }

  const handle = (socket: Socket, request: unknown, rest: Buffer): void => {
    if (typeof request !== 'object' || request === null) return void socket.destroy()
    const { op, host: rawHost, port: rawPort } = request as { op?: unknown; host?: unknown; port?: unknown }
    const host = hostName(rawHost)
    const declared = host !== undefined && matchesStub(host, stubs)
    if (op === 'resolve') {
      // An allowed lookup has reached nothing yet: the connection that follows is the record.
      if (declared) return answer(socket, { ok: true }, true)
      record(host ?? 'unknown', 53, 'dns', false)
      return answer(socket, { ok: false, reason: 'undeclared' }, true)
    }
    if (op !== 'connect') return void socket.destroy()
    const port = typeof rawPort === 'number' && Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65_536 ? rawPort : 0
    const protocol = carried[port]
    if (!declared) {
      record(host ?? 'unknown', port, protocol ?? 'tcp', false)
      return answer(socket, { ok: false, reason: 'undeclared' }, true)
    }
    // The app is one service at one port: a request for its host on any
    // other port is not the app, however a service on the machine the app
    // is published from may answer (#224).
    const dialled = dialAs(host)
    const served = app !== undefined && host === app.host ? app : undefined
    if (served !== undefined && port !== served.port) {
      record(host, port, protocol ?? 'tcp', false)
      return answer(socket, { ok: false, reason: 'the app answers on its published port only' }, true)
    }
    // A mapped stub host answers on the gate's own two and the ports its
    // stub declares alone (#224): the cell can speak for itself on the
    // mounted socket, and what the shim binds is no rule of the gate's.
    if (served === undefined && dialled !== host && !stubDeclares(host, port)) {
      record(host, port, 'tcp', false)
      return answer(socket, { ok: false, reason: 'a stub answers on the gate\'s own two and the ports its stub declares only' }, true)
    }
    if (protocol === undefined && dialled === host) {
      // A host the cell dials by its own name reaches out through the gate's
      // own two ports; a mapped host is the stack's own service, and answers
      // on whatever port it listens on.
      record(host, port, 'tcp', false)
      return answer(socket, { ok: false, reason: `the gate carries ports ${carriedNote} only` }, true)
    }
    // The protocol the record names is what the dial is: the app's own
    // scheme on the app's port, the gate's own two as a browser reads them,
    // and a stub's declared port tcp, whatever other host carries that
    // number (#224).
    const named = served !== undefined || dialled === host || port === 80 || port === 443 ? (protocol ?? 'tcp') : 'tcp'
    record(host, port, named, true)
    const upstream = track(dial(dialled, served?.dialPort ?? port))
    let settled = false
    const refuse = (why: string): void => {
      if (settled) return
      settled = true
      upstream.destroy()
      answer(socket, { ok: false, reason: `unreachable: ${why}` }, true)
    }
    const timer = setTimeout(() => refuse('timed out'), DIAL_TIMEOUT_MS)
    upstream.once('error', (error) => {
      clearTimeout(timer)
      refuse((error as NodeJS.ErrnoException).code ?? error.message)
    })
    upstream.once('connect', () => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      answer(socket, { ok: true }, false)
      if (rest.length > 0) upstream.write(rest)
      socket.pipe(upstream)
      upstream.pipe(socket)
      socket.on('close', () => upstream.destroy())
      upstream.on('close', () => socket.destroy())
    })
  }

  const requests = createServer((socket) => {
    track(socket)
    let buffered = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk])
      const end = buffered.indexOf(0x0a)
      if (end === -1) {
        if (buffered.length > MAX_REQUEST_BYTES) socket.destroy()
        return
      }
      socket.off('data', onData)
      socket.pause()
      if (end > MAX_REQUEST_BYTES) return void socket.destroy()
      let request: unknown
      try {
        request = JSON.parse(buffered.subarray(0, end).toString('utf8'))
      } catch {
        return void socket.destroy()
      }
      handle(socket, request, buffered.subarray(end + 1))
      socket.resume()
    }
    socket.on('data', onData)
  })

  // The driver's way in: whoever connects to the relay port is joined to the
  // endpoint the cell exposes. The build's side of it is the build's own.
  const relay = createServer((socket) => {
    track(socket)
    const endpoint = track(connect(join(opts.socketDir, CDP_SOCKET)))
    socket.pipe(endpoint)
    endpoint.pipe(socket)
    socket.on('close', () => endpoint.destroy())
    endpoint.on('close', () => socket.destroy())
  })

  const gateSocket = join(opts.socketDir, GATE_SOCKET)
  await rm(gateSocket, { force: true })
  await listen(requests, gateSocket)
  await listen(relay, opts.relayPort ?? GATE_RELAY_PORT, opts.relayHost ?? '0.0.0.0')
  const address = relay.address()
  const relayPort = address !== null && typeof address !== 'string' ? address.port : (opts.relayPort ?? GATE_RELAY_PORT)
  opts.write(JSON.stringify({ event: 'ready', relayPort }))

  let stopped: Promise<GateSummary> | undefined
  const stop = (): Promise<GateSummary> => {
    stopped ??= (async () => {
      const closed = Promise.all([requests, relay].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
      for (const socket of open) socket.destroy()
      await closed
      const entries = [...reached.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, entry]) => entry)
      const summary: GateSummary = { event: 'summary', reached: entries, capped }
      opts.write(JSON.stringify(summary))
      return summary
    })()
    return stopped
  }
  return { relayPort, stop }
}
