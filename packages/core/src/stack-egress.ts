import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProfileStub } from './profile.js'

/**
 * How a booted stack is contained (#382). The run reads the stack as compose
 * resolves it (`compose config --format json`) and writes an override that
 *
 * - makes every network of the stack internal, so nothing in it routes
 *   anywhere but to the stack's own services;
 * - joins every service to one more internal network, the contained one,
 *   where the sink answers names and the relay reaches every service;
 * - takes every published port off the service that published it and
 *   publishes it on the relay instead, which is on the contained network
 *   and on an ordinary one: docker publishes no port of an internal network.
 *
 * A second override, written once the sink is up and has said its address,
 * points every service's resolver at the sink. A stack that cannot be held
 * to this is not contained, and the reason says why, so the evidence never
 * calls it contained.
 */

/** The run's resolver for the stack: a stub host is a stub's address, any other name is recorded and refused. */
export const EGRESS_DNS_SERVICE = 'qare-egress-dns'
/** The stack's one way in: the published ports, carried to the services inside. */
export const EGRESS_RELAY_SERVICE = 'qare-egress-relay'
/** The internal network every service of the stack joins, with the sink and the relay. */
export const CONTAINED_NETWORK = 'qare-contained'
/** The ordinary network the relay publishes the stack's ports from. */
export const INGRESS_NETWORK = 'qare-ingress'
/** Where the relay listens for the first published port; each further port takes the next. */
export const RELAY_FIRST_PORT = 20_000

/** Why a stack booted where no image names the run's own is not contained. */
export const NO_EGRESS_IMAGE = 'the sink and the relay run from the image the run is in, and QARE_IMAGE_REF names none (the pipeline execute step sets it)'

/** Where the run writes a stack's containment override: named for the project, so no two runs share one. */
export function containmentOverrideFile(project: string): string {
  return join(tmpdir(), `${project}.egress.yml`)
}

/** Where the run writes the override that points the stack's resolvers at the sink. */
export function dnsOverrideFile(project: string): string {
  return join(tmpdir(), `${project}.egress-dns.yml`)
}

/** The part of `compose config --format json` the containment reads. */
export interface ComposeConfig {
  networks?: Record<string, { external?: unknown } | null> | null
  services?: Record<string, ComposeService | null> | null
}

interface ComposeService {
  network_mode?: unknown
  networks?: unknown
  ports?: unknown
}

interface PublishedPort {
  target?: unknown
  published?: unknown
  host_ip?: unknown
  protocol?: unknown
}

export type Containment =
  | {
      kind: 'contained'
      /** The first override, YAML. */
      override: string
      /** The services whose resolver the sink becomes: every one that has a network of its own. */
      services: string[]
    }
  | { kind: 'uncontained'; reason: string }

/** A string compose reads as itself: every `$` doubled, so nothing is interpolated. */
function literal(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll('$', '$$$$')
  if (Array.isArray(value)) return value.map(literal)
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [literal(key) as string, literal(entry)]))
  return value
}

/** One value as YAML: JSON, which YAML reads as the same value. */
function flow(value: unknown): string {
  return JSON.stringify(literal(value))
}

