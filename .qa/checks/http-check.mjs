import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import './source.mjs'

// Executable checks of the http check kind (#378), run against the
// checkout's core source without a build. The app is a fetch stand-in in
// this process: a contained check has no network, and none is needed to
// show what the harness sends, records and decides. Each check prints what
// it observed. Scratch is restricted to .qa/checks/scratch.

const core = (file) => import(`../../packages/core/src/${file}`)
const scratch = fileURLToPath(new URL('./scratch/', import.meta.url))
await mkdir(scratch, { recursive: true })
const TARGET = ['https:', '//shop.example.test/api/'].join('')
const TOKEN = 'tok-6d1f0a9c3e5b'
const COOKIE = 'sess-0f9c2e7d41b8a6'

const EMPTY_ORDER = {
  kind: 'http',
  name: 'empty order refused',
  method: 'POST',
  path: '/orders',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
  body: '{"items":[]}',
  expect: {
    status: 422,
    headers: [{ name: 'content-type', contains: 'json' }],
    json: [{ path: 'error.code', equals: 'empty_order' }],
  },
}

// The app under test, standing in for fetch: an empty order is refused,
// and the answer echoes the credential and sets a cookie, as a careless
// API would, so the evidence's redaction has something to do.
const sent = []
globalThis.fetch = async (url, init = {}) => {
  sent.push({ url: String(url), method: init.method, headers: { ...init.headers }, body: init.body, redirect: init.redirect })
  const items = JSON.parse(init.body ?? '{}').items ?? []
  const status = items.length === 0 ? 422 : 201
  const body = status === 422 ? { error: { code: 'empty_order' }, echo: init.headers?.authorization ?? null } : { id: 7, password: 'hunter2' }
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'set-cookie': `session=${COOKIE}; HttpOnly`, 'x-request-id': 'r-1' },
  })
}

