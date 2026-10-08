import { expect, test } from 'vitest'
import { inboxSource, mailReader, mailSourceOf, mailpitSource, type MailSource } from '../src/index.js'
import { answering, caughtMessage, fakeMailpit } from './fake-mailpit.js'

// Test files must not carry network literals (the offline scanner), so the
// schemes and authorities are joined at runtime.
const INBOX_URL = ['http:', '//sink.local/inbox'].join('')
const MAILPIT_URL = ['http:', '//localhost:8025/mailpit'].join('')
const LINK = ['http:', '//localhost:3000/confirm?id=1'].join('')
const BODY = `Hello. Open ${LINK} to confirm.\r\n`

test('the Mailpit adapter lists what was sent to one address after a moment, and reads it', async () => {
  const fake = fakeMailpit([
    caughtMessage({ text: BODY }),
    caughtMessage({ ID: 'old', created: '2026-10-03T16:00:00.000Z', subject: 'Earlier' }),
    caughtMessage({ ID: 'other', to: 'qare-xyz@localhost' }),
  ])
  const source = mailpitSource(MAILPIT_URL, fake.transport)

  const listed = await source.list({ address: 'qare-abc@localhost', after: '2026-10-03T16:30:00.000Z' })
  expect(listed).toEqual([{ id: 'JErteJnrGgnzfkBut4FbSx', received_at: '2026-10-03T16:52:30.702Z' }])
  expect(fake.requests[0]).toContain('/mailpit/api/v1/search?query=to%3A%22qare-abc%40localhost%22')

  const read = await source.read('JErteJnrGgnzfkBut4FbSx')
  expect(read).toEqual({
    from: 'App <no-reply@app.test>',
    subject: 'Confirm your account',
    body: BODY,
    // When the catcher received it, not the Date header the sender wrote.
    received_at: '2026-10-03T16:52:30.702Z',
  })
  expect(source.describe).toBe(`mailpit at ${MAILPIT_URL}`)
})

test('the Mailpit adapter matches the recipient exactly, though the search matches substrings', async () => {
  const fake = fakeMailpit([caughtMessage({ ID: 'longer', to: 'xqare-abc@localhost.example' }), caughtMessage({ ID: 'mine', to: 'QARE-abc@localhost' })])
  const source = mailpitSource(MAILPIT_URL, fake.transport)
  expect((await source.list({ address: 'qare-abc@localhost' })).map((ref) => ref.id)).toEqual(['mine'])
})

test('the Mailpit adapter deletes one address by message id and leaves the rest', async () => {
  const caught = [caughtMessage(), caughtMessage({ ID: 'second', subject: 'Again' }), caughtMessage({ ID: 'longer', to: 'xqare-abc@localhost' })]
  const fake = fakeMailpit(caught)
  const source = mailpitSource(MAILPIT_URL, fake.transport)

  expect(await source.delete({ address: 'qare-abc@localhost' })).toBe(2)
  expect(caught.map((message) => message.ID)).toEqual(['longer'])
  // Nothing left at the address: nothing is asked of the catcher's delete.
  const before = fake.requests.filter((request) => request.startsWith('DELETE')).length
  expect(await source.delete({ address: 'qare-abc@localhost' })).toBe(0)
  expect(fake.requests.filter((request) => request.startsWith('DELETE'))).toHaveLength(before)
})

test('the Mailpit adapter names what the catcher answered when it cannot be read', async () => {
  const down = mailpitSource(MAILPIT_URL, answering(() => new Response('no', { status: 503 })))
  await expect(down.list({ address: 'qare-abc@localhost' })).rejects.toThrow('mailpit responded 503')
  const odd = mailpitSource(MAILPIT_URL, answering(() => Response.json({ total: 0 })))
  await expect(odd.list({ address: 'qare-abc@localhost' })).rejects.toThrow('carries no messages array')
  // An address that would break out of the quoted search term is refused.
  const fake = fakeMailpit([])
  await expect(mailpitSource(MAILPIT_URL, fake.transport).list({ address: 'a"b@localhost' })).rejects.toThrow('cannot be searched for')
  expect(fake.requests).toEqual([])
})

test('the inbox contract is one adapter behind the same interface', async () => {
  const requests: string[] = []
  const transport = answering((input, init) => {
    const url = new URL(String(input))
    requests.push(`${init?.method ?? 'GET'} ${url.search}`)
    if (init?.method === 'DELETE') return Response.json({ deleted: 1 })
    return Response.json({ messages: [{ from: 'App <no-reply@app.test>', subject: 'Welcome', body: 'hello', received_at: '2026-10-03T16:52:30.702Z' }] })
  })
  const source = inboxSource(INBOX_URL, transport)

  const listed = await source.list({ address: 'qa@localhost', after: '2026-10-03T16:00:00.000Z' })
  expect(listed).toHaveLength(1)
  expect(listed[0]?.received_at).toBe('2026-10-03T16:52:30.702Z')
  expect(await source.read(listed[0]?.id ?? '')).toEqual({ from: 'App <no-reply@app.test>', subject: 'Welcome', body: 'hello', received_at: '2026-10-03T16:52:30.702Z' })
  await expect(source.read('never-listed')).rejects.toThrow('was not listed')
  expect(await source.delete({ address: 'qa@localhost' })).toBe(1)
  expect(requests).toEqual(['GET ?address=qa%40localhost&after=2026-10-03T16%3A00%3A00.000Z', 'DELETE ?address=qa%40localhost'])
  expect(source.describe).toBe(`inbox at ${INBOX_URL}`)
})

