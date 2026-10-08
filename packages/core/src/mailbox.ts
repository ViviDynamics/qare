import type { MailAuthenticationEvidence } from './mail-auth.js'

export interface MailMessage {
  from: string
  subject: string
  body: string
  received_at: string
  /**
   * The message's headers, where the source can report them (#218): names in
   * lower case, each with its values top first, as the message carries them.
   */
  headers?: Record<string, string[]>
  /** Where the mailbox says the message landed (inbox, spam, a folder), where it says (#218). */
  placement?: string
}

export interface MailEvidenceMessage {
  from: string
  subject: string
  excerpt: string
  links: string[]
  received_at: string
  wait_ms: number
  polls: number
  /** What the receiving provider said of the message's authentication, when the check asserts it (#218). */
  authentication?: MailAuthenticationEvidence
  /** Where the mailbox says the message landed, when the check asserts it (#218). */
  placement?: string
}

/**
 * The message a mail check read, as a result carries it and the comment
 * shows it (#65): the sender, the subject, an excerpt and its links, with
 * addresses and one-time codes already swept. Never the whole body.
 */
export interface MailProof {
  /** The mail check's name, or its position in the criterion when it has none. */
  check: string
  from: string
  subject: string
  excerpt: string
  links: string[]
  /** How the message was delivered, in one line, when the check asserts it (#218): the provider's results and the placement. */
  delivery?: string
}

export type ReadMail = (address: string, after: string, signal?: AbortSignal) => Promise<MailMessage[]>

export type MailOutcome =
  | { status: 'passed'; message: MailMessage; waitMs: number; polls: number }
  | { status: 'unverified'; reason: string }

const MAIL_POLL_INTERVAL_MS = 500

/**
 * The listing contract a mail inbox implements for a `mail` check: a GET of the
 * inbox URL with `address` and `after` query parameters answers with the
 * messages sent to that address. Anything that cannot be reached is the
 * caller's `unverified`, never a failed criterion: an unreachable mailbox is an
 * environment problem, not a product failure.
 */
export function httpMailbox(inbox: string, fetchImpl: typeof fetch = fetch): ReadMail {
  return async (address, after, signal) => {
    const url = new URL(inbox)
    url.searchParams.set('address', address)
    url.searchParams.set('after', after)
    const response = await fetchImpl(url.toString(), { signal })
    if (!response.ok) {
      throw new Error(`inbox responded ${response.status}`)
    }
    const parsed = (await response.json()) as { messages?: unknown }
    if (!Array.isArray(parsed.messages)) throw new Error('inbox response carries no messages array')
    return parsed.messages.map(parseMessage)
  }
}

function parseMessage(value: unknown, index: number): MailMessage {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`inbox message ${index} is not an object`)
  }
  const record = value as Record<string, unknown>
  for (const field of ['from', 'subject', 'body'] as const) {
    if (typeof record[field] !== 'string') throw new Error(`inbox message ${index} has no string ${field}`)
  }
  const received = Date.parse(String(record.received_at))
  if (!Number.isFinite(received)) throw new Error(`inbox message ${index} has no parsable received_at`)
  const headers = parseHeaders(record.headers, index)
  if (record.placement !== undefined && (typeof record.placement !== 'string' || record.placement.trim() === ''))
    throw new Error(`inbox message ${index} has a placement that is not a non-empty string`)
  return {
    from: record.from as string,
    subject: record.subject as string,
    body: record.body as string,
    received_at: new Date(received).toISOString(),
    ...(headers === undefined ? {} : { headers }),
    ...(record.placement === undefined ? {} : { placement: (record.placement as string).trim() }),
  }
}

/**
 * The headers an inbox may list with a message (#218): an object of header
 * name to its value or values. Names are read in lower case. A value that is
 * neither a string nor a list of strings is refused, not skipped: a header
 * read wrong is evidence read wrong.
 */
function parseHeaders(value: unknown, index: number): Record<string, string[]> | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`inbox message ${index} has headers that are not an object`)
  const headers: Record<string, string[]> = {}
  for (const [name, held] of Object.entries(value as Record<string, unknown>)) {
    const values = typeof held === 'string' ? [held] : held
    if (!Array.isArray(values) || !values.every((entry): entry is string => typeof entry === 'string'))
      throw new Error(`inbox message ${index} has a ${name} header that is neither a string nor a list of strings`)
    headers[name.toLowerCase()] = [...(headers[name.toLowerCase()] ?? []), ...values]
  }
  return headers
}

