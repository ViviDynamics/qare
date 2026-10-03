/**
 * The three wire formats a cell reads (#223): a DNS question, the server
 * name in a TLS client hello, and the host in an HTTP request head. Each is
 * read far enough to learn which host a contained build is reaching for and
 * no further. Every byte here was written by pull request code, so nothing
 * throws on a malformed message: it is read as naming nothing.
 */

/** A host name as the record carries it: lower case, bounded, and made only of what a name is made of. */
export function hostName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const name = raw.toLowerCase().replace(/\.$/, '')
  if (name === '' || name.length > 253) return undefined
  return /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/.test(name) ? name : undefined
}

export interface DnsQuestion {
  id: number
  /** The name asked for, normalised; undefined when it is not a host name. */
  name: string | undefined
  /** The record type asked for: 1 is an address. */
  type: number
  /** The question as it arrived, to be sent back as asked. */
  question: Buffer
  /** Whether the asker wants recursion, which the reply echoes. */
  recursionDesired: boolean
}

export const DNS_TYPE_A = 1

/** Read the one question of a DNS query, or undefined when the message is not a query with one. */
export function readDnsQuestion(message: Buffer): DnsQuestion | undefined {
  if (message.length < 12) return undefined
  const flags = message.readUInt16BE(2)
  // A response, or an opcode other than a standard query, is not a question.
  if ((flags & 0x8000) !== 0 || (flags & 0x7800) !== 0) return undefined
  if (message.readUInt16BE(4) !== 1) return undefined
  const labels: string[] = []
  let at = 12
  for (;;) {
    const length = message[at]
    if (length === undefined) return undefined
    if (length === 0) break
    // Labels are at most 63 bytes; the two high bits mark a pointer, which a question never holds.
    if (length > 63) return undefined
    const end = at + 1 + length
    if (end > message.length) return undefined
    labels.push(message.subarray(at + 1, end).toString('latin1'))
    at = end
  }
  const end = at + 5
  if (end > message.length) return undefined
  return {
    id: message.readUInt16BE(0),
    name: hostName(labels.join('.')),
    type: message.readUInt16BE(at + 1),
    question: Buffer.from(message.subarray(12, end)),
    recursionDesired: (flags & 0x0100) !== 0,
  }
}

/**
 * The reply to a question: one address, an empty answer, or no such name.
 * An address is never cached (a time to live of zero), so every lookup the
 * build makes is one the gate is asked about.
 */
export function dnsReply(query: DnsQuestion, answer: { address: string } | 'empty' | 'nxdomain'): Buffer {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(query.id, 0)
  // A response, recursion available, with the asker's own recursion bit.
  header.writeUInt16BE(0x8080 | (query.recursionDesired ? 0x0100 : 0) | (answer === 'nxdomain' ? 3 : 0), 2)
  header.writeUInt16BE(1, 4)
  if (typeof answer === 'string') return Buffer.concat([header, query.question])
  header.writeUInt16BE(1, 6)
  const octets = answer.address.split('.').map((part) => Number(part))
  // A pointer to the question's name, type A, class IN, no time to live, four bytes.
  const record = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 0, 0, 4, ...octets])
  return Buffer.concat([header, query.question, record])
}

/** What a peek at the first bytes of a connection learned: wait for more, or it has been read (with a name or without). */
export type Peeked = { state: 'more' } | { state: 'read'; name?: string }

const READ_NOTHING: Peeked = { state: 'read' }
const named = (raw: string): Peeked => {
  const name = hostName(raw)
  return name === undefined ? READ_NOTHING : { state: 'read', name }
}

/** The server name a TLS client hello carries (#223), read from the first record of a connection. */
export function tlsServerName(bytes: Buffer): Peeked {
  if (bytes.length < 5) return bytes.length === 0 || bytes[0] === 0x16 ? { state: 'more' } : READ_NOTHING
  // A handshake record, or this is not TLS.
  if (bytes[0] !== 0x16) return READ_NOTHING
  const recordEnd = 5 + bytes.readUInt16BE(3)
  if (recordEnd > 5 + 16_384 + 256) return READ_NOTHING
  if (bytes.length < recordEnd) return { state: 'more' }
  const record = bytes.subarray(5, recordEnd)
  // A cursor that refuses to run off the record: every length in a hello is the build's own claim.
  let at = 0
  const take = (count: number): Buffer | undefined => {
    if (count < 0 || at + count > record.length) return undefined
    const slice = record.subarray(at, at + count)
    at += count
    return slice
  }
  const skipSized = (lengthBytes: 1 | 2): boolean => {
    const size = take(lengthBytes)
    if (size === undefined) return false
    return take(lengthBytes === 1 ? size.readUInt8(0) : size.readUInt16BE(0)) !== undefined
  }
  const head = take(4)
  // A client hello, then its version and random.
  if (head === undefined || head[0] !== 0x01) return READ_NOTHING
  if (take(2 + 32) === undefined) return READ_NOTHING
  // Session id, cipher suites, compression methods.
  if (!skipSized(1) || !skipSized(2) || !skipSized(1)) return READ_NOTHING
  const extensionsSize = take(2)
  if (extensionsSize === undefined) return READ_NOTHING
  const extensionsEnd = Math.min(record.length, at + extensionsSize.readUInt16BE(0))
  while (at + 4 <= extensionsEnd) {
    const header = take(4) as Buffer
    const body = take(header.readUInt16BE(2))
    if (body === undefined) return READ_NOTHING
    if (header.readUInt16BE(0) !== 0) continue
    // server_name: a list length, then entries of type, length, name. Type 0 is a host name.
    if (body.length < 5 || body[2] !== 0) return READ_NOTHING
    const length = body.readUInt16BE(3)
    if (5 + length > body.length) return READ_NOTHING
    return named(body.subarray(5, 5 + length).toString('latin1'))
  }
  return READ_NOTHING
}

/** How much of a request a head may take before it is read as naming nothing. */
const MAX_HTTP_HEAD = 8_192

/** The host an HTTP request names in its `Host` header (#223), without its port. */
export function httpHost(bytes: Buffer): Peeked {
  const text = bytes.subarray(0, MAX_HTTP_HEAD).toString('latin1')
  const end = text.indexOf('\r\n\r\n')
  if (end === -1) return bytes.length >= MAX_HTTP_HEAD ? READ_NOTHING : { state: 'more' }
  for (const line of text.slice(0, end).split('\r\n').slice(1)) {
    const match = /^host:\s*(.*?)\s*$/i.exec(line)
    if (match === null) continue
    return named((match[1] as string).replace(/:\d+$/, ''))
  }
  return READ_NOTHING
}
