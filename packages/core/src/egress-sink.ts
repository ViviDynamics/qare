import { createSocket, type RemoteInfo, type Socket as UdpSocket } from 'node:dgram'
import { lookup } from 'node:dns/promises'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { networkInterfaces } from 'node:os'
import { isAbsolute } from 'node:path'
import { DNS_TYPE_A, hostName, readDnsQuestion, type DnsQuestion } from './cell-wire.js'

/**
 * The two processes that make a booted stack's containment (#382), run as
 * `qare cell egress-dns` and `qare cell egress-relay` from the image the run
 * is in. Neither is a command a person runs.
 *
 * The stack's networks are internal, so nothing in it routes anywhere but
 * to its own services. The sink is the stack's resolver for every name that
 * is not one of its services: a host a stub declares is answered with the
 * address of the service that provides it, and any other name is answered
 * NXDOMAIN and written to the record. The relay is the stack's one way in:
 * it publishes the ports the stack published and carries each connection to
 * the service inside.
 *
 * Both run beside pull request code, so nothing that reaches them is
 * trusted: a name is held to being a name, and the record is capped.
 */

/** The distinct names one stack may put in the record before it is cut. */
const DEFAULT_MAX_ENTRIES = 200
/** How long the sink tells a resolver to keep a stub's address. */
const ANSWER_TTL_SECONDS = 5
const CLASS_IN = 1
const RCODE_NXDOMAIN = 3
const RCODE_SERVFAIL = 2
const DIAL_TIMEOUT_MS = 15_000

/** One name the stack looked up, and whether a stub declares it. */
export interface SinkLookup {
  host: string
  declared: boolean
}

/** What the run reads back from the sink's log. `address` is where the sink answers. */
export interface SinkRecord {
  address?: string
  lookups: SinkLookup[]
  capped: boolean
}

export interface DnsSinkOptions {
  /** Each host a stub declares, as the profile writes it (`*.` for one label), and the compose service that provides it. */
  hosts: Readonly<Record<string, string>>
  port?: number
  bind?: string
  /**
   * The file the run writes each stub service's addresses to once they are
   * up (#408), read on every answer. A service it names is answered from it,
   * with no lookup, since a daemon may answer no embedded DNS.
   */
  map?: string
  /** The addresses of a compose service, as the stack's own resolver gives them: the fallback for a service the map does not name yet. */
  resolveService?: (service: string) => Promise<string[]>
  /** Where each record line goes: the sink's stdout, which the run reads with `compose logs`. */
  write: (line: string) => void
  maxEntries?: number
}

export interface DnsSink {
  address: string
  port: number
  stop: () => Promise<void>
}

/** A name as a resolver asks it: lower case, no trailing dot. */
function normalize(name: string): string {
  return name.toLowerCase().replace(/\.$/, '')
}

/** The service that provides a host, by an exact declaration or a `*.` one a single label above it. */
export function serviceFor(host: string, hosts: Readonly<Record<string, string>>): string | undefined {
  for (const [declared, service] of Object.entries(hosts)) {
    const name = normalize(declared)
    if (name.startsWith('*.')) {
      const suffix = name.slice(1)
      if (host.endsWith(suffix)) {
        const prefix = host.slice(0, host.length - suffix.length)
        if (prefix !== '' && !prefix.includes('.')) return service
      }
    } else if (host === name) return service
  }
  return undefined
}

/** A reply to a question: the question echoed, the rcode, and an A record per address. */
function reply(query: DnsQuestion, rcode: number, addresses: string[]): Buffer {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(query.id, 0)
  // A response, recursion available, with the asker's own recursion bit.
  header.writeUInt16BE(0x8080 | (query.recursionDesired ? 0x0100 : 0) | rcode, 2)
  header.writeUInt16BE(1, 4)
  header.writeUInt16BE(addresses.length, 6)
  const answers = addresses.map((address) => {
    const record = Buffer.alloc(16)
    // A pointer to the question's name, type A, class IN, a short time to live, four bytes.
    record.writeUInt16BE(0xc00c, 0)
    record.writeUInt16BE(DNS_TYPE_A, 2)
    record.writeUInt16BE(CLASS_IN, 4)
    record.writeUInt32BE(ANSWER_TTL_SECONDS, 6)
    record.writeUInt16BE(4, 10)
    address.split('.').forEach((octet, index) => (record[12 + index] = Number(octet)))
    return record
  })
  return Buffer.concat([header, query.question, ...answers])
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

async function defaultResolveService(service: string): Promise<string[]> {
  const found = await lookup(service, { all: true, family: 4 })
  return found.map((entry) => entry.address)
}

/** The sink's own address on the stack's network: the one interface a container on it has. */
export function ownAddress(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) if (entry.family === 'IPv4' && !entry.internal) return entry.address
  }
  return undefined
}

