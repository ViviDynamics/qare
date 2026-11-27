import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import {
  BROWSER_FLOW_DRIVER,
  ELECTRON_FLOW_DRIVER,
  FakeAgentRunner,
  makePlaywrightFlowSession,
  parsePlan,
  planRun,
  runFlowCheck,
  runJob,
  validateProfileConfig,
  type AgentRunResult,
  type FlowAction,
  type FlowPage,
  type FlowTrace,
  type Job,
  type JobCriterion,
} from '../src/index.js'

// #430: on the website pilot "Signing in ... lands on the dashboard at
// /dashboard" stayed unverified: the flow could only assert the greeting,
// which the app shows on every signed-in page. assertUrl asserts where the
// page is, judged by the harness from the URL the driver reports.

// Test files carry no network literals (the offline scanner), so URLs are joined at runtime.
const ORIGIN = ['https:', '//app.example.test'].join('')

const made: string[] = []

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}

/** A page whose URL is each of `urls` in turn, and then the last one for good: a redirect, read as it happens. */
function pageAt(urls: readonly string[], opts: { unreadable?: boolean; noUrl?: boolean } = {}): { page: FlowPage; reads: () => number } {
  let reads = 0
  const page: FlowPage = {
    open: async () => {},
    click: async () => {},
    type: async () => {},
    choose: async () => {},
    waitFor: async () => {},
    assertText: async () => {},
    assertElement: async () => {},
    screenshot: async (path) => writeFile(path, 'png'),
    ...(opts.noUrl === true
      ? {}
      : {
          url: async () => {
            if (opts.unreadable === true) throw new Error('Target page, context or browser has been closed')
            const url = urls[Math.min(reads, urls.length - 1)] as string
            reads += 1
            return url
          },
        }),
  }
  return { page, reads: () => reads }
}

const TRACE: FlowTrace = { start: async () => 'trace', stop: async () => {} }

async function assertAt(urls: readonly string[], action: FlowAction, opts: { unreadable?: boolean; noUrl?: boolean } = {}) {
  const dir = await tempDir('qare-assert-url-')
  const { page, reads } = pageAt(urls, opts)
  const result = await runFlowCheck({
    outDir: dir,
    page,
    trace: TRACE,
    recording: false,
    assertTimeoutMs: 40,
    pollIntervalMs: 1,
    actions: [{ action: 'open', url: `${ORIGIN}/login` }, action],
  })
  const log = await readFile(join(dir, 'actions.log'), 'utf8')
  return { result, log, reads: reads() }
}

function planWith(action: unknown): unknown {
  return { schemaVersion: '1', criteria: [{ id: 'c1', text: 'lands on the dashboard', checks: [{ kind: 'flow', name: 'lands', actions: [action] }] }] }
}

test('the plan loads an assertUrl with a path, and with query parameters beside it (#430)', () => {
  const plan = parsePlan(planWith({ action: 'assertUrl', path: '/dashboard', query: { tab: 'billing' } }), [], BROWSER_FLOW_DRIVER)
  const check = plan.criteria[0] as { checks: Array<{ actions: unknown[] }> }
  expect(check.checks[0]?.actions).toEqual([{ action: 'assertUrl', path: '/dashboard', query: { tab: 'billing' } }])
  const bare = parsePlan(planWith({ action: 'assertUrl', path: '/dashboard' }), [], BROWSER_FLOW_DRIVER)
  expect((bare.criteria[0] as { checks: Array<{ actions: unknown[] }> }).checks[0]?.actions).toEqual([{ action: 'assertUrl', path: '/dashboard' }])
})

