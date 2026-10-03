import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
  expect(plan.profile.map((file) => file.path)).toEqual(['.qa/config.yml', '.qa/QA.md', '.qa/fixtures/users.yml', '.qa/stubs/.gitkeep'])

  await write(repo, plan)
  const profile = await loadProfile(join(repo, '.qa'))
  // The service built from the repository, not the database beside it, and
  // the health check its own healthcheck asks for, on the port it publishes.
  expect(profile.app?.boot).toEqual({ compose: 'docker-compose.yml', service: 'web' })
  expect(profile.app?.health).toEqual({ http: url('http', 'localhost:8080/up'), timeout: '120s' })
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
  expect(config).toContain(`http: ${JSON.stringify(url('http', 'localhost:3000/'))}`)
  expect(config).toContain('TODO(qare init): the service "api" publishes no port: publish one, and correct the health URL')
})

test('the application service can be named, and a name the compose file does not define is refused', async () => {
  const repo = await composeRepo()
  await write(repo, await planInit(repo, { service: 'worker' }))
  expect((await loadProfile(join(repo, '.qa'))).app?.boot.service).toBe('worker')
  await expect(planInit(repo, { service: 'nope' })).rejects.toThrow(
    new InitError('--service "nope" is not a service of ./docker-compose.yml (it defines db, web, worker)'),
  )
})

test('the suites init recognises are written as suites', async () => {
  const repo = await composeRepo({
    'playwright.config.ts': 'export default {}\n',
    'features/checkout/pay.feature': 'Feature: pay\n',
    Gemfile: "gem 'cucumber'\n",
    'spec/system/login_spec.rb': '# spec\n',
  })
  await write(repo, await planInit(repo))
  expect((await loadProfile(join(repo, '.qa'))).suites).toEqual([
    { name: 'cucumber', command: 'bundle exec cucumber', kind: 'command' },
    { name: 'playwright', command: 'npx playwright test', kind: 'command' },
    { name: 'rspec-system', command: 'bundle exec rspec spec/system', kind: 'command' },
  ])
  // Without a Gemfile, Cucumber is the JavaScript one.
  const js = await repoWith({ 'compose.yml': 'services:\n  web: {}\n', 'features/a.feature': 'Feature: a\n' })
  await write(js, await planInit(js))
  expect((await loadProfile(join(js, '.qa'))).suites).toEqual([{ name: 'cucumber', command: 'npx cucumber-js', kind: 'command' }])
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
  expect((await loadProfile(join(booted, '.qa'))).app?.health.http).toBe(url('http', 'localhost:8080/healthz'))
  await expect(planInit(booted, { health: 'healthz' })).rejects.toThrow(/--health "healthz" is not a path/)
})

test('with no compose file and no target there is nothing to write, and init says which flag is missing', async () => {
  const repo = await repoWith({ 'README.md': 'hello' })
  await expect(planInit(repo)).rejects.toThrow(InitError)
  await expect(planInit(repo)).rejects.toThrow(/no compose file.*--target <url>/)
  await expect(planInit(repo, { target: 'staging' })).rejects.toThrow(/target\.url/)
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
  expect(app.secret).toBe('OPENAI_API_KEY')

  const target = parse(callerWorkflow({ model: 'some-model' })) as { on: Record<string, unknown> }
  expect(Object.keys(target.on)).toEqual(['pull_request'])
  // What is written into a workflow file is never taken as YAML of its own.
  expect(() => callerWorkflow({ model: 'a\nb: c' })).toThrow(InitError)
  expect(() => callerWorkflow({ model: 'm', requeue: { branch: 'a b' } })).toThrow(InitError)
})
