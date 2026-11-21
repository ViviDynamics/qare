import { describe, expect, test } from 'vitest'
import { parse } from 'yaml'
import { containedAddresses, containmentOf, dnsOverride, EGRESS_DNS_SERVICE, EGRESS_MAP_FILE, EGRESS_RELAY_SERVICE, CONTAINED_NETWORK, INGRESS_NETWORK, relayOverride } from '../src/stack-egress.js'

const IMAGE = 'ghcr.io/vividynamics/qare-core:2026.11.21'

/** `compose config --format json` of a mail app: the app publishes its port, the catcher publishes none. */
const mailStack = {
  name: 'qare-run',
  networks: { default: { name: 'qare-run_default', ipam: {} } },
  services: {
    web: {
      networks: { default: null },
      ports: [{ mode: 'ingress', host_ip: '127.0.0.1', target: 3000, published: '41234', protocol: 'tcp' }],
    },
    mailpit: { networks: { default: null } },
  },
}

const stubs = [{ service: 'billing', hosts: ['api.billing-vendor.example', '*.cdn.billing-vendor.example'], provided_by: { compose_service: 'billing-stub' } }]

describe('the containment of a booted stack (#382)', () => {
  test('every network goes internal, every service joins the contained network, and the published ports move to the relay', () => {
    const plan = containmentOf(mailStack, { image: IMAGE, stubs })
    if (plan.kind !== 'contained') throw new Error(plan.reason)
    // compose reads !reset as "drop what the stack's own file said"; YAML reads the empty list under it.
    expect(plan.override.match(/ports: !reset \[\]/g)).toHaveLength(2)
    const override = parse(plan.override, { logLevel: 'error' })
    expect(override.networks).toEqual({
      default: { internal: true },
      [CONTAINED_NETWORK]: { internal: true },
      [INGRESS_NETWORK]: {},
    })
    // Each service keeps the networks it had and joins the contained one besides (#408).
    expect(override.services.web).toEqual({ networks: { default: {}, [CONTAINED_NETWORK]: {} }, ports: [] })
    expect(override.services.mailpit).toEqual({ networks: { default: {}, [CONTAINED_NETWORK]: {} }, ports: [] })
    expect(override.services[EGRESS_DNS_SERVICE]).toMatchObject({
      image: IMAGE,
      command: ['qare', 'cell', 'egress-dns', '--map', EGRESS_MAP_FILE, '--host', 'api.billing-vendor.example=billing-stub', '--host', '*.cdn.billing-vendor.example=billing-stub'],
      networks: { [CONTAINED_NETWORK]: {} },
      tmpfs: ['/run/qare-egress'],
      cap_drop: ['ALL'],
    })
    // The relay's forwards name addresses, written once the stack is up (#408): here it has none yet.
    expect(override.services[EGRESS_RELAY_SERVICE]).toMatchObject({
      image: IMAGE,
      networks: { [CONTAINED_NETWORK]: {}, [INGRESS_NETWORK]: {} },
      ports: [{ target: 20000, published: '41234', host_ip: '127.0.0.1', protocol: 'tcp' }],
      cap_drop: ['ALL'],
    })
    expect(override.services[EGRESS_RELAY_SERVICE].command).toBeUndefined()
    expect(plan.services).toEqual(['web', 'mailpit'])
    expect(plan.forwards).toEqual([{ listen: 20000, service: 'web', target: 3000 }])
    expect(plan.stubServices).toEqual([])
  })

  test('a service with no declared networks keeps the implicit default beside one with a static address on a custom subnet (#408)', () => {
    // compose config of a stack like a pinned-address one: db is pinned on the default network's own subnet,
    // web declares no network and reaches db through extra_hosts; compose lists web's implicit default as null.
    const pinned = {
      name: 'qare-run',
      networks: { default: { name: 'qare-run_default', ipam: { config: [{ subnet: '198.18.89.0/24' }] } } },
      services: {
        web: { extra_hosts: ['db=198.18.89.10'], networks: { default: null }, ports: [{ target: 3000, published: '41234', protocol: 'tcp' }] },
        db: { networks: { default: { ipv4_address: '198.18.89.10' } } },
        'billing-stub': { networks: { default: { ipv4_address: '198.18.89.20' }, backend: { aliases: ['billing'] } } },
        worker: {},
      },
    }
    const plan = containmentOf(pinned, { image: IMAGE, stubs })
    if (plan.kind !== 'contained') throw new Error(plan.reason)
    const override = parse(plan.override, { logLevel: 'error' })
    expect(override.services.web.networks).toEqual({ default: {}, [CONTAINED_NETWORK]: {} })
    expect(override.services.db.networks).toEqual({ default: {}, [CONTAINED_NETWORK]: {} })
    expect(override.services['billing-stub'].networks).toEqual({ default: {}, backend: {}, [CONTAINED_NETWORK]: {} })
    // A service compose lists with no networks at all is on the default one.
    expect(override.services.worker.networks).toEqual({ default: {}, [CONTAINED_NETWORK]: {} })
    // A network a service joins is made internal even where the top level does not list it.
    expect(override.networks).toEqual({ default: { internal: true }, backend: { internal: true }, [CONTAINED_NETWORK]: { internal: true }, [INGRESS_NETWORK]: {} })
    expect(plan.stubServices).toEqual(['billing-stub'])
  })

  test('the override merged over the stack keeps every network setting a service had (#408)', () => {
    // compose merges service networks by key, and an empty mapping adds nothing to the key it merges into.
    const stack = { default: { ipv4_address: '198.18.89.10' } }
    const plan = containmentOf({ services: { db: { networks: stack } } }, { image: IMAGE, stubs: [] })
    if (plan.kind !== 'contained') throw new Error(plan.reason)
    const added = parse(plan.override, { logLevel: 'error' }).services.db.networks as Record<string, object>
    const merged = Object.fromEntries([...new Set([...Object.keys(stack), ...Object.keys(added)])].map((key) => [key, { ...(stack as Record<string, object>)[key], ...added[key] }]))
    expect(merged).toEqual({ default: { ipv4_address: '198.18.89.10' }, [CONTAINED_NETWORK]: {} })
  })

  test('the relay override carries each forward to the address the run found, and skips a service that is not running (#408)', () => {
    const forwards = [
      { listen: 20000, service: 'web', target: 3000 },
      { listen: 20001, service: 'admin', target: 4000 },
    ]
    const relay = relayOverride(forwards, { web: ['198.18.0.4'] })
    if (!('override' in relay)) throw new Error(relay.missing)
    expect(parse(relay.override, { logLevel: 'error' })).toEqual({
      services: { [EGRESS_RELAY_SERVICE]: { command: ['qare', 'cell', 'egress-relay', '--forward', '20000=198.18.0.4:3000'] } },
    })
    expect(relay.override).toContain('command: !override')
    expect(relayOverride(forwards, { web: [] })).toEqual({ missing: 'web' })
    expect(relayOverride(forwards, {})).toEqual({ override: undefined })
  })

  test("the addresses are read from docker inspect on the run's contained network, by compose service (#408)", () => {
    const container = (service: string, project: string, networks: Record<string, { IPAddress?: string }>) => ({
      Config: { Labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': service } },
      NetworkSettings: { Networks: networks },
    })
    const inspect = JSON.stringify([
      container('web', 'qare-run', { 'qare-run_default': { IPAddress: '198.18.89.2' }, [`qare-run_${CONTAINED_NETWORK}`]: { IPAddress: '198.18.0.4' } }),
      container('billing-stub', 'qare-run', { [`qare-run_${CONTAINED_NETWORK}`]: { IPAddress: '198.18.0.3' } }),
      container('billing-stub', 'qare-run', { [`qare-run_${CONTAINED_NETWORK}`]: { IPAddress: '198.18.0.5' } }),
      container('db', 'qare-run', { 'qare-run_default': { IPAddress: '198.18.89.10' } }),
      container('web', 'qare-other', { [`qare-other_${CONTAINED_NETWORK}`]: { IPAddress: '198.18.1.4' } }),
    ])
    expect(containedAddresses(inspect, 'qare-run')).toEqual({ web: ['198.18.0.4'], 'billing-stub': ['198.18.0.3', '198.18.0.5'], db: [] })
    expect(containedAddresses('not json', 'qare-run')).toBeUndefined()
  })

  test('the second override points every service of the stack at the sink, replacing any resolver it named', () => {
    const text = dnsOverride(['web', 'mailpit'], '192.0.2.2')
    const override = parse(text, { logLevel: 'error' })
    // No search domain either: the runner's own would turn one refused name into a second, the runner's (#382).
    expect(override).toEqual({ services: { web: { dns: ['192.0.2.2'], dns_search: ['.'] }, mailpit: { dns: ['192.0.2.2'], dns_search: ['.'] } } })
    expect(text).toContain('dns: !override')
    expect(text).toContain('dns_search: !override ["."]')
  })

  test('a service that shares another service network is contained by that one, and gets no network or resolver of its own', () => {
    const plan = containmentOf(
      { ...mailStack, services: { ...mailStack.services, sidecar: { network_mode: 'service:web' } } },
      { image: IMAGE, stubs: [] },
    )
    if (plan.kind !== 'contained') throw new Error(plan.reason)
    expect(plan.services).toEqual(['web', 'mailpit'])
    expect(plan.override).not.toContain('sidecar')
  })

  test('every value is written so compose interpolates none of it', () => {
    const plan = containmentOf(mailStack, { image: IMAGE, stubs: [{ service: 'x', hosts: ['a.example'], provided_by: { compose_service: 'st$ub' } }] })
    if (plan.kind !== 'contained') throw new Error(plan.reason)
    expect(plan.override).toContain('a.example=st$$ub')
  })

  test.each([
    [{ ...mailStack, services: { web: { network_mode: 'host' } } }, 'the service web runs with network_mode host, which no network of the stack can contain'],
    [{ ...mailStack, networks: { shared: { name: 'shared', external: true } } }, 'the stack joins the external network shared, which the run cannot make internal'],
    [
      { ...mailStack, services: { web: { networks: { default: null }, ports: [{ target: 53, published: '5353', protocol: 'udp' }] } } },
      'the service web publishes udp port 53, which the relay does not carry',
    ],
    [{ ...mailStack, services: { [EGRESS_DNS_SERVICE]: {} } }, `the stack has a service named ${EGRESS_DNS_SERVICE}, the name the run gives its own resolver`],
  ])('a stack the run cannot contain says why', (config, reason) => {
    expect(containmentOf(config, { image: IMAGE, stubs: [] })).toEqual({ kind: 'uncontained', reason })
  })

  test('with no image to run the sink from, nothing is contained, and the reason says so', () => {
    expect(containmentOf(mailStack, { image: '', stubs: [] })).toEqual({
      kind: 'uncontained',
      reason: 'the sink and the relay run from the image the run is in, and QARE_IMAGE_REF names none (the pipeline execute step sets it)',
    })
  })
})
