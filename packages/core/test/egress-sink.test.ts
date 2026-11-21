import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { ask, echoServer, readThrough, type Closable } from './egress-sockets.js'
import { parseSinkRecord, startDnsSink, startRelay, type DnsSink, type Relay } from '../src/egress-sink.js'

/** A DNS query for one name, as a stub resolver sends it. */
function query(name: string, type = 1, id = 0x1234): Buffer {
  const labels = name.split('.').filter((label) => label !== '')
  const parts = labels.map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, 'ascii')]))
  const header = Buffer.alloc(12)
  header.writeUInt16BE(id, 0)
  header.writeUInt16BE(0x0100, 2)
  header.writeUInt16BE(1, 4)
  const tail = Buffer.alloc(4)
  tail.writeUInt16BE(type, 0)
  tail.writeUInt16BE(1, 2)
  return Buffer.concat([header, ...parts, Buffer.from([0]), tail])
}

const sinks: DnsSink[] = []
const relays: Relay[] = []
const servers: Closable[] = []
afterEach(async () => {
  for (const sink of sinks.splice(0)) await sink.stop()
  for (const relay of relays.splice(0)) await relay.stop()
  for (const server of servers.splice(0)) await server.close()
})

async function sink(hosts: Record<string, string>, lines: string[], maxEntries?: number): Promise<DnsSink> {
  const started = await startDnsSink({
    hosts,
    port: 0,
    bind: '127.0.0.1',
    resolveService: async (service) => (service === 'billing-stub' ? ['192.0.2.13'] : service === 'mail-stub' ? ['192.0.2.14', '192.0.2.15'] : []),
    write: (line) => lines.push(line),
    ...(maxEntries === undefined ? {} : { maxEntries }),
  })
  sinks.push(started)
  return started
}

describe('the DNS sink of a contained stack (#382)', () => {
  test('a declared host is answered with the address of the service that provides it, and recorded as declared', async () => {
    const lines: string[] = []
    const started = await sink({ 'api.billing-vendor.example': 'billing-stub' }, lines)
    const answer = await ask(started.port, query('API.Billing-Vendor.example'))
    expect(answer).toEqual({ id: 0x1234, rcode: 0, addresses: ['192.0.2.13'] })
    expect(lines.map((line) => JSON.parse(line))).toEqual([{ event: 'lookup', host: 'api.billing-vendor.example', declared: true }])
  })

  test('a wildcard stub answers one label under it, and nothing deeper', async () => {
    const lines: string[] = []
    const started = await sink({ '*.mail.example': 'mail-stub' }, lines)
    expect((await ask(started.port, query('smtp.mail.example'))).addresses).toEqual(['192.0.2.14', '192.0.2.15'])
    expect((await ask(started.port, query('a.b.mail.example'))).rcode).toBe(3)
  })

  test('an undeclared host is answered NXDOMAIN and recorded once, however often it is asked', async () => {
    const lines: string[] = []
    const started = await sink({ 'api.billing-vendor.example': 'billing-stub' }, lines)
    for (let index = 0; index < 3; index += 1) expect((await ask(started.port, query('api.stripe.com'))).rcode).toBe(3)
    expect(lines.map((line) => JSON.parse(line))).toEqual([{ event: 'lookup', host: 'api.stripe.com', declared: false }])
  })

  test('a declared host asked for another record type is answered with nothing, not refused', async () => {
    const lines: string[] = []
    const started = await sink({ 'api.billing-vendor.example': 'billing-stub' }, lines)
    expect(await ask(started.port, query('api.billing-vendor.example', 28))).toEqual({ id: 0x1234, rcode: 0, addresses: [] })
  })

  test('the record is capped: past the bound, a line says names were dropped, once', async () => {
    const lines: string[] = []
    const started = await sink({}, lines, 2)
    for (const name of ['a.example', 'b.example', 'c.example', 'd.example']) await ask(started.port, query(name))
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { event: 'lookup', host: 'a.example', declared: false },
      { event: 'lookup', host: 'b.example', declared: false },
      { event: 'capped' },
    ])
  })

  test('a name that is not a host name is refused and not written to the record as itself', async () => {
    const lines: string[] = []
    const started = await sink({}, lines)
    expect((await ask(started.port, query('bad"name.example'))).rcode).toBe(3)
    expect(lines.map((line) => JSON.parse(line))).toEqual([{ event: 'lookup', host: 'invalid', declared: false }])
  })
})

