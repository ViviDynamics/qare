import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { parse } from 'yaml'
import { INIT_WORKFLOW_PATH, InitError, VERSION, callerWorkflow, loadProfile, planInit, readinessInventory } from '../src/index.js'
import type { InitPlan } from '../src/index.js'

// #146: `qare init` turns the readiness inventory into a starting profile and
// the caller workflow. planInit decides what the files say; the CLI writes
// them. Test files carry no network literals, so URLs are joined at runtime.
const url = (scheme: string, rest: string) => [`${scheme}:`, `//${rest}`].join('')

async function repoWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-init-'))
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true })
    await writeFile(join(dir, name), content, 'utf8')
  }
  return dir
}

async function write(repo: string, plan: InitPlan): Promise<void> {
  for (const file of [...plan.profile, plan.workflow]) {
    await mkdir(dirname(join(repo, file.path)), { recursive: true })
    await writeFile(join(repo, file.path), file.content, 'utf8')
  }
}

const COMPOSE = [
  'services:',
  '  db:',
  '    image: postgres:16',
  '    healthcheck: { test: ["CMD", "pg_isready"] }',
  '  web:',
  '    build: .',
  '    ports: ["${QARE_APP_PORT:-8080}:3000"]',
  '    healthcheck:',
  `      test: ["CMD", "curl", "-f", "${url('http', 'localhost:3000/up')}"]`,
  '  worker:',
  '    build: .',
].join('\n')

function composeRepo(extra: Record<string, string> = {}): Promise<string> {
  return repoWith({
    'docker-compose.yml': COMPOSE,
    'app/pay.rb': `Net::HTTP.get(${JSON.stringify(url('https', 'api.billing-vendor.example/v1/charges'))})`,
    'config/mail.yml': `host: ${url('https', 'smtp.mail-vendor.example')}\ndb: ${url('http', 'db:5432')}`,
    ...extra,
  })
}

test('a repository with a compose file gets a profile that boots its application service', async () => {
  const repo = await composeRepo()
  const plan = await planInit(repo)
  expect(plan.kind).toBe('app')
  // No stubs directory (#416): every stub is a compose service config.yml names.
  expect(plan.profile.map((file) => file.path)).toEqual(['.qa/config.yml', '.qa/QA.md', '.qa/fixtures/users.yml'])

  await write(repo, plan)
  const profile = await loadProfile(join(repo, '.qa'))
  // The service built from the repository, not the database beside it, and
  // the health check its own healthcheck asks for, on the port it publishes.
  expect(profile.app?.boot).toEqual({ compose: 'docker-compose.yml', service: 'web' })
  // The port is the run's own (#374): each run publishes the app on a port it
  // allocates, so a number read from the compose file names no run's app.
  expect(profile.app?.health).toEqual({ http: url('http', 'localhost:{{run.app_port}}/up'), timeout: '120s' })
  expect(profile.stubs).toEqual([
    { service: 'api-billing-vendor-example', hosts: ['api.billing-vendor.example'], provided_by: { compose_service: 'api-billing-vendor-example-stub' } },
    { service: 'smtp-mail-vendor-example', hosts: ['smtp.mail-vendor.example'], provided_by: { compose_service: 'smtp-mail-vendor-example-stub' } },
  ])
  expect(profile.suites).toEqual([])
})

test('readiness names exactly what the starting profile still lacks', async () => {
  const repo = await composeRepo()
  await write(repo, await planInit(repo))
  const inventory = await readinessInventory(repo)
  expect(inventory.profile.loadError).toBeUndefined()
  expect(inventory.gaps).toEqual([
    '.qa/QA.md is not filled in: say what this app is, in a sentence or two',
    '.qa/QA.md is not filled in: say what matters most, so the planner knows what a regression would cost',
    '.qa/QA.md is not filled in: list the pages the flow and visual checks should cover',
    '.qa/QA.md is not filled in: say how to sign in, or that there is no login',
    '.qa/config.yml is not filled in: name the command that seeds the QA data, in place of "true"',
    '.qa/config.yml is not filled in: describe the user QA signs in as in .qa/fixtures/users.yml, and name its role here',
    'service "worker" in ./docker-compose.yml has no healthcheck',
    'stub "api-billing-vendor-example" is provided by the compose service "api-billing-vendor-example-stub", which docker-compose.yml does not define',
    'stub "smtp-mail-vendor-example" is provided by the compose service "smtp-mail-vendor-example-stub", which docker-compose.yml does not define',
  ])
  expect(inventory.stubGaps.map((gap) => gap.host)).toEqual(['api.billing-vendor.example', 'smtp.mail-vendor.example'])
})

