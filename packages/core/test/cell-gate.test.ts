import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { CDP_SOCKET, startGate, type Gate, type GateSummary } from '../src/cell-gate.js'
import { askGate, dialLoopback, loopbackServer, unixServer } from './cell-sockets.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** An upstream that greets and echoes, standing in for a declared host. */
async function upstream(): Promise<{ port: number }> {
  const listening = await loopbackServer((socket) => {
    socket.write('hello from upstream\n')
    socket.on('data', (chunk) => socket.write(`echo ${String(chunk)}`))
    socket.on('error', () => {})
  })
  cleanups.push(listening.close)
  return { port: listening.port }
}

async function gate(
  hosts: string[],
  extra: { maxEntries?: number; dialPort?: number; map?: Record<string, string>; ports?: { port: number; protocol: 'http' | 'https' }[] } = {},
): Promise<{ gate: Gate; dir: string; lines: string[]; dialled: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-gate-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const lines: string[] = []
  const dialled: string[] = []
  const started = await startGate({
    hosts,
    socketDir: dir,
    relayPort: 0,
    relayHost: '127.0.0.1',
    write: (line) => lines.push(line),
    dial: (host, port) => {
      dialled.push(`${host}:${port}`)
      // The declared host is the upstream above, wherever the name would really lead.
      return dialLoopback(extra.dialPort ?? 1)
    },
    ...(extra.maxEntries === undefined ? {} : { maxEntries: extra.maxEntries }),
    ...(extra.map === undefined ? {} : { map: extra.map }),
    ...(extra.ports === undefined ? {} : { ports: extra.ports }),
  })
  cleanups.push(() => started.stop().then(() => {}))
  return { gate: started, dir, lines, dialled }
}

const ask = askGate

const until = async (done: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !done(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10))
  if (!done()) throw new Error('timed out waiting')
}

function summaryOf(lines: string[]): GateSummary {
  const line = lines.map((entry) => JSON.parse(entry) as { event: string }).find((entry) => entry.event === 'summary')
  if (line === undefined) throw new Error('the gate wrote no summary')
  return line as unknown as GateSummary
}

test('the gate says it is ready, naming the port the driver is relayed on (#223)', async () => {
  const { gate: started, lines } = await gate([])
  expect(JSON.parse(lines[0] as string)).toEqual({ event: 'ready', relayPort: started.relayPort })
  expect(started.relayPort).toBeGreaterThan(0)
})

test('a lookup of a declared name is allowed; an undeclared one is refused and counted (#223)', async () => {
  const { gate: started, dir, lines } = await gate(['api.example.test', '*.cdn.example.test'])
  expect((await ask(dir, { op: 'resolve', host: 'api.example.test' })).reply).toEqual({ ok: true })
  expect((await ask(dir, { op: 'resolve', host: 'A.cdn.Example.test' })).reply).toEqual({ ok: true })
  expect((await ask(dir, { op: 'resolve', host: 'evil.example.test' })).reply).toEqual({ ok: false, reason: 'undeclared' })
  expect((await ask(dir, { op: 'resolve', host: 'evil.example.test' })).reply).toEqual({ ok: false, reason: 'undeclared' })
  // Two labels below a wildcard is not one label below it.
  expect((await ask(dir, { op: 'resolve', host: 'a.b.cdn.example.test' })).reply).toEqual({ ok: false, reason: 'undeclared' })
  await started.stop()
  // A lookup that was allowed reached nothing yet; the ones refused are the record.
  expect(summaryOf(lines)).toEqual({
    event: 'summary',
    capped: false,
    reached: [
      { host: 'a.b.cdn.example.test', port: 53, protocol: 'dns', declared: false, count: 1 },
      { host: 'evil.example.test', port: 53, protocol: 'dns', declared: false, count: 2 },
    ],
  })
})