describe('the sink without the embedded DNS (#408)', () => {
  test("a stub's service is answered with the address the run handed the sink, and looked up by name only until then", async () => {
    const map = join(mkdtempSync(join(tmpdir(), 'qare-egress-map-')), 'services.json')
    const asked: string[] = []
    const started = await startDnsSink({
      hosts: { 'api.billing-vendor.example': 'billing-stub' },
      port: 0,
      bind: '127.0.0.1',
      map,
      // A daemon with no embedded DNS: a service name never resolves.
      resolveService: async (service) => {
        asked.push(service)
        throw new Error(`getaddrinfo ENOTFOUND ${service}`)
      },
      write: () => {},
    })
    sinks.push(started)
    expect((await ask(started.port, query('api.billing-vendor.example'))).rcode).toBe(2)
    writeFileSync(map, JSON.stringify({ 'billing-stub': ['198.18.0.3'] }))
    expect(await ask(started.port, query('api.billing-vendor.example'))).toEqual({ id: 0x1234, rcode: 0, addresses: ['198.18.0.3'] })
    expect(asked).toEqual(['billing-stub'])
  })
})

describe('the relay of a contained stack (#382)', () => {
  test('carries a connection on a published port to the service inside', async () => {
    const server = await echoServer('from the app')
    servers.push(server)
    const relay = await startRelay({ forwards: [{ listen: 0, host: '127.0.0.1', port: server.port }], bind: '127.0.0.1' })
    relays.push(relay)
    const got = await readThrough(relay.ports[0] as number)
    expect(got).toBe('from the app')
  })
})

describe('reading the sink record back (#382)', () => {
  test('keeps the lookups and drops whatever is not the sink speaking', () => {
    const record = parseSinkRecord(
      [
        '{"event":"ready","address":"192.0.2.2"}',
        '{"event":"lookup","host":"api.stripe.com","declared":false}',
        'not json',
        '{"event":"lookup","host":"Bad Host","declared":false}',
        '{"event":"lookup","host":"api.billing-vendor.example","declared":true}',
        '{"event":"lookup","host":"api.stripe.com","declared":false}',
      ].join('\n'),
    )
    expect(record).toEqual({
      address: '192.0.2.2',
      lookups: [
        { host: 'api.stripe.com', declared: false },
        { host: 'api.billing-vendor.example', declared: true },
      ],
      capped: false,
    })
  })

  test('says when the record was capped, and has no address when the sink never said it was ready', () => {
    expect(parseSinkRecord('{"event":"capped"}\n')).toEqual({ lookups: [], capped: true })
  })
})

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise((resolve) => server.close(resolve))
  return port
}