test('a health URL init had to guess is marked for a person to confirm', async () => {
  const repo = await repoWith({ 'compose.yaml': 'services:\n  api:\n    image: api:latest\n' })
  const plan = await planInit(repo)
  const config = plan.profile.find((file) => file.path === '.qa/config.yml')?.content ?? ''
  expect(config).toContain(`http: ${JSON.stringify(url('http', 'localhost:{{run.app_port}}/'))}`)
  expect(config).toContain(
    'TODO(qare init): the service "api" publishes no port, and each run publishes the app on its own: in compose.yaml give it ports: ["127.0.0.1:${QARE_APP_PORT:-3000}:3000"], then remove this line',
  )
})

test('a fixed published port is named with the compose change that puts the app on the run port (#374)', async () => {
  const repo = await repoWith({
    'compose.yaml': `services:\n  web:\n    build: .\n    ports: ["8080:3000"]\n    healthcheck: { test: "curl -f ${url('http', 'localhost:3000/up')}" }\n`,
  })
  await write(repo, await planInit(repo))
  expect((await loadProfile(join(repo, '.qa'))).app?.health.http).toBe(url('http', 'localhost:{{run.app_port}}/up'))
  expect((await readinessInventory(repo)).gaps).toContain(
    '.qa/config.yml is not filled in: the service "web" publishes the fixed port 8080, and each run publishes the app on its own: in compose.yaml give it ports: ["127.0.0.1:${QARE_APP_PORT:-8080}:3000"], then remove this line',
  )
  // A port the run hands to compose needs no change, with or without a default.
  for (const ports of ['["${QARE_APP_PORT}:3000"]', '["127.0.0.1:${QARE_APP_PORT:-4000}:3000"]', '[{ target: 3000, published: "${QARE_APP_PORT:-4000}" }]']) {
    const own = await repoWith({ 'compose.yaml': `services:\n  web:\n    build: .\n    ports: ${ports}\n` })
    const config = (await planInit(own)).profile[0]?.content ?? ''
    expect(config, ports).not.toContain('TODO(qare init): the service')
  }
})

test('the health URL keeps the scheme the healthcheck asks with', async () => {
  const repo = await repoWith({
    'compose.yaml': `services:\n  web:\n    ports: ["8443:8443"]\n    healthcheck: { test: "curl -kf ${url('https', 'localhost:8443/up')}" }\n`,
  })
  await write(repo, await planInit(repo))
  expect((await loadProfile(join(repo, '.qa'))).app?.health.http).toBe(url('https', 'localhost:{{run.app_port}}/up'))
})

test('a target profile that is already there holds, whatever compose file lies beside it', async () => {
  const target = url('https', 'staging.example.test')
  const repo = await repoWith({
    'docker-compose.yml': 'services:\n  web:\n    build: .\n',
    '.qa/QA.md': '# QA\n',
    '.qa/config.yml': `target:\n  url: ${target}\n  health: { http: /up, timeout: 30s }\n`,
  })
  const plan = await planInit(repo)
  expect(plan.kind).toBe('target')
  expect(plan.workflow.content).not.toContain('push:')
})

test('the application service can be named, and a name the compose file does not define is refused', async () => {
  const repo = await composeRepo()
  await write(repo, await planInit(repo, { service: 'worker' }))
  expect((await loadProfile(join(repo, '.qa'))).app?.boot.service).toBe('worker')
  await expect(planInit(repo, { service: 'nope' })).rejects.toThrow(
    new InitError('--service "nope" is not a service of ./docker-compose.yml (it defines db, web, worker)'),
  )
})

test('the suites init recognises run inside the booted service, where their runtime is (#374)', async () => {
  const repo = await composeRepo({
    'playwright.config.ts': 'export default {}\n',
    'features/checkout/pay.feature': 'Feature: pay\n',
    Gemfile: "gem 'cucumber'\n",
    'spec/system/login_spec.rb': '# spec\n',
  })
  await write(repo, await planInit(repo))
  // The run image has no npm, Ruby or project dependencies: the service does.
  const exec = 'docker compose -p qare-{{run.id}} -f docker-compose.yml exec -T web'
  expect((await loadProfile(join(repo, '.qa'))).suites).toEqual([
    { name: 'cucumber', command: `${exec} bundle exec cucumber`, kind: 'command' },
    { name: 'playwright', command: `${exec} npx playwright test`, kind: 'command' },
    { name: 'rspec-system', command: `${exec} bundle exec rspec spec/system`, kind: 'command' },
  ])
  // Without a Gemfile, Cucumber is the JavaScript one.
  const js = await repoWith({ 'compose.yml': 'services:\n  app: {}\n', 'features/a.feature': 'Feature: a\n' })
  await write(js, await planInit(js))
  expect((await loadProfile(join(js, '.qa'))).suites).toEqual([
    { name: 'cucumber', command: 'docker compose -p qare-{{run.id}} -f compose.yml exec -T app npx cucumber-js', kind: 'command' },
  ])
})