test('a connection to a declared host is made by the gate and carried both ways, and recorded (#223)', async () => {
  const { port } = await upstream()
  const { gate: started, dir, lines, dialled } = await gate(['api.example.test'], { dialPort: port })
  const { reply, socket, rest } = await ask(dir, { op: 'connect', host: 'api.example.test', port: 443 })
  expect(reply).toEqual({ ok: true })
  socket.write('ping')
  let received = rest()
  socket.on('data', (chunk) => {
    received += String(chunk)
  })
  await until(() => received.includes('echo ping'))
  expect(received).toBe('hello from upstream\necho ping')
  // The gate dials the name it was asked for, on the port it was asked for.
  expect(dialled).toEqual(['api.example.test:443'])
  socket.destroy()
  await ask(dir, { op: 'connect', host: 'api.example.test', port: 80 }).then(({ socket: plain }) => plain.destroy())
  await started.stop()
  expect(summaryOf(lines).reached).toEqual([
    { host: 'api.example.test', port: 443, protocol: 'https', declared: true, count: 1 },
    { host: 'api.example.test', port: 80, protocol: 'http', declared: true, count: 1 },
  ])
})

test('a mapped host is dialled as the name the map carries, and recorded as the name the cell asked for (#224)', async () => {
  const { port } = await upstream()
  const { gate: started, dir, lines, dialled } = await gate(['api.billing.example.test'], {
    dialPort: port,
    map: { 'api.billing.example.test': 'billing-stub' },
  })
  const { reply } = await ask(dir, { op: 'connect', host: 'api.billing.example.test', port: 443 })
  expect(reply).toEqual({ ok: true })
  expect(dialled).toEqual(['billing-stub:443'])
  await started.stop()
  expect(summaryOf(lines).reached).toEqual([
    { host: 'api.billing.example.test', port: 443, protocol: 'https', declared: true, count: 1 },
  ])
})

test('a map key with a wildcard carries every host the pattern names, dialled as the mapped service (#224)', async () => {
  const { port } = await upstream()
  const { gate: started, dir, dialled } = await gate(['api.vendor.example.test'], {
    dialPort: port,
    map: { '*.vendor.example.test': 'billing-stub' },
  })
  const { reply } = await ask(dir, { op: 'connect', host: 'api.vendor.example.test', port: 443 })
  expect(reply).toEqual({ ok: true })
  expect(dialled).toEqual(['billing-stub:443'])
  await started.stop()
})

test('an exact mapping is resolved however the profile spelled the host (#224)', async () => {
  const { port } = await upstream()
  const { gate: started, dir, dialled } = await gate(['api.billing.example.test', '*.vendor.example.test'], {
    dialPort: port,
    map: { 'API.BILLING.EXAMPLE.TEST': 'billing-stub', '*.VENDOR.EXAMPLE.TEST': 'vendor-stub' },
  })
  // The request is the lowercase name it resolved to; the map is the
  // profile's own casing. Either way, the stub answers, not a host on the
  // internet that happens to spell the same.
  expect((await ask(dir, { op: 'connect', host: 'api.billing.example.test', port: 8080 })).reply).toEqual({ ok: true })
  expect(dialled).toEqual(['billing-stub:8080'])
  expect((await ask(dir, { op: 'connect', host: 'a.vendor.example.test', port: 8080 })).reply).toEqual({ ok: true })
  expect(dialled).toEqual(['billing-stub:8080', 'vendor-stub:8080'])
  await started.stop()
})

test("a mapped host is reached on any port the stack answers on; an unmapped one is held to the gate's own two (#224)", async () => {
  const { port } = await upstream()
  const { gate: started, dir, lines, dialled } = await gate(['api.billing.example.test', 'plain.example.test'], {
    dialPort: port,
    map: { 'api.billing.example.test': 'billing-stub' },
  })
  const { reply } = await ask(dir, { op: 'connect', host: 'api.billing.example.test', port: 8080 })
  expect(reply).toEqual({ ok: true })
  expect(dialled).toEqual(['billing-stub:8080'])
  expect((await ask(dir, { op: 'connect', host: 'plain.example.test', port: 8080 })).reply).toEqual({
    ok: false,
    reason: 'the gate carries ports 80 and 443 only',
  })
  await started.stop()
  expect(summaryOf(lines).reached).toEqual([
    { host: 'api.billing.example.test', port: 8080, protocol: 'tcp', declared: true, count: 1 },
    { host: 'plain.example.test', port: 8080, protocol: 'tcp', declared: false, count: 1 },
  ])
})

