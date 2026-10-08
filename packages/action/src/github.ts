import { GitHubApiError, GitHubClientError } from './errors.js'
import { DEFAULT_API_ROOT, resolveIdentity, type GitHubIdentity } from './identity.js'

export { GitHubApiError, GitHubClientError } from './errors.js'

const DEFAULT_REPOSITORY_ENV = 'GITHUB_REPOSITORY'

export interface GitHubIssue {
  number: number
  title: string
  body?: string
  state?: string
  /** Who opened it. An issue is qare's own only when this is the identity qare posts as. */
  user?: { login?: string } | null
}

/** A GitHub account as blame reads it (#154): its login, and whether GitHub says it is a bot. */
export interface GitHubPerson {
  login: string
  bot: boolean
}

/** A pull request as blame reads it (#154): who opened it and who merged it. */
export interface GitHubPull {
  number: number
  title: string
  author?: GitHubPerson
  mergedBy?: GitHubPerson
}

interface GithubUser {
  login?: string
  type?: string
}

function person(user: GithubUser | null | undefined): GitHubPerson | undefined {
  if (user === null || user === undefined || typeof user.login !== 'string' || user.login === '') return undefined
  return { login: user.login, bot: user.type === 'Bot' }
}

export interface GitHubComment {
  id: number
  body?: string
  user?: { login?: string } | null
  /** How GitHub relates the author to the repository: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE and so on. */
  author_association?: string
}

export interface GitHubCheckRun {
  name: string
  head_sha: string
  status: 'completed'
  conclusion: 'success' | 'failure' | 'neutral'
  output: { title: string; summary: string }
}

/** A job of a workflow run, as the Actions jobs API lists it. */
export interface GitHubRunJob {
  name: string
  conclusion: string | null
  steps?: Array<{ name: string; conclusion: string | null }>
}

interface GithubRef {
  object: { sha: string }
}

interface GithubCommit {
  tree: { sha: string }
}

export interface GithubTreeEntry {
  path: string
  mode: '100644'
  type: 'blob'
  sha: string
}

export interface GitHubClientOptions {
  repository?: string
  apiRoot?: string
  /** A token handed over directly: an explicit choice, above the environment. */
  token?: string
  /** The variable that holds the token, when the command line names one (`--token-env`). */
  tokenEnv?: string
  /**
   * Who the client posts as. Left out, it is resolved from the environment
   * (#61): the App, then a personal access token, then the Actions token.
   */
  identity?: GitHubIdentity
  fetchImpl?: typeof fetch
}

/** The most pages of a label's issues one read takes, a hundred issues a page. */
const MAX_ISSUE_PAGES = 200

export class GitHubClient {
  readonly repository: string
  /** Who this client posts as. The posting code asks it nothing but its login. */
  readonly identity: GitHubIdentity
  private readonly root: string
  private readonly doFetch: typeof fetch