test('a repository with no compose file gets a target profile from the URL it is given', async () => {
  const repo = await repoWith({ 'README.md': `see ${url('https', 'docs.example.com')}`, 'playwright.config.js': '' })
  const target = url('https', 'staging.example.test/app')
  const plan = await planInit(repo, { target })
  expect(plan.kind).toBe('target')
  expect(plan.profile.map((file) => file.path)).toEqual(['.qa/config.yml', '.qa/QA.md'])
  await write(repo, plan)
  const profile = await loadProfile(join(repo, '.qa'))
  expect(profile.target).toEqual({ url: target, health: { http: `${target}/`, timeout: '30s' }, hosts: [] })
  // A target has no stubs, whatever the scan read.
  expect(profile.stubs).toEqual([])
  expect(profile.flavour).toBe('web')
  expect(profile.suites).toEqual([{ name: 'playwright', command: 'npx playwright test', kind: 'command' }])
  // The health probe passes on 200 alone, and "/" is a guess: a person confirms it.
  const inventory = await readinessInventory(repo)
  expect(inventory.gaps).toHaveLength(5)
  expect(inventory.gaps[4]).toBe(
    '.qa/config.yml is not filled in: confirm the health path answers 200 when the app is up (a redirect does not pass), then remove this line',
  )
})

test('a health path that is named is written, and is not left for a person to confirm', async () => {
  const target = url('https', 'staging.example.test')
  const repo = await repoWith({ 'README.md': 'hello' })
  await write(repo, await planInit(repo, { target, health: '/wiki/Main_Page' }))
  expect((await loadProfile(join(repo, '.qa'))).target?.health.http).toBe(`${target}/wiki/Main_Page`)
  expect((await readinessInventory(repo)).gaps.filter((gap) => gap.startsWith('.qa/config.yml'))).toEqual([])

  const booted = await composeRepo()
  await write(booted, await planInit(booted, { health: '/healthz' }))
  expect((await loadProfile(join(booted, '.qa'))).app?.health.http).toBe(url('http', 'localhost:{{run.app_port}}/healthz'))
  await expect(planInit(booted, { health: 'healthz' })).rejects.toThrow(/--health "healthz" is not a path/)
})

test('with no compose file and no target there is nothing to write, and init says which flag is missing', async () => {
  const repo = await repoWith({ 'README.md': 'hello' })
  await expect(planInit(repo)).rejects.toThrow(InitError)
  await expect(planInit(repo)).rejects.toThrow(/no compose file.*--target <url>/)
  await expect(planInit(repo, { target: 'staging' })).rejects.toThrow(/target\.url/)
  // A desktop build is the third shape, and init says where it is described.
  await expect(planInit(repo)).rejects.toThrow(/a desktop build is checked through a client profile, which is written by hand \(docs\/SPEC\.md, Clients\)/)
})

test('a client profile that is already there holds: init writes the workflow and leaves the profile alone (#75)', async () => {
  const repo = await repoWith({
    '.qa/QA.md': '# QA\n',
    '.qa/config.yml': [
      'client:',
      '  driver: electron',
      '  artefact:',
      '    kind: archive',
      '    executable: greeter/greeter',
      '    head: { path: artefacts/head.tar.gz }',
      '    base: { path: artefacts/base.tar.gz }',
    ].join('\n'),
  })
  // No compose file and no --target: the profile says what the run launches.
  const plan = await planInit(repo)
  expect(plan.kind).toBe('client')
  expect(plan.profile).toEqual([])
  expect(plan.workflow.path).toBe(INIT_WORKFLOW_PATH)
  // Nothing is stubbed for a client, so nothing is re-queued for want of a stub.
  expect(plan.workflow.content).not.toContain('requeue')
  // A compose file kept for development does not turn it into a booted profile.
  const beside = await repoWith({
    '.qa/QA.md': '# QA\n',
    '.qa/config.yml': 'client:\n  driver: electron\n  executable: dist/app/app\n',
    'docker-compose.yml': COMPOSE,
  })
  expect((await planInit(beside)).kind).toBe('client')
})

