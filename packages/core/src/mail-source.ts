import { httpMailbox, type MailMessage, type ReadMail } from './mailbox.js'

/**
 * Where a run reads mail from (#65). A sink in the stack, a hosted endpoint,
 * a vendor API and a mailbox protocol all present the same four reads, so a
 * mail check never knows which one it waited on: filter by address, filter by
 * arrival time, read, delete.
 */
export interface MailSource {
  /** The adapter's name, as a profile declares it. */
  readonly kind: string
  /** What a reason and the evidence call this source. It never carries a credential. */
  readonly describe: string
  /** The messages sent to one address, optionally only those received after a moment. */
  list(filter: MailFilter, signal?: AbortSignal): Promise<MailRef[]>
  /** One listed message, in full. */
  read(id: string, signal?: AbortSignal): Promise<MailMessage>
  /** Delete everything sent to one address; answers how many messages went. */
  delete(filter: { address: string }, signal?: AbortSignal): Promise<number>
}

export interface MailFilter {
  address: string
  /** An ISO timestamp: only messages the source received after it. */
  after?: string
}

export interface MailRef {
  id: string
  received_at: string
}

/** The source a profile declares: an adapter kind and where it answers. */
export interface DeclaredMailSource {
  kind: MailSourceKind
  url: string
}

export const MAIL_SOURCE_KINDS = ['mailpit', 'inbox'] as const
export type MailSourceKind = (typeof MAIL_SOURCE_KINDS)[number]

export function mailSourceOf(declared: DeclaredMailSource, fetchImpl: typeof fetch = fetch): MailSource {
  return declared.kind === 'mailpit' ? mailpitSource(declared.url, fetchImpl) : inboxSource(declared.url, fetchImpl)
}

/**
 * What a mail check waits on: every message a source lists for the address,
 * read in full, so the check's matchers see the body as well as the subject.
 */
export function mailReader(source: MailSource): ReadMail {
  return async (address, after, signal) => {
    const listed = await source.list({ address, after }, signal)
    return Promise.all(listed.map((ref) => source.read(ref.id, signal)))
  }
}

function afterMoment(after: string | undefined): number | undefined {
  if (after === undefined) return undefined
  const moment = Date.parse(after)
  if (!Number.isFinite(moment)) throw new Error(`the arrival time ${JSON.stringify(after)} is not a timestamp`)
  return moment
}

/**
 * The listing contract of #67 behind the interface: a GET of the inbox URL
 * with `address` and `after` answers with the messages, and a DELETE of it
 * with `address` removes them and answers `{ "deleted": <count> }`. The
 * contract lists whole messages, so a read is served from the last listing.
 */
export function inboxSource(inbox: string, fetchImpl: typeof fetch = fetch): MailSource {
  const listInbox = httpMailbox(inbox, fetchImpl)
  // Keyed by what the message is, so a wait that polls for a minute holds
  // each message once, not once per poll.
  const listed = new Map<string, MailMessage>()
  return {
    kind: 'inbox',
    describe: `inbox at ${inbox}`,
    async list(filter, signal) {
      // The contract has always taken a moment; without one, everything is asked for.
      const messages = await listInbox(filter.address, filter.after ?? new Date(0).toISOString(), signal)
      return messages.map((message, index) => {
        const id = `${filter.address}#${index}@${message.received_at}`
        listed.set(id, message)
        return { id, received_at: message.received_at }
      })
    },
    async read(id) {
      const message = listed.get(id)
      if (message === undefined) throw new Error(`inbox message ${JSON.stringify(id)} was not listed, so there is nothing to read`)
      return message
    },
    async delete(filter, signal) {
      const url = new URL(inbox)
      url.searchParams.set('address', filter.address)
      const response = await fetchImpl(url.toString(), { method: 'DELETE', signal })
      if (!response.ok) throw new Error(`inbox responded ${response.status}`)
      const parsed = (await response.json()) as { deleted?: unknown }
      if (typeof parsed.deleted !== 'number') throw new Error('inbox delete response carries no deleted count')
      return parsed.deleted
    },
  }
}

// One address holds a run's handful of messages, so one page is nearly always
// the whole of it. The bound on pages stops a catcher that ignores `start`
// from being read forever.
const MAILPIT_PAGE = 200
const MAILPIT_MAX_PAGES = 50

interface MailpitAddress {
  Name?: unknown
  Address?: unknown
}

/**
 * A Mailpit catcher in the stack, read over its HTTP API. `url` is where its
 * web interface answers, with its webroot when it has one.
 *
 * Mailpit's `to:` search matches a substring of the address, so the adapter
 * filters recipients exactly and deletes by message id: a run can only ever
 * read or remove what was sent to the address it asked about.
 */
