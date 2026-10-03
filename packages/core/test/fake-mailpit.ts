// A Mailpit that answers from memory, shared by the adapter's tests and the
// run's: no test reaches a network.

export interface Caught {
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
export function fakeMailpit(caught: Caught[]): { fetch: typeof fetch; requests: string[] } {
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
    const marker = url.pathname.indexOf('/mailpit/api/v1/')
    if (marker < 0) return new Response('not found', { status: 404 })
    const path = url.pathname.slice(marker + '/mailpit/api/v1/'.length)
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

export function caughtMessage(fields: Partial<Caught> = {}): Caught {
  return {
    ID: 'JErteJnrGgnzfkBut4FbSx',
    to: 'qare-abc@localhost',
    from: { Name: 'App', Address: 'no-reply@app.test' },
    subject: 'Confirm your account',
    text: 'Hello. Your account is ready.\r\n',
    created: '2026-10-03T16:52:30.702Z',
    ...fields,
  }
}
