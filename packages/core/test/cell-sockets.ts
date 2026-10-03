// What the cell's tests open sockets with (#223). Everything here stays on
// this machine: loopback and unix sockets, never a host elsewhere. It lives
// outside the test files, which import no network module (runner.test.ts
// holds them to it), the way sample-server.ts does.
import { createSocket } from 'node:dgram'
import { request } from 'node:http'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { connect as tlsConnect } from 'node:tls'
import { GATE_SOCKET } from '../src/cell-gate.js'

export type { Server, Socket }

/** A server on a loopback port of its own. */
export async function loopbackServer(onSocket: (socket: Socket) => void): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const server = createServer(onSocket)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { server, port: address.port, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

/** A server on a unix socket. */
export async function unixServer(path: string, onSocket: (socket: Socket) => void): Promise<{ close: () => Promise<void> }> {
  const server = createServer(onSocket)
  await new Promise<void>((resolve) => server.listen(path, resolve))
  return { close: () => new Promise((resolve) => server.close(() => resolve())) }
}

export const dialLoopback = (port: number): Socket => connect({ host: '127.0.0.1', port })
export const dialUnix = (path: string): Socket => connect(path)

/** One request to the gate: the line it is sent, the line it answers, and the socket for what follows. */
export function askGate(dir: string, request: unknown): Promise<{ reply: Record<string, unknown> | undefined; socket: Socket; rest: () => string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(join(dir, GATE_SOCKET))
    let buffered = ''
    let answered = false
    socket.on('error', reject)
    socket.on('connect', () => socket.write(typeof request === 'string' ? request : `${JSON.stringify(request)}\n`))
    socket.on('data', (chunk) => {
      buffered += String(chunk)
      const end = buffered.indexOf('\n')
      if (answered || end === -1) return
      answered = true
      const line = buffered.slice(0, end)
      buffered = buffered.slice(end + 1)
      resolve({ reply: JSON.parse(line) as Record<string, unknown>, socket, rest: () => buffered })
    })
    socket.on('close', () => {
      if (!answered) resolve({ reply: undefined, socket, rest: () => buffered })
    })
  })
}

/** A DNS query as a resolver sends it: one question, recursion desired. */
export function dnsQuery(name: string, type: number, id = 0x1234): Buffer {
  const labels = name.split('.').map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, 'latin1')]))
  return Buffer.concat([Buffer.from([id >> 8, id & 0xff, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]), ...labels, Buffer.from([0, type >> 8, type & 0xff, 0, 1])])
}

/** Ask the resolver on a loopback port, and hand back its reply. */
export function lookup(port: number, name: string, type: number, id = 0xabcd): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4')
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error(`no DNS reply for ${name}`))
    }, 2_000)
    socket.on('message', (message) => {
      clearTimeout(timer)
      socket.close()
      resolve(message)
    })
    socket.send(dnsQuery(name, type, id), port, '127.0.0.1')
  })
}

/** A plain request to a loopback port, naming a host. */
export function getAs(port: number, host: string): Promise<{ status?: number; body?: string; error?: string }> {
  return new Promise((resolve) => {
    const call = request({ host: '127.0.0.1', port, path: '/hello', headers: { host }, agent: false }, (response) => {
      let body = ''
      response.on('data', (chunk) => (body += String(chunk)))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
    })
    call.on('error', (error) => resolve({ error: (error as NodeJS.ErrnoException).code ?? error.message }))
    call.end()
  })
}

/** Open a TLS connection to a loopback port, naming a server; resolves with how it ended when it is refused. */
export function tlsTo(port: number, servername: string | undefined): { destroy: () => void; ended: Promise<string> } {
  const client = tlsConnect({ host: '127.0.0.1', port, ...(servername === undefined ? {} : { servername }), rejectUnauthorized: false })
  const ended = new Promise<string>((resolve) => {
    client.on('error', (error) => resolve((error as NodeJS.ErrnoException).code ?? error.message))
    client.on('close', () => resolve('closed'))
  })
  return { destroy: () => client.destroy(), ended }
}

/** The first bytes a real TLS client sends, taken off a socket. */
export async function clientHello(servername: string | undefined): Promise<Buffer> {
  let captured: ((chunk: Buffer) => void) | undefined
  const first = new Promise<Buffer>((resolve) => (captured = resolve))
  const listening = await loopbackServer((socket) => {
    socket.on('error', () => {})
    socket.once('data', (chunk) => {
      socket.destroy()
      captured?.(chunk)
    })
  })
  const client = tlsTo(listening.port, servername)
  const hello = await first
  client.destroy()
  await listening.close()
  return hello
}
