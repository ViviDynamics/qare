import type { MailMessage } from './mailbox.js'

/**
 * How a message was delivered, as a mail check may assert it (#218): whether
 * it passed SPF, DKIM and DMARC, which domain sent it, and where the mailbox
 * says it landed.
 *
 * The receiving provider's verdict is the evidence. qare reads the
 * `Authentication-Results` header (RFC 8601) the receiver added; it verifies
 * no signature and asks no DNS itself. A shortfall here is a fault in the
 * environment (a DNS record, a relay setting), so it leaves a criterion
 * `unverified` with the record named, and never `failed`.
 */

export const AUTH_MECHANISMS = ['spf', 'dkim', 'dmarc'] as const
export type AuthMechanism = (typeof AUTH_MECHANISMS)[number]

/** What a mail check asserts about a message's authentication. */
export interface MailAuthenticationAssertion {
  /** The mechanisms that must pass. */
  require: AuthMechanism[]
  /** The sending domain expected: the domain of the From header, which the passing results must align with. */
  domain?: string
  /** The receiving server whose results count, by its authserv-id. Absent, the topmost header's. */
  authserv?: string
}

/** One result of an `Authentication-Results` header. */
export interface AuthResult {
  method: string
  result: string
  /** The domain the method was evaluated for: smtp.mailfrom or smtp.helo, header.d, header.from. */
  domain?: string
  /** The DKIM selector, when the receiver reported it. */
  selector?: string
  reason?: string
  /** Every ptype.property the receiver wrote, as written. */
  properties: Record<string, string>
}

export interface AuthenticationResults {
  /** The server that judged: the header's authserv-id. */
  authserv: string
  results: AuthResult[]
}

/** The results a check's evidence carries: what the receiver said, and whether each domain aligns with the From domain. */
export interface MailAuthenticationEvidence {
  authserv: string
  from_domain?: string
  results: Array<{ method: string; result: string; domain?: string; selector?: string; aligned?: boolean }>
}

export interface MailDeliveryEvidence {
  authentication?: MailAuthenticationEvidence
  placement?: string
}

export interface DeliveryOutcome {
  status: 'passed' | 'unverified'
  /** Why the assertion is not shown, when it is not. */
  reason?: string
  /** What was read, whichever way it went. Absent when the check asserts nothing about delivery. */
  evidence?: MailDeliveryEvidence
  /** One line for the comment's table. */
  summary?: string
}

/** A header's comments, which nest, taken out; quoted strings are left whole. */
function withoutComments(text: string): string {
  let out = ''
  let depth = 0
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string
    if (char === '\\' && index + 1 < text.length) {
      if (depth === 0) out += char + (text[index + 1] as string)
      index += 1
      continue
    }
    if (depth === 0 && char === '"') quoted = !quoted
    if (!quoted && char === '(') {
      depth += 1
      continue
    }
    if (!quoted && char === ')' && depth > 0) {
      depth -= 1
      // A comment stands where white space may: the words either side stay apart.
      out += ' '
      continue
    }
    if (depth === 0) out += char
  }
  return out
}

/** Split on a separator that is not inside a quoted string. */
function splitOutsideQuotes(text: string, separator: string): string[] {
  const parts: string[] = []
  let current = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string
    if (char === '\\' && index + 1 < text.length) {
      current += char + (text[index + 1] as string)
      index += 1
      continue
    }
    if (char === '"') quoted = !quoted
    if (!quoted && char === separator) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts
}

function unquote(value: string): string {
  const trimmed = value.trim()
  return trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2 ? trimmed.slice(1, -1).replace(/\\(.)/g, '$1') : trimmed
}

/** The domain of an address or a bare domain, lower case: what follows the last @, or the whole. */
function domainOf(value: string): string | undefined {
  const bare = value.trim().replace(/^<|>$/g, '')
  const domain = bare.slice(bare.lastIndexOf('@') + 1).toLowerCase().replace(/\.$/, '')
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(domain) ? domain : undefined
}

/** The domain of a From header: `Name <local@domain>` or `local@domain`. */
export function fromDomain(from: string): string | undefined {
  const angled = /<([^<>]*)>\s*$/.exec(from)
  const address = angled === null ? from : (angled[1] ?? '')
  return address.includes('@') ? domainOf(address) : undefined
}

