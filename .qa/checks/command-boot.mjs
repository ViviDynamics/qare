import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import './source.mjs'

// Its compose is a stand-in, so the stack is booted uncontained: containment
// is exercised by stack-egress.mjs (#382), and the run's image is not named here.
delete process.env.QARE_IMAGE_REF

// Executable checks of booting an app by command (#379), run against the
// checkout's core source without a build. The image has no docker daemon,
// so compose is a stand-in that records each call and reads the project
// file the run wrote, which is what the boot hands docker. Each check prints
// what it observed. Scratch is restricted to .qa/checks/scratch.

const core = (file) => import(`../../packages/core/src/${file}`)
// The run module first: it loads the core's modules in the order they expect.
await core('run.ts')
const scratch = fileURLToPath(new URL('./scratch/', import.meta.url))
mkdirSync(scratch, { recursive: true })
const HEALTH = ['http:', '//localhost:{{run.app_port}}/up'].join('')
const BOOT = { command: 'npm ci && npm start -- --port $PORT', image: 'node:22', port: 3000 }

/** A compose stand-in: records every call, and the project file each one names, as compose would read it. */
function composeRecorder() {
  const calls = []
  return {
    calls,
    runCompose: async (args, _timeoutMs, env) => {
      const at = args.indexOf('-f')
      const file = at === -1 ? undefined : args[at + 1]
      calls.push({ args, env, ...(file === undefined ? {} : { project: JSON.parse(readFileSync(file, 'utf8')) }) })
      return { code: 0, stdout: '', stderr: '' }
    },
  }
}

const appProfile = (extra = {}) => ({
  app: { boot: BOOT, health: { http: HEALTH, timeout: '5s' }, seed: { command: 'true' }, login: { fixture: 'fixtures/users.yml', role: 'admin' } },
  stubs: [],
  visual: { widths: [], themes: [] },
  suites: [],
  ...extra,
})