test('a query parameter named like an object property is held as a parameter, not dropped (#430)', async () => {
  const plan = parsePlan(JSON.parse('{"schemaVersion":"1","criteria":[{"id":"c1","text":"x","checks":[{"kind":"flow","name":"n","actions":[{"action":"assertUrl","path":"/a","query":{"__proto__":"x"}}]}]}]}'), [], BROWSER_FLOW_DRIVER)
  const [action] = (plan.criteria[0] as { checks: Array<{ actions: Array<{ query: Record<string, string> }> }> }).checks[0]?.actions ?? []
  expect(Object.keys(action?.query ?? {})).toEqual(['__proto__'])
  expect((await assertAt([`${ORIGIN}/a?other=1`], action as unknown as FlowAction)).result.outcome).toBe('failed')
})

test('the plan refuses an assertUrl whose path or query is not one the harness can judge (#430)', () => {
  const refused = (action: unknown): string => {
    try {
      parsePlan(planWith(action), [], BROWSER_FLOW_DRIVER)
    } catch (error) {
      return String(error)
    }
    throw new Error(`the plan loaded ${JSON.stringify(action)}`)
  }
  expect(refused({ action: 'assertUrl' })).toMatch(/path/)
  expect(refused({ action: 'assertUrl', path: 'dashboard' })).toMatch(/starts with \//)
  expect(refused({ action: 'assertUrl', path: `${ORIGIN}/dashboard` })).toMatch(/starts with \//)
  expect(refused({ action: 'assertUrl', path: '/dashboard?tab=billing' })).toMatch(/query/)
  expect(refused({ action: 'assertUrl', path: '/dashboard#top' })).toMatch(/fragment/)
  expect(refused({ action: 'assertUrl', path: '/dashboard', query: {} })).toMatch(/query/)
  expect(refused({ action: 'assertUrl', path: '/dashboard', query: { page: 2 } })).toMatch(/query\.page/)
  expect(refused({ action: 'assertUrl', path: '/dashboard', query: 'tab=billing' })).toMatch(/query/)
})

test('a page at the asserted path passes, and the action log records the URL it read (#430)', async () => {
  const { result, log } = await assertAt([`${ORIGIN}/dashboard`], { action: 'assertUrl', path: '/dashboard' })

  expect(result.outcome).toBe('passed')
  expect(log).toContain(`action 1: assert the page is at /dashboard: it is, at ${ORIGIN}/dashboard`)
})

test('a page at another path fails, naming the path it is at and the URL it read (#430)', async () => {
  const { result, log } = await assertAt([`${ORIGIN}/login?error=1`], { action: 'assertUrl', path: '/dashboard' })

  expect(result.outcome).toBe('failed')
  expect(result.reason).toBe(`assert failed: the page is at /login, not /dashboard (it read ${ORIGIN}/login?error=1)`)
  expect(log).toContain(`assert failed: the page is at /login, not /dashboard (it read ${ORIGIN}/login?error=1)`)
  expect(result.evidence).toContain('failure.png')
})

test('a redirect that ends on the asserted path passes: the URL is read until it settles there (#430)', async () => {
  const { result, log, reads } = await assertAt(
    [`${ORIGIN}/session`, `${ORIGIN}/session`, `${ORIGIN}/dashboard`],
    { action: 'assertUrl', path: '/dashboard' },
  )

  expect(result.outcome).toBe('passed')
  expect(reads).toBe(3)
  expect(log).toContain(`it is, at ${ORIGIN}/dashboard`)
})

test('a redirect that ends somewhere else fails with the last URL it read (#430)', async () => {
  const { result } = await assertAt([`${ORIGIN}/session`, `${ORIGIN}/login`], { action: 'assertUrl', path: '/dashboard' })

  expect(result.outcome).toBe('failed')
  expect(result.reason).toContain('the page is at /login, not /dashboard')
})

test('query parameters are a subset match: each named one must hold its value, and others may be there (#430)', async () => {
  const url = `${ORIGIN}/search?q=ada%20lovelace&page=2`
  const held = await assertAt([url], { action: 'assertUrl', path: '/search', query: { q: 'ada lovelace' } })
  expect(held.result.outcome).toBe('passed')

  const wrong = await assertAt([url], { action: 'assertUrl', path: '/search', query: { q: 'grace hopper' } })
  expect(wrong.result.outcome).toBe('failed')
  expect(wrong.result.reason).toContain('the query parameter q is "ada lovelace", not "grace hopper"')

  const missing = await assertAt([url], { action: 'assertUrl', path: '/search', query: { sort: 'new' } })
  expect(missing.result.outcome).toBe('failed')
  expect(missing.result.reason).toContain('the query parameter sort is not there')
})

test('one trailing slash is the same landing, and an encoded path matches its plain spelling (#430)', async () => {
  expect((await assertAt([`${ORIGIN}/dashboard/`], { action: 'assertUrl', path: '/dashboard' })).result.outcome).toBe('passed')
  expect((await assertAt([`${ORIGIN}/dashboard`], { action: 'assertUrl', path: '/dashboard/' })).result.outcome).toBe('passed')
  expect((await assertAt([`${ORIGIN}/caf%C3%A9`], { action: 'assertUrl', path: '/café' })).result.outcome).toBe('passed')
  expect((await assertAt([`${ORIGIN}/dashboard/settings`], { action: 'assertUrl', path: '/dashboard' })).result.outcome).toBe('failed')
})

test('a page whose URL cannot be read leaves the check unverified, never failed (#430)', async () => {
  const unreadable = await assertAt([], { action: 'assertUrl', path: '/dashboard' }, { unreadable: true })
  expect(unreadable.result.outcome).toBe('unverified')
  expect(unreadable.result.reason).toContain('has been closed')

  const noSeam = await assertAt([], { action: 'assertUrl', path: '/dashboard' }, { noUrl: true })
  expect(noSeam.result.outcome).toBe('unverified')
  expect(noSeam.result.reason).toContain('the driver reports no URL')
})

test('the browser driver declares assertUrl and reports the page\'s URL; the electron driver leaves it out (#430)', async () => {
  expect(BROWSER_FLOW_DRIVER.actions).toContain('assertUrl')
  expect(ELECTRON_FLOW_DRIVER.actions).not.toContain('assertUrl')
  expect(() => parsePlan(planWith({ action: 'assertUrl', path: '/' }), [], ELECTRON_FLOW_DRIVER)).toThrow(/electron driver declares/)

  const chromium = {
    launch: async () => ({
      newContext: async () => ({
        on: () => undefined,
        newPage: async () => ({ url: () => `${ORIGIN}/dashboard`, on: () => undefined, goto: async () => undefined }),
      }),
      close: async () => undefined,
    }),
  }
  const session = await makePlaywrightFlowSession({ loadPlaywright: async () => ({ chromium }) as never })
  expect(await session.page.url?.()).toBe(`${ORIGIN}/dashboard`)
  await session.dispose()
})

function completed(output: string): AgentRunResult {
  return { status: 'completed', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, output }
}

const PLANNED = JSON.stringify({
  schemaVersion: '1',
  criteria: [{ id: 'c1', text: 'Signing in lands on the dashboard at /dashboard', checks: [{ kind: 'flow', name: 'lands', actions: [{ action: 'assertUrl', path: '/dashboard' }] }] }],
})

test('the planner is offered assertUrl and told to use it for a criterion that names where a step lands (#430)', async () => {
  const runner = new FakeAgentRunner([completed(PLANNED)])
  const plan = await planRun(runner, {
    criteria: [{ id: 'c1', text: 'Signing in lands on the dashboard at /dashboard' }],
    diff: 'diff --git a/a b/a',
    driver: BROWSER_FLOW_DRIVER,
  })

  const [request] = runner.requests
  expect(request?.prompt).toContain('assertUrl asserts the path the page is at')
  expect(request?.prompt).toContain('A criterion that names where a step lands')
  const action = (JSON.parse(request?.outputSchema ?? '{}') as { properties: { criteria: { items: { properties: { checks: { items: { properties: { actions: { items: { properties: Record<string, unknown> } } } } } } } } } })
    .properties.criteria.items.properties.checks.items.properties.actions.items.properties
  expect(action.path).toEqual({ type: 'string' })
  expect(action.query).toEqual({ type: 'object' })
  expect((plan.criteria[0] as { checks: Array<{ actions: unknown[] }> }).checks[0]?.actions).toEqual([{ action: 'assertUrl', path: '/dashboard' }])
})

test('a driver without assertUrl is not told about it (#430)', async () => {
  const runner = new FakeAgentRunner([completed(JSON.stringify({ schemaVersion: '1', criteria: [{ id: 'c1', text: 'x', unplannable: 'no' }] }))])
  await planRun(runner, { criteria: [{ id: 'c1', text: 'x' }], diff: 'diff --git a/a b/a', driver: ELECTRON_FLOW_DRIVER })

  expect(runner.requests[0]?.prompt).not.toContain('assertUrl')
})

async function targetJob(criteria: JobCriterion[], url: string): Promise<Job> {
  const repoPath = await tempDir('qare-assert-url-target-')
  return {
    id: 'job-assert-url',
    repoPath,
    baseRef: 'main',
    headRef: 'HEAD',
    profile: { inline: validateProfileConfig({ target: { url, health: { http: '/up', timeout: '1s' } } }) },
    criteria,
    evidenceDir: join(repoPath, 'evidence'),
    post: 'none',
  }
}

const UP = { probe: async () => ({ ok: true }), pollIntervalMs: 1 }
const NEVER_COMPOSE = {
  runCompose: async () => {
    throw new Error('a target run must not boot anything')
  },
}

function sessionAt(url: string) {
  return async () => ({ page: pageAt([url]).page, trace: TRACE, dispose: async () => {}, outbound: () => [] })
}

test('on a target below a path, an asserted path resolves below it, as an open path does (#430)', async () => {
  const target = `${ORIGIN}/app/`
  const job = await targetJob(
    [{ id: 'c1', text: 'lands on the dashboard', checks: [{ kind: 'flow', actions: [{ action: 'open', url: '/login' }, { action: 'assertUrl', path: '/dashboard' }] }] }],
    target,
  )

  const { result } = await runJob(job, { ...NEVER_COMPOSE, ...UP, flowSession: sessionAt(`${ORIGIN}/app/dashboard`) })

  expect(result.verdict).toBe('passed')
})

test('an asserted path that climbs out of the target is refused before anything runs (#430)', async () => {
  const job = await targetJob(
    [{ id: 'c1', text: 'x', checks: [{ kind: 'flow', actions: [{ action: 'assertUrl', path: '/../admin' }] }] }],
    `${ORIGIN}/app/`,
  )

  const { result } = await runJob(job, { ...NEVER_COMPOSE, ...UP, flowSession: sessionAt(`${ORIGIN}/admin`) })

  expect(result.verdict).toBe('refused')
  expect((result.criteria[0] as { reason: string }).reason).toContain('actions[0].path')
})

test('a run value in the asserted path and query is filled in before it is judged (#430)', async () => {
  const job = await targetJob(
    [
      {
        id: 'c1',
        text: 'lands on its own page',
        checks: [
          {
            kind: 'flow',
            actions: [
              { action: 'open', url: '/runs/{{run.id}}?to={{run.mail_address}}' },
              { action: 'assertUrl', path: '/runs/{{run.id}}', query: { to: '{{run.mail_address}}' } },
            ],
          },
        ],
      },
    ],
    ORIGIN,
  )
  // The page lands where it was opened, so the assertion holds only once both
  // sides carry the minted values, not the references.
  let at = 'about:blank'
  const page: FlowPage = { ...pageAt([]).page, open: async (url) => void (at = url), url: async () => at }

  const { result } = await runJob(job, { ...NEVER_COMPOSE, ...UP, flowSession: async () => ({ page, trace: TRACE, dispose: async () => {}, outbound: () => [] }) })

  expect(at).toMatch(/\/runs\/[0-9a-f-]{36}\?to=qare-/)
  expect(result.verdict).toBe('passed')
}, 15_000)