/** The containment of a stack, or why it cannot be contained. */
export function containmentOf(config: ComposeConfig, opts: { image: string; stubs: readonly ProfileStub[] }): Containment {
  if (opts.image === '') return { kind: 'uncontained', reason: NO_EGRESS_IMAGE }
  const services = Object.entries(config.services ?? {})
  for (const name of [EGRESS_DNS_SERVICE, EGRESS_RELAY_SERVICE])
    if (services.some(([service]) => service === name)) return { kind: 'uncontained', reason: `the stack has a service named ${name}, the name the run gives its own ${name === EGRESS_DNS_SERVICE ? 'resolver' : 'relay'}` }
  const networks = Object.entries(config.networks ?? {})
  for (const [name, network] of networks) {
    if (name === CONTAINED_NETWORK || name === INGRESS_NETWORK) return { kind: 'uncontained', reason: `the stack has a network named ${name}, a name the run gives its own` }
    if (network !== null && network.external !== undefined && network.external !== null && network.external !== false)
      return { kind: 'uncontained', reason: `the stack joins the external network ${name}, which the run cannot make internal` }
  }

  const joined: string[] = []
  const forwards: Array<{ listen: number; service: string; target: number; published?: string; host_ip?: string }> = []
  for (const [name, service] of services) {
    const mode = service?.network_mode
    if (typeof mode === 'string' && mode !== '') {
      // Sharing another service's network is being contained by it; none at all is contained already.
      if (mode === 'none' || mode.startsWith('service:')) continue
      return { kind: 'uncontained', reason: `the service ${name} runs with network_mode ${mode}, which no network of the stack can contain` }
    }
    joined.push(name)
    const ports = Array.isArray(service?.ports) ? (service.ports as PublishedPort[]) : []
    for (const port of ports) {
      const protocol = typeof port.protocol === 'string' ? port.protocol : 'tcp'
      const target = typeof port.target === 'number' ? port.target : Number(port.target)
      if (protocol !== 'tcp') return { kind: 'uncontained', reason: `the service ${name} publishes ${protocol} port ${String(port.target)}, which the relay does not carry` }
      if (!Number.isInteger(target) || target <= 0 || target > 65_535) return { kind: 'uncontained', reason: `the service ${name} publishes a port the relay cannot read: ${JSON.stringify(port.target)}` }
      const published = port.published === undefined || port.published === null || port.published === '' ? undefined : String(port.published)
      if (published !== undefined && !/^\d+$/.test(published)) return { kind: 'uncontained', reason: `the service ${name} publishes the port range ${published}, which the relay does not carry` }
      forwards.push({
        listen: RELAY_FIRST_PORT + forwards.length,
        service: name,
        target,
        ...(published === undefined ? {} : { published }),
        ...(typeof port.host_ip === 'string' && port.host_ip !== '' ? { host_ip: port.host_ip } : {}),
      })
    }
  }

  const hosts = opts.stubs.flatMap((stub) => stub.hosts.map((host) => `${host}=${stub.provided_by.compose_service}`))
  const hardened = { cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'], read_only: true, restart: 'no' }
  const lines = ['services:']
  for (const name of joined) lines.push(`  ${flow(name)}:`, `    networks: ${flow({ [CONTAINED_NETWORK]: {} })}`, '    ports: !reset []')
  lines.push(
    `  ${flow(EGRESS_DNS_SERVICE)}: ${flow({
      image: opts.image,
      command: ['qare', 'cell', 'egress-dns', ...hosts.flatMap((host) => ['--host', host])],
      networks: { [CONTAINED_NETWORK]: {} },
      ...hardened,
    })}`,
    `  ${flow(EGRESS_RELAY_SERVICE)}: ${flow({
      image: opts.image,
      command: ['qare', 'cell', 'egress-relay', ...forwards.flatMap((forward) => ['--forward', `${forward.listen}=${forward.service}:${forward.target}`])],
      networks: { [CONTAINED_NETWORK]: {}, [INGRESS_NETWORK]: {} },
      ports: forwards.map((forward) => ({
        target: forward.listen,
        ...(forward.published === undefined ? {} : { published: forward.published }),
        ...(forward.host_ip === undefined ? {} : { host_ip: forward.host_ip }),
        protocol: 'tcp',
      })),
      ...hardened,
    })}`,
    'networks:',
    ...networks.map(([name]) => `  ${flow(name)}: ${flow({ internal: true })}`),
    `  ${flow(CONTAINED_NETWORK)}: ${flow({ internal: true })}`,
    `  ${flow(INGRESS_NETWORK)}: {}`,
  )
  return { kind: 'contained', override: `${lines.join('\n')}\n`, services: joined }
}

/** The second override: every service resolves through the sink, at the address it said it answers on. */
export function dnsOverride(services: readonly string[], address: string): string {
  return `services:\n${services.map((name) => `  ${flow(name)}:\n    dns: !override ${flow([address])}\n`).join('')}`
}
