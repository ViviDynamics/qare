// The shape of an http check (#378), shared by the plan and job loaders. A
// model may plan one, so every field it carries is bounded here, where the
// plan loads: nothing downstream is left to decide whether a request is one
// the harness may send.

export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const
export type HttpMethod = (typeof HTTP_METHODS)[number]

/** The most headers one request may carry. */
export const MAX_HTTP_HEADERS = 32
/** The longest header value, in bytes. */
export const MAX_HTTP_HEADER_BYTES = 8 * 1024
/** The largest request body, in bytes. */
export const MAX_HTTP_BODY_BYTES = 64 * 1024
/** The longest path, in characters. */
export const MAX_HTTP_PATH = 2048
/** The longest an http check may wait for its answer. */
export const MAX_HTTP_TIMEOUT_MS = 120_000

/**
 * Headers the client itself writes from the request, or that change how the
 * connection is used: a plan that set one would be asking the harness to lie
 * about the request it sends, so they are refused.
 */
const CLIENT_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'expect',
])

/** A header name as RFC 9110 writes a token. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** One matcher on a response header, named case-insensitively. */
export interface HttpHeaderAssertion {
  name: string
  equals?: string
  contains?: string
  matches?: string
  exists?: boolean
}

/** One matcher on the JSON body, at a dot path, judged the way a tool result's is. */
export interface HttpJsonAssertion {
  path: string
  equals?: unknown
  contains?: string
  matches?: string
  exists?: boolean
}

/** What the response must show. The status is always named. */
export interface HttpExpect {
  status: number | number[]
  headers?: HttpHeaderAssertion[]
  json?: HttpJsonAssertion[]
}

/** The fields an http check carries in a plan and in a job alike. */
export interface HttpCheckFields {
  method: HttpMethod
  /** A path on the app under test, never a URL. */
  path: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  expect: HttpExpect
}

type Fail = (field: string, message: string) => never

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read an http check's fields, refusing anything outside the bounds. `fail`
 * throws the caller's own error type, so a plan and a job each report the
 * field in their own terms.
 */
export function parseHttpFields(value: Record<string, unknown>, base: string, fail: Fail): HttpCheckFields {
  const method = value.method
  if (typeof method !== 'string' || !(HTTP_METHODS as readonly string[]).includes(method))
    fail(`${base}.method`, `method must be one of ${HTTP_METHODS.join(', ')}`)
  const path = parsePath(value.path, `${base}.path`, fail)
  const headers = parseHeaders(value.headers, `${base}.headers`, fail)
  let body: string | undefined
  if (value.body !== undefined) {
    if (typeof value.body !== 'string') fail(`${base}.body`, 'body must be a string; a JSON body is written as its text with a content-type header')
    if (method === 'GET' || method === 'HEAD') fail(`${base}.body`, `a ${method} request carries no body`)
    if (Buffer.byteLength(value.body, 'utf8') > MAX_HTTP_BODY_BYTES) fail(`${base}.body`, `body must be at most ${MAX_HTTP_BODY_BYTES} bytes`)
    body = value.body
  }
  let timeoutMs: number | undefined
  if (value.timeoutMs !== undefined) {
    const timeout = value.timeoutMs
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_HTTP_TIMEOUT_MS)
      fail(`${base}.timeoutMs`, `timeoutMs must be a positive number of milliseconds, at most ${MAX_HTTP_TIMEOUT_MS}`)
    timeoutMs = timeout
  }
  const expect = parseExpect(value.expect, `${base}.expect`, fail)
  return {
    method: method as HttpMethod,
    path,
    ...(headers === undefined ? {} : { headers }),
    ...(body === undefined ? {} : { body }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    expect,
  }
}

