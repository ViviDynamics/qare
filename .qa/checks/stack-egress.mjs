import assert from 'node:assert/strict'
import { createSocket } from 'node:dgram'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import './source.mjs'

// Executable checks of a booted stack's egress containment (#382), run
// against the checkout's core source without a build. There is no docker
// daemon here, so compose is a stand-in that records each call, answers
// `config` with a stack and answers `logs` with what the stack's resolver
// recorded. The resolver itself is the checkout's real one, on loopback.
// Each check prints what it observed, one statement per line.
// Scratch is restricted to .qa/checks/scratch.

const core = (file) => import(`../../packages/core/src/${file}`)
// The run module first: it loads the core's modules in the order they expect.
await core('run.ts')
const scratch = fileURLToPath(new URL('./scratch/', import.meta.url))
mkdirSync(scratch, { recursive: true })
const HEALTH = ['http:', '//localhost:3000/up'].join('')
const IMAGE = 'ghcr.io/vividynamics/qare-core:2026.11.23'
const READY = '{"event":"ready","address":"192.0.2.2","port":53}'
const STUBS = [{ service: 'billing', hosts: ['api.billing-vendor.example'], provided_by: { compose_service: 'billing-stub' } }]
const CONFIG = JSON.stringify({
  networks: { default: { name: 'x_default' } },
  services: {
    web: { networks: { default: null }, ports: [{ target: 3000, published: '3000', host_ip: '127.0.0.1', protocol: 'tcp' }] },
    'billing-stub': { networks: { default: null } },
  },
})
const say = (line) => console.log(line)

