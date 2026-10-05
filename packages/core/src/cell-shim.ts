import { createSocket } from 'node:dgram'
import { rm } from 'node:fs/promises'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { CDP_SOCKET, GATE_SOCKET } from './cell-gate.js'
import { DNS_TYPE_A, dnsReply, httpHost, readDnsQuestion, tlsServerName, type Peeked } from './cell-wire.js'

/**
 * The inside of a client build's cell (#223, ADR-0006). The cell has a
 * loopback interface and nothing else, and one socket to the gate. This
 * makes that socket look like a network to a program that knows nothing
 * about it:
 *
 * - the resolver on loopback asks the gate about every name, and answers a
 *   declared one with the address the shim holds for it and any other with
 *   no such name;
 * - ports 80 and 443 on loopback read which host a connection is for and
 *   ask the gate to connect it, carrying the bytes untouched; so does the
 *   port where the run's booted app answers, when the run names one (#224);
 * - a stub host the profile gives ports for is answered on its own address,
 *   so a command dials it on the port the profile names, over any protocol
 *   (#224);
 * - the build's DevTools endpoint is exposed on a socket the gate relays to
 *   the driver.
 *
 * It runs beside the build as the same user and is trusted with nothing:
 * it knows no list and keeps no record. With no gate to ask, nothing
 * resolves and nothing connects.
 */

const LOOPBACK = '127.0.0.1'
/** Every local address: a stub host's own listener outranks it for the address it names (#224). */
const ANY = '0.0.0.0'
/** How long the gate is given to answer one request. */
const GATE_TIMEOUT_MS = 20_000
/** How long a connection is given to say which host it is for. */
const PEEK_TIMEOUT_MS = 10_000

export interface ShimOptions {
  socketDir: string
  dnsPort?: number
  httpPort?: number
  httpsPort?: number
  /**
   * The loopback port where the run's booted app answers, and how (#224).
   * A named command connects to the app's name on this port; the shim reads
   * the connection the same way it reads 80 and 443, and asks the gate.
   */
  appPort?: number
  appScheme?: 'http' | 'https'
  /**
   * A declared stub host and a port the profile says its service answers on
   * (#224). The shim gives every named host its own loopback address and
   * answers the port there, so a command reaches the stub on the port the
   * profile named, and the gate is asked with the host it is dialed by.
   */
  stubPorts?: { host: string; port: number }[]
  /** The loopback port the build's DevTools endpoint listens on. */
  cdpPort: number
}

export interface Shim {
  ports: { dns: number; http: number; https: number; app?: number }
  stop: () => Promise<void>
}

type GateReply = { ok: boolean; reason?: string }

/**
 * One request to the gate: the line sent, the line answered, and the socket,
 * which after an accepted connect is the connection. Whatever arrived after
 * the reply line is handed back, so no byte of the connection is lost.
 */
function askGate(socketDir: string, request: Record<string, unknown>): Promise<{ reply: GateReply; socket: Socket; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = connect(join(socketDir, GATE_SOCKET))
    let buffered = Buffer.alloc(0)
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      reject(error)
    }
    const timer = setTimeout(() => fail(new Error('the gate did not answer')), GATE_TIMEOUT_MS)
    socket.on('error', fail)
    socket.on('close', () => fail(new Error('the gate closed without answering')))
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk])
      const end = buffered.indexOf(0x0a)
      if (end === -1 || settled) return
      settled = true
      clearTimeout(timer)
      socket.off('data', onData)
      socket.pause()
      try {
        resolve({ reply: JSON.parse(buffered.subarray(0, end).toString('utf8')) as GateReply, socket, rest: buffered.subarray(end + 1) })
      } catch (error) {
        socket.destroy()
        reject(error as Error)
      }
    }
    socket.on('data', onData)
  })
}

function listening(server: Server, ...where: [string] | [number, string]): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    const done = (): void => {
      server.off('error', reject)
      resolve()
    }
    if (where.length === 1) server.listen(where[0], done)
    else server.listen(where[0], where[1], done)
  })
}

const portOf = (server: Server): number => {
  const address = server.address()
  return address !== null && typeof address !== 'string' ? address.port : 0
}

