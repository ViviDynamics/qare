import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, connect } from 'node:net'
import { createSocket } from 'node:dgram'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import './source.mjs'

// The core's own YAML reader, as the core's package resolves it.
const { parse } = createRequire(new URL('../../packages/core/package.json', import.meta.url))('yaml')

// Executable checks of a contained stack that pins its addresses (#408), run
// against the checkout's core source without a build. There is no docker
// daemon here: compose is a stand-in that records each call, and docker is
// a stand-in that describes each container with its address on the
// contained network. Nothing here resolves a service name, which is the
// daemon the fix is for. Each check prints what it observed, one statement
// per line. Scratch is restricted to .qa/checks/scratch.

const core = (file) => import(`../../packages/core/src/${file}`)
await core('run.ts')
const scratch = fileURLToPath(new URL('./scratch/', import.meta.url))
mkdirSync(scratch, { recursive: true })
const HEALTH = ['http:', '//localhost:3000/up'].join('')
const IMAGE = 'ghcr.io/vividynamics/qare-core:2026.11.24'
const READY = '{"event":"ready","address":"198.18.0.2","port":53}'
const STUBS = [{ service: 'billing', hosts: ['api.billing-vendor.example'], provided_by: { compose_service: 'billing-stub' } }]
// compose config of examples/pinned-app: web declares no network (compose lists its implicit default as null), db and the stub are pinned.
const PINNED = {
  networks: { default: { name: 'x_default', ipam: { config: [{ subnet: '198.18.89.0/24' }] } } },
  services: {
    web: { extra_hosts: ['db=198.18.89.10', 'billing-stub=198.18.89.20'], networks: { default: null }, ports: [{ target: 3000, published: '3000', host_ip: '127.0.0.1', protocol: 'tcp' }] },
    db: { networks: { default: { ipv4_address: '198.18.89.10' } } },
    'billing-stub': { networks: { default: { ipv4_address: '198.18.89.20' } } },
  },
}
const say = (line) => console.log(line)

function compose(answers = {}) {
  const calls = []
  return {
    calls,
    runCompose: async (args) => {
      const files = Object.fromEntries(args.filter((arg) => arg.endsWith('.yml') && existsSync(arg)).map((arg) => [arg.split('/').pop(), readFileSync(arg, 'utf8')]))
      calls.push({ args, files })
      if (args.includes('config')) return { code: 0, stdout: JSON.stringify(PINNED), stderr: '' }
      if (args.includes('logs')) return { code: 0, stdout: READY, stderr: '' }
      if (args.includes('down')) return { code: answers.down ?? 0, stdout: '', stderr: answers.down ? 'daemon gone' : '' }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
}

/** A docker stand-in: `addresses` is each service's address on the contained network, undefined for none. */
function daemon(addresses) {
  const calls = []
  return {
    calls,
    runDocker: async (args) => {
      calls.push(args)
      const project = (args.find((arg) => arg.startsWith('label=com.docker.compose.project=')) ?? '').split('=')[2]
      if (args[0] === 'ps') return { code: 0, stdout: Object.keys(addresses).map((service) => `${project}/${service}`).join('\n'), stderr: '' }
      const described = args.slice(1).map((id) => {
        const [owner, service] = id.split('/')
        const address = addresses[service]
        return { Config: { Labels: { 'com.docker.compose.project': owner, 'com.docker.compose.service': service } }, NetworkSettings: { Networks: address === undefined ? {} : { [`${owner}_qare-contained`]: { IPAddress: address } } } }
      })
      return { code: 0, stdout: JSON.stringify(described), stderr: '' }
    },
  }
}

const profile = () => ({
  app: { boot: { compose: 'compose.qa.yaml', service: 'web' }, health: { http: HEALTH, timeout: '5s' }, seed: { command: 'true' }, login: { fixture: 'f.yml', role: 'admin' } },
  stubs: STUBS,
  visual: { widths: [], themes: [] },
  suites: [],
})
const ALL = { 'qare-egress-dns': '198.18.0.2', 'billing-stub': '198.18.0.3', db: '198.18.0.5', web: '198.18.0.4' }
const verbs = (calls, project) => calls.map((call) => call.args.filter((arg) => !arg.endsWith('.yml') && arg !== '-f' && arg !== '-p' && arg !== project).join(' '))

function ask(port, name) {
  const labels = name.split('.').map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]))
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0x4242, 0)
  header.writeUInt16BE(0x0100, 2)
  header.writeUInt16BE(1, 4)
  const tail = Buffer.from([0, 1, 0, 1])
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4')
    const timer = setTimeout(() => (socket.close(), reject(new Error('no answer'))), 2000)
    socket.on('message', (reply) => {
      clearTimeout(timer)
      socket.close()
      let at = 12
      while (reply[at] !== 0) at += reply[at] + 1
      at += 5
      const addresses = []
      for (let index = 0; index < reply.readUInt16BE(6); index += 1) {
        addresses.push([...reply.subarray(at + 12, at + 16)].join('.'))
        at += 16
      }
      resolve({ rcode: reply[3] & 0x0f, addresses })
    })
    socket.send(Buffer.concat([header, ...labels, Buffer.from([0]), tail]), port, '127.0.0.1')
  })
}

