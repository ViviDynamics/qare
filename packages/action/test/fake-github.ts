import { createVerify } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface FakeIssue {
  number: number
  title: string
  body: string
  comments: string[]
}

/** What GitHub keeps about an issue beside its text (#154): its state, its labels and who opened it. */
export interface FakeIssueMeta {
  state: 'open' | 'closed'
  stateReason?: string
  labels: string[]
  author: string
}

export interface FakeAccount {
  login: string
  type: 'User' | 'Bot'
}

/** A pull request as the fake serves it to blame (#154). */
export interface FakePullRecord {
  title: string
  author?: FakeAccount
  mergedBy?: FakeAccount
  merged: boolean
  files: string[]
  reviews: Array<{ user: FakeAccount; state: string }>
}

export interface FakeCall {
  method: string
  path: string
  query: string
  body: unknown
  /** The Authorization header the request carried, to tell which credential made it. */
  authorization?: string
}

/**
 * A credential the fake accepts, and what GitHub lets its kind do: a user's
 * token answers GET /user and may not write check runs, the Actions token
 * and an App installation's token are the reverse.
 */
export interface FakeToken {
  login: string
  kind: 'actions' | 'user' | 'installation'
  /** GET /user answers 403 with GitHub's rate limit message, as an exhausted token is answered. */
  rateLimited?: boolean
  /** A check run is refused: the token's job was not granted checks: write. */
  noChecks?: boolean
}

/** The App the fake knows: its id, the public half of its key, and where it is installed. */
export interface FakeApp {
  id: string
  /** PEM. A JSON web token must verify against it. */
  publicKey: string
  slug: string
  installationId: number
  /** False: the App exists and is not installed on the repository. */
  installed: boolean
}

export interface FakeComment {
  id: number
  issue: number
  body: string
  /** Who wrote it; the fake token comments as github-actions[bot]. */
  author?: string
  /** How GitHub relates the author to the repository (OWNER, MEMBER, NONE, ...); NONE when unset. */
  association?: string
  /** An edit to this comment answers with this status. */
  failEditWith?: number
}

export interface FakeGithub {
  url: string
  calls: FakeCall[]
  issues: Map<number, FakeIssue>
  /**
   * State, labels and author of the issues created through the API, or set by
   * a test. An issue with no entry here is served as it always was: text only.
   */
  issueMeta: Map<number, FakeIssueMeta>
  /** The default branch's commits, oldest first, as the commits API lists them (#154). */
  commitLog: Array<{ sha: string; message: string; date: string }>
  /** The pull requests each commit came in by, by number. */
  commitPulls: Map<string, number[]>
  /** The pull requests blame can read. */
  pullRecords: Map<number, FakePullRecord>
  /** Every comment with its id, in the order written; issue.comments mirrors the bodies. */
  commentRecords: FakeComment[]
  /** Every token the fake accepts. FAKE_TOKEN, the Actions token, is there from the start. */
  tokens: Map<string, FakeToken>
  /** The App a JSON web token may authenticate as; undefined means there is none. */
  app: FakeApp | undefined
  /** What each installation token was asked for: the request body, in order. */
  minted: Array<{ token: string; body: unknown }>
  /** The fake's clock, in milliseconds, for a test that moves time; undefined means the real one. */
  nowMs: number | undefined
  checkRuns: unknown[]
  /**
   * The jobs of each workflow run attempt, keyed "<run id>/<attempt>", as the
   * Actions jobs API lists them: name, conclusion and steps.
   */
  runJobs: Map<string, unknown[]>
  /** Branch heads: refs/heads/&lt;branch&gt; to the head commit sha. */
  refs: Map<string, string>
  /** Every commit the fake has accepted, sha to its tree and parents. */
  commits: Map<string, { tree: string; parents: string[] }>
  /** Every pull request the fake has accepted, number to its record. */
  pulls: FakePull[]
  /** Blob contents by sha, so a contents read can serve what a push wrote. */
  blobs: Map<string, Buffer>
  /** Tree entries by sha: path, mode and blob sha. */
  trees: Map<string, FakeTreeEntry[]>
  /** The trees whose listing GitHub would cut short, by sha. */
  truncatedTrees: Set<string>
  /**
   * True: the repository answers 404 to everything under /repos, as GitHub
   * answers for a private repository the token cannot see.
   */
  hidden: boolean
  status: number | undefined
  /**
   * How many of the next git ref updates fail with 422, one per attempt: the
   * way GitHub refuses a push onto a branch that moved under it. Set to 1 to
   * make exactly one push attempt fail, more to exhaust a retry budget.
   */
  failRefPatches: number
  close(): Promise<void>
}