/** The addresses the map names for a service, or undefined when the map is absent, unreadable or silent on it. */
async function mapped(map: string | undefined, service: string): Promise<string[] | undefined> {
  if (map === undefined) return undefined
  try {
    const parsed = JSON.parse(await readFile(map, 'utf8')) as Record<string, unknown>
    const found = parsed[service]
    return Array.isArray(found) ? found.filter((address): address is string => typeof address === 'string' && IPV4.test(address)) : undefined
  } catch {
    return undefined
  }
}

export async function startDnsSink(opts: DnsSinkOptions): Promise<DnsSink> {
  const fallback = opts.resolveService ?? defaultResolveService
  const resolveService = async (service: string): Promise<string[]> => (await mapped(opts.map, service)) ?? fallback(service)
  const max = opts.maxEntries ?? DEFAULT_MAX_ENTRIES
  const seen = new Set<string>()
  let capped = false
  const record = (host: string, declared: boolean): void => {
    if (seen.has(host)) return
    if (seen.size >= max) {
      if (!capped) opts.write(JSON.stringify({ event: 'capped' }))
      capped = true
      return
    }
    seen.add(host)
    opts.write(JSON.stringify({ event: 'lookup', host, declared }))
  }
  const socket: UdpSocket = createSocket('udp4')
  const answer = async (message: Buffer, from: RemoteInfo): Promise<void> => {
    const question = readDnsQuestion(message)
    if (question === undefined) return
    // A name that is not a host name is never written to the record as itself.
    const host = question.name
    const service = host === undefined ? undefined : serviceFor(host, opts.hosts)
    record(host ?? 'invalid', service !== undefined)
    let out: Buffer
    if (service === undefined) out = reply(question, RCODE_NXDOMAIN, [])
    else if (question.type !== DNS_TYPE_A) out = reply(question, 0, [])
    else {
      const addresses = await resolveService(service).then(
        (found) => found.filter((address) => IPV4.test(address)),
        () => undefined,
      )
      out = addresses === undefined || addresses.length === 0 ? reply(question, RCODE_SERVFAIL, []) : reply(question, 0, addresses)
    }
    socket.send(out, from.port, from.address)
  }
  socket.on('message', (message, from) => void answer(message, from).catch(() => {}))
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(opts.port ?? 53, opts.bind ?? '0.0.0.0', () => {
      socket.off('error', reject)
      resolve()
    })
  })
  const bound = socket.address()
  return {
    address: bound.address,
    port: bound.port,
    stop: () => new Promise<void>((resolve) => socket.close(() => resolve())),
  }
}

/** Read the sink's log back: the lookups it recorded, once each, and nothing that is not the sink's own shape. */
export function parseSinkRecord(text: string): SinkRecord {
  const lookups = new Map<string, SinkLookup>()
  let address: string | undefined
  let capped = false
  for (const line of text.split('\n')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line.trim())
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const entry = parsed as Record<string, unknown>
    if (entry.event === 'ready' && typeof entry.address === 'string' && IPV4.test(entry.address)) address = entry.address
    else if (entry.event === 'capped') capped = true
    else if (entry.event === 'lookup' && typeof entry.host === 'string' && hostName(entry.host) === entry.host && typeof entry.declared === 'boolean') {
      if (!lookups.has(entry.host)) lookups.set(entry.host, { host: entry.host, declared: entry.declared })
    }
  }
  return { ...(address === undefined ? {} : { address }), lookups: [...lookups.values()], capped }
}

export interface RelayForward {
  listen: number
  host: string
  port: number
}

export interface Relay {
  ports: number[]
  stop: () => Promise<void>
}

/** Carry each connection on a listening port to the service inside, and nothing else. */
export async function startRelay(opts: { forwards: readonly RelayForward[]; bind?: string }): Promise<Relay> {
  const servers: Server[] = []
  const open = new Set<Socket>()
  for (const forward of opts.forwards) {
    const server = createServer((inbound) => {
      open.add(inbound)
      inbound.on('close', () => open.delete(inbound))
      const outbound = connect({ host: forward.host, port: forward.port, timeout: DIAL_TIMEOUT_MS })
      open.add(outbound)
      outbound.on('close', () => open.delete(outbound))
      outbound.once('connect', () => outbound.setTimeout(0))
      outbound.once('timeout', () => outbound.destroy())
      const close = (): void => {
        inbound.destroy()
        outbound.destroy()
      }
      inbound.on('error', close)
      outbound.on('error', close)
      inbound.pipe(outbound)
      outbound.pipe(inbound)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(forward.listen, opts.bind ?? '0.0.0.0', () => {
        server.off('error', reject)
        resolve()
      })
    })
    servers.push(server)
  }
  return {
    ports: servers.map((server) => (server.address() as AddressInfo).port),
    stop: async () => {
      for (const socket of open) socket.destroy()
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
    },
  }
}

/** Where a command's signals arrive: the process, or a test's stand-in. */
interface SignalSource {
  on(event: string, listener: () => void): unknown
  off(event: string, listener: () => void): unknown
}

const STOP_SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP']

function untilSignalled(signals: SignalSource): Promise<void> {
  return new Promise((resolve) => {
    const stop = (): void => {
      for (const signal of STOP_SIGNALS) signals.off(signal, stop)
      resolve()
    }
    for (const signal of STOP_SIGNALS) signals.on(signal, stop)
  })
}