const check = process.argv[2]
const dir = await mkdtemp(join(scratch, 'http-'))
try {
  if (check === 'plan') {
    // A plan carries an http check with a method, a path, headers, a body
    // and matchers, and the loader refuses what falls outside the bounds.
    const { parsePlan, PlanValidationError } = await core('plan.ts')
    const planOf = (one) => parsePlan({ schemaVersion: '1', criteria: [{ id: 'c1', text: 'an empty order is refused', checks: [one] }] })
    const loaded = planOf(EMPTY_ORDER).criteria[0].checks[0]
    assert.deepEqual(loaded, EMPTY_ORDER)
    const refused = {}
    for (const [label, bad] of Object.entries({
      'a URL to another host': { ...EMPTY_ORDER, path: ['https:', '//elsewhere.example/orders'].join('') },
      'a method outside the set': { ...EMPTY_ORDER, method: 'TRACE' },
      'no status matcher': { ...EMPTY_ORDER, expect: { json: EMPTY_ORDER.expect.json } },
      'a header the client writes': { ...EMPTY_ORDER, headers: { host: 'elsewhere.example' } },
      'a matcher the harness does not read': { ...EMPTY_ORDER, expect: { status: 200, body: 'ok' } },
    })) {
      try {
        planOf(bad)
        assert.fail(`${label} was accepted`)
      } catch (error) {
        assert.ok(error instanceof PlanValidationError, `${label}: ${error}`)
        refused[label] = error.message
      }
    }
    console.log(JSON.stringify({ check, loaded, refused }, null, 2))
  } else if (check === 'record') {
    // The evidence records the request and the response status, headers and
    // body, redacted by qare's rules.
    const { runHttpCheckJob } = await core('http-run.ts')
    const { redactionRules } = await core('redact.ts')
    const outcome = await runHttpCheckJob({
      check: EMPTY_ORDER,
      address: { targetUrl: TARGET },
      values: {},
      evidenceDir: dir,
      checkDir: 'checks/c1/0',
      rules: redactionRules(),
      defaultTimeoutMs: 5000,
    })
    assert.deepEqual(outcome.evidence, ['checks/c1/0/http.json'])
    const text = await readFile(join(dir, 'checks/c1/0/http.json'), 'utf8')
    const record = JSON.parse(text)
    assert.equal(record.request.method, 'POST')
    assert.equal(record.request.url, `${TARGET}orders`)
    assert.deepEqual(record.request.body, { items: [] })
    assert.equal(record.response.status, 422)
    assert.equal(record.response.headers['x-request-id'], 'r-1')
    assert.equal(record.response.body.error.code, 'empty_order')
    assert.equal(record.request.headers.authorization, '[redacted]')
    assert.equal(record.response.headers['set-cookie'], '[redacted]')
    assert.ok(!text.includes(TOKEN), 'the credential the plan wrote is in the evidence')
    assert.ok(!text.includes(COOKIE), 'the cookie the app set is in the evidence')
    console.log(JSON.stringify({ check, outcome: outcome.status, written: outcome.evidence }))
    console.log(text)
  } else if (check === 'judge') {
    // The matchers decide: one job, run by the checkout's runJob against a
    // target, with no model anywhere, proves one criterion and fails another
    // on the same answer, by what each check's matchers say.
    const { runJob } = await core('run.ts')
    const job = {
      id: 'http-self-check', repoPath: dir, baseRef: 'main', headRef: 'HEAD', post: 'none', evidenceDir: join(dir, 'evidence'),
      profile: { inline: { target: { url: TARGET, health: { http: '/health', timeout: '1s' } } } },
      criteria: [
        { id: 'refused', text: 'an empty order is refused with 422', checks: [EMPTY_ORDER] },
        { id: 'accepted', text: 'an empty order is accepted with 201', checks: [{ ...EMPTY_ORDER, expect: { status: 201 } }] },
        { id: 'code', text: 'the refusal names another code', checks: [{ ...EMPTY_ORDER, expect: { status: 422, json: [{ path: 'error.code', equals: 'other' }] } }] },
      ],
    }
    const { result } = await runJob(job, { probe: async () => ({ ok: true }), pollIntervalMs: 1 })
    const outcomes = Object.fromEntries(result.criteria.map((criterion) => [criterion.id, { outcome: criterion.outcome, ...(criterion.reason === undefined ? {} : { reason: criterion.reason }) }]))
    assert.deepEqual(Object.fromEntries(Object.entries(outcomes).map(([id, one]) => [id, one.outcome])), { refused: 'proven', accepted: 'failed', code: 'failed' })
    assert.equal(sent.length, 3)
    assert.ok(sent.every((request) => request.redirect === 'manual'), 'a redirect would be followed')
    assert.ok(sent.every((request) => Object.keys(request.headers).sort().join() === 'authorization,content-type'), 'the request carried more than the plan wrote')
    console.log(JSON.stringify({ check, outcomes, sent: sent.map(({ url, method }) => ({ url, method })) }, null, 2))
  } else if (check === 'planner') {
    // The planner's prompt describes the http kind, and a profile with no
    // browser flavour is offered it and keeps it: the checkout's planRun,
    // with a stand-in model that answers an http check.
    const { FakeAgentRunner } = await core('runner.ts')
    const { planRun } = await core('plan-step.ts')
    const answer = JSON.stringify({ schemaVersion: '1', criteria: [{ id: 'c1', text: 'POST /orders with no items returns 422', checks: [EMPTY_ORDER] }] })
    const runner = new FakeAgentRunner([{ status: 'completed', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, output: answer }])
    const plan = await planRun(runner, {
      criteria: [{ id: 'c1', text: 'POST /orders with no items returns 422' }],
      diff: 'diff --git a/app/orders.rb b/app/orders.rb',
      target: TARGET.replace(/\/api\/$/, ''),
      noBrowser: { flavour: 'core' },
    })
    const [request] = runner.requests
    const kinds = JSON.parse(request.outputSchema).properties.criteria.items.properties.checks.items.properties.kind.enum
    assert.deepEqual(kinds, ['command', 'mail', 'http'])
    assert.equal(runner.requests.length, 1, 'the http check was corrected on a browserless profile')
    assert.equal(plan.criteria[0].checks[0].kind, 'http')
    const lines = request.prompt.split('\n').filter((line) => /http|ships no browser/i.test(line))
    assert.ok(lines.some((line) => line.startsWith('- http: {"kind":"http"')))
    assert.ok(request.prompt.includes('qare-core'))
    console.log(JSON.stringify({ check, flavour: 'core', offered: kinds, planned: plan.criteria[0].checks[0].kind }))
    console.log(lines.join('\n'))
  } else {
    throw new Error(`unknown check ${JSON.stringify(check)}: expected plan, record, judge or planner`)
  }
} finally {
  await rm(dir, { recursive: true, force: true })
}