test('the gate carries the port the run booted the app on, and names every port it carries (#224)', async () => {
  const { port } = await upstream()
  const { gate: started, dir, lines, dialled } = await gate(['api.example.test'], {
    dialPort: port,
    ports: [{ port: 3000, protocol: 'http' }],
  })
  const { reply } = await ask(dir, { op: 'connect', host: 'api.example.test', port: 3000 })
  expect(reply).toEqual({ ok: true })
  expect(dialled).toEqual(['api.example.test:3000'])
  expect((await ask(dir, { op: 'connect', host: 'api.example.test', port: 22 })).reply).toEqual({
    ok: false,
    reason: 'the gate carries ports 80, 443 and 3000 only',
  })
  await started.stop()
  expect(summaryOf(lines).reached).toEqual([
    { host: 'api.example.test', port: 22, protocol: 'tcp', declared: false, count: 1 },
    { host: 'api.example.test', port: 3000, protocol: 'http', declared: true, count: 1 },
  ])
})

test('a connection the profile does not declare is refused before anything is dialled, and recorded (#223)', async () => {
  const { port } = await upstream()
  const { gate: started, dir, lines, dialled } = await gate(['api.example.test'], { dialPort: port })
  expect((await ask(dir, { op: 'connect', host: 'evil.example.test', port: 443 })).reply).toEqual({ ok: false, reason: 'undeclared' })
  // A declared host on a port the gate does not carry is refused too, and is not called declared.
  expect((await ask(dir, { op: 'connect', host: 'api.example.test', port: 22 })).reply).toEqual({ ok: false, reason: 'the gate carries ports 80 and 443 only' })
  // A connection that named no host, or something that is not a host, is recorded as unknown.
  expect((await ask(dir, { op: 'connect', port: 443 })).reply).toEqual({ ok: false, reason: 'undeclared' })
  expect((await ask(dir, { op: 'connect', host: 'evil.test\n"injected"', port: 80 })).reply).toEqual({ ok: false, reason: 'undeclared' })
  expect(dialled).toEqual([])
  await started.stop()
  expect(summaryOf(lines).reached).toEqual([
    { host: 'api.example.test', port: 22, protocol: 'tcp', declared: false, count: 1 },
    { host: 'evil.example.test', port: 443, protocol: 'https', declared: false, count: 1 },
    { host: 'unknown', port: 443, protocol: 'https', declared: false, count: 1 },
    { host: 'unknown', port: 80, protocol: 'http', declared: false, count: 1 },
  ])
})

test('a declared host that cannot be reached is said, and still recorded as reached for (#223)', async () => {
  // Port 1 on loopback refuses.
  const { gate: started, dir, lines } = await gate(['api.example.test'])
  const { reply } = await ask(dir, { op: 'connect', host: 'api.example.test', port: 443 })
  expect(reply).toEqual({ ok: false, reason: 'unreachable: ECONNREFUSED' })
  await started.stop()
  expect(summaryOf(lines).reached).toEqual([{ host: 'api.example.test', port: 443, protocol: 'https', declared: true, count: 1 }])
})

test('a request that is not one is dropped without an answer (#223)', async () => {
  const { gate: started, dir, lines } = await gate(['api.example.test'])
  expect((await ask(dir, 'not json\n')).reply).toBeUndefined()
  expect((await ask(dir, `${JSON.stringify({ op: 'launch' })}\n`)).reply).toBeUndefined()
  // A first line with no end is not read without limit.
  expect((await ask(dir, 'x'.repeat(5000))).reply).toBeUndefined()
  await started.stop()
  expect(summaryOf(lines).reached).toEqual([])
})

test('the record is bounded, and says when it was cut (#223)', async () => {
  const { gate: started, dir, lines } = await gate([], { maxEntries: 2 })
  for (const host of ['a.test', 'b.test', 'c.test', 'a.test']) await ask(dir, { op: 'resolve', host })
  await started.stop()
  const summary = summaryOf(lines)
  expect(summary.capped).toBe(true)
  expect(summary.reached).toEqual([
    { host: 'a.test', port: 53, protocol: 'dns', declared: false, count: 2 },
    { host: 'b.test', port: 53, protocol: 'dns', declared: false, count: 1 },
  ])
})

test('the driver is relayed to the endpoint the cell exposes (#223)', async () => {
  const { gate: started, dir } = await gate([])
  const endpoint = await unixServer(join(dir, CDP_SOCKET), (socket) => socket.on('data', (chunk) => socket.write(`cdp ${String(chunk)}`)))
  cleanups.push(endpoint.close)
  const client = dialLoopback(started.relayPort)
  let received = ''
  client.on('data', (chunk) => {
    received += String(chunk)
  })
  client.write('attach')
  await until(() => received === 'cdp attach')
  client.destroy()
})