export async function startShim(opts: ShimOptions): Promise<Shim> {
  const open = new Set<Socket>()
  const track = (socket: Socket): Socket => {
    open.add(socket)
    socket.on('close', () => open.delete(socket))
    socket.on('error', () => {})
    return socket
  }

  // Every host the profile gave ports for answers on its own loopback
  // address, so two stubs that name the same port do not collide and a
  // connection is attributed by the address it was made to. The first
  // address after the resolver's is the first host named (#224).
  const addresses = new Map<string, string>()
  for (const { host } of opts.stubPorts ?? []) {
    if (addresses.has(host)) continue
    const place = addresses.size + 2
    if (place > 254) throw new Error(`the profile names more stub hosts with ports than the cell's loopback has addresses for: ${host} is the 254th`)
    addresses.set(host, `127.0.0.${place}`)
  }

  // The resolver. A declared name is answered with the address the shim
  // holds for it, where the listeners below are; no query is ever
  // forwarded, so a lookup carries nothing out.
  const dns = createSocket('udp4')
  dns.on('error', () => {})
  dns.on('message', (message, from) => {
    const query = readDnsQuestion(message)
    if (query === undefined) return
    const send = (reply: Buffer): void => dns.send(reply, from.port, from.address, () => {})
    const allowed = (name: string | undefined): void => {
      const address = (name !== undefined ? addresses.get(name) : undefined) ?? LOOPBACK
      send(dnsReply(query, query.type === DNS_TYPE_A ? { address } : 'empty'))
    }
    if (query.name === 'localhost' || query.name?.endsWith('.localhost') === true) return allowed(query.name)
    askGate(opts.socketDir, { op: 'resolve', host: query.name ?? '' }).then(
      ({ reply, socket }) => {
        socket.destroy()
        if (reply.ok === true) allowed(query.name)
        else send(dnsReply(query, 'nxdomain'))
      },
      () => send(dnsReply(query, 'nxdomain')),
    )
  })
  await new Promise<void>((resolve, reject) => {
    dns.once('error', reject)
    dns.bind(opts.dnsPort ?? 53, LOOPBACK, () => {
      dns.off('error', reject)
      resolve()
    })
  })

  // A listener that reads which host each connection is for, then hands the
  // connection to the gate with every byte it has read so far.
  const carry = (port: number, peek: (bytes: Buffer) => Peeked): Server =>
    createServer((socket) => {
      track(socket)
      let buffered = Buffer.alloc(0)
      const timer = setTimeout(() => socket.destroy(), PEEK_TIMEOUT_MS)
      const onData = (chunk: Buffer): void => {
        buffered = Buffer.concat([buffered, chunk])
        const peeked = peek(buffered)
        if (peeked.state === 'more') return
        clearTimeout(timer)
        socket.off('data', onData)
        socket.pause()
        // A connection that names no host is still asked about, so the gate records it.
        askGate(opts.socketDir, { op: 'connect', host: peeked.name ?? '', port }).then(
          ({ reply, socket: upstream, rest }) => {
            track(upstream)
            if (reply.ok !== true || socket.destroyed) {
              upstream.destroy()
              socket.destroy()
              return
            }
            upstream.write(buffered)
            if (rest.length > 0) socket.write(rest)
            socket.pipe(upstream)
            upstream.pipe(socket)
            socket.on('close', () => upstream.destroy())
            upstream.on('close', () => socket.destroy())
            upstream.resume()
            socket.resume()
          },
          () => socket.destroy(),
        )
      }
      socket.on('data', onData)
      socket.on('close', () => clearTimeout(timer))
    })
  const http = carry(80, httpHost)
  const https = carry(443, tlsServerName)
  // The two peeked ports are bound to every local address, so a dial to a
  // stub host's own address lands on its listener when it has one, and on
  // the reader of host headers when it does not (#224).
  await listening(http, opts.httpPort ?? 80, ANY)
  await listening(https, opts.httpsPort ?? 443, ANY)
  // The booted app answers on the port the run gave it, not on either of
  // those two; the shim reads it as http or https, as the run booted it (#224).
  const app: Server | undefined =
    opts.appPort === undefined ? undefined : carry(opts.appPort, opts.appScheme === 'https' ? tlsServerName : httpHost)
  if (opts.appPort !== undefined && app !== undefined) await listening(app, opts.appPort, LOOPBACK)

  // A declared stub port is answered on the host's own address, and the
  // gate is asked with that host: no reading of what the connection is for,
  // because the address already says it (#224).
  const stubs: Server[] = []
  for (const { host, port } of opts.stubPorts ?? []) {
    const address = addresses.get(host)
    if (address === undefined) continue
    const server = createServer((socket) => {
      track(socket)
      askGate(opts.socketDir, { op: 'connect', host, port }).then(
        ({ reply, socket: upstream, rest }) => {
          track(upstream)
          if (reply.ok !== true) {
            upstream.destroy()
            socket.destroy()
            return
          }
          if (rest.length > 0) socket.write(rest)
          socket.pipe(upstream)
          upstream.pipe(socket)
          socket.on('close', () => upstream.destroy())
          upstream.on('close', () => socket.destroy())
          upstream.resume()
          socket.resume()
        },
        () => socket.destroy(),
      )
    })
    await listening(server, port, address)
    stubs.push(server)
  }

  // The driver's way in, from the gate's side of the shared directory.
  const devtools = createServer((socket) => {
    track(socket)
    const endpoint = track(connect({ host: LOOPBACK, port: opts.cdpPort }))
    socket.pipe(endpoint)
    endpoint.pipe(socket)
    socket.on('close', () => endpoint.destroy())
    endpoint.on('close', () => socket.destroy())
  })
  const cdpSocket = join(opts.socketDir, CDP_SOCKET)
  await rm(cdpSocket, { force: true })
  await listening(devtools, cdpSocket)

  const dnsAddress = dns.address()
  return {
    ports: { dns: dnsAddress.port, http: portOf(http), https: portOf(https), ...(app === undefined ? {} : { app: portOf(app) }) },
    stop: async () => {
      const closed = Promise.all([http, https, ...stubs, ...(app === undefined ? [] : [app]), devtools].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
      for (const socket of open) socket.destroy()
      await new Promise<void>((resolve) => dns.close(() => resolve()))
      await closed
    },
  }
}