/** A compose service name: a plain name, never a path or a flag. */
const SERVICE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * `qare cell egress-dns-map --map <file> --service <service>=<address>,...`
 * (#408): the run execs it in the sink's container once the stub services
 * are up, to hand the sink their addresses. The file is written beside
 * itself and renamed over, so the sink never reads half of it.
 */
async function writeServiceMap(map: string | undefined, entries: string[], who: string, io: { err: (line: string) => void }): Promise<number> {
  if (map === undefined || !isAbsolute(map)) {
    io.err(`${who}: --map must be an absolute path`)
    return 4
  }
  const services: Record<string, string[]> = {}
  for (const entry of entries) {
    const at = entry.indexOf('=')
    const service = at === -1 ? '' : entry.slice(0, at)
    const addresses = at === -1 ? [] : entry.slice(at + 1).split(',')
    if (!SERVICE.test(service) || addresses.length === 0 || !addresses.every((address) => IPV4.test(address))) {
      io.err(`${who}: ${JSON.stringify(entry)} is not a <compose service>=<address>[,<address>] entry`)
      return 4
    }
    services[service] = addresses
  }
  const partial = `${map}.${process.pid}.partial`
  try {
    await writeFile(partial, `${JSON.stringify(services)}\n`, { mode: 0o600 })
    await rename(partial, map)
  } catch (error) {
    io.err(`${who}: could not write ${map}: ${(error as Error).message}`)
    return 4
  }
  return 0
}

/**
 * `qare cell egress-dns --host <host>=<service>...` and `qare cell
 * egress-relay --forward <port>=<service>:<port>...` (#382). Each prints one
 * ready line and runs until it is signalled. Exit 4 is a call that was not
 * understood, as elsewhere in the CLI.
 */
export async function runEgressCommand(
  verb: 'egress-dns' | 'egress-relay' | 'egress-dns-map',
  flags: string[],
  io: { out: (line: string) => void; err: (line: string) => void; signals: SignalSource },
): Promise<number> {
  const values = (name: string): string[] => flags.flatMap((flag, index) => (flag === name && flags[index + 1] !== undefined ? [flags[index + 1] as string] : []))
  const who = `qare cell ${verb}`
  if (verb === 'egress-dns-map') return writeServiceMap(values('--map')[0], values('--service'), who, io)
  const bind = values('--bind')[0]
  if (verb === 'egress-dns') {
    const hosts: Record<string, string> = {}
    for (const entry of values('--host')) {
      const at = entry.indexOf('=')
      const host = at === -1 ? '' : entry.slice(0, at)
      const service = at === -1 ? '' : entry.slice(at + 1)
      if (hostName(host.replace(/^\*\./, '')) === undefined || !SERVICE.test(service)) {
        io.err(`${who}: ${JSON.stringify(entry)} is not a <host>=<compose service> stub`)
        return 4
      }
      hosts[host] = service
    }
    const port = values('--port')[0] === undefined ? 53 : Number(values('--port')[0])
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      io.err(`${who}: --port must be a port`)
      return 4
    }
    const map = values('--map')[0]
    if (map !== undefined && !isAbsolute(map)) {
      io.err(`${who}: --map must be an absolute path`)
      return 4
    }
    let sink: DnsSink
    try {
      sink = await startDnsSink({ hosts, port, ...(bind === undefined ? {} : { bind }), ...(map === undefined ? {} : { map }), write: io.out })
    } catch (error) {
      io.err(`${who}: could not start: ${(error as Error).message}`)
      return 4
    }
    io.out(JSON.stringify({ event: 'ready', address: bind ?? ownAddress() ?? sink.address, port: sink.port }))
    await untilSignalled(io.signals)
    await sink.stop()
    return 0
  }
  const forwards: RelayForward[] = []
  for (const entry of values('--forward')) {
    const match = /^(\d+)=([^:]+):(\d+)$/.exec(entry)
    const listen = Number(match?.[1])
    const port = Number(match?.[3])
    const carried = (value: number): boolean => Number.isInteger(value) && value > 0 && value <= 65_535
    if (match === null || !SERVICE.test(match[2] as string) || !carried(listen) || !carried(port)) {
      io.err(`${who}: ${JSON.stringify(entry)} is not a <port>=<service>:<port> forward`)
      return 4
    }
    forwards.push({ listen, host: match[2] as string, port })
  }
  if (forwards.length === 0) {
    io.err(`${who}: no --forward <port>=<service>:<port> to carry`)
    return 4
  }
  let relay: Relay
  try {
    relay = await startRelay({ forwards, ...(bind === undefined ? {} : { bind }) })
  } catch (error) {
    io.err(`${who}: could not start: ${(error as Error).message}`)
    return 4
  }
  io.out(JSON.stringify({ event: 'ready', ports: relay.ports }))
  await untilSignalled(io.signals)
  await relay.stop()
  return 0
}
