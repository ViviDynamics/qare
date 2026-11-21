import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import './source.mjs'

// Executable checks of what a boot that failed leaves in the evidence
// (#407), run against the checkout's core source without a build. There is
// no docker daemon here: compose is a stand-in that records each call and
// answers for a stack whose web service printed a line and exited 1, and
// whose run resolver recorded a name no stub declares. Each check prints
// what it observed, one statement per line. Scratch is restricted to
// .qa/checks/scratch.

const core = (file) => import(`../../packages/core/src/${file}`)
// The run module first: it loads the core's modules in the order they expect.
await core('run.ts')
const scratch = fileURLToPath(new URL('./scratch/', import.meta.url))
mkdirSync(scratch, { recursive: true })
const HEALTH = ['http:', '//localhost:3000/up'].join('')
const IMAGE = 'ghcr.io/vividynamics/qare-core:2026.11.24'
const SAID = 'crash-app: cannot reach db.crash-app.example, giving up'
const SECRET = 'crash-app-secret-407'
const WEB_LOG = `${Array.from({ length: 24 }, (_, index) => `web boot line ${index + 1}`).join('\n')}\nDATABASE_URL=postgres://app:${SECRET}@db.crash-app.example/app\n${SAID}\n`
const PS = [JSON.stringify({ Service: 'web', State: 'exited', ExitCode: 1, Health: '' }), JSON.stringify({ Service: 'db', State: 'running', ExitCode: 0, Health: 'healthy' })].join('\n')
const CONFIG = JSON.stringify({
  networks: { default: { name: 'x_default' } },
  services: { web: { networks: { default: null }, ports: [{ target: 3000, published: '3000', host_ip: '127.0.0.1', protocol: 'tcp' }] }, db: { networks: { default: null } } },
})
const RECORD = ['{"event":"ready","address":"192.0.2.2","port":53}', '{"event":"lookup","host":"db.crash-app.example","declared":false}'].join('\n')
const say = (line) => console.log(line)

