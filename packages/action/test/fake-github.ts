import { createServer, type Server } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface FakeIssue {
  number: number
  title: string
  body: string
  comments: string[]
}

export interface FakeCall {
  method: string
  path: string
  query: string
  body: unknown
}

export interface FakeGithub {
  url: string
  calls: FakeCall[]
  issues: Map<number, FakeIssue>
  status: number | undefined
  close(): Promise<void>
}

const TOKEN = 'qa-test-token'
const AUTH_HEADER = `Bearer ${TOKEN}`

export function startFakeGithub(): Promise<FakeGithub> {
  const issues = new Map<number, FakeIssue>()
  const calls: FakeCall[] = []
  const state = { status: undefined as number | undefined }
  let nextNumber = 100

  const server: Server = createServer((request, response) => {
    void handle(request, response)
  })

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', ['http:', '//fake.github.local'].join(''))
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const rawBody = Buffer.concat(chunks).toString('utf8')
    const body: unknown = rawBody === '' ? undefined : JSON.parse(rawBody)
    calls.push({ method: request.method ?? '', path: url.pathname, query: url.searchParams.toString(), body })

    const fail = () => {
      respond(response, state.status ?? 500, { message: 'fake error' })
    }
    if (state.status !== undefined) return fail()
    if (request.headers.authorization !== AUTH_HEADER) {
      respond(response, 401, { message: 'Bad credentials: Authorization: Bearer <token> required' })
      return
    }

    const parts = url.pathname.split('/').filter((part) => part !== '')
    if (url.pathname === '/search/issues' && request.method === 'GET') {
      const q = url.searchParams.get('q') ?? ''
      const phrase = /"([^"]+)"/.exec(q)?.[1] ?? ''
      const matched = [...issues.values()].filter((issue) => issue.body.includes(phrase) || issue.title.includes(phrase))
      const perPage = Number(url.searchParams.get('per_page') ?? '30')
      const page = Number(url.searchParams.get('page') ?? '1')
      const items =
        Number.isInteger(perPage) && perPage > 0 && Number.isInteger(page) && page > 0
          ? matched.slice((page - 1) * perPage, page * perPage)
          : matched
      respond(response, 200, { total_count: matched.length, items })
      return
    }
    if (parts[0] === 'repos' && parts[3] === 'issues' && parts.length === 4 && request.method === 'POST') {
      const payload = body as { title: string; body: string }
      const issue: FakeIssue = { number: nextNumber, title: payload.title, body: payload.body, comments: [] }
      nextNumber += 1
      issues.set(issue.number, issue)
      respond(response, 201, issue)
      return
    }
    if (parts[0] === 'repos' && parts[3] === 'issues' && parts[4] !== undefined && parts.length === 5) {
      const issue = issues.get(Number(parts[4]))
      if (issue === undefined) {
        respond(response, 404, { message: 'issue not found' })
        return
      }
      if (request.method === 'GET') {
        respond(response, 200, issue)
        return
      }
      if (request.method === 'PATCH') {
        issue.body = (body as { body: string }).body
        respond(response, 200, issue)
        return
      }
    }
    if (parts[0] === 'repos' && parts[3] === 'issues' && parts[5] === 'comments' && parts.length === 6) {
      const issue = issues.get(Number(parts[4]))
      if (issue === undefined) {
        respond(response, 404, { message: 'issue not found' })
        return
      }
      if (request.method === 'POST') {
        issue.comments.push((body as { body: string }).body)
        respond(response, 201, { body: (body as { body: string }).body })
        return
      }
    }
    respond(response, 404, { message: `fake github has no route for ${request.method} ${url.pathname}` })
  }

  function respond(response: ServerResponse, status: number, payload: unknown): void {
    response.statusCode = status
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(payload))
  }

  return new Promise((resolveFake) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolveFake({
        url: ['http:', `//127.0.0.1:${port}`].join(''),
        calls,
        issues,
        get status(): number | undefined {
          return state.status
        },
        set status(value: number | undefined) {
          state.status = value
        },
        close: () =>
          new Promise((resolveClose) => {
            server.close(() => resolveClose())
          }),
      } as FakeGithub)
    })
  })
}

export const FAKE_TOKEN = TOKEN
