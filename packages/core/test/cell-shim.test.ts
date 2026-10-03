import { createSocket } from 'node:dgram'
import { mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as tlsConnect } from 'node:tls'
import { afterEach, expect, test } from 'vitest'
import { CDP_SOCKET, startGate, type Gate } from '../src/cell-gate.js'
import { startShim, type Shim } from '../src/cell-shim.js'
import { readDnsQuestion } from '../src/cell-wire.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const until = async (done: () => boolean): Promise<void> => {
  for (let i = 0; i < 300 && !done(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10))
  if (!done()) throw new Error('timed out waiting')
}

/** A cell's two halves on one machine: the gate, dialling a local upstream, and the shim that asks it. */
async function cell(hosts: string[], opts: { gate?: boolean } = {}): Promise<{ shim: Shim; gate: Gate | undefined; dir: string; received: Buffer[]; dialled: string[]; cdpPort: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-shim-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const received: Buffer[] = []
  const upstream = createServer((socket) => {
    socket.on('error', () => {})
    socket.on('data', (chunk) => {
      received.push(chunk)
      if (String(chunk).startsWith('GET ')) socket.end('HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nupstream')
    })
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise((resolve) => upstream.close(resolve)))
  const upstreamPort = (upstream.address() as { port: number }).port
  // What stands in for the build's DevTools endpoint.
  const devtools = createServer((socket) => socket.on('data', (chunk) => socket.write(`devtools ${String(chunk)}`)))
  await new Promise<void>((resolve) => devtools.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise((resolve) => devtools.close(resolve)))
  const cdpPort = (devtools.address() as { port: number }).port
  const dialled: string[] = []
  const gate =
    opts.gate === false
      ? undefined
      : await startGate({
          hosts,
          socketDir: dir,
          relayPort: 0,
          relayHost: '127.0.0.1',
          write: () => {},
          dial: (host, port) => {
            dialled.push(`${host}:${port}`)
            return connect({ host: '127.0.0.1', port: upstreamPort })
          },
        })
  if (gate !== undefined) cleanups.push(() => gate.stop())
  const shim = await startShim({ socketDir: dir, dnsPort: 0, httpPort: 0, httpsPort: 0, cdpPort })
  cleanups.push(() => shim.stop())
  return { shim, gate, dir, received, dialled, cdpPort }
}

function lookup(port: number, name: string, type: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4')
    const labels = name.split('.').map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]))
    const query = Buffer.concat([Buffer.from([0xab, 0xcd, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]), ...labels, Buffer.from([0, type >> 8, type & 0xff, 0, 1])])
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error(`no DNS reply for ${name}`))
    }, 2_000)
    socket.on('message', (message) => {
      clearTimeout(timer)
      socket.close()
      resolve(message)
    })
    socket.send(query, port, '127.0.0.1')
  })
}

const rcode = (reply: Buffer): number => reply[3]! & 0x0f
const answers = (reply: Buffer): number => reply.readUInt16BE(6)
const address = (reply: Buffer): number[] => [...reply.subarray(reply.length - 4)]

test('the cell\'s resolver answers a declared name with loopback and nothing else with an address (#223)', async () => {
  const { shim, gate } = await cell(['api.example.test'])
  const declared = await lookup(shim.ports.dns, 'api.example.test', 1)
  expect([rcode(declared), answers(declared), address(declared)]).toEqual([0, 1, [127, 0, 0, 1]])
  // The reply is to the question asked.
  expect(declared.readUInt16BE(0)).toBe(0xabcd)
  expect(readDnsQuestion(Buffer.concat([declared.subarray(0, 2), Buffer.from([1, 0]), declared.subarray(4)]))?.name).toBe('api.example.test')
  // A declared name has no IPv6 address here: the cell has no route for one.
  const v6 = await lookup(shim.ports.dns, 'api.example.test', 28)
  expect([rcode(v6), answers(v6)]).toEqual([0, 0])
  // An undeclared name does not exist, whatever is asked about it.
  const undeclared = await lookup(shim.ports.dns, 'evil.example.test', 1)
  expect([rcode(undeclared), answers(undeclared)]).toEqual([3, 0])
  expect(rcode(await lookup(shim.ports.dns, 'evil.example.test', 28))).toBe(3)
  // localhost is the cell itself, and nobody is asked.
  const local = await lookup(shim.ports.dns, 'localhost', 1)
  expect([rcode(local), answers(local), address(local)]).toEqual([0, 1, [127, 0, 0, 1]])
  const summary = await gate!.stop()
  expect(summary.reached).toEqual([{ host: 'evil.example.test', port: 53, protocol: 'dns', declared: false, count: 2 }])
})

function get(port: number, host: string): Promise<{ status?: number; body?: string; error?: string }> {
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

test('a plain request to a declared host is carried by name; one to any other host is cut (#223)', async () => {
  const { shim, gate, dialled, received } = await cell(['api.example.test'])
  expect(await get(shim.ports.http, 'api.example.test')).toEqual({ status: 200, body: 'upstream' })
  expect(dialled).toEqual(['api.example.test:80'])
  // The request arrives whole: the head the shim read to learn the host is not lost.
  expect(String(Buffer.concat(received))).toMatch(/^GET \/hello HTTP\/1\.1\r\n/)
  expect((await get(shim.ports.http, 'evil.example.test')).error).toBe('ECONNRESET')
  expect(dialled).toEqual(['api.example.test:80'])
  const summary = await gate!.stop()
  expect(summary.reached).toEqual([
    { host: 'api.example.test', port: 80, protocol: 'http', declared: true, count: 1 },
    { host: 'evil.example.test', port: 80, protocol: 'http', declared: false, count: 1 },
  ])
})

test('a TLS connection is carried by the name in its hello, unopened (#223)', async () => {
  const { shim, gate, dialled, received } = await cell(['api.example.test'])
  const client = tlsConnect({ host: '127.0.0.1', port: shim.ports.https, servername: 'api.example.test', rejectUnauthorized: false })
  client.on('error', () => {})
  await until(() => received.length > 0)
  client.destroy()
  expect(dialled).toEqual(['api.example.test:443'])
  // What reached the declared host is the client's own hello: a TLS handshake record.
  expect(Buffer.concat(received)[0]).toBe(0x16)
  const refused = tlsConnect({ host: '127.0.0.1', port: shim.ports.https, servername: 'evil.example.test', rejectUnauthorized: false })
  const ended = await new Promise<string>((resolve) => {
    refused.on('error', (error) => resolve((error as NodeJS.ErrnoException).code ?? error.message))
    refused.on('close', () => resolve('closed'))
  })
  expect(['ECONNRESET', 'closed']).toContain(ended)
  expect(dialled).toEqual(['api.example.test:443'])
  const summary = await gate!.stop()
  expect(summary.reached.map((entry) => `${entry.host}:${entry.port} ${entry.declared}`)).toEqual(['api.example.test:443 true', 'evil.example.test:443 false'])
})

test('the build\'s DevTools endpoint is exposed on the socket the gate relays (#223)', async () => {
  const { dir } = await cell([])
  const client = connect(join(dir, CDP_SOCKET))
  let received = ''
  client.on('data', (chunk) => (received += String(chunk)))
  client.write('attach')
  await until(() => received === 'devtools attach')
  client.destroy()
})

test('with no gate to ask, nothing resolves and nothing connects (#223)', async () => {
  const { shim } = await cell(['api.example.test'], { gate: false })
  expect(rcode(await lookup(shim.ports.dns, 'api.example.test', 1))).toBe(3)
  expect((await get(shim.ports.http, 'api.example.test')).error).toBe('ECONNRESET')
})