/** A compose stand-in: records each call and the override files it names, answers config and the resolver's log. */
function compose(record = []) {
  const calls = []
  return {
    calls,
    runCompose: async (args) => {
      const files = args.filter((arg) => arg.endsWith('.yml') && existsSync(arg)).map((arg) => readFileSync(arg, 'utf8'))
      calls.push({ args, files })
      if (args.includes('config')) return { code: 0, stdout: CONFIG, stderr: '' }
      if (args.includes('logs')) return { code: 0, stdout: [READY, ...record].join('\n'), stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
}

const profile = (extra = {}) => ({
  app: { boot: { compose: 'compose.qa.yaml', service: 'web' }, health: { http: HEALTH, timeout: '5s' }, seed: { command: 'true' }, login: { fixture: 'f.yml', role: 'admin' } },
  stubs: STUBS,
  visual: { widths: [], themes: [] },
  suites: [],
  ...extra,
})

/** One DNS query on loopback, and the reply's rcode and A records. */
function ask(port, name, type = 1) {
  const labels = name.split('.').map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]))
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0x4242, 0)
  header.writeUInt16BE(0x0100, 2)
  header.writeUInt16BE(1, 4)
  const tail = Buffer.alloc(4)
  tail.writeUInt16BE(type, 0)
  tail.writeUInt16BE(1, 2)
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
const dir = await mkdtemp(join(scratch, 'stack-egress-'))
try {
  if (check === 'sink') {
    // The checkout's resolver, on loopback: a declared stub host answered with
    // the address of the service that provides it, anything else refused and
    // recorded once, and the record read back by the run's own parser.
    const { startDnsSink, parseSinkRecord } = await core('egress-sink.ts')
    const lines = [READY]
    const sink = await startDnsSink({ hosts: { 'api.billing-vendor.example': 'billing-stub', '*.cdn.example': 'billing-stub' }, port: 0, bind: '127.0.0.1', resolveService: async () => ['192.0.2.7'], write: (line) => lines.push(line) })
    const declared = await ask(sink.port, 'api.billing-vendor.example')
    const wildcard = await ask(sink.port, 'img.cdn.example')
    const undeclared = await ask(sink.port, 'api.stripe.com')
    await ask(sink.port, 'api.stripe.com')
    await sink.stop()
    assert.deepEqual(declared, { rcode: 0, addresses: ['192.0.2.7'] })
    assert.deepEqual(wildcard, { rcode: 0, addresses: ['192.0.2.7'] })
    assert.equal(undeclared.rcode, 3)
    const record = parseSinkRecord(lines.join('\n'))
    assert.deepEqual(record.lookups, [
      { host: 'api.billing-vendor.example', declared: true },
      { host: 'img.cdn.example', declared: true },
      { host: 'api.stripe.com', declared: false },
    ])
    say(`declared stub host api.billing-vendor.example answered rcode ${declared.rcode} with the stub service address ${declared.addresses.join(',')}`)
    say(`wildcard stub host img.cdn.example answered rcode ${wildcard.rcode} with ${wildcard.addresses.join(',')}`)
    say(`undeclared host api.stripe.com answered rcode ${undeclared.rcode} (NXDOMAIN), asked twice and recorded once`)
    say(`the record as the resolver wrote it: ${JSON.stringify(lines.slice(1))}`)
    say(`the record as the run reads it back: ${JSON.stringify(record)}`)
  } else if (check === 'boot') {
    // The checkout's bootApp with an image to run the resolver from: every
    // network internal, the ports moved to the relay, the resolver started
    // alone first, every service pointed at it with no search domain, and
    // the down naming the overrides so the resolver and relay go too.
    const { bootApp, stopApp } = await core('boot.ts')
    const { isolateRun } = await core('isolation.ts')
    const isolation = await isolateRun()
    const stack = compose()
    const outcome = await bootApp(profile(), { runCompose: stack.runCompose, probe: async () => ({ ok: true }), pollIntervalMs: 1, isolation, egressImage: IMAGE })
    assert.equal(outcome.kind, 'up')
    assert.deepEqual(outcome.egress, { containment: 'contained' })
    const verbs = stack.calls.map((call) => call.args.filter((arg) => !arg.startsWith('/') && arg !== '-f' && arg !== '-p' && arg !== isolation.project).join(' '))
    const override = stack.calls.find((call) => call.args.includes('--no-deps')).files[0]
    const dns = stack.calls.at(-1).files.at(-1)
    assert.match(override, /"default": \{"internal":true\}/)
    assert.match(override, /"qare-contained": \{"internal":true\}/)
    assert.match(dns, /dns_search: !override \["\."\]/)
    stack.calls.length = 0
    await stopApp(profile(), { runCompose: stack.runCompose, isolation })
    const down = stack.calls[0].args
    say(`boot outcome: ${outcome.kind}, egress ${JSON.stringify(outcome.egress)}`)
    say(`compose calls in order: ${JSON.stringify(verbs)}`)
    say(`containment override written for the stack:\n${override}`)
    say(`resolver override written once the resolver said its address:\n${dns}`)
    say(`the down names ${down.filter((arg) => arg.endsWith('.yml')).length} containment overrides: ${JSON.stringify(down.map((arg) => (arg.startsWith('/') ? arg.split('/').pop() : arg)))}`)
    // A stack the run cannot contain, and a run with no image, boot uncontained and say why.
    const host = compose()
    host.runCompose = ((run) => async (args, ...rest) => (args.includes('config') ? { code: 0, stdout: JSON.stringify({ services: { web: { network_mode: 'host' } } }), stderr: '' } : run(args, ...rest)))(host.runCompose)
    const hosted = await bootApp(profile(), { runCompose: host.runCompose, probe: async () => ({ ok: true }), pollIntervalMs: 1, isolation: await isolateRun(), egressImage: IMAGE })
    const imageless = await bootApp(profile(), { runCompose: compose().runCompose, probe: async () => ({ ok: true }), pollIntervalMs: 1, isolation: await isolateRun(), egressImage: '' })
    assert.equal(hosted.egress.containment, 'uncontained')
    assert.equal(imageless.egress.containment, 'uncontained')
    say(`a stack with network_mode host boots uncontained: ${hosted.egress.reason}`)
    say(`a run with no image to start the resolver from boots uncontained: ${imageless.egress.reason}`)
  } else if (check === 'run') {
    // The checkout's runJob: the record read after the checks, a name no stub
    // declares refusing the run, result.json carrying it, the comment listing
    // it, and the stub issue step reading it. An uncontained stack and a
    // target each say in the comment that egress was not contained.
    const { runJob, renderComment, missingStubsFromResult, parseResult } = await core('index.ts')
    const repo = join(dir, 'repo')
    mkdirSync(repo)
    const job = (inline) => ({ id: 'egress', repoPath: repo, baseRef: 'main', headRef: 'HEAD', post: 'none', evidenceDir: join(repo, 'evidence'), profile: { inline }, criteria: [{ id: 'runs', text: 'the check runs', checks: [{ kind: 'command', run: 'true' }] }] })
    const lookups = ['{"event":"lookup","host":"api.billing-vendor.example","declared":true}', '{"event":"lookup","host":"api.undeclared-vendor.example","declared":false}']
    const { result } = await runJob(job(profile()), { runCompose: compose(lookups).runCompose, probe: async () => ({ ok: true }), pollIntervalMs: 1, execution: 'native', egressImage: IMAGE })
    const written = parseResult(JSON.parse(readFileSync(join(repo, 'evidence', 'result.json'), 'utf8')))
    assert.equal(result.verdict, 'refused')
    assert.deepEqual(written.egress, { containment: 'contained', declared: ['api.billing-vendor.example'], undeclared: ['api.undeclared-vendor.example'] })
    const comment = renderComment(result)
    const listed = comment.split('\n').filter((line) => line.includes('contained') || line.includes('missing stub'))
    assert.ok(comment.includes('refused: missing stub: api.undeclared-vendor.example:unknown (dns)'))
    say(`run verdict ${result.verdict}; the criterion's own check ${result.criteria[0].outcome}`)
    say(`result.json egress: ${JSON.stringify(written.egress)}`)
    say('the evidence comment lists the undeclared host:')
    for (const line of listed) say(`  ${line}`)
    say(`the stub issue step reads: ${JSON.stringify(missingStubsFromResult(result))}`)
    const uncontained = await runJob(job(profile()), { runCompose: compose().runCompose, probe: async () => ({ ok: true }), pollIntervalMs: 1, execution: 'native', egressImage: '' })
    const statement = renderComment(uncontained.result).split('\n').find((line) => line.includes('was not contained'))
    assert.ok(statement !== undefined)
    say(`an uncontained stack: verdict ${uncontained.result.verdict}, result.json egress ${JSON.stringify(uncontained.result.egress)}`)
    say(`the evidence comment states it: ${statement}`)
    const target = renderComment({ schemaVersion: '1', verdict: 'passed', criteria: [], target: { url: ['https:', '//staging.example'].join(''), comparison: 'none' } }).split('\n').find((line) => line.includes('egress'))
    assert.ok(target.includes('its own egress was not contained by the run'))
    say(`a target run's evidence comment states it: ${target}`)
  } else if (check === 'ci') {
    // Where the real boot is proven: the CI step, and what its script holds the run to.
    const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8').split('\n')
    const script = readFileSync(new URL('../../scripts/egress-boot.sh', import.meta.url), 'utf8').split('\n')
    const at = (lines, text) => lines.findIndex((line) => line.includes(text))
    const step = at(ci, "Prove a booted stack's egress is contained")
    assert.ok(step >= 0)
    say(`.github/workflows/ci.yml:${step + 1}: ${ci[step].trim()}`)
    say(`.github/workflows/ci.yml:${step + 4}: ${ci[step + 3].trim()}`)
    for (const text of ['.verdict == "refused"', '.egress.containment == "contained"', '.egress.undeclared == [$host]', 'refused: missing stub: $undeclared:unknown (dns)', 'left="$(running)$(networks)"']) {
      const line = at(script, text)
      assert.ok(line >= 0, text)
      say(`scripts/egress-boot.sh:${line + 1}: ${script[line].trim()}`)
    }
  } else {
    throw new Error(`unknown check ${JSON.stringify(check)}: sink, boot, run or ci`)
  }
} finally {
  await rm(dir, { recursive: true, force: true })
}
