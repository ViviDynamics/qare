export interface MailMessage {
  from: string
  subject: string
  body: string
  received_at: string
}

export interface MailEvidenceMessage {
  from: string
  subject: string
  excerpt: string
  links: string[]
  received_at: string
  wait_ms: number
  polls: number
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
  return {
    from: record.from as string,
    subject: record.subject as string,
    body: record.body as string,
    received_at: new Date(received).toISOString(),
  }
}

/**
 * Wait for one message at an address. Only messages the sink reports after the
 * check's own start are considered, so a rerun waits for a new message instead
 * of matching the previous run's mail. A message that never arrives, and a
 * mailbox that cannot be reached, are both `unverified` with the reason named:
 * neither is a product failure, and neither may be reported as one.
 */
export async function runMailCheck(
  check: { address: string; from?: string; subject?: string; body?: string },
  inbox: string | undefined,
  readMail: ReadMail | undefined,
  timeoutMs: number,
  pollIntervalMs = MAIL_POLL_INTERVAL_MS,
): Promise<MailOutcome> {
  if (readMail === undefined) {
    return {
      status: 'unverified',
      reason: `no mail source: the profile declares no mail.inbox, so the mailbox for ${check.address} is unreachable`,
    }
  }
  const startedAt = Date.now()
  const after = new Date(startedAt).toISOString()
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
        return Number.isFinite(received) && received > startedAt
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