describe('qare cell egress-dns-map, and the sink and relay by address (#408)', () => {
  test('the map is written whole, and the running sink answers from it where no service name resolves', async () => {
    const { runCellCommand } = await import('../src/cell-launch.js')
    const { EventEmitter } = await import('node:events')
    const map = join(mkdtempSync(join(tmpdir(), 'qare-egress-map-')), 'services.json')
    const out: string[] = []
    const signals = new EventEmitter()
    // The command resolves a service by name only through the host's resolver, where `qare-test-stub-408` is no host.
    const running = runCellCommand(['egress-dns', '--port', '0', '--bind', '127.0.0.1', '--map', map, '--host', 'api.example.test=qare-test-stub-408'], { out: (line) => out.push(line), err: () => {}, signals })
    await expect.poll(() => out.length).toBe(1)
    const port = (JSON.parse(out[0] as string) as { port: number }).port
    expect(await runCellCommand(['egress-dns-map', '--map', map, '--service', 'qare-test-stub-408=198.18.0.3,198.18.0.5'], { out: () => {}, err: () => {} })).toBe(0)
    expect(JSON.parse(readFileSync(map, 'utf8'))).toEqual({ 'qare-test-stub-408': ['198.18.0.3', '198.18.0.5'] })
    expect((await ask(port, query('api.example.test'))).addresses).toEqual(['198.18.0.3', '198.18.0.5'])
    signals.emit('SIGTERM')
    expect(await running).toBe(0)
  })

  test('the map refuses what is not a service and its addresses', async () => {
    const { runCellCommand } = await import('../src/cell-launch.js')
    const said: string[] = []
    const io = { out: () => {}, err: (line: string) => said.push(line) }
    expect(await runCellCommand(['egress-dns-map', '--service', 'stub=198.18.0.3'], io)).toBe(4)
    expect(await runCellCommand(['egress-dns-map', '--map', 'relative.json', '--service', 'stub=198.18.0.3'], io)).toBe(4)
    expect(await runCellCommand(['egress-dns-map', '--map', '/run/qare-egress/services.json', '--service', 'stub=stub-host'], io)).toBe(4)
    expect(await runCellCommand(['egress-dns-map', '--map', '/run/qare-egress/services.json', '--service', '../stub=198.18.0.3'], io)).toBe(4)
    expect(said).toEqual([
      'qare cell egress-dns-map: --map must be an absolute path',
      'qare cell egress-dns-map: --map must be an absolute path',
      'qare cell egress-dns-map: "stub=stub-host" is not a <compose service>=<address>[,<address>] entry',
      'qare cell egress-dns-map: "../stub=198.18.0.3" is not a <compose service>=<address>[,<address>] entry',
    ])
  })

  test('the relay carries a connection to an address it was handed, with no name to look up', async () => {
    const { runCellCommand } = await import('../src/cell-launch.js')
    const { EventEmitter } = await import('node:events')
    const server = await echoServer('from the app by address')
    servers.push(server)
    const listen = await freePort()
    const out: string[] = []
    const signals = new EventEmitter()
    const running = runCellCommand(['egress-relay', '--bind', '127.0.0.1', '--forward', `${listen}=127.0.0.1:${server.port}`], { out: (line) => out.push(line), err: () => {}, signals })
    await expect.poll(() => out.length).toBe(1)
    expect(await readThrough(listen)).toBe('from the app by address')
    signals.emit('SIGTERM')
    expect(await running).toBe(0)
  })
})

describe('qare cell egress-dns and qare cell egress-relay (#382)', () => {
  test('refuse what is not theirs, by name', async () => {
    const { runCellCommand } = await import('../src/cell-launch.js')
    const { EventEmitter } = await import('node:events')
    const said: string[] = []
    const io = { out: () => {}, err: (line: string) => said.push(line), signals: new EventEmitter() }
    expect(await runCellCommand(['egress-dns', '--host', 'not a host=stub'], io)).toBe(4)
    expect(await runCellCommand(['egress-dns', '--host', 'api.example.test'], io)).toBe(4)
    expect(await runCellCommand(['egress-dns', '--host', 'api.example.test=../stub'], io)).toBe(4)
    expect(await runCellCommand(['egress-relay'], io)).toBe(4)
    expect(await runCellCommand(['egress-relay', '--forward', '20000=web'], io)).toBe(4)
    expect(said).toEqual([
      'qare cell egress-dns: "not a host=stub" is not a <host>=<compose service> stub',
      'qare cell egress-dns: "api.example.test" is not a <host>=<compose service> stub',
      'qare cell egress-dns: "api.example.test=../stub" is not a <host>=<compose service> stub',
      'qare cell egress-relay: no --forward <port>=<service>:<port> to carry',
      'qare cell egress-relay: "20000=web" is not a <port>=<service>:<port> forward',
    ])
  })

  test('the sink says where it answers, and stops on a signal', async () => {
    const { runCellCommand } = await import('../src/cell-launch.js')
    const { EventEmitter } = await import('node:events')
    const out: string[] = []
    const signals = new EventEmitter()
    const running = runCellCommand(['egress-dns', '--port', '0', '--bind', '127.0.0.1', '--host', 'api.example.test=stub'], { out: (line) => out.push(line), err: () => {}, signals })
    await expect.poll(() => out.length).toBe(1)
    expect(JSON.parse(out[0] as string)).toMatchObject({ event: 'ready' })
    signals.emit('SIGTERM')
    expect(await running).toBe(0)
  })
})