test('the caller workflow pins this release, and re-queues refused pull requests only for a booted profile', async () => {
  const app = await planInit(await composeRepo(), { defaultBranch: 'trunk', model: 'some-model' })
  expect(app.workflow.path).toBe(INIT_WORKFLOW_PATH)
  const workflow = parse(app.workflow.content) as {
    on: Record<string, { branches?: string[]; paths?: string[] } | null>
    jobs: { qare: { uses: string; with: Record<string, string>; secrets: Record<string, string> } }
  }
  expect(workflow.jobs.qare.uses).toBe(`ViviDynamics/qare/.github/workflows/pipeline.yml@${VERSION}`)
  expect(workflow.jobs.qare.with).toEqual({ 'nare-model': 'some-model' })
  expect(workflow.jobs.qare.secrets).toEqual({ 'model-key': '${{ secrets.OPENAI_API_KEY }}' })
  expect(workflow.on.push).toEqual({ branches: ['trunk'], paths: ['.qa/**'] })
  // A newer push to a pull request supersedes the run of the older one (#374).
  expect((parse(app.workflow.content) as { concurrency: unknown }).concurrency).toEqual({
    group: 'qare-${{ github.event.pull_request.number || github.ref }}',
    'cancel-in-progress': true,
  })
  expect(app.secret).toBe('OPENAI_API_KEY')

  // A branch or a model named like a YAML keyword or a number stays a string.
  const odd = parse(callerWorkflow({ model: '123', requeue: { branch: 'true' } })) as typeof workflow
  expect(odd.jobs.qare.with).toEqual({ 'nare-model': '123' })
  expect(odd.on.push?.branches).toEqual(['true'])
  expect(callerWorkflow({ model: 'null' })).toContain('nare-model: "null"')

  const target = parse(callerWorkflow({ model: 'some-model' })) as { on: Record<string, unknown> }
  expect(Object.keys(target.on)).toEqual(['pull_request'])
  // What is written into a workflow file is never taken as YAML of its own.
  expect(() => callerWorkflow({ model: 'a\nb: c' })).toThrow(InitError)
  expect(() => callerWorkflow({ model: 'm', requeue: { branch: 'a b' } })).toThrow(InitError)
})

test('the profile init writes for a compose example runs as written: readiness names only what a person knows (#374)', async () => {
  const examples = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'examples')
  for (const example of ['compose-app', 'mail-app']) {
    const repo = await mkdtemp(join(tmpdir(), `qare-init-${example}-`))
    await cp(join(examples, example), repo, { recursive: true, filter: (source) => !source.split(sep).includes('.qa') })
    await write(repo, await planInit(repo))
    const profile = await loadProfile(join(repo, '.qa'))
    expect(profile.app?.health.http, example).toBe(url('http', 'localhost:{{run.app_port}}/'))
    // Every gap is a TODO(qare init) line only a person can fill, or the
    // compose file's own missing healthcheck, which the profile does not need:
    // nothing about booting, the port, the stubs or the suites.
    expect((await readinessInventory(repo)).gaps, example).toEqual([
      '.qa/QA.md is not filled in: say what this app is, in a sentence or two',
      '.qa/QA.md is not filled in: say what matters most, so the planner knows what a regression would cost',
      '.qa/QA.md is not filled in: list the pages the flow and visual checks should cover',
      '.qa/QA.md is not filled in: say how to sign in, or that there is no login',
      '.qa/config.yml is not filled in: name the command that seeds the QA data, in place of "true"',
      '.qa/config.yml is not filled in: describe the user QA signs in as in .qa/fixtures/users.yml, and name its role here',
      ...(example === 'compose-app' ? ['service "web" in ./compose.yaml has no healthcheck'] : ['service "mailpit" in ./compose.yaml has no healthcheck', 'service "web" in ./compose.yaml has no healthcheck']),
    ])
  }
})

const PACKAGE = JSON.stringify({ name: 'shop', scripts: { start: 'node server.js' } })

