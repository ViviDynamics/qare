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

export interface FakeComment {
  id: number
  issue: number
  body: string
  /** Who wrote it; the fake token comments as github-actions[bot]. */
  author?: string
  /** An edit to this comment answers with this status. */
  failEditWith?: number
}

export interface FakeGithub {
  url: string
  calls: FakeCall[]
  issues: Map<number, FakeIssue>
  /** Every comment with its id, in the order written; issue.comments mirrors the bodies. */
  commentRecords: FakeComment[]
  checkRuns: unknown[]
  status: number | undefined
  close(): Promise<void>
}

const TOKEN = 'qa-test-token'
const TOKEN_LOGIN = 'github-actions[bot]'
const AUTH_HEADER = `Bearer ${TOKEN}`

export function startFakeGithub(): Promise<FakeGithub> {
  const issues = new Map<number, FakeIssue>()
  const calls: FakeCall[] = []
  const commentRecords: FakeComment[] = []
  const checkRuns: unknown[] = []
  const state = { status: undefined as number | undefined }
  let nextNumber = 100
  let nextCommentId = 5000

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
        const text = (body as { body: string }).body
        issue.comments.push(text)
        const record = { id: nextCommentId, issue: issue.number, body: text, author: TOKEN_LOGIN }
        nextCommentId += 1
        commentRecords.push(record)
        respond(response, 201, { id: record.id, body: text })
        return
      }
      if (request.method === 'GET') {
        const perPage = Number(url.searchParams.get('per_page') ?? '30')
        const page = Number(url.searchParams.get('page') ?? '1')
        const mine = commentRecords.filter((record) => record.issue === issue.number)
        respond(
          response,
          200,
          mine
            .slice((page - 1) * perPage, page * perPage)
            .map((record) => ({ id: record.id, body: record.body, user: { login: record.author ?? TOKEN_LOGIN } })),
        )
        return
      }
    }
    if (
      parts[0] === 'repos' && parts[3] === 'issues' && parts[4] === 'comments' && parts.length === 6 &&
      request.method === 'PATCH'
    ) {
      const record = commentRecords.find((candidate) => candidate.id === Number(parts[5]))
      if (record === undefined) {
        respond(response, 404, { message: 'comment not found' })
        return
      }
      if (record.failEditWith !== undefined) {
        respond(response, record.failEditWith, { message: 'fake edit failure' })
        return
      }
      record.body = (body as { body: string }).body
      const issue = issues.get(record.issue)
      if (issue !== undefined) {
        const mine = commentRecords.filter((candidate) => candidate.issue === record.issue)
        issue.comments = mine.map((candidate) => candidate.body)
      }
      respond(response, 200, { id: record.id, body: record.body })
      return
    }
    if (parts[0] === 'repos' && parts[3] === 'check-runs' && parts.length === 4 && request.method === 'POST') {
      checkRuns.push(body)
      respond(response, 201, { id: checkRuns.length, ...(body as object) })
      return
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
        commentRecords,
        checkRuns,
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
