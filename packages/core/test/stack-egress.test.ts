import { describe, expect, test } from 'vitest'
import { parse } from 'yaml'
import { containmentOf, dnsOverride, EGRESS_DNS_SERVICE, EGRESS_RELAY_SERVICE, CONTAINED_NETWORK, INGRESS_NETWORK } from '../src/stack-egress.js'

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
    expect(override.services.web).toEqual({ networks: { [CONTAINED_NETWORK]: {} }, ports: [] })
    expect(override.services.mailpit).toEqual({ networks: { [CONTAINED_NETWORK]: {} }, ports: [] })
    expect(override.services[EGRESS_DNS_SERVICE]).toMatchObject({
      image: IMAGE,
      command: ['qare', 'cell', 'egress-dns', '--host', 'api.billing-vendor.example=billing-stub', '--host', '*.cdn.billing-vendor.example=billing-stub'],
      networks: { [CONTAINED_NETWORK]: {} },
      cap_drop: ['ALL'],
    })
    expect(override.services[EGRESS_RELAY_SERVICE]).toMatchObject({
      image: IMAGE,
      command: ['qare', 'cell', 'egress-relay', '--forward', '20000=web:3000'],
      networks: { [CONTAINED_NETWORK]: {}, [INGRESS_NETWORK]: {} },
      ports: [{ target: 20000, published: '41234', host_ip: '127.0.0.1', protocol: 'tcp' }],
      cap_drop: ['ALL'],
    })
    expect(plan.services).toEqual(['web', 'mailpit'])
  })

  test('the second override points every service of the stack at the sink, replacing any resolver it named', () => {
    const text = dnsOverride(['web', 'mailpit'], '192.0.2.2')
    const override = parse(text, { logLevel: 'error' })
    expect(override).toEqual({ services: { web: { dns: ['192.0.2.2'] }, mailpit: { dns: ['192.0.2.2'] } } })
    expect(text).toContain('dns: !override')
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