test('a repository with no compose file but a start script gets a profile that boots by command (#379)', async () => {
  const repo = await repoWith({ 'package.json': PACKAGE, 'package-lock.json': '{}', 'playwright.config.ts': 'export default {}\n' })
  const plan = await planInit(repo)
  expect(plan.kind).toBe('app')
  // A command boot has no stubs, so it keeps no stubs directory.
  expect(plan.profile.map((file) => file.path)).toEqual(['.qa/config.yml', '.qa/QA.md', '.qa/fixtures/users.yml'])
  // Nothing is stubbed, so nothing is re-queued for want of a stub.
  expect(Object.keys((parse(plan.workflow.content) as { on: Record<string, unknown> }).on)).toEqual(['pull_request'])

  await write(repo, plan)
  const profile = await loadProfile(join(repo, '.qa'))
  expect(profile.app?.boot).toEqual({ command: 'npm ci && npm start', image: 'node:22', port: 3000 })
  expect(profile.app?.health).toEqual({ http: url('http', 'localhost:{{run.app_port}}/'), timeout: '120s' })
  expect(profile.stubs).toEqual([])
  // A suite runs inside the one service, reached by the run's project alone.
  expect(profile.suites).toEqual([{ name: 'playwright', command: 'docker compose -p qare-{{run.id}} exec -T app npx playwright test', kind: 'command' }])
  // What only a person knows is left as TODO lines readiness reports: the
  // image, the port and the health path are guesses.
  const gaps = (await readinessInventory(repo)).gaps.filter((gap) => gap.startsWith('.qa/config.yml'))
  expect(gaps).toEqual([
    '.qa/config.yml is not filled in: confirm the image the start command runs in: it carries sh and the runtime the app needs, then remove this line',
    '.qa/config.yml is not filled in: confirm the port the app listens on inside the image (qare hands it to the app as PORT), then remove this line',
    '.qa/config.yml is not filled in: confirm the health path answers 200 when the app is up (a redirect does not pass), then remove this line',
    '.qa/config.yml is not filled in: name the command that seeds the QA data, in place of "true"',
    '.qa/config.yml is not filled in: describe the user QA signs in as in .qa/fixtures/users.yml, and name its role here',
  ])
  // Nothing about booting is a gap: no compose file is needed.
  expect((await readinessInventory(repo)).gaps.filter((gap) => gap.includes('compose'))).toEqual([])
})

test('the start command installs with the package manager the lockfile names (#379)', async () => {
  const commandFor = async (files: Record<string, string>): Promise<unknown> => {
    const repo = await repoWith({ 'package.json': PACKAGE, ...files })
    await write(repo, await planInit(repo, { health: '/up' }))
    return (await loadProfile(join(repo, '.qa'))).app?.boot
  }
  expect(await commandFor({ 'pnpm-lock.yaml': '' })).toMatchObject({ command: 'corepack enable && pnpm install --frozen-lockfile && pnpm start' })
  expect(await commandFor({ 'yarn.lock': '' })).toMatchObject({ command: 'corepack enable && yarn install --frozen-lockfile && yarn start' })
  expect(await commandFor({})).toMatchObject({ command: 'npm install && npm start' })
})

test('a compose file still wins over a start script, and a package with no start script boots nothing (#379)', async () => {
  const repo = await composeRepo({ 'package.json': PACKAGE })
  await write(repo, await planInit(repo))
  expect((await loadProfile(join(repo, '.qa'))).app?.boot).toEqual({ compose: 'docker-compose.yml', service: 'web' })

  const none = await repoWith({ 'package.json': JSON.stringify({ scripts: { test: 'vitest' } }) })
  await expect(planInit(none)).rejects.toThrow(/no compose file found and no start script/)
  // --service names a compose service, and a command boot has none to name.
  const started = await repoWith({ 'package.json': PACKAGE })
  await expect(planInit(started, { service: 'web' })).rejects.toThrow(/--service .* names a compose service/)
})

test('a command boot that is already there keeps its command, image and port (#379)', async () => {
  const repo = await repoWith({ 'package.json': PACKAGE })
  await write(repo, await planInit(repo))
  const config = join(repo, '.qa', 'config.yml')
  const { readFile } = await import('node:fs/promises')
  await writeFile(config, (await readFile(config, 'utf8')).replace('boot: { command: "npm install && npm start", image: "node:22", port: 3000 }', 'boot: { command: "bin/serve", image: "ruby:3.3", port: 9292 }'), 'utf8')
  await write(repo, await planInit(repo))
  expect((await loadProfile(join(repo, '.qa'))).app?.boot).toEqual({ command: 'bin/serve', image: 'ruby:3.3', port: 9292 })
})