/** A compose stand-in for a stack whose web service exits 1 during the boot: records each call, and answers ps and logs as compose would. */
function compose(opts = {}) {
  const calls = []
  let ups = 0
  return {
    calls,
    runCompose: async (args) => {
      calls.push(args)
      if (args.includes('config')) return { code: 0, stdout: CONFIG, stderr: '' }
      if (args.includes('ps')) return { code: 0, stdout: PS, stderr: '' }
      if (args.includes('logs')) {
        if (args.includes('qare-egress-dns')) return { code: 0, stdout: `${RECORD}\n`, stderr: '' }
        return { code: 0, stdout: args.includes('web') ? WEB_LOG : 'db: ready to accept connections\n', stderr: '' }
      }
      if (args.includes('up') && args.includes('--wait')) {
        ups += 1
        const fails = opts.failUp === undefined || opts.failUp(ups)
        return { code: fails ? 1 : 0, stdout: '', stderr: fails ? 'container web-1 exited (1)\n' : '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
}

function profile(seed = 'true') {
  return {
    app: {
      boot: { compose: 'compose.yaml', service: 'web' },
      health: { http: HEALTH, timeout: '5s' },
      seed: { command: seed },
      login: { fixture: 'fixtures/users.yml', role: 'reader' },
    },
    stubs: [],
    visual: { widths: [], themes: [] },
    suites: [],
    // The whole plan at the base too, so the base boots the same failing stack.
    base: { criteria: 'all' },
  }
}

const check = process.argv[2]
const dir = await mkdtemp(join(scratch, 'boot-failure-'))
try {
  if (check === 'boot') {
    // The checkout's bootApp on a contained stack whose up exits 1: every
    // service's state and its last 200 lines are read, and the resolver's
    // record with them, before anything takes the stack down.
    const { bootApp } = await core('boot.ts')
    const { isolateRun } = await core('isolation.ts')
    const stand = compose()
    const outcome = await bootApp(profile(), { runCompose: stand.runCompose, runDocker: async () => ({ code: 0, stdout: '', stderr: '' }), isolation: await isolateRun(), egressImage: IMAGE, pollIntervalMs: 1 })
    assert.equal(outcome.kind, 'blocked')
    assert.equal(outcome.reason, 'compose up exited 1')
    const VERBS = ['build', 'config', 'up', 'ps', 'logs', 'down', 'exec']
    const verbs = stand.calls.map((args) => args.slice(args.findIndex((arg) => VERBS.includes(arg))).join(' '))
    const up = verbs.findIndex((verb) => verb.startsWith('up -d --wait'))
    const ps = verbs.findIndex((verb) => verb.startsWith('ps -a'))
    assert.ok(up >= 0 && ps > up)
    assert.ok(!verbs.some((verb) => verb.includes('down')), 'nothing took the stack down before it was read')
    assert.deepEqual(
      outcome.services.map((service) => ({ service: service.service, state: service.state, exitCode: service.exitCode, ...(service.health === undefined ? {} : { health: service.health }) })),
      [{ service: 'web', state: 'exited', exitCode: 1 }, { service: 'db', state: 'running', exitCode: 0, health: 'healthy' }],
    )
    assert.ok(outcome.services[0].log.includes(SAID))
    assert.deepEqual(outcome.lookups.lookups, [{ host: 'db.crash-app.example', declared: false }])
    say(`boot outcome: ${outcome.kind}, reason ${JSON.stringify(outcome.reason)}, egress ${JSON.stringify(outcome.egress)}`)
    say('the compose calls after the up, in order (no down among them):')
    for (const verb of verbs.slice(up)) say(`  docker compose -p <project> ${verb}`)
    for (const service of outcome.services) say(`service ${service.service}: state ${service.state}, exit code ${service.exitCode}${service.health === undefined ? '' : `, health ${service.health}`}, ${service.log.split('\n').filter(Boolean).length} log lines read`)
    say(`the resolver's record read before the down: ${JSON.stringify(outcome.lookups.lookups)}`)
  } else if (check === 'run' || check === 'base') {
    // The checkout's runJob: a one-sided run (run) or a two-sided one whose
    // base boots the same failing stack (base). Each side's services are
    // written to <side>/services/<service>.log, redacted; result.json names
    // each service, its exit code and its last 20 lines; and the comment
    // names the service that exited, its code and its last lines, beside the
    // name the contained stack looked up before it failed.
    const { runJob, renderComment, parseResult } = await core('index.ts')
    const repo = join(dir, 'repo')
    mkdirSync(repo)
    const job = { id: 'boot-failure', repoPath: repo, baseRef: 'main', headRef: 'HEAD', post: 'none', evidenceDir: join(repo, 'evidence'), profile: { inline: profile() }, criteria: [{ id: 'up', text: 'the app comes up', checks: [{ kind: 'command', run: 'true' }] }] }
    const opts = { runCompose: compose().runCompose, runDocker: async () => ({ code: 0, stdout: '', stderr: '' }), probe: async () => ({ ok: true }), pollIntervalMs: 1, execution: 'native', egressImage: IMAGE }
    if (check === 'base') {
      const base = join(dir, 'base')
      mkdirSync(base)
      opts.base = { repoPath: base }
    }
    const { result } = await runJob(job, opts)
    const written = parseResult(JSON.parse(readFileSync(join(repo, 'evidence', 'result.json'), 'utf8')))
    assert.equal(result.verdict, 'blocked')
    const sides = check === 'base' ? [['head', written], ['base', written.base]] : [['', written]]
    for (const [side, record] of sides) {
      const at = side === '' ? 'evidence' : `evidence/${side}`
      const log = join(repo, at, 'services', 'web.log')
      assert.ok(existsSync(log), `${at}/services/web.log`)
      const text = readFileSync(log, 'utf8')
      assert.ok(text.includes(SAID))
      assert.ok(!text.includes(SECRET), 'the log is redacted')
      const web = record.boot.services.find((service) => service.service === 'web')
      assert.equal(web.exitCode, 1)
      assert.ok(web.tail.length <= 20 && web.tail.at(-1) === SAID)
      assert.ok(!web.tail.join('\n').includes(SECRET))
      assert.ok(record.egress.undeclared.includes('db.crash-app.example'))
      say(`${at}/services/web.log: ${text.split('\n').filter(Boolean).length} lines, the last ${JSON.stringify(SAID)}, the password redacted (${text.split('\n').find((line) => line.startsWith('DATABASE_URL'))})`)
      say(`${at}/services/db.log written: ${existsSync(join(repo, at, 'services', 'db.log'))}`)
      say(`${side === '' ? '' : `${side === 'base' ? 'base.' : ''}`}boot in result.json: ${JSON.stringify(record.boot.services.map((service) => ({ ...service, tail: undefined, ...(service.tail === undefined ? {} : { tailLines: service.tail.length }) })))}`)
      say(`${side === 'base' ? 'base.' : ''}egress in result.json: ${JSON.stringify(record.egress)}`)
    }
    const comment = renderComment(written, { kind: 'artifact' })
    assert.ok(comment.includes('`web` exited with code 1'))
    assert.ok(comment.includes(SAID))
    assert.ok(comment.includes('refused: missing stub: db.crash-app.example:unknown (dns)'))
    assert.ok(!comment.includes(SECRET))
    const fences = comment.split('\n').filter((line) => line.startsWith('```')).length
    say(`verdict ${result.verdict}; the comment as it is posted, from its boot section to the end of the egress record:`)
    const lines = comment.split('\n')
    const from = lines.findIndex((line) => line.includes('did not come up'))
    const to = lines.findIndex((line, index) => index > from && line.startsWith('- `refused: missing stub'))
    for (const line of lines.slice(from, to + 1)) say(`  ${line}`)
    say(`the comment carries the password: ${comment.includes(SECRET)}; code fences in it: ${fences}`)
  } else if (check === 'seed') {
    // A stack that came up but whose seed failed is read the same way, before the teardown.
    const { runJob } = await core('index.ts')
    const repo = join(dir, 'repo')
    mkdirSync(repo)
    const job = { id: 'boot-failure-seed', repoPath: repo, baseRef: 'main', headRef: 'HEAD', post: 'none', evidenceDir: join(repo, 'evidence'), profile: { inline: profile('false') }, criteria: [{ id: 'up', text: 'the app comes up', checks: [{ kind: 'command', run: 'true' }] }] }
    const { result } = await runJob(job, { runCompose: compose({ failUp: () => false }).runCompose, probe: async () => ({ ok: true }), pollIntervalMs: 1, execution: 'native', egressImage: '' })
    assert.equal(result.verdict, 'blocked')
    assert.ok(existsSync(join(repo, 'evidence', 'services', 'web.log')))
    say(`a seed that exited 1: verdict ${result.verdict}, reason ${JSON.stringify(result.criteria[0].reason)}`)
    say(`boot in result.json: ${JSON.stringify(result.boot.services.map((service) => ({ ...service, tail: undefined })))}`)
    say(`egress in result.json: ${JSON.stringify(result.egress)}`)
  } else if (check === 'ci') {
    // Where the real boot is proven: the CI step, and what its script holds the run to.
    const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8').split('\n')
    const script = readFileSync(new URL('../../scripts/crash-boot.sh', import.meta.url), 'utf8').split('\n')
    const compose = readFileSync(new URL('../../examples/crash-app/compose.yaml', import.meta.url), 'utf8').split('\n')
    const at = (lines, text) => lines.findIndex((line) => line.includes(text))
    const step = at(ci, "Prove a boot failure leaves the service's log in the evidence")
    assert.ok(step >= 0)
    say(`.github/workflows/ci.yml:${step + 1}: ${ci[step].trim()}`)
    say(`.github/workflows/ci.yml:${step + 4}: ${ci[step + 3].trim()}`)
    for (const text of ['wget -q', 'echo "crash-app:', 'exit 1']) {
      const line = at(compose, text)
      assert.ok(line >= 0, text)
      say(`examples/crash-app/compose.yaml:${line + 1}: ${compose[line].trim()}`)
    }
    for (const text of ['said="crash-app:', '.verdict == "blocked"', '.state == "exited" and .exitCode == 1', '(.tail | index($said)) != null', '(.egress.undeclared | index($host)) != null', 'grep -qF "$said" "$log"', 'grep -rqF "$secret" evidence', 'for expected in', 'left="$(running)$(networks)"']) {
      const line = at(script, text)
      assert.ok(line >= 0, text)
      say(`scripts/crash-boot.sh:${line + 1}: ${script[line].trim()}`)
    }
  } else {
    throw new Error(`unknown check ${JSON.stringify(check)}: boot, run, base, seed or ci`)
  }
} finally {
  await rm(dir, { recursive: true, force: true })
}