const check = process.argv[2]
const dir = await mkdtemp(join(scratch, 'pinned-stack-'))
try {
  if (check === 'merge') {
    // The containment override for the pinned stack, and the stack's own networks merged under it by key, as compose merges them.
    const { containmentOf } = await core('stack-egress.ts')
    const plan = containmentOf(PINNED, { image: IMAGE, stubs: STUBS })
    assert.equal(plan.kind, 'contained')
    const override = parse(plan.override, { logLevel: 'error' })
    for (const [name, service] of Object.entries(PINNED.services)) {
      const own = service.networks ?? {}
      const added = override.services[name].networks
      const merged = Object.fromEntries([...new Set([...Object.keys(own), ...Object.keys(added)])].map((key) => [key, { ...(own[key] ?? {}), ...added[key] }]))
      say(`service ${name}: declared networks ${JSON.stringify(own)}; override networks ${JSON.stringify(added)}; merged ${JSON.stringify(merged)}`)
      assert.ok('default' in merged && 'qare-contained' in merged)
    }
    assert.deepEqual(override.services.web.networks, { default: {}, 'qare-contained': {} })
    say(`web, which declares no network, keeps default: ${'default' in override.services.web.networks}`)
    say(`db keeps ipv4_address 198.18.89.10 on default after the merge: ${JSON.stringify({ ...PINNED.services.db.networks.default, ...override.services.db.networks.default })}`)
    say(`top-level networks in the override: ${JSON.stringify(override.networks)}`)
    say(`stub services whose addresses the resolver is handed: ${JSON.stringify(plan.stubServices)}`)
  } else if (check === 'boot') {
    // bootApp against a daemon that resolves no service name: every address comes from docker inspect.
    const { bootApp, stopApp } = await core('boot.ts')
    const { isolateRun } = await core('isolation.ts')
    const isolation = await isolateRun()
    const stack = compose()
    const docker = daemon(ALL)
    const outcome = await bootApp(profile(), { runCompose: stack.runCompose, runDocker: docker.runDocker, probe: async () => ({ ok: true }), pollIntervalMs: 1, isolation, egressImage: IMAGE })
    assert.equal(outcome.kind, 'up')
    assert.deepEqual(outcome.egress, { containment: 'contained' })
    const relay = stack.calls.at(-1).files[`${isolation.project}.egress-relay.yml`]
    const first = stack.calls.find((call) => call.args.includes('config') === false && Object.keys(call.files).length > 0).files[`${isolation.project}.egress.yml`]
    assert.match(relay, /"--forward","20000=198\.18\.0\.4:3000"/)
    say(`boot outcome: ${outcome.kind}, egress ${JSON.stringify(outcome.egress)}`)
    for (const [index, line] of verbs(stack.calls, isolation.project).entries()) say(`compose call ${index + 1}: ${line}`)
    for (const [index, args] of docker.calls.entries()) say(`docker call ${index + 1}: ${args.join(' ')}`)
    say(`resolver command in the containment override: ${JSON.stringify(parse(first, { logLevel: 'error' }).services['qare-egress-dns'].command)}`)
    say(`relay command in the relay override: ${JSON.stringify(parse(relay, { logLevel: 'error' }).services['qare-egress-relay'].command)}`)
    stack.calls.length = 0
    await stopApp(profile(), { runCompose: stack.runCompose, isolation })
    say(`the down names: ${JSON.stringify(stack.calls[0].args.map((arg) => (arg.startsWith('/') ? arg.split('/').pop() : arg)))}`)
  } else if (check === 'uncontained') {
    // An address the run needs that the daemon does not give: the stack is taken down and boots as it is, with the reason.
    const { bootApp } = await core('boot.ts')
    const { isolateRun } = await core('isolation.ts')
    for (const [label, addresses, answers] of [
      ['stub without an address', { ...ALL, 'billing-stub': undefined }, {}],
      ['app without an address', { ...ALL, web: undefined }, {}],
      ['stub without an address, and a down that fails', { ...ALL, 'billing-stub': undefined }, { down: 1 }],
    ]) {
      const isolation = await isolateRun()
      const stack = compose(answers)
      const outcome = await bootApp(profile(), { runCompose: stack.runCompose, runDocker: daemon(addresses).runDocker, probe: async () => ({ ok: true }), pollIntervalMs: 1, isolation, egressImage: IMAGE })
      say(`${label}: outcome ${outcome.kind}, egress ${JSON.stringify(outcome.egress ?? null)}${outcome.kind === 'blocked' ? `, reason ${outcome.reason}` : ''}`)
      say(`${label}: last compose calls ${JSON.stringify(verbs(stack.calls, isolation.project).slice(-2))}`)
      say(`${label}: relay started ${stack.calls.some((call) => call.args.includes('qare-egress-relay'))}`)
    }
  } else if (check === 'sink') {
    // The checkout's real resolver and relay commands on loopback, where the stub's service name resolves nowhere.
    const { runCellCommand } = await core('cell-launch.ts')
    const map = join(dir, 'services.json')
    const out = []
    const signals = new EventEmitter()
    const sinking = runCellCommand(['egress-dns', '--port', '0', '--bind', '127.0.0.1', '--map', map, '--host', 'api.billing-vendor.example=qare-no-such-service-408'], { out: (line) => out.push(line), err: () => {}, signals })
    while (out.length === 0) await new Promise((resolve) => setTimeout(resolve, 10))
    const port = JSON.parse(out[0]).port
    const before = await ask(port, 'api.billing-vendor.example')
    const mapped = await runCellCommand(['egress-dns-map', '--map', map, '--service', 'qare-no-such-service-408=198.18.0.3'], { out: () => {}, err: (line) => say(line) })
    const after = await ask(port, 'api.billing-vendor.example')
    signals.emit('SIGTERM')
    await sinking
    assert.equal(after.rcode, 0)
    say(`before the map: api.billing-vendor.example answered rcode ${before.rcode} (the service name resolves nowhere)`)
    say(`qare cell egress-dns-map exited ${mapped}; the map holds ${readFileSync(map, 'utf8').trim()}`)
    say(`after the map: api.billing-vendor.example answered rcode ${after.rcode} with ${after.addresses.join(',')}`)
    const app = createServer((socket) => socket.end('from the app by address'))
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve))
    const free = createServer()
    await new Promise((resolve) => free.listen(0, '127.0.0.1', resolve))
    const listen = free.address().port
    await new Promise((resolve) => free.close(resolve))
    const relayOut = []
    const relaySignals = new EventEmitter()
    const relaying = runCellCommand(['egress-relay', '--bind', '127.0.0.1', '--forward', `${listen}=127.0.0.1:${app.address().port}`], { out: (line) => relayOut.push(line), err: () => {}, signals: relaySignals })
    while (relayOut.length === 0) await new Promise((resolve) => setTimeout(resolve, 10))
    const got = await new Promise((resolve, reject) => {
      let text = ''
      const socket = connect(listen, '127.0.0.1')
      socket.on('data', (chunk) => (text += chunk))
      socket.on('end', () => resolve(text))
      socket.on('error', reject)
    })
    relaySignals.emit('SIGTERM')
    await relaying
    await new Promise((resolve) => app.close(resolve))
    assert.equal(got, 'from the app by address')
    say(`the relay forwarding to the address 127.0.0.1, with no name to look up, carried: ${got}`)
  } else if (check === 'ci') {
    // Where the real boot is proven: the CI step, the example's pinned stack, and what its script holds the run to.
    const at = (lines, text) => lines.findIndex((line) => line.includes(text))
    const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8').split('\n')
    const step = at(ci, 'Prove a contained stack keeps its pinned addresses')
    assert.ok(step >= 0)
    say(`.github/workflows/ci.yml:${step + 1}: ${ci[step].trim()}`)
    const run = at(ci, 'scripts/pinned-boot.sh qare-core:ci')
    say(`.github/workflows/ci.yml:${run + 1}: ${ci[run].trim()}`)
    const example = readFileSync(new URL('../../examples/pinned-app/compose.yaml', import.meta.url), 'utf8').split('\n')
    for (const text of ['subnet: 198.18.89.0/24', '"db:198.18.89.10"', 'ipv4_address: 198.18.89.10', 'ipv4_address: 198.18.89.20']) {
      const line = at(example, text)
      assert.ok(line >= 0, text)
      say(`examples/pinned-app/compose.yaml:${line + 1}: ${example[line].trim()}`)
    }
    const config = readFileSync(new URL('../../examples/pinned-app/.qa/config.yml', import.meta.url), 'utf8').split('\n')
    const seed = at(config, 'seed:')
    say(`examples/pinned-app/.qa/config.yml:${seed + 1}: ${config[seed].trim()}`)
    const script = readFileSync(new URL('../../scripts/pinned-boot.sh', import.meta.url), 'utf8').split('\n')
    for (const text of ['.verdict == "passed"', '.egress.containment == "contained"', '([.criteria[] | .outcome == "proven"] | all)', 'select($cmd[.] == "--forward")', '.["billing-stub"] | length > 0', 'endswith("_default")) and any', 'left="$(running)$(networks)"']) {
      const line = at(script, text)
      assert.ok(line >= 0, text)
      say(`scripts/pinned-boot.sh:${line + 1}: ${script[line].trim()}`)
    }
  } else {
    throw new Error(`unknown check ${JSON.stringify(check)}: merge, boot, uncontained, sink or ci`)
  }
} finally {
  await rm(dir, { recursive: true, force: true })
}
