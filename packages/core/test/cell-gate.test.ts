import { mkdtemp, rm } from 'node:fs/promises'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { CDP_SOCKET, GATE_SOCKET, startGate, type Gate, type GateSummary } from '../src/cell-gate.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** An upstream that greets and echoes, standing in for a declared host. */
async function upstream(): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => {
    socket.write('hello from upstream\n')
    socket.on('data', (chunk) => socket.write(`echo ${String(chunk)}`))
    socket.on('error', () => {})
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { server, port: address.port }
}

async function gate(hosts: string[], extra: { maxEntries?: number; dialPort?: number } = {}): Promise<{ gate: Gate; dir: string; lines: string[]; dialled: string[] }> {
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
      return connect({ host: '127.0.0.1', port: extra.dialPort ?? 1 })
    },
    ...(extra.maxEntries === undefined ? {} : { maxEntries: extra.maxEntries }),
  })
  cleanups.push(() => started.stop().then(() => {}))
  return { gate: started, dir, lines, dialled }
}

/** One request to the gate: the line it is sent, the line it answers, and the socket for what follows. */
function ask(dir: string, request: unknown): Promise<{ reply: Record<string, unknown> | undefined; socket: Socket; rest: () => string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(join(dir, GATE_SOCKET))
    let buffered = ''
    let answered = false
    socket.on('error', reject)
    socket.on('connect', () => socket.write(typeof request === 'string' ? request : `${JSON.stringify(request)}\n`))
    const settle = (): void => {
      if (answered) return
      const end = buffered.indexOf('\n')
      if (end === -1) return
      answered = true
      const line = buffered.slice(0, end)
      buffered = buffered.slice(end + 1)
      resolve({ reply: JSON.parse(line) as Record<string, unknown>, socket, rest: () => buffered })
    }
    socket.on('data', (chunk) => {
      buffered += String(chunk)
      settle()
    })
    socket.on('close', () => {
      if (!answered) resolve({ reply: undefined, socket, rest: () => buffered })
    })
  })
}

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
  const endpoint = createServer((socket) => socket.on('data', (chunk) => socket.write(`cdp ${String(chunk)}`)))
  await new Promise<void>((resolve) => endpoint.listen(join(dir, CDP_SOCKET), resolve))
  cleanups.push(() => new Promise((resolve) => endpoint.close(() => resolve())))
  const client = connect({ host: '127.0.0.1', port: started.relayPort })
  let received = ''
  client.on('data', (chunk) => {
    received += String(chunk)
  })
  client.write('attach')
  await until(() => received === 'cdp attach')
  client.destroy()
})