  constructor(options: GitHubClientOptions = {}) {
    const repository = options.repository ?? process.env[DEFAULT_REPOSITORY_ENV] ?? ''
    if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
      throw new GitHubClientError(
        `qare-action needs a repository as "owner/name": pass --repository "owner/name" or set ${DEFAULT_REPOSITORY_ENV} (got ${JSON.stringify(repository)})`,
      )
    }
    this.repository = repository
    this.root = (options.apiRoot ?? DEFAULT_API_ROOT).replace(/\/+$/, '')
    this.doFetch = options.fetchImpl ?? globalThis.fetch
    this.identity =
      options.identity ??
      resolveIdentity({
        repository,
        apiRoot: this.root,
        fetchImpl: this.doFetch,
        token: options.token,
        tokenEnv: options.tokenEnv,
      })
  }

  async searchIssues(query: string): Promise<GitHubIssue[]> {
    const items: GitHubIssue[] = []
    for (let page = 1; ; page += 1) {
      const response = await this.request(
        'GET',
        '/search/issues',
        new URLSearchParams({ q: query, per_page: '100', page: String(page) }),
      )
      const batch = (response as { items?: GitHubIssue[] }).items
      if (!Array.isArray(batch) || batch.length === 0) break
      items.push(...batch)
      if (batch.length < 100) break
    }
    return items
  }

  async getIssue(number: number): Promise<GitHubIssue> {
    return this.request('GET', `/repos/${this.repository}/issues/${number}`)
  }

  /** Labels are sent only when named: GitHub creates one that does not exist yet. */
  async createIssue(title: string, body: string, labels?: string[]): Promise<GitHubIssue> {
    return this.request('POST', `/repos/${this.repository}/issues`, undefined, {
      title,
      body,
      ...(labels === undefined || labels.length === 0 ? {} : { labels }),
    })
  }

  /** Close or reopen an issue (#154), saying why. The body and the labels are left as they are. */
  async setIssueState(number: number, state: 'open' | 'closed', reason: 'completed' | 'reopened'): Promise<void> {
    await this.request('PATCH', `/repos/${this.repository}/issues/${number}`, undefined, { state, state_reason: reason })
  }

  /**
   * The commits reachable from a revision and committed since a moment
   * (#154), newest first, with the first line of each message. At most
   * `limit` are read; `truncated` says there were more.
   */
  async listCommitsSince(sha: string, since: string, limit: number): Promise<{ commits: Array<{ sha: string; subject: string }>; truncated: boolean }> {
    const commits: Array<{ sha: string; subject: string }> = []
    for (let page = 1; ; page += 1) {
      const batch = await this.request<Array<{ sha: string; commit?: { message?: string } }>>(
        'GET',
        `/repos/${this.repository}/commits`,
        new URLSearchParams({ sha, since, per_page: '100', page: String(page) }),
      )
      if (!Array.isArray(batch) || batch.length === 0) break
      for (const entry of batch) {
        if (commits.length >= limit) return { commits, truncated: true }
        commits.push({ sha: entry.sha, subject: (entry.commit?.message ?? '').split('\n')[0] ?? '' })
      }
      if (batch.length < 100) break
    }
    return { commits, truncated: false }
  }

  /** The numbers of the merged pull requests a commit came in by (#154); one never merged brought nothing. */
  async listMergedPullsForCommit(sha: string): Promise<number[]> {
    const pulls = await this.request<Array<{ number: number; merged_at?: string | null }>>(
      'GET',
      `/repos/${this.repository}/commits/${sha}/pulls`,
      new URLSearchParams({ per_page: '100' }),
    )
    if (!Array.isArray(pulls)) return []
    return pulls.filter((pull) => typeof pull.merged_at === 'string' && pull.merged_at !== '').map((pull) => pull.number)
  }

  async getPull(number: number): Promise<GitHubPull> {
    const pull = await this.request<{ number: number; title?: string; user?: GithubUser | null; merged_by?: GithubUser | null }>(
      'GET',
      `/repos/${this.repository}/pulls/${number}`,
    )
    const author = person(pull.user)
    const mergedBy = person(pull.merged_by)
    return {
      number: pull.number,
      title: pull.title ?? '',
      ...(author === undefined ? {} : { author }),
      ...(mergedBy === undefined ? {} : { mergedBy }),
    }
  }

  /** The paths a pull request changed, at most `limit` of them. */
  async listPullFiles(number: number, limit: number): Promise<string[]> {
    const files: string[] = []
    for (let page = 1; files.length < limit; page += 1) {
      const batch = await this.request<Array<{ filename?: string }>>(
        'GET',
        `/repos/${this.repository}/pulls/${number}/files`,
        new URLSearchParams({ per_page: '100', page: String(page) }),
      )
      if (!Array.isArray(batch) || batch.length === 0) break
      for (const entry of batch) if (typeof entry.filename === 'string') files.push(entry.filename)
      if (batch.length < 100) break
    }
    return files.slice(0, limit)
  }

  /** Who approved a pull request, in the order they did, each once. */
  async listPullApprovers(number: number): Promise<GitHubPerson[]> {
    const reviews = await this.request<Array<{ state?: string; user?: GithubUser | null }>>(
      'GET',
      `/repos/${this.repository}/pulls/${number}/reviews`,
      new URLSearchParams({ per_page: '100' }),
    )
    const approvers = new Map<string, GitHubPerson>()
    for (const review of Array.isArray(reviews) ? reviews : []) {
      const who = review.state === 'APPROVED' ? person(review.user) : undefined
      if (who !== undefined && !approvers.has(who.login)) approvers.set(who.login, who)
    }
    return [...approvers.values()]
  }

  async patchIssueBody(number: number, body: string): Promise<void> {
    await this.request('PATCH', `/repos/${this.repository}/issues/${number}`, undefined, { body })
  }

  async postIssueComment(number: number, body: string): Promise<void> {
    await this.request('POST', `/repos/${this.repository}/issues/${number}/comments`, undefined, { body })
  }

  async listIssueComments(number: number): Promise<GitHubComment[]> {
    const comments: GitHubComment[] = []
    for (let page = 1; ; page += 1) {
      const batch = await this.request<GitHubComment[]>(
        'GET',
        `/repos/${this.repository}/issues/${number}/comments`,
        new URLSearchParams({ per_page: '100', page: String(page) }),
      )
      if (!Array.isArray(batch) || batch.length === 0) break
      comments.push(...batch)
      if (batch.length < 100) break
    }
    return comments
  }

  async updateIssueComment(id: number, body: string): Promise<void> {
    await this.request('PATCH', `/repos/${this.repository}/issues/comments/${id}`, undefined, { body })
  }

  /**
   * GitHub lets only an App write a check run, so this one request is made
   * with the identity's checks token: the App's own, or, for a personal
   * access token, the Actions token of the run it is used in. An identity
   * with no token that may write one says so before anything is sent, and a
   * refusal from GitHub is reported as GitHub gave it.
   */
  async createCheckRun(run: GitHubCheckRun): Promise<void> {
    await this.request('POST', `/repos/${this.repository}/check-runs`, undefined, run, await this.identity.checksToken())
  }

  /** Every job of one attempt of a workflow run, in the order the API lists them. */
  async listRunJobs(runId: number, attempt: number): Promise<GitHubRunJob[]> {
    const jobs: GitHubRunJob[] = []
    for (let page = 1; ; page += 1) {
      const batch = await this.request<{ jobs?: GitHubRunJob[] }>(
        'GET',
        `/repos/${this.repository}/actions/runs/${runId}/attempts/${attempt}/jobs`,
        new URLSearchParams({ per_page: '100', page: String(page) }),
      )
      const listed = Array.isArray(batch.jobs) ? batch.jobs : []
      jobs.push(...listed)
      if (listed.length < 100) break
    }
    return jobs
  }

  /** The commit a branch head points at, or undefined when the branch does not exist. */
  async getBranchHead(branch: string): Promise<string | undefined> {
    try {
      const ref = await this.request<GithubRef>('GET', `/repos/${this.repository}/git/ref/heads/${branch}`)
      return ref.object.sha
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return undefined
      throw error
    }
  }

  async createBlob(content: Buffer): Promise<string> {
    const blob = await this.request<{ sha: string }>('POST', `/repos/${this.repository}/git/blobs`, undefined, {
      content: content.toString('base64'),
      encoding: 'base64',
    })
    return blob.sha
  }

  async createTree(entries: GithubTreeEntry[], baseTree?: string): Promise<string> {
    const tree = await this.request<{ sha: string }>('POST', `/repos/${this.repository}/git/trees`, undefined, {
      ...(baseTree === undefined ? {} : { base_tree: baseTree }),
      tree: entries,
    })
    return tree.sha
  }

  /**
   * Whether this identity can see the repository at all (#151). GitHub
   * answers 404 for a private repository a token cannot see, exactly as it
   * does for a file that is not there, so a reader that must tell "absent"
   * from "unreadable" asks this first.
   */
  async canSeeRepository(): Promise<boolean> {
    try {
      await this.request('GET', `/repos/${this.repository}`)
      return true
    } catch (error) {
      if (error instanceof GitHubApiError && (error.status === 404 || error.status === 403)) return false
      throw error
    }
  }

  /**
   * The open issues that carry a label, read from the issues themselves and
   * not from the search (#151): the search index lags an issue's creation by
   * minutes, and a listing sees it at once. Pull requests, which the listing
   * mixes in, are left out.
   */
  async listOpenIssuesByLabel(label: string): Promise<GitHubIssue[]> {
    const issues: GitHubIssue[] = []
    // Read to the last page: a listing that stopped early would leave issues
    // out without a word. The bound is only against a listing that never
    // ends, and reaching it is an error, never a short answer.
    for (let page = 1; ; page += 1) {
      if (page > MAX_ISSUE_PAGES)
        throw new GitHubClientError(`${this.repository} lists more than ${MAX_ISSUE_PAGES * 100} open issues labelled ${label}, which is more than can be read`)
      const listed = await this.request<Array<GitHubIssue & { pull_request?: unknown }>>(
        'GET',
        `/repos/${this.repository}/issues`,
        new URLSearchParams({ state: 'open', labels: label, per_page: '100', page: String(page) }),
      )
      issues.push(...listed.filter((issue) => issue.pull_request === undefined))
      if (listed.length < 100) break
    }
    return issues
  }

  /**
   * Every file path of a tree, read whole (#151). A tree GitHub cut short is
   * refused: a listing that silently lacks its newest entries would be read
   * as a repository that recorded no run.
   */
  async listTreePaths(tree: string): Promise<string[]> {
    const listed = await this.request<{ tree?: Array<{ path?: unknown; type?: unknown }>; truncated?: unknown }>(
      'GET',
      `/repos/${this.repository}/git/trees/${tree}`,
      new URLSearchParams({ recursive: '1' }),
    )
    if (listed.truncated === true) throw new GitHubClientError(`GitHub cut the listing of tree ${tree} short, so what it holds cannot be read whole`)
    if (!Array.isArray(listed.tree)) throw new GitHubClientError(`GitHub returned no listing for tree ${tree}`)
    return listed.tree.filter((entry) => entry.type === 'blob' && typeof entry.path === 'string').map((entry) => entry.path as string)
  }

  async getCommitTree(sha: string): Promise<string> {
    const commit = await this.request<GithubCommit>('GET', `/repos/${this.repository}/git/commits/${sha}`)
    return commit.tree.sha
  }

  /** One commit with no parents when there is no parent yet, so the branch starts as an orphan. */
  async createCommit(message: string, tree: string, parents: string[]): Promise<string> {
    const commit = await this.request<{ sha: string }>('POST', `/repos/${this.repository}/git/commits`, undefined, {
      message,
      tree,
      parents,
    })
    return commit.sha
  }

  /**
   * Creates the branch on its first commit, or moves it fast-forward onto a
   * new one. A non-fast-forward (a concurrent run pushed first) is refused by
   * the default force=false, which fails this push rather than rewriting
   * history: the branch is append-only.
   */
  async pushBranch(branch: string, sha: string, parent: string | undefined): Promise<void> {
    if (parent === undefined) {
      await this.request('POST', `/repos/${this.repository}/git/refs`, undefined, {
        ref: `refs/heads/${branch}`,
        sha,
      })
      return
    }
    await this.request('PATCH', `/repos/${this.repository}/git/refs/heads/${branch}`, undefined, { sha })
  }

  /** A file's content at a ref, base64-decoded; absent is undefined, not an error. */
  async getContents(path: string, ref: string): Promise<Buffer | undefined> {
    try {
      const contents = await this.request<{ content?: string; encoding?: string }>(
        'GET',
        `/repos/${this.repository}/contents/${path}`,
        new URLSearchParams({ ref }),
      )
      if (contents.encoding !== 'base64' || typeof contents.content !== 'string') {
        throw new GitHubClientError(`GitHub returned the contents of ${path} in a form ingest cannot read`)
      }
      return Buffer.from(contents.content, 'base64')
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return undefined
      throw error
    }
  }

  async createPullRequest(head: string, base: string, title: string, body: string): Promise<{ number: number; htmlUrl?: string }> {
    const pull = await this.request<{ number: number; html_url?: string }>(
      'POST',
      `/repos/${this.repository}/pulls`,
      undefined,
      { title, head, base, body },
    )
    return { number: pull.number, htmlUrl: pull.html_url }
  }

  private async request<T>(method: string, path: string, query?: URLSearchParams, payload?: unknown, token?: string): Promise<T> {
    const url = new URL(`${this.root}${path}`)
    if (query !== undefined) {
      for (const [key, value] of query) url.searchParams.append(key, value)
    }
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token ?? (await this.identity.token())}`,
    }
    let bodyText: string | undefined
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json'
      bodyText = JSON.stringify(payload)
    }
    const endpoint = `${method} ${url.pathname}${url.search}`
    const response = await this.doFetch(url, { method, headers, body: bodyText })
    if (!response.ok) {
      throw new GitHubApiError(response.status, endpoint, await response.text())
    }
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }
}