/**
 * Wait for one message at an address. Only messages the source received after
 * the wait's window opened are considered, so a rerun waits for a new message
 * instead of matching the previous run's mail. The window opens when the
 * check starts, unless the caller names an earlier moment: a run opens it
 * when the criterion starts, because the check that makes an app send runs
 * before the mail check, and a message sent while it ran has already arrived
 * by the time the wait begins (#65). A message that never arrives, and a
 * mailbox that cannot be reached, are both `unverified` with the reason named:
 * neither is a product failure, and neither may be reported as one.
 */
export async function runMailCheck(
  check: { address: string; from?: string; subject?: string; body?: string },
  inbox: string | undefined,
  readMail: ReadMail | undefined,
  timeoutMs: number,
  pollIntervalMs = MAIL_POLL_INTERVAL_MS,
  windowOpenedAt?: number,
): Promise<MailOutcome> {
  if (readMail === undefined) {
    return {
      status: 'unverified',
      reason: `no mail source: the profile declares no mail.source and no mail.inbox, so the mailbox for ${check.address} is unreachable`,
    }
  }
  const startedAt = Date.now()
  const opened = windowOpenedAt === undefined ? startedAt : Math.min(windowOpenedAt, startedAt)
  const after = new Date(opened).toISOString()
  const deadline = startedAt + timeoutMs
  let polls = 0
  for (;;) {
    polls += 1
    let messages: MailMessage[]
    try {
      // The signal bounds a poll as well as the waiting between polls, so a
      // sink that accepts and never answers cannot stall the run past the
      // check's timeout; the abort rejection lands as unverified below.
      messages = await readMail(check.address, after, AbortSignal.timeout(Math.max(1, deadline - Date.now())))
    } catch (error) {
      return {
        status: 'unverified',
        reason: `the mailbox ${inbox ?? `for ${check.address}`} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    const fresh = messages
      .filter((message) => {
        const received = Date.parse(message.received_at)
        return Number.isFinite(received) && received > opened
      })
      .filter((message) => matches(message, check))
    const message = fresh[0]
    if (message !== undefined) {
      return { status: 'passed', message, waitMs: Date.now() - startedAt, polls }
    }
    if (Date.now() >= deadline) {
      return {
        status: 'unverified',
        reason: `no message arrived at ${check.address} within ${timeoutMs}ms matching the check${check.subject === undefined ? '' : ` (subject ${JSON.stringify(check.subject)})`}; the wait was ${Date.now() - startedAt}ms across ${polls} polls`,
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
}

function matches(message: MailMessage, check: { from?: string; subject?: string; body?: string }): boolean {
  return (
    (check.from === undefined || message.from.includes(check.from)) &&
    (check.subject === undefined || message.subject.includes(check.subject)) &&
    (check.body === undefined || message.body.includes(check.body))
  )
}

const EXCERPT_CHARS = 280
// The evidence records links as data the harness produced from the message
// body, so the judge never mistakes a link for something the model claimed.
const LINK = /https?:\/\/[^\s<>"')]+/g

export function mailEvidence(message: MailMessage, waitMs: number, polls: number): MailEvidenceMessage {
  const links = [...new Set((message.body.match(LINK) ?? []).map((link) => link.replace(/[.,;:]+$/, '')))]
  return {
    from: message.from,
    subject: message.subject,
    excerpt: message.body.slice(0, EXCERPT_CHARS),
    links,
    received_at: message.received_at,
    wait_ms: waitMs,
    polls,
  }
}

/**
 * Most one-time codes are short digit runs; a plan that reads codes of another
 * shape declares its own pattern (#64).
 */
export const DEFAULT_CODE_PATTERN = '\\b\\d{6,8}\\b'

/**
 * Pull the one-time code out of a message body (#64). A pattern with a capture
 * group yields the group; otherwise the whole match is the code. A match that
 * is empty — a pattern like `a*` matches nothing without text — is no code: the
 * caller's `unverified` names it, and an empty value is never published.
 */
export function extractCode(body: string, pattern?: string): string | undefined {
  const match = new RegExp(pattern ?? DEFAULT_CODE_PATTERN).exec(body)
  if (match === null) return undefined
  // A pattern with a capture group yields the group; a group that did not
  // participate (an optional one against a body without a code) is no code,
  // never the whole match, which would publish the body and type it later.
  const value = match.length > 1 ? match[1] : match[0]
  return value === undefined || value === '' ? undefined : value
}
