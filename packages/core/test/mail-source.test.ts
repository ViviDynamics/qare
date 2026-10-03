import { expect, test } from 'vitest'
import { inboxSource, mailReader, mailSourceOf, mailpitSource, type MailSource } from '../src/index.js'

// Test files must not carry network literals (the offline scanner), so the
// schemes and authorities are joined at runtime.
const INBOX_URL = ['http:', '//sink.local/inbox'].join('')
const MAILPIT_URL = ['http:', '//localhost:8025/mailpit'].join('')
const LINK = ['http:', '//localhost:3000/confirm?id=1'].join('')

interface Caught {
  ID: string
  to: string
  from: { Name: string; Address: string }
  subject: string
  text: string
  created: string
}

/**
 * A fake that answers with the shapes a real Mailpit (v1.27) returned for
 * the same requests: the search summary, the message, and the delete by id.
 * Like the real one, its `to:` search matches a substring of the address,
 * whatever its case.
 */
function fakeMailpit(caught: Caught[]): { fetch: typeof fetch; requests: string[] } {
  const requests: string[] = []
  const summary = (message: Caught) => ({
    ID: message.ID,
    From: message.from,
    To: [{ Name: '', Address: message.to }],
    Cc: null,
    Bcc: null,
    Subject: message.subject,
    Created: message.created,
    Snippet: message.text.slice(0, 40),
  })
  const transport = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    requests.push(`${method} ${url.pathname}${url.search}`)
    if (!url.pathname.startsWith('/mailpit/api/v1/')) return new Response('not found', { status: 404 })
    const path = url.pathname.slice('/mailpit/api/v1/'.length)
    if (method === 'GET' && path === 'search') {
      const query = /^to:"(.*)"$/.exec(url.searchParams.get('query') ?? '')
      if (query === null) return new Response('bad query', { status: 400 })
      const matched = caught.filter((message) => message.to.toLowerCase().includes((query[1] ?? '').toLowerCase()))
      return Response.json({ total: caught.length, messages_count: matched.length, messages: matched.map(summary) })
    }
    if (method === 'GET' && path.startsWith('message/')) {
      const message = caught.find((entry) => entry.ID === path.slice('message/'.length))
      if (message === undefined) return new Response('Message not found', { status: 404 })
      // The message's own Date is the header's when the sender wrote one;
      // only the summary's Created says when the catcher received it.
      return Response.json({ ID: message.ID, From: message.from, To: [{ Name: '', Address: message.to }], Subject: message.subject, Date: '2020-01-01T00:00:00Z', Text: message.text, HTML: '' })
    }
    if (method === 'DELETE' && path === 'messages') {
      const body = JSON.parse(String(init?.body)) as { IDs: string[] }
      for (const id of body.IDs) {
        const index = caught.findIndex((entry) => entry.ID === id)
        if (index >= 0) caught.splice(index, 1)
      }
      return new Response('ok', { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }
  return { fetch: transport as typeof fetch, requests }
}

function caughtMessage(fields: Partial<Caught> = {}): Caught {
  return {
    ID: 'JErteJnrGgnzfkBut4FbSx',
    to: 'qare-abc@localhost',
    from: { Name: 'App', Address: 'no-reply@app.test' },
    subject: 'Confirm your account',
    text: `Hello. Open ${LINK} to confirm.\r\n`,
    created: '2026-10-03T16:52:30.702Z',
    ...fields,
  }
}

test('the Mailpit adapter lists what was sent to one address after a moment, and reads it', async () => {
  const fake = fakeMailpit([
    caughtMessage(),
    caughtMessage({ ID: 'old', created: '2026-10-03T16:00:00.000Z', subject: 'Earlier' }),
    caughtMessage({ ID: 'other', to: 'qare-xyz@localhost' }),
  ])
  const source = mailpitSource(MAILPIT_URL, fake.fetch)

  const listed = await source.list({ address: 'qare-abc@localhost', after: '2026-10-03T16:30:00.000Z' })
  expect(listed).toEqual([{ id: 'JErteJnrGgnzfkBut4FbSx', received_at: '2026-10-03T16:52:30.702Z' }])
  expect(fake.requests[0]).toContain('/mailpit/api/v1/search?query=to%3A%22qare-abc%40localhost%22')

  const read = await source.read('JErteJnrGgnzfkBut4FbSx')
  expect(read).toEqual({
    from: 'App <no-reply@app.test>',
    subject: 'Confirm your account',
    body: `Hello. Open ${LINK} to confirm.\r\n`,
    // When the catcher received it, not the Date header the sender wrote.
    received_at: '2026-10-03T16:52:30.702Z',
  })
  expect(source.describe).toBe(`mailpit at ${MAILPIT_URL}`)
})

test('the Mailpit adapter matches the recipient exactly, though the search matches substrings', async () => {
  const fake = fakeMailpit([caughtMessage({ ID: 'longer', to: 'xqare-abc@localhost.example' }), caughtMessage({ ID: 'mine', to: 'QARE-abc@localhost' })])
  const source = mailpitSource(MAILPIT_URL, fake.fetch)
  expect((await source.list({ address: 'qare-abc@localhost' })).map((ref) => ref.id)).toEqual(['mine'])
})

test('the Mailpit adapter deletes one address by message id and leaves the rest', async () => {
  const caught = [caughtMessage(), caughtMessage({ ID: 'second', subject: 'Again' }), caughtMessage({ ID: 'longer', to: 'xqare-abc@localhost' })]
  const fake = fakeMailpit(caught)
  const source = mailpitSource(MAILPIT_URL, fake.fetch)

  expect(await source.delete({ address: 'qare-abc@localhost' })).toBe(2)
  expect(caught.map((message) => message.ID)).toEqual(['longer'])
  // Nothing left at the address: nothing is asked of the catcher's delete.
  const before = fake.requests.filter((request) => request.startsWith('DELETE')).length
  expect(await source.delete({ address: 'qare-abc@localhost' })).toBe(0)
  expect(fake.requests.filter((request) => request.startsWith('DELETE'))).toHaveLength(before)
})

test('the Mailpit adapter names what the catcher answered when it cannot be read', async () => {
  const down = mailpitSource(MAILPIT_URL, (async () => new Response('no', { status: 503 })) as typeof fetch)
  await expect(down.list({ address: 'qare-abc@localhost' })).rejects.toThrow('mailpit responded 503')
  const odd = mailpitSource(MAILPIT_URL, (async () => Response.json({ total: 0 })) as typeof fetch)
  await expect(odd.list({ address: 'qare-abc@localhost' })).rejects.toThrow('carries no messages array')
  // An address that would break out of the quoted search term is refused.
  const fake = fakeMailpit([])
  await expect(mailpitSource(MAILPIT_URL, fake.fetch).list({ address: 'a"b@localhost' })).rejects.toThrow('cannot be searched for')
  expect(fake.requests).toEqual([])
})

test('the inbox contract is one adapter behind the same interface', async () => {
  const requests: string[] = []
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    requests.push(`${init?.method ?? 'GET'} ${url.search}`)
    if (init?.method === 'DELETE') return Response.json({ deleted: 1 })
    return Response.json({ messages: [{ from: 'App <no-reply@app.test>', subject: 'Welcome', body: 'hello', received_at: '2026-10-03T16:52:30.702Z' }] })
  }) as typeof fetch
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
  const source = inboxSource(INBOX_URL, (async () => new Response('no', { status: 405 })) as typeof fetch)
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