export interface FakeTreeEntry {
  path: string
  mode: '100644'
  type: 'blob'
  sha: string
}

export interface FakePull {
  number: number
  head: string
  base: string
  title: string
  body: string
  htmlUrl?: string
}

const TOKEN = 'qa-test-token'
const TOKEN_LOGIN = 'github-actions[bot]'

interface FakeCommit {
  tree: string
  parents: string[]
}

export function startFakeGithub(): Promise<FakeGithub> {
  const issues = new Map<number, FakeIssue>()
  const issueMeta = new Map<number, FakeIssueMeta>()
  const commitLog: Array<{ sha: string; message: string; date: string }> = []
  const commitPulls = new Map<string, number[]>()
  const pullRecords = new Map<number, FakePullRecord>()
  /** An issue as the API answers with it: its text, and what GitHub keeps beside it when the fake knows it. */
  const served = (issue: FakeIssue): unknown => {
    const meta = issueMeta.get(issue.number)
    if (meta === undefined) return issue
    return {
      ...issue,
      state: meta.state,
      ...(meta.stateReason === undefined ? {} : { state_reason: meta.stateReason }),
      labels: meta.labels.map((name) => ({ name })),
      user: { login: meta.author },
    }
  }
  const calls: FakeCall[] = []
  const commentRecords: FakeComment[] = []
  const checkRuns: unknown[] = []
  const runJobs = new Map<string, unknown[]>()
  const refs = new Map<string, string>()
  const commits = new Map<string, FakeCommit>()
  const pulls: FakePull[] = []
  const blobs = new Map<string, Buffer>()
  const trees = new Map<string, FakeTreeEntry[]>()
  const truncatedTrees = new Set<string>()
  let hidden = false
  const tokens = new Map<string, FakeToken>([[TOKEN, { login: TOKEN_LOGIN, kind: 'actions' }]])
  const minted: Array<{ token: string; body: unknown }> = []
  const state = {
    status: undefined as number | undefined,
    failRefPatches: 0,
    app: undefined as FakeApp | undefined,
    nowMs: undefined as number | undefined,
  }
  const clock = () => state.nowMs ?? Date.now()
  let nextNumber = 100
  let nextCommentId = 5000
  let nextObject = 1
  const objectSha = (prefix: string) => `${prefix}-${nextObject++}`

  const server: Server = createServer((request, response) => {
    void handle(request, response)
  })

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', ['http:', '//fake.github.local'].join(''))
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const rawBody = Buffer.concat(chunks).toString('utf8')
    const body: unknown = rawBody === '' ? undefined : JSON.parse(rawBody)
    const authorization = request.headers.authorization
    calls.push({
      method: request.method ?? '',
      path: url.pathname,
      query: url.searchParams.toString(),
      body,
      ...(authorization === undefined ? {} : { authorization }),
    })

    const fail = () => {
      respond(response, state.status ?? 500, { message: 'fake error' })
    }
    if (state.status !== undefined) return fail()
    const parts = url.pathname.split('/').filter((part) => part !== '')
    const bearer = /^Bearer (.+)$/.exec(authorization ?? '')?.[1] ?? ''

    // The App's own endpoints: authenticated by a JSON web token the App
    // signed with its private key, never by a token.
    const asApp =
      url.pathname === '/app' ||
      (parts[0] === 'repos' && parts[3] === 'installation' && parts.length === 4) ||
      (parts[0] === 'app' && parts[1] === 'installations')
    if (asApp) {
      const app = state.app
      if (app === undefined || !jwtIsFrom(bearer, app)) {
        respond(response, 401, { message: 'A JSON web token could not be decoded' })
        return
      }
      if (url.pathname === '/app' && request.method === 'GET') {
        respond(response, 200, { id: 1, slug: app.slug, name: app.slug })
        return
      }
      if (parts[0] === 'repos' && request.method === 'GET') {
        if (!app.installed) return respond(response, 404, { message: 'Not Found' })
        respond(response, 200, { id: app.installationId, app_slug: app.slug })
        return
      }
      if (parts[3] === 'access_tokens' && parts.length === 4 && request.method === 'POST') {
        if (!app.installed || Number(parts[2]) !== app.installationId) return respond(response, 404, { message: 'Not Found' })
        const token = `ghs_fake_installation_${minted.length + 1}`
        minted.push({ token, body })
        tokens.set(token, { login: `${app.slug}[bot]`, kind: 'installation' })
        respond(response, 201, { token, expires_at: new Date(clock() + 60 * 60 * 1000).toISOString() })
        return
      }
      respond(response, 404, { message: `fake github has no App route for ${request.method} ${url.pathname}` })
      return
    }

    const caller = tokens.get(bearer)
    if (caller === undefined) {
      respond(response, 401, { message: 'Bad credentials: Authorization: Bearer <token> required' })
      return
    }
    if (url.pathname === '/user' && request.method === 'GET') {
      // Only a user's token is a user; an installation's is refused, as GitHub refuses it.
      if (caller.kind !== 'user') return respond(response, 403, { message: 'Resource not accessible by integration' })
      if (caller.rateLimited === true) return respond(response, 403, { message: 'API rate limit exceeded for user ID 1.' })
      respond(response, 200, { login: caller.login })
      return
    }

    if (url.pathname === '/search/issues' && request.method === 'GET') {
      const q = url.searchParams.get('q') ?? ''
      const phrase = /"([^"]+)"/.exec(q)?.[1] ?? ''
      // is:open and is:closed narrow by state; an issue the fake holds no state for is open.
      const wanted = /\bis:(open|closed)\b/.exec(q)?.[1]
      // label:<name> narrows to the issues that carry it, as the search does.
      const label = /\blabel:([^\s"]+)/.exec(q)?.[1]
      const matched = [...issues.values()]
        .filter((issue) => issue.body.includes(phrase) || issue.title.includes(phrase))
        .filter((issue) => wanted === undefined || (issueMeta.get(issue.number)?.state ?? 'open') === wanted)
        .filter((issue) => label === undefined || (issueMeta.get(issue.number)?.labels ?? []).includes(label))
      const perPage = Number(url.searchParams.get('per_page') ?? '30')
      const page = Number(url.searchParams.get('page') ?? '1')
      const items =
        Number.isInteger(perPage) && perPage > 0 && Number.isInteger(page) && page > 0
          ? matched.slice((page - 1) * perPage, page * perPage)
          : matched
      respond(response, 200, { total_count: matched.length, items: items.map(served) })
      return
    }
    if (parts[0] === 'repos' && hidden) return respond(response, 404, { message: 'Not Found' })
    if (parts[0] === 'repos' && parts.length === 3 && request.method === 'GET') {
      respond(response, 200, { full_name: `${parts[1]}/${parts[2]}`, default_branch: 'main' })
      return
    }
    // The issue listing, which is not the search: it reads the issues themselves, so it sees one the moment it is created.
    if (parts[0] === 'repos' && parts[3] === 'issues' && parts.length === 4 && request.method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open'
      const labels = (url.searchParams.get('labels') ?? '').split(',').filter((label) => label !== '')
      const listed = [...issues.values()]
        .filter((issue) => state === 'all' || (issueMeta.get(issue.number)?.state ?? 'open') === state)
        .filter((issue) => labels.every((label) => (issueMeta.get(issue.number)?.labels ?? []).includes(label)))
        .sort((a, b) => a.number - b.number)
      const perPage = Number(url.searchParams.get('per_page') ?? '30')
      const page = Number(url.searchParams.get('page') ?? '1')
      respond(response, 200, listed.slice((page - 1) * perPage, page * perPage).map(served))
      return
    }
    if (parts[0] === 'repos' && parts[3] === 'issues' && parts.length === 4 && request.method === 'POST') {
      const payload = body as { title: string; body: string; labels?: string[] }
      const issue: FakeIssue = { number: nextNumber, title: payload.title, body: payload.body, comments: [] }
      nextNumber += 1
      issues.set(issue.number, issue)
      issueMeta.set(issue.number, { state: 'open', labels: payload.labels ?? [], author: caller.login })
      respond(response, 201, served(issue))
      return
    }
    if (parts[0] === 'repos' && parts[3] === 'issues' && parts[4] !== undefined && parts.length === 5) {
      const issue = issues.get(Number(parts[4]))
      if (issue === undefined) {
        respond(response, 404, { message: 'issue not found' })
        return
      }
      if (request.method === 'GET') {
        respond(response, 200, served(issue))
        return
      }
      if (request.method === 'PATCH') {
        // Only what the request names changes: a state change leaves the body alone.
        const patch = body as { body?: string; state?: 'open' | 'closed'; state_reason?: string }
        if (patch.body !== undefined) issue.body = patch.body
        if (patch.state !== undefined) {
          const meta = issueMeta.get(issue.number) ?? { state: 'open', labels: [], author: TOKEN_LOGIN }
          issueMeta.set(issue.number, { ...meta, state: patch.state, ...(patch.state_reason === undefined ? {} : { stateReason: patch.state_reason }) })
        }
        respond(response, 200, served(issue))
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
        const record = { id: nextCommentId, issue: issue.number, body: text, author: caller.login }
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
            .map((record) => ({ id: record.id, body: record.body, user: { login: record.author ?? TOKEN_LOGIN }, author_association: record.association ?? 'NONE' })),
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
      // GitHub lets only an App write a check run: a user's token is refused.
      if (caller.kind === 'user') return respond(response, 403, { message: 'You must authenticate via a GitHub App.' })
      if (caller.noChecks === true) return respond(response, 403, { message: 'Resource not accessible by integration' })
      checkRuns.push(body)
      respond(response, 201, { id: checkRuns.length, ...(body as object) })
      return
    }
    if (
      parts[0] === 'repos' && parts[3] === 'actions' && parts[4] === 'runs' && parts[6] === 'attempts' &&
      parts[8] === 'jobs' && parts.length === 9 && request.method === 'GET'
    ) {
      const jobs = runJobs.get(`${parts[5]}/${parts[7]}`)
      if (jobs === undefined) return respond(response, 404, { message: 'run attempt not found' })
      const perPage = Number(url.searchParams.get('per_page') ?? '30')
      const page = Number(url.searchParams.get('page') ?? '1')
      respond(response, 200, { total_count: jobs.length, jobs: jobs.slice((page - 1) * perPage, page * perPage) })
      return
    }
    // What blame reads (#154): the commits since a moment, the pull requests a
    // commit came in by, and a pull request's people, files and reviews.
    if (parts[0] === 'repos' && parts[3] === 'commits' && parts.length === 4 && request.method === 'GET') {
      const since = Date.parse(url.searchParams.get('since') ?? '')
      const perPage = Number(url.searchParams.get('per_page') ?? '30')
      const page = Number(url.searchParams.get('page') ?? '1')
      const listed = [...commitLog]
        .filter((commit) => Number.isNaN(since) || Date.parse(commit.date) >= since)
        .reverse()
        .slice((page - 1) * perPage, page * perPage)
      respond(response, 200, listed.map((commit) => ({ sha: commit.sha, commit: { message: commit.message, committer: { date: commit.date } } })))
      return
    }
    if (parts[0] === 'repos' && parts[3] === 'commits' && parts[5] === 'pulls' && parts.length === 6 && request.method === 'GET') {
      const numbers = commitPulls.get(parts[4] ?? '') ?? []
      respond(
        response,
        200,
        numbers.map((number) => {
          const record = pullRecords.get(number)
          return { number, title: record?.title ?? '', user: record?.author ?? null, merged_at: record?.merged === true ? '2026-09-29T00:00:00Z' : null }
        }),
      )
      return
    }
    if (parts[0] === 'repos' && parts[3] === 'pulls' && parts[4] !== undefined && request.method === 'GET') {
      const record = pullRecords.get(Number(parts[4]))
      if (record === undefined) return respond(response, 404, { message: 'pull request not found' })
      if (parts.length === 5) {
        respond(response, 200, { number: Number(parts[4]), title: record.title, user: record.author ?? null, merged_by: record.mergedBy ?? null, merged_at: record.merged ? '2026-09-29T00:00:00Z' : null })
        return
      }
      const perPage = Number(url.searchParams.get('per_page') ?? '30')
      const page = Number(url.searchParams.get('page') ?? '1')
      if (parts[5] === 'files' && parts.length === 6) {
        respond(response, 200, record.files.slice((page - 1) * perPage, page * perPage).map((filename) => ({ filename })))
        return
      }
      if (parts[5] === 'reviews' && parts.length === 6) {
        respond(response, 200, record.reviews)
        return
      }
    }
    // A small git data API: blobs, trees, commits and refs are stored in
    // memory so a push can be followed from blob to ref.
    if (parts[0] === 'repos' && parts[3] === 'git' && parts[4] === 'blobs' && parts.length === 5) {
      if (request.method !== 'POST') return respond(response, 404, { message: 'no such blob route' })
      const payload = body as { content: string; encoding: string }
      const sha = objectSha('blob')
      blobs.set(sha, Buffer.from(payload.content, payload.encoding === 'base64' ? 'base64' : 'utf8'))
      respond(response, 201, { sha })
      return
    }
    if (parts[0] === 'repos' && parts[3] === 'git' && parts[4] === 'trees' && parts.length === 6 && request.method === 'GET') {
      const tree = trees.get(parts[5] ?? '')
      if (tree === undefined) return respond(response, 404, { message: 'tree not found' })
      // As the trees API lists one: every entry with its type, and whether the listing was cut short.
      respond(response, 200, { sha: parts[5], tree: tree.map((entry) => ({ path: entry.path, mode: entry.mode, type: 'blob', sha: entry.sha })), truncated: truncatedTrees.has(parts[5] ?? '') })
      return
    }
    if (parts[0] === 'repos' && parts[3] === 'git' && parts[4] === 'trees' && parts.length === 5) {
      if (request.method !== 'POST') return respond(response, 404, { message: 'no such tree route' })
      const sha = objectSha('tree')
      trees.set(sha, (body as { tree: FakeTreeEntry[] }).tree)
      respond(response, 201, { sha })
      return
    }
    if (parts[0] === 'repos' && parts[3] === 'git' && parts[4] === 'commits') {
      if (request.method === 'POST' && parts.length === 5) {
        const sha = objectSha('commit')
        const payload = body as { tree: string; parents?: string[] }
        commits.set(sha, { tree: payload.tree, parents: payload.parents ?? [] })
        respond(response, 201, { sha, tree: { sha: payload.tree } })
        return
      }
      if (request.method === 'GET' && parts.length === 6) {
        const commit = commits.get(parts[5])
        if (commit === undefined) return respond(response, 404, { message: 'commit not found' })
        respond(response, 200, { sha: parts[5], tree: { sha: commit.tree }, parents: commit.parents })
        return
      }
    }
    if (parts[0] === 'repos' && parts[3] === 'git' && parts[4] === 'refs') {
      if (request.method === 'POST' && parts.length === 5) {
        const payload = body as { ref: string; sha: string }
        if (refs.has(payload.ref)) return respond(response, 422, { message: 'reference already exists' })
        refs.set(payload.ref, payload.sha)
        respond(response, 201, { ref: payload.ref, object: { sha: payload.sha, type: 'commit' } })
        return
      }
      if (parts[5] === 'heads' && parts.length === 7) {
        const branch = `refs/heads/${parts[6]}`
        if (request.method === 'GET') {
          const sha = refs.get(branch)
          if (sha === undefined) return respond(response, 404, { message: 'branch not found' })
          respond(response, 200, { ref: branch, object: { sha, type: 'commit' } })
          return
        }
        if (request.method === 'PATCH') {
          const sha = refs.get(branch)
          if (sha === undefined) return respond(response, 404, { message: 'branch not found' })
          if (state.failRefPatches > 0) {
            state.failRefPatches -= 1
            return respond(response, 422, { message: 'Update is not a fast forward' })
          }
          refs.set(branch, (body as { sha: string }).sha)
          respond(response, 200, { ref: branch, object: { sha: (body as { sha: string }).sha, type: 'commit' } })
          return
        }
      }
    }
    if (parts[0] === 'repos' && parts[3] === 'git' && parts[4] === 'ref' && parts[5] === 'heads' && parts.length === 7) {
      if (request.method !== 'GET') return respond(response, 404, { message: 'no such ref route' })
      const branch = `refs/heads/${parts[6]}`
      const sha = refs.get(branch)
      if (sha === undefined) return respond(response, 404, { message: 'branch not found' })
      respond(response, 200, { ref: branch, object: { sha, type: 'commit' } })
      return
    }
    if (parts[0] === 'repos' && parts[3] === 'pulls' && parts.length === 4 && request.method === 'POST') {
      const payload = body as { title: string; head: string; base: string; body: string }
      const existing = pulls.find((pull) => pull.head === payload.head)
      if (existing !== undefined) {
        respond(response, 422, {
          message: `Validation Failed: a pull request already exists for ${payload.head}.`,
        })
        return
      }
      const pull: FakePull = { number: nextNumber, head: payload.head, base: payload.base, title: payload.title, body: payload.body }
      nextNumber += 1
      pulls.push(pull)
      respond(response, 201, { number: pull.number, html_url: `pull/${pull.number}` })
      return
    }
    if (parts[0] === 'repos' && parts[3] === 'contents' && parts.length >= 5 && request.method === 'GET') {
      const path = parts.slice(4).join('/')
      const ref = url.searchParams.get('ref') ?? ''
      const head = refs.get(`refs/heads/${ref}`)
      const tree = head === undefined ? undefined : trees.get(commits.get(head)?.tree ?? '')
      const entry = tree?.find((candidate) => candidate.path === path)
      const content = entry === undefined ? undefined : blobs.get(entry.sha)
      if (content === undefined) return respond(response, 404, { message: `no contents for ${path} at ${ref}` })
      respond(response, 200, { content: content.toString('base64'), encoding: 'base64' })
      return
    }
    respond(response, 404, { message: `fake github has no route for ${request.method} ${url.pathname}` })
  }

  /** A JSON web token as GitHub accepts one: RS256, signed by the App, issued by it, and short. */
  function jwtIsFrom(jwt: string, app: FakeApp): boolean {
    const [header, payload, signature] = jwt.split('.')
    if (header === undefined || payload === undefined || signature === undefined) return false
    try {
      const head = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { alg?: string }
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { iss?: unknown; iat?: unknown; exp?: unknown }
      if (head.alg !== 'RS256' || String(claims.iss) !== app.id) return false
      if (typeof claims.iat !== 'number' || typeof claims.exp !== 'number') return false
      const now = Math.floor(clock() / 1000)
      // No longer than ten minutes, not yet expired, and not issued in the future.
      if (claims.exp - claims.iat > 600 || claims.exp <= now || claims.iat > now) return false
      return createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(app.publicKey, Buffer.from(signature, 'base64url'))
    } catch {
      return false
    }
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
        issueMeta,
        commitLog,
        commitPulls,
        pullRecords,
        commentRecords,
        tokens,
        minted,
        get app(): FakeApp | undefined {
          return state.app
        },
        set app(value: FakeApp | undefined) {
          state.app = value
        },
        get nowMs(): number | undefined {
          return state.nowMs
        },
        set nowMs(value: number | undefined) {
          state.nowMs = value
        },
        checkRuns,
        runJobs,
        refs,
        commits,
        pulls,
        blobs,
        trees,
        truncatedTrees,
        get hidden() {
          return hidden
        },
        set hidden(value: boolean) {
          hidden = value
        },
        get status(): number | undefined {
          return state.status
        },
        set status(value: number | undefined) {
          state.status = value
        },
        get failRefPatches(): number {
          return state.failRefPatches
        },
        set failRefPatches(value: number) {
          state.failRefPatches = value
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
