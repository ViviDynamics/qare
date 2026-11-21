import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'
import {
  REDACTED,
  httpCheckUrl,
  redactionRules,
  runHttpCheckJob,
  runJob,
  validateProfileConfig,
  type Job,
  type JobCriterion,
  type JobHttpCheck,
} from '../src/index.js'
import { API_SECRET, startApiServer } from './api-server.js'

// The http check's execution (#378): where a request may go, what it carries,
// how the matchers decide, and what the evidence keeps.

let api: Awaited<ReturnType<typeof startApiServer>>
const made: string[] = []

beforeAll(async () => {
  api = await startApiServer()
})
afterAll(async () => {
  await api.close()
})
afterEach(async () => {
  api.seen.length = 0
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-http-'))
  made.push(dir)
  return dir
}

const EMPTY_ORDER: JobHttpCheck = {
  kind: 'http',
  name: 'empty order',
  method: 'POST',
  path: '/orders',
  headers: { 'content-type': 'application/json', authorization: 'Bearer tok-6d1f0a9c3e' },
  body: '{"items":[]}',
  expect: {
    status: 422,
    headers: [{ name: 'Content-Type', contains: 'json' }],
    json: [{ path: 'error.code', equals: 'empty_order' }, { path: 'error.items', exists: true }],
  },
}

async function run(check: JobHttpCheck, address = { targetUrl: `${api.origin}/app/` }) {
  const evidenceDir = await tempDir()
  const outcome = await runHttpCheckJob({
    check,
    address,
    values: {},
    evidenceDir,
    checkDir: 'checks/c1/0',
    rules: redactionRules({ values: ['hunter2'] }),
    defaultTimeoutMs: 5000,
  })
  const record = outcome.evidence.length === 0 ? undefined : JSON.parse(await readFile(join(evidenceDir, outcome.evidence[0] ?? ''), 'utf8'))
  return { outcome, record }
}

test('a path resolves on the booted app, with the run port pinned, or below the target, and nowhere else', () => {
  const app = { appHealth: 'http://localhost:{{run.app_port}}/up' }
  expect(httpCheckUrl('/orders?x=1', app, { app_port: '54321' })).toEqual({ ok: true, url: 'http://localhost:54321/orders?x=1' })
  expect(httpCheckUrl('/orders', { targetUrl: 'https://shop.example/app/' }, {})).toEqual({ ok: true, url: 'https://shop.example/app/orders' })
  expect(httpCheckUrl('/../admin', { targetUrl: 'https://shop.example/app/' }, {}).ok).toBe(false)
  expect(httpCheckUrl('/%2e%2e/admin', { targetUrl: 'https://shop.example/app/' }, {}).ok).toBe(false)
  expect(httpCheckUrl('//elsewhere.example/x', app, { app_port: '1' }).ok).toBe(false)
  expect(httpCheckUrl('https://elsewhere.example/x', app, { app_port: '1' }).ok).toBe(false)
  expect(httpCheckUrl('/orders', {}, {})).toMatchObject({ ok: false, reason: expect.stringContaining('no app') })
  expect(httpCheckUrl('/orders', { client: true, appHealth: 'http://localhost:3000/up' }, {}).ok).toBe(false)
  // A credential in the target URL is never sent by an http check.
  expect(httpCheckUrl('/orders', { targetUrl: 'https://user:pw@shop.example/' }, {})).toMatchObject({ ok: false, reason: expect.stringContaining('credential') })
})

test('the matchers decide: an empty order refused with 422 passes', async () => {
  const { outcome, record } = await run(EMPTY_ORDER)
  expect(outcome).toMatchObject({ status: 'passed', evidence: ['checks/c1/0/http.json'] })
  expect(record.outcome).toBe('passed')
  expect(record.request).toMatchObject({ method: 'POST', url: `${api.origin}/app/orders` })
  expect(record.response.status).toBe(422)
  expect(record.response.body).toMatchObject({ error: { code: 'empty_order' } })
  // The request carried what the plan wrote and nothing else.
  expect(api.seen[0]?.body).toBe('{"items":[]}')
  expect(api.seen[0]?.headers.authorization).toBe('Bearer tok-6d1f0a9c3e')
  expect(api.seen[0]?.headers.cookie).toBeUndefined()
})

test('a status the response does not have fails the check, naming both', async () => {
  const { outcome, record } = await run({ ...EMPTY_ORDER, expect: { status: [200, 201] } })
  expect(outcome.status).toBe('failed')
  expect(outcome.reason).toContain('422')
  expect(outcome.reason).toContain('200 or 201')
  expect(record.outcome).toBe('failed')
})

test('a header or JSON value that does not hold fails the check', async () => {
  const header = await run({ ...EMPTY_ORDER, expect: { status: 422, headers: [{ name: 'x-request-id', equals: 'r-2' }] } })
  expect(header.outcome.status).toBe('failed')
  expect(header.outcome.reason).toContain('x-request-id')
  const missing = await run({ ...EMPTY_ORDER, expect: { status: 422, headers: [{ name: 'etag', exists: true }] } })
  expect(missing.outcome.status).toBe('failed')
  const json = await run({ ...EMPTY_ORDER, expect: { status: 422, json: [{ path: 'error.code', equals: 'other' }] } })
  expect(json.outcome.status).toBe('failed')
  expect(json.outcome.reason).toContain('error.code')
  // A path no body has is absent, whatever the object inherits.
  const inherited = await run({ ...EMPTY_ORDER, expect: { status: 422, json: [{ path: 'error.constructor', exists: true }] } })
  expect(inherited.outcome.status).toBe('failed')
})

test('a JSON matcher on a body that is not JSON fails, and one on a body cut at the cap is unverified', async () => {
  const text = await run({ kind: 'http', method: 'GET', path: '/text', expect: { status: 200, json: [{ path: 'a', exists: true }] } })
  expect(text.outcome.status).toBe('failed')
  expect(text.outcome.reason).toContain('not JSON')
  const big = await run({ kind: 'http', method: 'GET', path: '/big', expect: { status: 200, json: [{ path: 'blob', exists: true }] } })
  expect(big.outcome.status).toBe('unverified')
  expect(big.record.response.truncated).toBe(true)
  // The evidence keeps a bounded excerpt of the body, whatever the app sent.
  expect(JSON.stringify(big.record).length).toBeLessThan(32 * 1024)
})

test('a redirect is the answer, never followed to another host', async () => {
  const { outcome, record } = await run({ kind: 'http', method: 'GET', path: '/redirect', expect: { status: 302, headers: [{ name: 'location', contains: 'elsewhere' }] } })
  expect(outcome.status).toBe('passed')
  expect(record.response.status).toBe(302)
  expect(api.seen).toHaveLength(1)
})

test('no answer in time is unverified, not failed', async () => {
  const { outcome } = await run({ kind: 'http', method: 'GET', path: '/slow', timeoutMs: 100, expect: { status: 200 } })
  expect(outcome.status).toBe('unverified')
  expect(outcome.reason).toContain('100 ms')
})

test('no app to address is unverified, and nothing is sent', async () => {
  const { outcome } = await run(EMPTY_ORDER, {} as { targetUrl: string })
  expect(outcome.status).toBe('unverified')
  expect(api.seen).toHaveLength(0)
})

test('the evidence is redacted: secret headers both ways, echoed values, and secret keys in the body', async () => {
  const { record } = await run(EMPTY_ORDER)
  expect(record.request.headers.authorization).toBe(REDACTED)
  expect(record.response.headers['set-cookie']).toBe(REDACTED)
  expect(record.response.headers['x-request-id']).toBe('r-1')
  // The app echoed the authorization header into its body: swept too.
  expect(JSON.stringify(record)).not.toContain('tok-6d1f0a9c3e')
  expect(JSON.stringify(record)).not.toContain(API_SECRET)
  const created = await run({ ...EMPTY_ORDER, body: '{"items":[1]}', expect: { status: 201 } })
  expect(created.record.response.body.password).toBe(REDACTED)
  expect(JSON.stringify(created.record)).not.toContain('hunter2')
})

function targetJob(repoPath: string, criteria: JobCriterion[]): Job {
  return {
    id: 'job-http',
    repoPath,
    baseRef: 'main',
    headRef: 'HEAD',
    profile: { inline: validateProfileConfig({ target: { url: `${api.origin}/app/`, health: { http: '/health', timeout: '1s' } } }) },
    criteria,
    evidenceDir: join(repoPath, 'evidence'),
    post: 'none',
  }
}

const UP = { probe: async () => ({ ok: true }), pollIntervalMs: 1 }

test('a run proves or fails a criterion by its http check alone, with run values substituted', async () => {
  const repoPath = await tempDir()
  const job = targetJob(repoPath, [
    { id: 'c1', text: 'an empty order is refused', checks: [{ ...EMPTY_ORDER, headers: { 'content-type': 'application/json', 'x-run': '{{run.id}}' } }] },
    { id: 'c2', text: 'an empty order is accepted', checks: [{ ...EMPTY_ORDER, expect: { status: 201 } }] },
  ])
  const { result } = await runJob(job, UP)
  expect(result.criteria.map((criterion) => criterion.outcome)).toEqual(['proven', 'failed'])
  expect(result.criteria[0]?.evidence).toEqual(['checks/c1/0/http.json'])
  expect(api.seen[0]?.headers['x-run']).not.toContain('{{')
})

test('a run refuses an http check before anything runs when its references or path cannot hold', async () => {
  const repoPath = await tempDir()
  const unknown = targetJob(repoPath, [{ id: 'c1', text: 't', checks: [{ ...EMPTY_ORDER, path: '/orders/{{run.nope}}' }] }])
  const refusedUnknown = (await runJob(unknown, UP)).result
  expect(refusedUnknown.verdict).toBe('refused')
  expect(refusedUnknown.criteria[0]?.reason).toContain('run.nope')
  const climbing = targetJob(repoPath, [{ id: 'c1', text: 't', checks: [{ ...EMPTY_ORDER, path: '/../admin' }] }])
  const refusedClimbing = (await runJob(climbing, UP)).result
  expect(refusedClimbing.verdict).toBe('refused')
  expect(refusedClimbing.criteria[0]?.reason).toContain('climbs out')
  expect(api.seen).toHaveLength(0)
})
