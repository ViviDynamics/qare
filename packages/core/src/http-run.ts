import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { httpCheckUrl, type FlowAddressContext } from './app-address.js'
import type { HttpHeaderAssertion, HttpJsonAssertion } from './http-check.js'
import type { JobHttpCheck } from './job.js'
import { judgeToolAssertion } from './mcp.js'
import { REDACTED, redactText, redactValue, valueRules, type RedactionRule } from './redact.js'
import type { RunValues } from './values.js'

/** How much of a response body the check reads; past it the body is cut, and a JSON matcher cannot look. */
export const MAX_HTTP_RESPONSE_BYTES = 1024 * 1024
/** How much of a request or response body the evidence keeps. */
export const MAX_HTTP_EVIDENCE_BODY = 16 * 1024

/** Headers whose value is a credential, whichever way it travels. */
const SECRET_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie'])

export interface HttpCheckJobInput {
  /** The check, with the run's values already substituted. */
  check: JobHttpCheck
  /** How the app under test is addressed on this side of the run. */
  address: FlowAddressContext
  values: RunValues
  evidenceDir: string
  /** The check's directory, relative to the evidence directory. */
  checkDir: string
  rules: readonly RedactionRule[]
  defaultTimeoutMs: number
}

export interface HttpCheckOutcome {
  status: 'passed' | 'failed' | 'unverified'
  reason?: string
  evidence: string[]
}

/**
 * Send one http check's request and judge the response (#378). The request
 * goes only to the app under test (`httpCheckUrl`), carries only what the plan
 * wrote, and follows no redirect. The status, header and JSON matchers decide
 * the outcome in code, never a model. Anything that is not the app's answer
 * (nowhere to send it, no answer in time, a body too large to judge) is
 * unverified; an answer the matchers refuse is failed. The request and the
 * response are recorded in `http.json`, redacted, with the bodies capped.
 */
export async function runHttpCheckJob(input: HttpCheckJobInput): Promise<HttpCheckOutcome> {
  const { check } = input
  const target = httpCheckUrl(check.path, input.address, input.values)
  if (!target.ok) return { status: 'unverified', reason: target.reason, evidence: [] }
  const headers = check.headers ?? {}
  // A credential the plan wrote is swept wherever it shows up again, an
  // echo in the response body included.
  const secrets = Object.entries(headers).flatMap(([name, value]) => (isSecretHeader(name) ? [value, ...value.split(/\s+/).slice(1)] : []))
  const rules = [...input.rules, ...valueRules(secrets.filter((secret) => secret.length >= 4))]
  const timeoutMs = check.timeoutMs ?? input.defaultTimeoutMs
  const request = {
    method: check.method,
    url: target.url,
    headers: evidenceHeaders(headers),
    ...(check.body === undefined ? {} : { body: evidenceBody(check.body, false, rules) }),
  }
  const record = async (fields: Record<string, unknown>): Promise<string[]> => {
    const dir = join(input.evidenceDir, input.checkDir)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'http.json'), `${JSON.stringify(redactValue({ request, ...fields }, rules), null, 2)}\n`)
    return [`${input.checkDir}/http.json`]
  }

  const signal = AbortSignal.timeout(timeoutMs)
  let response: Response
  let read: { bytes: Buffer; truncated: boolean }
  try {
    // Only the plan's headers: nothing from the job's environment is added.
    response = await fetch(target.url, {
      method: check.method,
      headers,
      ...(check.body === undefined ? {} : { body: check.body }),
      redirect: 'manual',
      signal,
    })
    read = await readCapped(response, MAX_HTTP_RESPONSE_BYTES)
  } catch (error) {
    const reason = signal.aborted
      ? `the app did not answer ${check.method} ${check.path} within ${timeoutMs} ms`
      : `the app did not answer ${check.method} ${check.path}: ${describeError(error)}`
    return { status: 'unverified', reason, evidence: await record({ error: reason, outcome: 'unverified' }) }
  }

  const text = read.bytes.toString('utf8')
  const failures: string[] = []
  const expected = Array.isArray(check.expect.status) ? check.expect.status : [check.expect.status]
  if (!expected.includes(response.status))
    failures.push(`the response status was ${response.status}, expected ${expected.join(' or ')}`)
  for (const assertion of check.expect.headers ?? []) {
    const failure = judgeHeader(assertion, response.headers)
    if (failure !== undefined) failures.push(failure)
  }
  let unverified: string | undefined
  const json = check.expect.json ?? []
  if (json.length > 0) {
    if (read.truncated) unverified = `the response body is larger than ${MAX_HTTP_RESPONSE_BYTES} bytes, so its JSON matchers could not be judged`
    else {
      const parsed = parseJson(text)
      if (!parsed.ok) failures.push('the response body is not JSON, so its JSON matchers do not hold')
      else for (const assertion of json) if (!judgeToolAssertion(assertion, { text, structured: parsed.value, isError: false })) failures.push(describeJson(assertion))
    }
  }
  const status: HttpCheckOutcome['status'] = failures.length > 0 ? 'failed' : unverified !== undefined ? 'unverified' : 'passed'
  const responseHeaders: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    responseHeaders[name] = value
  })
  const evidence = await record({
    response: {
      status: response.status,
      headers: evidenceHeaders(responseHeaders),
      body: evidenceBody(text, read.truncated, rules),
      ...(read.truncated ? { truncated: true } : {}),
    },
    failures,
    outcome: status,
  })
  const reason = failures.length > 0 ? failures.join('; ') : unverified
  return { status, ...(reason === undefined ? {} : { reason: redactText(reason, rules) }), evidence }
}