function parsePath(value: unknown, field: string, fail: Fail): string {
  if (typeof value !== 'string' || value === '') fail(field, 'path must be a non-empty string')
  // A path, and only a path: the run resolves it on the app it booted or on
  // the profile's target, so a plan never names a host (#378).
  if (!value.startsWith('/') || value.startsWith('//'))
    fail(field, `path ${JSON.stringify(value)} must be a path on the app, starting with one "/": an http check never names a host`)
  if (value.length > MAX_HTTP_PATH) fail(field, `path must be at most ${MAX_HTTP_PATH} characters`)
  if (/[\s\x00-\x1f\x7f#\\]/.test(value)) fail(field, 'path must not contain whitespace, control characters, a backslash or a fragment')
  return value
}

function parseHeaders(value: unknown, field: string, fail: Fail): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) fail(field, 'headers must be an object of string values')
  const entries = Object.entries(value)
  if (entries.length > MAX_HTTP_HEADERS) fail(field, `a request carries at most ${MAX_HTTP_HEADERS} headers`)
  const seen = new Set<string>()
  for (const [name, header] of entries) {
    const at = `${field}.${name}`
    if (!HEADER_NAME.test(name)) fail(at, `${JSON.stringify(name)} is not a header name`)
    const lower = name.toLowerCase()
    if (CLIENT_HEADERS.has(lower)) fail(at, `the ${lower} header is written by the client from the request, never by a plan`)
    if (seen.has(lower)) fail(at, `the ${lower} header is named more than once`)
    seen.add(lower)
    if (typeof header !== 'string') fail(at, 'a header value must be a string')
    if (/[\r\n\x00]/.test(header)) fail(at, 'a header value must not contain a line break or a NUL')
    if (Buffer.byteLength(header, 'utf8') > MAX_HTTP_HEADER_BYTES) fail(at, `a header value must be at most ${MAX_HTTP_HEADER_BYTES} bytes`)
  }
  return value as Record<string, string>
}

const EXPECT_FIELDS = ['status', 'headers', 'json']

function parseExpect(value: unknown, field: string, fail: Fail): HttpExpect {
  if (!isRecord(value))
    fail(field, 'an http check names what the response must show in expect, at least its status; nothing is judged by a model')
  // A matcher the harness does not read would pass silently: refused.
  for (const key of Object.keys(value))
    if (!EXPECT_FIELDS.includes(key)) fail(`${field}.${key}`, `expect names status, headers and json matchers only, not ${JSON.stringify(key)}`)
  const status = parseStatus(value.status, `${field}.status`, fail)
  const headers = value.headers === undefined ? undefined : parseMatchers(value.headers, `${field}.headers`, 'name', fail)
  const json = value.json === undefined ? undefined : parseMatchers(value.json, `${field}.json`, 'path', fail)
  return {
    status,
    ...(headers === undefined ? {} : { headers: headers as unknown as HttpHeaderAssertion[] }),
    ...(json === undefined ? {} : { json: json as unknown as HttpJsonAssertion[] }),
  }
}

function parseStatus(value: unknown, field: string, fail: Fail): number | number[] {
  const one = (code: unknown, at: string): number => {
    if (typeof code !== 'number' || !Number.isInteger(code) || code < 100 || code > 599)
      fail(at, 'a status is a whole number from 100 to 599')
    return code
  }
  if (value === undefined) fail(field, 'an http check always names the status the response must have')
  if (Array.isArray(value)) {
    if (value.length === 0) fail(field, 'a status list names at least one status')
    return value.map((code, index) => one(code, `${field}[${index}]`))
  }
  return one(value, field)
}

const MATCHERS = ['equals', 'contains', 'matches', 'exists']

function parseMatchers(value: unknown, field: string, key: 'name' | 'path', fail: Fail): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length === 0) fail(field, `${field} must be a non-empty array of matchers`)
  return value.map((entry, index) => {
    const at = `${field}[${index}]`
    if (!isRecord(entry)) fail(at, `a matcher is an object with a ${key} and one of ${MATCHERS.join(', ')}`)
    const target = entry[key]
    if (typeof target !== 'string' || target.trim() === '') fail(`${at}.${key}`, `a matcher names a ${key}`)
    const named = MATCHERS.filter((matcher) => entry[matcher] !== undefined)
    if (named.length !== 1)
      fail(at, `a matcher names exactly one of ${MATCHERS.join(', ')}${named.length > 1 ? `, not ${named.join(' and ')}` : ''}`)
    const matcher = named[0] as string
    const matched = entry[matcher]
    if ((matcher === 'contains' || matcher === 'matches' || (matcher === 'equals' && key === 'name')) && (typeof matched !== 'string' || matched === ''))
      fail(`${at}.${matcher}`, `${matcher} must be a non-empty string`)
    if (matcher === 'exists' && typeof matched !== 'boolean') fail(`${at}.exists`, 'exists must be a boolean')
    if (matcher === 'matches') {
      try {
        new RegExp(matched as string)
      } catch (error) {
        fail(`${at}.matches`, `not a valid pattern (${error instanceof Error ? error.message : String(error)})`)
      }
    }
    return { [key]: target, [matcher]: matched }
  })
}
