import { createSocket } from 'node:dgram'
import { connect, createServer, type AddressInfo, type Server } from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'
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

interface Answer {
  id: number
  rcode: number
  addresses: string[]
}

function ask(port: number, message: Buffer): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4')
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error('no answer'))
    }, 2000)
    socket.on('message', (reply) => {
      clearTimeout(timer)
      socket.close()
      const count = reply.readUInt16BE(6)
      // Skip the question: the name, then type and class.
      let at = 12
      while (reply[at] !== 0) at += (reply[at] as number) + 1
      at += 5
      const addresses: string[] = []
      for (let index = 0; index < count; index += 1) {
        at += 2 // a pointer to the question's name
        const length = reply.readUInt16BE(at + 8)
        addresses.push([...reply.subarray(at + 10, at + 10 + length)].join('.'))
        at += 10 + length
      }
      resolve({ id: reply.readUInt16BE(0), rcode: reply[3]! & 0x0f, addresses })
    })
    socket.send(message, port, '127.0.0.1')
  })
}

const sinks: DnsSink[] = []
const relays: Relay[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const sink of sinks.splice(0)) await sink.stop()
  for (const relay of relays.splice(0)) await relay.stop()
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve))
})

async function sink(hosts: Record<string, string>, lines: string[], maxEntries?: number): Promise<DnsSink> {
  const started = await startDnsSink({
    hosts,
    port: 0,
    bind: '127.0.0.1',
    resolveService: async (service) => (service === 'billing-stub' ? ['10.1.2.3'] : service === 'mail-stub' ? ['10.1.2.4', '10.1.2.5'] : []),
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
    expect(answer).toEqual({ id: 0x1234, rcode: 0, addresses: ['10.1.2.3'] })
    expect(lines.map((line) => JSON.parse(line))).toEqual([{ event: 'lookup', host: 'api.billing-vendor.example', declared: true }])
  })

  test('a wildcard stub answers one label under it, and nothing deeper', async () => {
    const lines: string[] = []
    const started = await sink({ '*.mail.example': 'mail-stub' }, lines)
    expect((await ask(started.port, query('smtp.mail.example'))).addresses).toEqual(['10.1.2.4', '10.1.2.5'])
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

describe('the relay of a contained stack (#382)', () => {
  test('carries a connection on a published port to the service inside', async () => {
    const server = createServer((socket) => socket.end('from the app'))
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const target = (server.address() as AddressInfo).port
    const relay = await startRelay({ forwards: [{ listen: 0, host: '127.0.0.1', port: target }], bind: '127.0.0.1' })
    relays.push(relay)
    const got = await new Promise<string>((resolve, reject) => {
      const socket = connect(relay.ports[0] as number, '127.0.0.1')
      let text = ''
      socket.on('data', (chunk) => (text += chunk.toString()))
      socket.on('end', () => resolve(text))
      socket.on('error', reject)
    })
    expect(got).toBe('from the app')
  })
})

describe('reading the sink record back (#382)', () => {
  test('keeps the lookups and drops whatever is not the sink speaking', () => {
    const record = parseSinkRecord(
      [
        '{"event":"ready","address":"10.9.0.2"}',
        '{"event":"lookup","host":"api.stripe.com","declared":false}',
        'not json',
        '{"event":"lookup","host":"Bad Host","declared":false}',
        '{"event":"lookup","host":"api.billing-vendor.example","declared":true}',
        '{"event":"lookup","host":"api.stripe.com","declared":false}',
      ].join('\n'),
    )
    expect(record).toEqual({
      address: '10.9.0.2',
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