function isSecretHeader(name: string): boolean {
  const lower = name.toLowerCase()
  return SECRET_HEADERS.has(lower) || /(?:^|-)(?:api-?key|auth|token|secret|password|session)(?:-|$)/.test(lower)
}

/** Header names lower-cased, credential values replaced; the rest is swept with the run's rules when written. */
function evidenceHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), isSecretHeader(name) ? REDACTED : value]))
}

/**
 * A body as the evidence keeps it: parsed when it is JSON that fits, so the
 * redaction of secret keys reaches it, otherwise its text, swept before it is
 * cut so nothing straddles the cut.
 */
function evidenceBody(text: string, truncated: boolean, rules: readonly RedactionRule[]): unknown {
  if (!truncated && text.length <= MAX_HTTP_EVIDENCE_BODY) {
    const parsed = parseJson(text)
    if (parsed.ok) return parsed.value
  }
  const swept = redactText(text, rules)
  return swept.length <= MAX_HTTP_EVIDENCE_BODY ? swept : `${swept.slice(0, MAX_HTTP_EVIDENCE_BODY)}\n[cut at ${MAX_HTTP_EVIDENCE_BODY} characters]`
}

async function readCapped(response: Response, cap: number): Promise<{ bytes: Buffer; truncated: boolean }> {
  if (response.body === null) return { bytes: Buffer.alloc(0), truncated: false }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return { bytes: Buffer.concat(chunks), truncated: false }
    const room = cap - total
    if (value.byteLength > room) {
      chunks.push(Buffer.from(value.subarray(0, room)))
      await reader.cancel().catch(() => undefined)
      return { bytes: Buffer.concat(chunks), truncated: true }
    }
    chunks.push(Buffer.from(value))
    total += value.byteLength
  }
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text.trim() === '') return { ok: false }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false }
  }
}

function judgeHeader(assertion: HttpHeaderAssertion, headers: Headers): string | undefined {
  const value = headers.get(assertion.name)
  const name = assertion.name.toLowerCase()
  if (assertion.exists !== undefined)
    return (value !== null) === assertion.exists ? undefined : `the ${name} header is ${value === null ? 'absent' : 'present'}, expected it ${assertion.exists ? 'present' : 'absent'}`
  if (value === null) return `the ${name} header is absent`
  if (assertion.equals !== undefined && value !== assertion.equals) return `the ${name} header does not equal ${JSON.stringify(assertion.equals)}`
  if (assertion.contains !== undefined && !value.includes(assertion.contains)) return `the ${name} header does not contain ${JSON.stringify(assertion.contains)}`
  if (assertion.matches !== undefined && !new RegExp(assertion.matches).test(value)) return `the ${name} header does not match ${JSON.stringify(assertion.matches)}`
  return undefined
}

function describeJson(assertion: HttpJsonAssertion): string {
  const matcher =
    assertion.exists !== undefined
      ? assertion.exists
        ? 'exists'
        : 'is absent'
      : assertion.contains !== undefined
        ? `contains ${JSON.stringify(assertion.contains)}`
        : assertion.matches !== undefined
          ? `matches ${JSON.stringify(assertion.matches)}`
          : `equals ${JSON.stringify(assertion.equals)}`
  return `the JSON body at ${JSON.stringify(assertion.path)} does not hold: expected it ${matcher}`
}

function describeError(error: unknown): string {
  const cause = (error as { cause?: unknown }).cause
  if (cause instanceof Error) return cause.message
  return error instanceof Error ? error.message : String(error)
}
