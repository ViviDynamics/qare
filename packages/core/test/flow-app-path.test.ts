import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  FakeAgentRunner,
  bootedAppOrigin,
  flowOpenUrl,
  planRun,
  plannedAppAddress,
  runJob,
  type AgentRunResult,
  type FlowPage,
  type FlowTrace,
  type Job,
  type JobCriterion,
  type QaProfile,
} from '../src/index.js'

// #264: a planner writes {"action":"open","url":"/auth/sign_in"} for an app
// whose port is chosen per run, and the browser refused it: "Cannot navigate
// to invalid URL". The profile named the app's address only in its health
// check, and nothing resolved a path against the app the run booted.

const local = (rest: string): string => ['http:', rest].join('')
// Nothing here is reached: these are addresses a profile may carry, built so no literal names the network.
const secure = (rest: string): string => ['https:', rest].join('')
const HEALTH_BY_VALUE = local('//localhost:{{run.app_port}}/up')
const HEALTH_FIXED = local('//localhost:3000/up')

function profileWith(health: string): QaProfile {
  return {
    app: {
      boot: { compose: 'compose.qa.yaml', service: 'web' },
      health: { http: health, timeout: '120s' },
      seed: { command: 'true' },
      login: { fixture: 'fixtures/users.yml', role: 'admin' },
    },
    stubs: [],
    visual: { widths: [1440], themes: ['light'] },
    suites: [],
  }
}

const HEALTHY_BOOT = {
  runCompose: async () => ({ code: 0, stdout: '', stderr: '' }),
  probe: async () => ({ ok: true }),
  pollIntervalMs: 1,
}

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

function session(events: string[]) {
  return async () => {
    const page: FlowPage = {
      open: async (url) => void events.push(`open ${url}`),
      click: async () => void events.push('click'),
      type: async () => void events.push('type'),
      choose: async () => void events.push('choose'),
      waitFor: async () => void events.push('waitFor'),
      assertText: async (text) => void events.push(`assert ${text}`),
      assertElement: async () => void events.push('assertElement'),
      screenshot: async (path) => {
        const { writeFile } = await import('node:fs/promises')
        await writeFile(path, PNG_1X1)
      },
    }
    const trace: FlowTrace = { start: async () => 'trace-1', stop: async () => {} }
    return { page, trace, dispose: async () => void events.push('dispose') }
  }
}

async function jobFor(profile: QaProfile, ...urls: string[]): Promise<Job> {
  const repoPath = await mkdtemp(join(tmpdir(), 'qare-flow-app-path-'))
  const criteria: JobCriterion[] = [
    {
      id: 'criterion-1',
      text: 'a member signs in',
      checks: [{ kind: 'flow', actions: [...urls.map((url) => ({ action: 'open' as const, url })), { action: 'assertText', text: 'Sign in' }] }],
    },
  ]
  return { id: 'job-flow-app-path', repoPath, baseRef: 'main', headRef: 'HEAD~1', profile: { inline: profile }, criteria, evidenceDir: join(repoPath, 'evidence'), post: 'none' }
}

async function runPort(job: Job): Promise<number> {
  const isolation = JSON.parse(await readFile(join(job.evidenceDir, 'isolation.json'), 'utf8')) as { port: number }
  return isolation.port
}