const check = process.argv[2]
const dir = await mkdtemp(join(scratch, 'command-boot-'))
try {
  if (check === 'boot') {
    // The profile loader takes the command form, and refuses a mix with
    // compose, a bad port, an image that is not one word, and stubs.
    const { validateProfileConfig, ProfileValidationError } = await core('profile.ts')
    const loaded = validateProfileConfig(appProfile()).app.boot
    assert.deepEqual(loaded, BOOT)
    const refused = {}
    for (const [label, config] of Object.entries({
      'compose and command together': appProfile({ app: { ...appProfile().app, boot: { ...BOOT, compose: 'compose.yaml' } } }),
      'a port that is not a port': appProfile({ app: { ...appProfile().app, boot: { ...BOOT, port: 70000 } } }),
      'an image with a newline in it': appProfile({ app: { ...appProfile().app, boot: { ...BOOT, image: 'node:22\nRUN curl evil' } } }),
      'a stub beside a command boot': appProfile({ stubs: [{ service: 'pay', hosts: ['pay.example.test'], provided_by: { compose_service: 'pay-stub' } }] }),
    })) {
      try {
        validateProfileConfig(config)
        assert.fail(`${label} was accepted`)
      } catch (error) {
        assert.ok(error instanceof ProfileValidationError, `${label}: ${error}`)
        refused[label] = error.message
      }
    }
    // The boot runs the command in the named image, published on the run's
    // allocated port, as the one service of the run's own compose project.
    const { bootApp, stopApp } = await core('boot.ts')
    const { isolateRun, isolatedHealthUrl } = await core('isolation.ts')
    const checkout = join(dir, 'checkout')
    mkdirSync(checkout)
    const isolation = await isolateRun()
    const compose = composeRecorder()
    const probed = []
    const health = isolatedHealthUrl(HEALTH.replace('{{run.app_port}}', String(isolation.port)), isolation.port)
    const profile = { ...appProfile(), app: { ...appProfile().app, health: { http: health, timeout: '5s' } } }
    const outcome = await bootApp(profile, { runCompose: compose.runCompose, probe: async (url) => (probed.push(url), { ok: true }), pollIntervalMs: 1, isolation, root: checkout })
    assert.equal(outcome.kind, 'up')
    const [build, up] = compose.calls
    assert.deepEqual(build.args.slice(0, 2), ['-p', isolation.project])
    assert.ok(up.args.includes('up'))
    const service = up.project.services.app
    assert.equal(service.build.dockerfile_inline, 'FROM node:22\nCOPY . /app\nWORKDIR /app\n')
    assert.equal(service.build.context, checkout)
    assert.deepEqual(service.command, ['sh', '-c', 'npm ci && npm start -- --port $$PORT'])
    assert.deepEqual(service.ports, ['127.0.0.1:${QARE_APP_PORT:-3000}:3000'])
    assert.equal(up.env.QARE_APP_PORT, String(isolation.port))
    assert.deepEqual(probed, [health])
    compose.calls.length = 0
    await stopApp(profile, { runCompose: compose.runCompose, isolation })
    console.log(JSON.stringify({ check, loaded, refused, project: isolation.project, port: isolation.port, composeCalls: [build.args, up.args], composeEnv: up.env, service, healthProbed: probed, stop: compose.calls.map((call) => call.args) }, null, 2))
  } else if (check === 'run') {
    // A whole run against a live command-booted app, on the checkout's
    // runJob. Compose is a stand-in that does what the project file the run
    // wrote says: build copies the checkout into the container's filesystem
    // (COPY . /app), up runs the command there with sh -c, PORT set and the
    // port published on the run's own, down stops it. The health check and a
    // command check reach the app over loopback, and the seed and a suite are
    // the profile's own `docker compose -p qare-{{run.id}} exec -T app`
    // lines, answered by a docker stand-in only for the run's project.
    const { runJob } = await core('run.ts')
    const repo = join(dir, 'repo')
    mkdirSync(repo)
    writeFileSync(join(repo, 'server.mjs'), [
      "import { createServer } from 'node:http'",
      "import { existsSync } from 'node:fs'",
      "createServer((req, res) => {",
      "  if (req.url === '/up') return res.end('ok')",
      "  res.end(existsSync('seeded') ? 'Hello, seeded shop' : 'Hello, empty shop')",
      "}).listen(Number(process.env.PORT), '127.0.0.1')",
      '',
    ].join('\n'))
    writeFileSync(join(repo, 'seed.mjs'), "import { writeFileSync } from 'node:fs'\nwriteFileSync('seeded', 'yes')\nconsole.log('seeded inside', process.cwd())\n")
    writeFileSync(join(repo, 'suite.mjs'), "import { readFileSync } from 'node:fs'\nconsole.log('suite inside', process.cwd(), 'saw seeded =', readFileSync('seeded', 'utf8'))\n")
    writeFileSync(join(repo, 'page.mjs'), "const body = await (await fetch(process.argv[2])).text()\nconsole.log(body)\nprocess.exit(body.includes('seeded') ? 0 : 1)\n")
    // Where the docker stand-in finds a started container's filesystem.
    const containers = join(scratch, 'containers')
    mkdirSync(containers, { recursive: true })
    const started = new Map()
    const calls = []
    const runCompose = async (args, _timeoutMs, env) => {
      calls.push(args)
      const project = args[1]
      const root = join(containers, project)
      const at = args.indexOf('-f')
      const service = at === -1 ? undefined : JSON.parse(readFileSync(args[at + 1], 'utf8')).services.app
      if (args.includes('build')) {
        // FROM <image>, COPY . /app, WORKDIR /app: the checkout is copied, so the app never writes to it.
        assert.match(service.build.dockerfile_inline, /^FROM node:22\nCOPY \. \/app\nWORKDIR \/app\n$/)
        cpSync(service.build.context, join(root, 'app'), { recursive: true })
      } else if (args.includes('up')) {
        const [sh, flag, line] = service.command
        const published = /^127\.0\.0\.1:\$\{QARE_APP_PORT:-(\d+)\}:(\d+)$/.exec(service.ports[0])
        assert.equal(published[2], String(service.environment.PORT))
        // The run's port stands in for the published one: no daemon maps it here.
        const child = spawn(sh, [flag, line.replaceAll('$$', '$')], { cwd: join(root, 'app'), env: { PATH: process.env.PATH, PORT: env.QARE_APP_PORT }, stdio: 'ignore' })
        started.set(project, child)
        writeFileSync(join(root, 'running'), '')
      } else if (args.includes('down')) {
        started.get(project)?.kill()
        rmSync(join(root, 'running'), { force: true })
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    process.env.PATH = `${fileURLToPath(new URL('./bin/', import.meta.url))}:${process.env.PATH}`
    const exec = 'docker compose -p qare-{{run.id}} exec -T app'
    const inline = {
      ...appProfile({ suites: [{ name: 'in-service', command: `${exec} node suite.mjs`, kind: 'flow' }] }),
      app: { ...appProfile().app, boot: { command: 'node server.mjs', image: 'node:22', port: 3000 }, seed: { command: `${exec} node seed.mjs` } },
    }
    let ran
    try {
      ran = await runJob(
        {
          id: 'command-boot', repoPath: repo, baseRef: 'main', headRef: 'HEAD', post: 'none', evidenceDir: join(dir, 'evidence'),
          profile: { inline },
          criteria: [
            { id: 'page', text: 'the seeded page answers on the run port', checks: [{ kind: 'command', run: `node page.mjs ${['http:', '//localhost:{{run.app_port}}/'].join('')}` }] },
            { id: 'suite', text: 'a suite runs inside the seeded service', checks: [{ kind: 'flow', suite: 'in-service' }] },
          ],
        },
        { runCompose, pollIntervalMs: 50, execution: 'native' },
      )
    } finally {
      for (const child of started.values()) child.kill()
    }
    const cleanup = () => rm(containers, { recursive: true, force: true })
    const { result, isolation } = ran
    const outcomes = Object.fromEntries(result.criteria.map((criterion) => [criterion.id, criterion.outcome]))
    const stdout = (id) => readFileSync(join(dir, 'evidence/checks', id, '0', 'stdout.txt'), 'utf8').trim()
    const seedLog = readFileSync(join(dir, 'evidence', 'seed.log'), 'utf8')
    if (result.verdict !== 'passed') console.error(JSON.stringify({ verdict: result.verdict, criteria: result.criteria, seed: seedLog }, null, 2))
    // The seed wrote inside the container's copy, never into the checkout.
    assert.equal(existsSync(join(containers, isolation.project, 'app', 'seeded')), true)
    assert.equal(existsSync(join(repo, 'seeded')), false)
    assert.deepEqual(outcomes, { page: 'proven', suite: 'proven' })
    // Another project is refused: the exec reaches the run's app and no other.
    const other = spawnSync('docker', ['compose', '-p', 'qare-someone-else', 'exec', '-T', 'app', 'true'], { encoding: 'utf8' })
    assert.notEqual(other.status, 0)
    console.log(JSON.stringify({ check, verdict: result.verdict, outcomes, project: isolation.project, port: isolation.port, seed: seedLog.trim(), pageCheck: stdout('page'), suite: stdout('suite'), checkoutUntouched: !existsSync(join(repo, 'seeded')), otherProject: other.stderr.trim(), composeCalls: calls }, null, 2))
    await cleanup()
  } else if (check === 'isolation') {
    // Two command boots at once never share a project, a port or a file,
    // and reap downs each by name and removes the file the run wrote.
    const { bootApp, commandBootFile } = await core('boot.ts')
    const { isolateRun } = await core('isolation.ts')
    const { reapProjects } = await core('reap.ts')
    const compose = composeRecorder()
    const runs = await Promise.all([isolateRun(), isolateRun()])
    await Promise.all(runs.map((isolation) => bootApp(appProfile(), { runCompose: compose.runCompose, probe: async () => ({ ok: true }), pollIntervalMs: 1, isolation, root: dir })))
    const files = runs.map((isolation) => commandBootFile(isolation.project))
    assert.notEqual(runs[0].project, runs[1].project)
    assert.notEqual(runs[0].port, runs[1].port)
    assert.notEqual(files[0], files[1])
    const ports = compose.calls.filter((call) => call.args.includes('up')).map((call) => ({ project: call.args[1], QARE_APP_PORT: call.env.QARE_APP_PORT }))
    const before = files.map((file) => existsSync(file))
    compose.calls.length = 0
    const reaped = await reapProjects({ projects: runs.map((isolation) => isolation.project), runCompose: compose.runCompose })
    const after = files.map((file) => existsSync(file))
    assert.deepEqual(before, [true, true])
    assert.deepEqual(after, [false, false])
    assert.deepEqual(reaped.reaped, runs.map((isolation) => isolation.project))
    console.log(JSON.stringify({ check, runs: runs.map(({ project, port }) => ({ project, port })), upsPublished: ports, files, filesBeforeReap: before, reaped, reapCalls: compose.calls.map((call) => call.args), filesAfterReap: after }, null, 2))
  } else if (check === 'init') {
    // qare init on a repository with no compose file and a package.json
    // start script writes the command form; with a compose file, compose.
    const { planInit } = await core('init.ts')
    const started = join(dir, 'started')
    mkdirSync(started)
    writeFileSync(join(started, 'package.json'), JSON.stringify({ name: 'shop', scripts: { start: 'node server.js' } }))
    writeFileSync(join(started, 'package-lock.json'), '{}')
    const plan = await planInit(started)
    const config = plan.profile.find((file) => file.path === '.qa/config.yml').content
    const boot = config.split('\n').find((line) => line.trim().startsWith('boot:'))
    assert.equal(boot.trim(), 'boot: { command: "npm ci && npm start", image: "node:22", port: 3000 }')
    const composed = join(dir, 'composed')
    mkdirSync(composed)
    writeFileSync(join(composed, 'package.json'), JSON.stringify({ scripts: { start: 'node server.js' } }))
    writeFileSync(join(composed, 'compose.yaml'), 'services:\n  web:\n    build: .\n    ports: ["${QARE_APP_PORT:-3000}:3000"]\n')
    const composeBoot = (await planInit(composed)).profile[0].content.split('\n').find((line) => line.trim().startsWith('boot:'))
    assert.match(composeBoot, /compose: "compose.yaml", service: "web"/)
    const neither = join(dir, 'neither')
    mkdirSync(neither)
    writeFileSync(join(neither, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }))
    const refusal = await planInit(neither).then(() => 'accepted', (error) => error.message)
    assert.match(refusal, /no compose file found and no start script/)
    console.log(JSON.stringify({ check, startScript: { files: plan.profile.map((file) => file.path), config }, withComposeFile: composeBoot.trim(), withNeither: refusal }, null, 2))
  } else {
    throw new Error(`unknown check ${JSON.stringify(check)}: boot, run, isolation or init`)
  }
} finally {
  await rm(dir, { recursive: true, force: true })
}
