import { expect, test } from 'vitest'
import { JobValidationError, PlanValidationError, fingerprintPlan, jobFromPlan, lockPlan, parseJob, parsePlan, type Plan } from '../src/index.js'

// An http check (#378): a request against the app under test and matchers
// decided in code. These tests hold the loaders to the shape and the bounds.

const HTTP = {
  kind: 'http',
  name: 'empty order refused',
  method: 'POST',
  path: '/orders',
  headers: { 'content-type': 'application/json' },
  body: '{"items":[]}',
  timeoutMs: 5000,
  expect: {
    status: 422,
    headers: [{ name: 'content-type', contains: 'json' }],
    json: [{ path: 'error.code', equals: 'empty_order' }, { path: 'error.items', exists: true }],
  },
}

function plan(check: unknown): Plan {
  return parsePlan({ schemaVersion: '1', criteria: [{ id: 'c1', text: 'an empty order is refused', checks: [check] }] })
}

function planError(check: unknown): PlanValidationError {
  try {
    plan(check)
  } catch (error) {
    expect(error).toBeInstanceOf(PlanValidationError)
    return error as PlanValidationError
  }
  throw new Error('expected the plan loader to refuse the check')
}

const CONTEXT = { id: 'pr-1', repoPath: '/work', baseRef: 'a', headRef: 'b', profile: { path: '.qa' }, evidenceDir: 'evidence' }

test('a plan carries an http check with its method, path, headers, body and matchers', () => {
  const loaded = plan(HTTP)
  const criterion = loaded.criteria[0]
  expect(criterion && 'checks' in criterion ? criterion.checks[0] : undefined).toEqual(HTTP)
})

test('a status may be one code or a list of codes, and status is the one matcher always named', () => {
  expect(plan({ ...HTTP, expect: { status: [200, 201] } }).criteria[0]).toMatchObject({ checks: [{ expect: { status: [200, 201] } }] })
  expect(planError({ ...HTTP, expect: { json: HTTP.expect.json } }).field).toBe('criteria[0].checks[0].expect.status')
  expect(planError({ ...HTTP, expect: { status: 99 } }).field).toBe('criteria[0].checks[0].expect.status')
  expect(planError({ ...HTTP, expect: { status: [] } }).field).toBe('criteria[0].checks[0].expect.status')
  expect(planError({ ...HTTP, expect: { status: 200.5 } }).field).toBe('criteria[0].checks[0].expect.status')
  expect(planError({ ...HTTP, expect: undefined }).field).toBe('criteria[0].checks[0].expect')
})

test('the method comes from a fixed set', () => {
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
    expect(() => plan({ ...HTTP, method, ...(method === 'GET' || method === 'HEAD' ? { body: undefined } : {}) })).not.toThrow()
  for (const method of ['CONNECT', 'TRACE', 'get', '', 7])
    expect(planError({ ...HTTP, method }).field).toBe('criteria[0].checks[0].method')
})

test('the target is a path on the app, never a URL or another host', () => {
  for (const path of [['https:', '//elsewhere.example/orders'].join(''), '//elsewhere.example/orders', 'orders', '/orders\nX: y', '/a b', '', '/orders#frag'])
    expect(planError({ ...HTTP, path }).field).toBe('criteria[0].checks[0].path')
  expect(planError({ ...HTTP, path: `/${'a'.repeat(4096)}` }).field).toBe('criteria[0].checks[0].path')
  expect(() => plan({ ...HTTP, path: '/orders/{{run.id}}?draft=1' })).not.toThrow()
})

test('headers are bounded in number and size, and the ones the client controls are refused', () => {
  const many = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`x-h${index}`, 'v']))
  expect(planError({ ...HTTP, headers: many }).field).toBe('criteria[0].checks[0].headers')
  expect(planError({ ...HTTP, headers: { 'x-big': 'v'.repeat(8193) } }).field).toBe('criteria[0].checks[0].headers.x-big')
  for (const name of ['Host', 'content-length', 'Connection', 'transfer-encoding', 'upgrade'])
    expect(planError({ ...HTTP, headers: { [name]: 'x' } }).field).toBe(`criteria[0].checks[0].headers.${name}`)
  expect(planError({ ...HTTP, headers: { 'x-a': 'one\r\nx-b: two' } }).field).toBe('criteria[0].checks[0].headers.x-a')
  expect(planError({ ...HTTP, headers: { 'bad name': 'x' } }).field).toBe('criteria[0].checks[0].headers.bad name')
  expect(planError({ ...HTTP, headers: { 'X-A': '1', 'x-a': '2' } }).field).toBe('criteria[0].checks[0].headers.x-a')
  expect(planError({ ...HTTP, headers: { 'x-n': 1 } }).field).toBe('criteria[0].checks[0].headers.x-n')
})