test('a flow that opens a path opens it on the app the run booted, at the origin of the health check with the run port', async () => {
  const events: string[] = []
  const job = await jobFor(profileWith(HEALTH_BY_VALUE), '/auth/sign_in')

  const { result } = await runJob(job, { ...HEALTHY_BOOT, flowSession: session(events) })

  expect(result.criteria[0]).toMatchObject({ outcome: 'proven' })
  const port = await runPort(job)
  expect(events[0]).toBe(`open ${local(`//localhost:${port}/auth/sign_in`)}`)
  // The action log names where the flow really went, so a reader can tell.
  expect(await readFile(join(job.evidenceDir, 'checks', 'criterion-1', '0', 'actions.log'), 'utf8')).toContain(`open ${local(`//localhost:${port}/auth/sign_in`)}`)
})

test('a health check that names a fixed local port is pinned to the run port, and the path follows it', async () => {
  const events: string[] = []
  const job = await jobFor(profileWith(HEALTH_FIXED), '/auth/sign_in?next=%2Fdashboard#form')

  await runJob(job, { ...HEALTHY_BOOT, flowSession: session(events) })

  const port = await runPort(job)
  expect(port).not.toBe(3000)
  expect(events[0]).toBe(`open ${local(`//localhost:${port}/auth/sign_in?next=%2Fdashboard#form`)}`)
})

test('the full address works too: a URL that names {{run.app_port}} opens the same app, and a path after it stays there', async () => {
  const events: string[] = []
  const job = await jobFor(profileWith(HEALTH_BY_VALUE), local('//localhost:{{run.app_port}}/auth/sign_in'), '/dashboard')

  const { result } = await runJob(job, { ...HEALTHY_BOOT, flowSession: session(events) })

  expect(result.criteria[0]).toMatchObject({ outcome: 'proven' })
  const port = await runPort(job)
  expect(events.slice(0, 2)).toEqual([`open ${local(`//localhost:${port}/auth/sign_in`)}`, `open ${local(`//localhost:${port}/dashboard`)}`])
})

test('a path cannot name another host: leading slashes are a path on the app, never a protocol-relative URL', async () => {
  const events: string[] = []
  const job = await jobFor(profileWith(HEALTH_BY_VALUE), '//elsewhere.example/steal')

  await runJob(job, { ...HEALTHY_BOOT, flowSession: session(events) })

  const port = await runPort(job)
  expect(events[0]).toBe(`open ${local(`//localhost:${port}/elsewhere.example/steal`)}`)
})

test('a path opened when the run booted no app and names no target is refused with a reason that says so', () => {
  const values = { id: 'r1', mail_address: 'qare-r1@localhost', app_port: '41234' }
  const nowhere = flowOpenUrl('/auth/sign_in', {}, values)
  expect(nowhere.ok).toBe(false)
  expect(nowhere).toMatchObject({ reason: expect.stringMatching(/"\/auth\/sign_in".*booted no app.*names no target/) })
  // A health check that names no origin is the same gap: there is nowhere to open the path.
  expect(flowOpenUrl('/auth/sign_in', { appHealth: 'not a url' }, values)).toMatchObject({ ok: false, reason: expect.stringMatching(/health URL.*names no origin/) })

  // What is not a path, or is another driver's to resolve, is left as written.
  expect(flowOpenUrl(secure('//elsewhere.example/x'), {}, values)).toEqual({ ok: true, url: secure('//elsewhere.example/x') })
  expect(flowOpenUrl('/settings', { client: true }, values)).toEqual({ ok: true, url: '/settings' })
  expect(flowOpenUrl('/wiki/Ada', { targetUrl: secure('//en.wikipedia.org') }, values)).toEqual({ ok: true, url: '/wiki/Ada' })
  expect(flowOpenUrl('/auth/sign_in', { appHealth: HEALTH_BY_VALUE }, values)).toEqual({ ok: true, url: local('//localhost:41234/auth/sign_in') })
})

test('a flow whose path has no app to be a page of leaves its criterion unverified, never failed, and opens nothing', async () => {
  const events: string[] = []
  // The one run that can reach the gap: an app whose health check names no origin a page could be on.
  const job = await jobFor(profileWith('localhost-without-a-scheme/up'), '/auth/sign_in')

  const { result } = await runJob(job, { ...HEALTHY_BOOT, flowSession: session(events) })

  expect(result.verdict).not.toBe('failed')
  expect(result.criteria[0]).toMatchObject({ id: 'criterion-1', outcome: 'unverified' })
  expect((result.criteria[0] as { reason?: string }).reason).toMatch(/"\/auth\/sign_in".*names no origin/)
  expect(events.filter((event) => event.startsWith('open'))).toEqual([])
})

test('the origin of the booted app is the health check with the run values, pinned to the run port', () => {
  const values = { id: 'r1', mail_address: 'qare-r1@localhost', app_port: '41234' }
  expect(bootedAppOrigin(HEALTH_BY_VALUE, values)).toBe(local('//localhost:41234'))
  expect(bootedAppOrigin(HEALTH_FIXED, values)).toBe(local('//localhost:41234'))
  // A health check on a host that is not local is taken as written: qare rewrites only what it can name.
  expect(bootedAppOrigin(secure('//staging.example/up'), values)).toBe(secure('//staging.example'))
  expect(bootedAppOrigin('not a url', values)).toBeUndefined()
})

test('the address the planner is told is the one that works in a plan: the run port by name, never a guessed number', () => {
  expect(plannedAppAddress(HEALTH_BY_VALUE)).toBe(local('//localhost:{{run.app_port}}'))
  // A fixed local port is pinned to the run's at run time, so the number in the profile is not where the app will be.
  expect(plannedAppAddress(HEALTH_FIXED)).toBe(local('//localhost:{{run.app_port}}'))
  expect(plannedAppAddress(local('//127.0.0.1:8080/healthz'))).toBe(local('//127.0.0.1:{{run.app_port}}'))
  expect(plannedAppAddress(secure('//staging.example/up'))).toBe(secure('//staging.example'))
  expect(plannedAppAddress('not a url')).toBeUndefined()
  // Credentials in a health URL are the profile's, not the planner's: the address is the origin, with no userinfo.
  expect(plannedAppAddress(local('//qa:hunter2-live@localhost:3000/up'))).toBe(local('//localhost:{{run.app_port}}'))
  expect(plannedAppAddress(local('//qa:hunter2-live@localhost:{{run.app_port}}/up'))).toBe(local('//localhost:{{run.app_port}}'))
  expect(plannedAppAddress(secure('//qa:hunter2-live@staging.example/up'))).toBe(secure('//staging.example'))
})

function completed(output: string): AgentRunResult {
  return { status: 'completed', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, output }
}

const ANSWER = JSON.stringify({
  schemaVersion: '1',
  criteria: [{ id: 'c1', text: 'a member signs in', checks: [{ kind: 'flow', name: 'sign in', actions: [{ action: 'open', url: '/auth/sign_in' }, { action: 'assertText', text: 'Sign in' }] }] }],
})
const CRITERIA = [{ id: 'c1', text: 'a member signs in' }]

test('the planner is told how a booted app is addressed: by path, or by the address with the run port', async () => {
  const runner = new FakeAgentRunner([completed(ANSWER)])

  const plan = await planRun(runner, { criteria: CRITERIA, diff: 'diff --git a/a b/a', app: { address: local('//localhost:{{run.app_port}}') } })

  expect(plan.criteria[0]).toMatchObject({ checks: [{ kind: 'flow', actions: [{ action: 'open', url: '/auth/sign_in' }, { action: 'assertText' }] }] })
  const prompt = runner.requests[0]?.prompt ?? ''
  expect(prompt).toContain(`The run boots the app itself and publishes it on a port chosen for the run, so its address is ${local('//localhost:{{run.app_port}}')}`)
  expect(prompt).toContain('{"action":"open","url":"/some/page"}')
  expect(prompt).toContain(`{"action":"open","url":"${local('//localhost:{{run.app_port}}/some/page')}"}`)
  expect(prompt).toMatch(/Never write a port number/)

  // A plan with nothing booted is told nothing of the kind.
  const bare = new FakeAgentRunner([completed(ANSWER)])
  await planRun(bare, { criteria: CRITERIA, diff: 'diff --git a/a b/a' })
  expect(bare.requests[0]?.prompt).not.toContain('The run boots the app itself')
})

test('a health URL that carries credentials reaches neither the planner nor the page a path opens on', async () => {
  const health = local('//qa:hunter2-live@localhost:{{run.app_port}}/up')
  const runner = new FakeAgentRunner([completed(ANSWER)])
  await planRun(runner, { criteria: CRITERIA, diff: 'diff --git a/a b/a', app: { address: plannedAppAddress(health) ?? '' } })
  expect(runner.requests[0]?.prompt).not.toContain('hunter2-live')
  expect(runner.requests[0]?.prompt).toContain(`its address is ${local('//localhost:{{run.app_port}}')}.`)

  const values = { id: 'r1', mail_address: 'qare-r1@localhost', app_port: '41234' }
  expect(flowOpenUrl('/auth/sign_in', { appHealth: health }, values)).toEqual({ ok: true, url: local('//localhost:41234/auth/sign_in') })
})

test('without a browser the planner still hears where a command reaches the booted app, and nothing about flows opening pages', async () => {
  const runner = new FakeAgentRunner([completed(JSON.stringify({ schemaVersion: '1', criteria: [{ id: 'c1', text: 'a member signs in', checks: [{ kind: 'command', name: 'unit', command: 'node --version' }] }] }))])

  await planRun(runner, { criteria: CRITERIA, diff: 'diff --git a/a b/a', app: { address: local('//localhost:{{run.app_port}}') }, noBrowser: { flavour: 'core' } })

  const prompt = runner.requests[0]?.prompt ?? ''
  expect(prompt).toContain(`its address is ${local('//localhost:{{run.app_port}}')}`)
  expect(prompt).not.toContain('"action":"open"')
})