export function mailpitSource(url: string, fetchImpl: typeof fetch = fetch): MailSource {
  const api = `${url.replace(/\/+$/, '')}/api/v1`
  // When the catcher received each listed message. A message's own Date is
  // the header the sender wrote, which says nothing about arrival.
  const received = new Map<string, string>()

  const request = async (path: string, init: RequestInit): Promise<Response> => {
    const response = await fetchImpl(`${api}/${path}`, init)
    if (!response.ok) throw new Error(`mailpit responded ${response.status}`)
    return response
  }

  const search = async (address: string, signal: AbortSignal | undefined): Promise<Array<{ id: string; received_at: string }>> => {
    if (/["\\\s]/.test(address)) throw new Error(`the address ${JSON.stringify(address)} cannot be searched for: it carries a quote, a backslash or white space`)
    const wanted = address.toLowerCase()
    const found = new Map<string, { id: string; received_at: string }>()
    // The search answers a page at a time: every page is read, so a message
    // past the first is still matched, and a delete leaves nothing behind.
    for (let start = 0, pages = 0; ; pages += 1) {
      if (pages >= MAILPIT_MAX_PAGES)
        throw new Error(`mailpit holds more than ${MAILPIT_MAX_PAGES * MAILPIT_PAGE} messages matching ${address}, which is more than one address is read for`)
      const query = new URLSearchParams({ query: `to:"${address}"`, start: String(start), limit: String(MAILPIT_PAGE) })
      const response = await request(`search?${query.toString()}`, { signal })
      const parsed = (await response.json()) as { messages?: unknown }
      if (!Array.isArray(parsed.messages)) throw new Error('mailpit search response carries no messages array')
      for (const [index, entry] of parsed.messages.entries()) {
        if (typeof entry !== 'object' || entry === null) throw new Error(`mailpit message ${start + index} is not an object`)
        const record = entry as Record<string, unknown>
        const recipients = [record.To, record.Cc, record.Bcc].flatMap((list) => (Array.isArray(list) ? (list as MailpitAddress[]) : []))
        if (!recipients.some((recipient) => typeof recipient?.Address === 'string' && recipient.Address.toLowerCase() === wanted)) continue
        const created = Date.parse(String(record.Created))
        if (typeof record.ID !== 'string' || !Number.isFinite(created)) throw new Error(`mailpit message ${start + index} carries no ID or no parsable Created`)
        found.set(record.ID, { id: record.ID, received_at: new Date(created).toISOString() })
      }
      if (parsed.messages.length < MAILPIT_PAGE) break
      start += parsed.messages.length
    }
    return [...found.values()]
  }

  const readHeaders = async (id: string, signal: AbortSignal | undefined): Promise<Record<string, string[]> | undefined> => {
    let parsed: unknown
    try {
      parsed = await (await request(`message/${encodeURIComponent(id)}/headers`, { signal })).json()
    } catch {
      return undefined
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const headers: Record<string, string[]> = {}
    for (const [name, values] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(values)) continue
      headers[name.toLowerCase()] = values.filter((value): value is string => typeof value === 'string')
    }
    return headers
  }

  return {
    kind: 'mailpit',
    describe: `mailpit at ${url}`,
    async list(filter, signal) {
      const after = afterMoment(filter.after)
      const found = (await search(filter.address, signal)).filter((ref) => after === undefined || Date.parse(ref.received_at) > after)
      for (const ref of found) received.set(ref.id, ref.received_at)
      return found
    },
    async read(id, signal) {
      const response = await request(`message/${encodeURIComponent(id)}`, { signal })
      const record = (await response.json()) as Record<string, unknown>
      const from = (typeof record.From === 'object' && record.From !== null ? record.From : {}) as MailpitAddress
      if (typeof from.Address !== 'string' || typeof record.Subject !== 'string') throw new Error(`mailpit message ${id} carries no sender or no subject`)
      const text = typeof record.Text === 'string' ? record.Text : ''
      const arrival = received.get(id) ?? (typeof record.Date === 'string' ? record.Date : '')
      const moment = Date.parse(arrival)
      if (!Number.isFinite(moment)) throw new Error(`mailpit message ${id} carries no parsable arrival time`)
      // The headers are their own read (#218). A catcher that cannot answer
      // it leaves the message without headers, which a check that asserts
      // on them reports as the source not saying; the message is still read.
      const headers = await readHeaders(id, signal)
      return {
        ...(headers === undefined ? {} : { headers }),
        from: typeof from.Name === 'string' && from.Name !== '' ? `${from.Name} <${from.Address}>` : from.Address,
        subject: record.Subject,
        // A message with no text part is read as its HTML: the matchers and
        // the link extraction still see what was sent.
        body: text !== '' ? text : typeof record.HTML === 'string' ? record.HTML : '',
        received_at: new Date(moment).toISOString(),
      }
    },
    async delete(filter, signal) {
      const ids = (await search(filter.address, signal)).map((ref) => ref.id)
      if (ids.length === 0) return 0
      await request('messages', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ IDs: ids }), signal })
      for (const id of ids) received.delete(id)
      return ids.length
    },
  }
}