test('a body is a bounded string, and a GET or HEAD carries none', () => {
  expect(planError({ ...HTTP, body: 'x'.repeat(64 * 1024 + 1) }).field).toBe('criteria[0].checks[0].body')
  expect(planError({ ...HTTP, body: { items: [] } }).field).toBe('criteria[0].checks[0].body')
  expect(planError({ ...HTTP, method: 'GET' }).field).toBe('criteria[0].checks[0].body')
})

test('the timeout is bounded', () => {
  expect(planError({ ...HTTP, timeoutMs: 120001 }).field).toBe('criteria[0].checks[0].timeoutMs')
  expect(planError({ ...HTTP, timeoutMs: 0 }).field).toBe('criteria[0].checks[0].timeoutMs')
})

test('header and JSON matchers name exactly one matcher, and a JSON matcher names a path', () => {
  const base = 'criteria[0].checks[0].expect'
  expect(planError({ ...HTTP, expect: { status: 200, headers: [{ name: 'etag' }] } }).field).toBe(`${base}.headers[0]`)
  expect(planError({ ...HTTP, expect: { status: 200, headers: [{ name: 'etag', exists: true, contains: 'x' }] } }).field).toBe(`${base}.headers[0]`)
  expect(planError({ ...HTTP, expect: { status: 200, headers: [{ contains: 'x' }] } }).field).toBe(`${base}.headers[0].name`)
  expect(planError({ ...HTTP, expect: { status: 200, headers: [{ name: 'etag', equals: 7 }] } }).field).toBe(`${base}.headers[0].equals`)
  expect(planError({ ...HTTP, expect: { status: 200, json: [{ equals: 1 }] } }).field).toBe(`${base}.json[0].path`)
  expect(planError({ ...HTTP, expect: { status: 200, json: [{ path: 'a', matches: '(' }] } }).field).toBe(`${base}.json[0].matches`)
  expect(planError({ ...HTTP, expect: { status: 200, json: [{ path: 'a', exists: 'yes' }] } }).field).toBe(`${base}.json[0].exists`)
  expect(planError({ ...HTTP, expect: { status: 200, json: [] } }).field).toBe(`${base}.json`)
  expect(planError({ ...HTTP, expect: { status: 200, body: 'ok' } }).field).toBe(`${base}.body`)
})

test('an http check becomes a job check that the job loader holds to the same rules', () => {
  const { job, notes } = jobFromPlan(plan(HTTP), CONTEXT)
  expect(notes).toEqual([])
  const { kind, name, method, path, headers, body, timeoutMs, expect: matchers } = HTTP
  expect(job.criteria[0]?.checks).toEqual([{ kind, name, method, path, headers, body, timeoutMs, expect: matchers }])

  const raw = { ...CONTEXT, post: 'none', criteria: [{ id: 'c1', text: 't', checks: [{ ...HTTP, method: 'TRACE' }] }] }
  expect(() => parseJob(raw)).toThrow(JobValidationError)
  expect(() => parseJob(raw)).toThrow(/method/)
})

test('a locked plan keeps every field of an http check, so a changed matcher is a changed plan', () => {
  const { locked } = lockPlan(plan(HTTP))
  expect(locked.criteria[0]).toMatchObject({ checks: [HTTP] })
  expect(fingerprintPlan(plan(HTTP))).not.toBe(fingerprintPlan(plan({ ...HTTP, expect: { ...HTTP.expect, status: 400 } })))
  expect(fingerprintPlan(plan(HTTP))).not.toBe(fingerprintPlan(plan({ ...HTTP, path: '/orders/2' })))
})