/**
 * Read one `Authentication-Results` header value (RFC 8601): the authserv-id,
 * then `method=result` with its reason and its `ptype.property=value` pairs,
 * separated by semicolons. Comments and folding are taken out. Undefined for
 * a value that names no server; a part that is not `method=result` is left
 * out, never guessed at.
 */
export function parseAuthenticationResults(header: string): AuthenticationResults | undefined {
  const flat = withoutComments(header.replace(/\r?\n[ \t]+/g, ' ')).trim()
  const [first, ...rest] = splitOutsideQuotes(flat, ';')
  const authserv = (first ?? '').trim().split(/\s+/)[0] ?? ''
  if (authserv === '' || authserv.includes('=')) return undefined
  const results: AuthResult[] = []
  for (const part of rest) {
    // Tokens are words and `name = value` pairs; white space may sit around the equals sign.
    const tokens = part.trim().replace(/\s*=\s*/g, '=').match(/(?:[^\s"]+|"(?:[^"\\]|\\.)*")+/g) ?? []
    const head = tokens[0] ?? ''
    const methodPair = /^([a-z0-9-]+)(?:\/\d+)?=(.+)$/i.exec(head)
    if (methodPair === null) continue
    const properties: Record<string, string> = {}
    let reason: string | undefined
    for (const token of tokens.slice(1)) {
      const at = token.indexOf('=')
      if (at <= 0) continue
      const name = token.slice(0, at).toLowerCase()
      const value = unquote(token.slice(at + 1))
      if (name === 'reason') reason = value
      else if (name.includes('.')) properties[name] = value
    }
    const method = (methodPair[1] ?? '').toLowerCase()
    const named =
      method === 'spf'
        ? (properties['smtp.mailfrom'] ?? properties['smtp.helo'])
        : method === 'dkim'
          ? (properties['header.d'] ?? properties['header.i'])
          : method === 'dmarc'
            ? properties['header.from']
            : undefined
    const domain = named === undefined ? undefined : domainOf(named)
    const selector = method === 'dkim' ? properties['header.s'] : undefined
    results.push({
      method,
      result: unquote(methodPair[2] ?? '').toLowerCase(),
      ...(domain === undefined ? {} : { domain }),
      ...(selector === undefined ? {} : { selector }),
      ...(reason === undefined ? {} : { reason }),
      properties,
    })
  }
  return { authserv: authserv.toLowerCase(), results }
}

/**
 * Whether two domains align the way DMARC's relaxed mode means it, as far as
 * it can be told without the public suffix list: they are the same domain, or
 * one is a subdomain of the other. It is a reading of the names alone, and
 * the receiver's own `dmarc=` result is the verdict that counts.
 */
function aligns(one: string, other: string): boolean {
  return one === other || one.endsWith(`.${other}`) || other.endsWith(`.${one}`)
}

/** The DNS record a failing result points at, in the words a person would look it up by. */
function recordAtFault(result: { method: string; domain?: string; selector?: string }, from: string | undefined): string {
  if (result.method === 'spf') return result.domain === undefined ? 'the SPF record of the envelope sender' : `the SPF record of ${result.domain}`
  if (result.method === 'dkim')
    return result.domain === undefined ? "the DKIM key of the signing domain" : `the DKIM key ${result.selector ?? '<selector>'}._domainkey.${result.domain}`
  const domain = result.domain ?? from
  return domain === undefined ? 'the DMARC record of the From domain' : `the DMARC record _dmarc.${domain}`
}

function propertyOf(result: { method: string; domain?: string }): string {
  if (result.domain === undefined) return ''
  const name = result.method === 'spf' ? 'smtp.mailfrom' : result.method === 'dkim' ? 'header.d' : 'header.from'
  return ` for ${name}=${result.domain}`
}

/**
 * Hold a message to what a mail check asserts about its delivery. Nothing
 * here ever fails a criterion: a mechanism that did not pass, a domain that
 * is not the one expected, a placement that is not the one expected, and a
 * source that reports none of it are each `unverified`, with what was read
 * and what is at fault named.
 */
export function assessDelivery(
  message: MailMessage,
  check: { authentication?: MailAuthenticationAssertion; placement?: string },
  source: string,
): DeliveryOutcome {
  if (check.authentication === undefined && check.placement === undefined) return { status: 'passed' }
  const evidence: MailDeliveryEvidence = {}
  const summary: string[] = []
  const reasons: string[] = []

  if (check.authentication !== undefined) {
    const assertion = check.authentication
    const headers = (message.headers?.['authentication-results'] ?? []).map(parseAuthenticationResults).filter((parsed): parsed is AuthenticationResults => parsed !== undefined)
    // A sender can write this header too. A receiver adds its own above what
    // it was sent, so the topmost is the receiver's unless the check names it.
    const wanted = assertion.authserv?.toLowerCase()
    const judged = wanted === undefined ? headers[0] : headers.find((parsed) => parsed.authserv === wanted)
    if (judged === undefined || judged.results.length === 0) {
      reasons.push(
        wanted !== undefined && headers.length > 0
          ? `${source} reports no authentication results from ${wanted} for the message (it carries results from ${[...new Set(headers.map((parsed) => parsed.authserv))].join(', ')}), so its authentication cannot be shown`
          : `${source} reports no authentication results for the message, so its authentication cannot be shown: a catcher in the stack receives mail without judging it, and only a receiving provider adds them`,
      )
    } else {
      const from = fromDomain(message.from)
      const expected = assertion.domain?.toLowerCase()
      const reference = expected ?? from
      const results = judged.results
        .filter((result) => (AUTH_MECHANISMS as readonly string[]).includes(result.method))
        .map((result) => ({
          method: result.method,
          result: result.result,
          ...(result.domain === undefined ? {} : { domain: result.domain }),
          ...(result.selector === undefined ? {} : { selector: result.selector }),
          ...(result.domain === undefined || reference === undefined ? {} : { aligned: aligns(result.domain, reference) }),
        }))
      evidence.authentication = { authserv: judged.authserv, ...(from === undefined ? {} : { from_domain: from }), results }
      summary.push(`${results.map((result) => `${result.method}=${result.result}${result.domain === undefined ? '' : ` (${result.domain})`}`).join(', ')}, judged by ${judged.authserv}`)

      if (expected !== undefined && (from === undefined || !aligns(from, expected)))
        reasons.push(`the message was sent from ${from ?? 'an address with no domain'}, and the check expects ${expected}`)
      for (const mechanism of assertion.require) {
        const reported = results.filter((result) => result.method === mechanism)
        if (reported.length === 0) {
          reasons.push(`${judged.authserv} reports no ${mechanism} result for the message`)
          continue
        }
        // With a sending domain expected, a pass counts when it is for a
        // domain that aligns with it: a relay's own signature passing says
        // nothing about the domain the message claims to be from.
        const counts = (result: (typeof results)[number]): boolean => result.result === 'pass' && (expected === undefined || result.aligned === true)
        if (reported.some(counts)) continue
        const fault = reported.find((result) => result.result !== 'pass' && (expected === undefined || result.aligned !== false)) ?? reported.find((result) => result.result !== 'pass') ?? reported[0]
        if (fault === undefined) continue
        reasons.push(
          fault.result === 'pass'
            ? `${mechanism}=pass${propertyOf(fault)}, which does not align with ${expected ?? 'the From domain'}; look at ${recordAtFault({ ...fault, domain: expected ?? fault.domain }, from)}`
            : `${mechanism}=${fault.result}${propertyOf(fault)}; look at ${recordAtFault(fault, from)}`,
        )
      }
      if (reasons.length > 0) reasons[reasons.length - 1] += ` (${judged.authserv}'s verdict, read from the Authentication-Results header)`
    }
  }

  if (check.placement !== undefined) {
    if (message.placement === undefined) {
      reasons.push(`${source} does not say where a message landed, so its placement cannot be shown`)
    } else {
      evidence.placement = message.placement
      summary.push(`landed in ${message.placement}`)
      if (message.placement.toLowerCase() !== check.placement.toLowerCase())
        reasons.push(`the message landed in ${message.placement}, and the check expects ${check.placement}`)
    }
  }

  const carried = Object.keys(evidence).length === 0 ? {} : { evidence }
  const line = summary.length === 0 ? {} : { summary: summary.join('; ') }
  if (reasons.length === 0) return { status: 'passed', ...carried, ...line }
  return { status: 'unverified', reason: `the message's delivery is not as the check asserts: ${reasons.join('; ')}`, ...carried, ...line }
}