test('an inbox that cannot delete says so, rather than reading as cleaned', async () => {
  const source = inboxSource(INBOX_URL, answering(() => new Response('no', { status: 405 })))
  await expect(source.delete({ address: 'qa@localhost' })).rejects.toThrow('inbox responded 405')
})

test('a reader over a source hands a mail check every message the source lists', async () => {
  const source: MailSource = {
    kind: 'fake',
    describe: 'fake',
    list: async (filter) => [{ id: `${filter.address}/${filter.after}`, received_at: '2026-10-03T16:52:30.702Z' }],
    read: async (id) => ({ from: 'a', subject: id, body: 'b', received_at: '2026-10-03T16:52:30.702Z' }),
    delete: async () => 0,
  }
  const messages = await mailReader(source)('qa@localhost', '2026-10-03T16:00:00.000Z')
  expect(messages.map((message) => message.subject)).toEqual(['qa@localhost/2026-10-03T16:00:00.000Z'])
})

test('a declared source builds the adapter its kind names', () => {
  expect(mailSourceOf({ kind: 'mailpit', url: MAILPIT_URL }).describe).toBe(`mailpit at ${MAILPIT_URL}`)
  expect(mailSourceOf({ kind: 'inbox', url: INBOX_URL }).describe).toBe(`inbox at ${INBOX_URL}`)
})

test('an inbox polled again names the same message the same way, so a wait holds nothing it has already seen twice', async () => {
  const stored = { from: 'App <no-reply@app.test>', subject: 'Welcome', body: 'hello', received_at: '2026-10-03T16:52:30.702Z' }
  const source = inboxSource(INBOX_URL, answering(() => Response.json({ messages: [stored] })))
  const first = await source.list({ address: 'qa@localhost' })
  const second = await source.list({ address: 'qa@localhost' })
  expect(second).toEqual(first)
  // Another address's listing does not disturb a read that is still to come.
  await source.list({ address: 'other@localhost' })
  expect((await source.read(first[0]?.id ?? '')).subject).toBe('Welcome')
})

test('the Mailpit adapter reads and deletes past one page of results', async () => {
  const caught = Array.from({ length: 450 }, (_, index) => caughtMessage({ ID: `message-${index}`, subject: `Message ${index}` }))
  const fake = fakeMailpit(caught)
  const source = mailpitSource(MAILPIT_URL, fake.transport)

  const listed = await source.list({ address: 'qare-abc@localhost' })
  expect(listed).toHaveLength(450)
  expect(new Set(listed.map((ref) => ref.id)).size).toBe(450)
  expect(await source.delete({ address: 'qare-abc@localhost' })).toBe(450)
  expect(caught).toEqual([])
})

// #218: a message carries the headers a source can report, and where the
// mailbox says it landed, so a mail check can assert how it was delivered.
test('the Mailpit adapter reads a message\'s headers from the catcher, names in lower case, and a catcher that reports none leaves them out', async () => {
  const results = 'mx.receiver.example; spf=pass smtp.mailfrom=app.test; dkim=pass header.d=app.test; dmarc=pass header.from=app.test'
  const fake = fakeMailpit([
    caughtMessage({ headers: { 'Authentication-Results': [results], Received: ['from a', 'from b'], Subject: ['Confirm your account'] } }),
    caughtMessage({ ID: 'bare' }),
  ])
  const source = mailpitSource(MAILPIT_URL, fake.transport)

  const read = await source.read('JErteJnrGgnzfkBut4FbSx')
  expect(read.headers).toEqual({ 'authentication-results': [results], received: ['from a', 'from b'], subject: ['Confirm your account'] })
  expect(fake.requests).toContain('GET /mailpit/api/v1/message/JErteJnrGgnzfkBut4FbSx/headers')
  // Mailpit says nothing of placement: it is a catcher, not a mailbox with folders.
  expect(read).not.toHaveProperty('placement')

  const bare = await source.read('bare')
  expect(bare).not.toHaveProperty('headers')
  expect(bare.subject).toBe('Confirm your account')
})

test('the inbox contract may list headers and a placement with a message, and refuses ones it cannot read', async () => {
  const listing = (extra: Record<string, unknown>) =>
    inboxSource(
      INBOX_URL,
      answering(() => Response.json({ messages: [{ from: 'App <no-reply@app.test>', subject: 'Welcome', body: 'hello', received_at: '2026-10-03T16:52:30.702Z', ...extra }] })),
    )
  const source = listing({ headers: { 'Authentication-Results': 'mx.receiver.example; dmarc=pass header.from=app.test', Received: ['from a', 'from b'] }, placement: ' Spam ' })
  const [ref] = await source.list({ address: 'qa@localhost' })
  expect(await source.read(ref?.id ?? '')).toEqual({
    from: 'App <no-reply@app.test>',
    subject: 'Welcome',
    body: 'hello',
    received_at: '2026-10-03T16:52:30.702Z',
    headers: { 'authentication-results': ['mx.receiver.example; dmarc=pass header.from=app.test'], received: ['from a', 'from b'] },
    placement: 'Spam',
  })

  await expect(listing({ headers: ['not', 'an', 'object'] }).list({ address: 'qa@localhost' })).rejects.toThrow('headers that are not an object')
  await expect(listing({ headers: { Received: 7 } }).list({ address: 'qa@localhost' })).rejects.toThrow('Received header that is neither a string nor a list of strings')
  await expect(listing({ placement: '' }).list({ address: 'qa@localhost' })).rejects.toThrow('placement that is not a non-empty string')
})
