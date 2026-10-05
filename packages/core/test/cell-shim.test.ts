import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { CDP_SOCKET, startGate, type Gate } from '../src/cell-gate.js'
import { startShim, type Shim } from '../src/cell-shim.js'
import { readDnsQuestion } from '../src/cell-wire.js'
import { dialAddress, dialLoopback, dialUnix, getAs as get, lookup, loopbackServer, tlsTo } from './cell-sockets.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const until = async (done: () => boolean): Promise<void> => {
  for (let i = 0; i < 300 && !done(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10))
  if (!done()) throw new Error('timed out waiting')
}

/** A cell's two halves on one machine: the gate, dialling a local upstream, and the shim that asks it. */
async function cell(hosts: string[], opts: { gate?: boolean; app?: { port: number; scheme: 'http' | 'https' }; map?: Record<string, string>; stubs?: { host: string; port: number }[] } = {}): Promise<{ shim: Shim; gate: Gate | undefined; dir: string; received: Buffer[]; dialled: string[]; cdpPort: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-shim-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const received: Buffer[] = []
  const upstream = await loopbackServer((socket) => {
    socket.on('error', () => {})
    socket.on('data', (chunk) => {
      received.push(chunk)
      if (String(chunk).startsWith('GET ')) socket.end('HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nupstream')
    })
  })
  cleanups.push(upstream.close)
  const upstreamPort = upstream.port
  // What stands in for the build's DevTools endpoint.
  const devtools = await loopbackServer((socket) => socket.on('data', (chunk) => socket.write(`devtools ${String(chunk)}`)))
  cleanups.push(devtools.close)
  const cdpPort = devtools.port
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
            return dialLoopback(upstreamPort)
          },
          ...(opts.app === undefined ? {} : { ports: [{ port: opts.app.port, protocol: opts.app.scheme }] }),
          ...(opts.map === undefined ? {} : { map: opts.map }),
          ...(opts.stubs === undefined ? {} : { stubPorts: opts.stubs }),
        })
  if (gate !== undefined) cleanups.push(() => gate.stop())
  const shim = await startShim({
    socketDir: dir,
    dnsPort: 0,
    httpPort: 0,
    httpsPort: 0,
    cdpPort,
    ...(opts.app === undefined ? {} : { appPort: opts.app.port, appScheme: opts.app.scheme }),
    ...(opts.stubs === undefined ? {} : { stubPorts: opts.stubs }),
  })
  cleanups.push(() => shim.stop())
  return { shim, gate, dir, received, dialled, cdpPort }
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
  const client = tlsTo(shim.ports.https, 'api.example.test')
  await until(() => received.length > 0)
  client.destroy()
  expect(dialled).toEqual(['api.example.test:443'])
  // What reached the declared host is the client's own hello: a TLS handshake record.
  expect(Buffer.concat(received)[0]).toBe(0x16)
  expect(['ECONNRESET', 'closed']).toContain(await tlsTo(shim.ports.https, 'evil.example.test').ended)
  expect(dialled).toEqual(['api.example.test:443'])
  const summary = await gate!.stop()
  expect(summary.reached.map((entry) => `${entry.host}:${entry.port} ${entry.declared}`)).toEqual(['api.example.test:443 true', 'evil.example.test:443 false'])
})

test('a connection to the app\'s port is carried by name, on the port the run booted it on (#224)', async () => {
  const { shim, gate, dialled, received } = await cell(['app.internal'], { app: { port: 30007, scheme: 'http' } })
  expect(shim.ports.app).toBe(30007)
  expect(await get(shim.ports.app as number, 'app.internal')).toEqual({ status: 200, body: 'upstream' })
  expect(dialled).toEqual(['app.internal:30007'])
  // The request arrives whole: the head the shim read to learn the host is not lost.
  expect(String(Buffer.concat(received))).toMatch(/^GET \/hello HTTP\/1\.1\r\n/)
  // An undeclared host on the app's port is refused and recorded, like any other port.
  expect((await get(shim.ports.app as number, 'evil.example.test')).error).toBe('ECONNRESET')
  const summary = await gate!.stop()
  expect(summary.reached).toEqual([
    { host: 'app.internal', port: 30007, protocol: 'http', declared: true, count: 1 },
    { host: 'evil.example.test', port: 30007, protocol: 'http', declared: false, count: 1 },
  ])
})

test('a stub the profile gives ports for is answered on its own address, at those ports (#224)', async () => {
  const { shim, gate, dialled, received } = await cell(['api.example.test', 'api2.example.test'], {
    map: { 'api.example.test': 'billing-stub', 'api2.example.test': 'other-stub' },
    stubs: [
      { host: 'api.example.test', port: 8080 },
      { host: 'api2.example.test', port: 8080 },
    ],
  })
  // Each named host answers with its own address, even where the port is the same.
  const first = await lookup(shim.ports.dns, 'api.example.test', 1)
  expect([rcode(first), answers(first), address(first)]).toEqual([0, 1, [127, 0, 0, 2]])
  const second = await lookup(shim.ports.dns, 'api2.example.test', 1)
  expect([rcode(second), answers(second), address(second)]).toEqual([0, 1, [127, 0, 0, 3]])

  // A connection to that address on the declared port is carried as the host
  // it is dialed by, no reading of what it is for. It reaches the upstream,
  // and the gate records it declared, its protocol unnamed.
  const dialled1 = dialAddress('127.0.0.2', 8080)
  dialled1.on('error', () => {})
  dialled1.write('PING\n')
  await until(() => received.some((chunk) => String(chunk).includes('PING')))
  dialled1.destroy()
  expect(dialled).toEqual(['billing-stub:8080'])
  const dialled2 = dialAddress('127.0.0.3', 8080)
  dialled2.on('error', () => {})
  dialled2.write('PING\n')
  await until(() => received.filter((chunk) => String(chunk).includes('PING')).length > 1)
  dialled2.destroy()
  expect(dialled).toEqual(['billing-stub:8080', 'other-stub:8080'])

  // A dial to the host's own address on the gate's own two is still read for
  // the host it names, and carried as that host.
  const overPeek = dialAddress('127.0.0.2', shim.ports.http)
  overPeek.on('error', () => {})
  overPeek.write('GET /hello HTTP/1.1\r\nHost: api.example.test\r\n\r\n')
  await until(() => received.some((chunk) => String(chunk).startsWith('GET ')))
  overPeek.destroy()
  expect(dialled).toEqual(['billing-stub:8080', 'other-stub:8080', 'billing-stub:80'])
  const summary = await gate!.stop()
  expect(summary.reached).toEqual([
    { host: 'api.example.test', port: 80, protocol: 'http', declared: true, count: 1 },
    { host: 'api.example.test', port: 8080, protocol: 'tcp', declared: true, count: 1 },
    { host: 'api2.example.test', port: 8080, protocol: 'tcp', declared: true, count: 1 },
  ])
})

test('the build\'s DevTools endpoint is exposed on the socket the gate relays (#223)', async () => {
  const { dir } = await cell([])
  const client = dialUnix(join(dir, CDP_SOCKET))
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
