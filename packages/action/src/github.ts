const DEFAULT_API_ROOT = ['https:', '//api.github.com'].join('')
const DEFAULT_TOKEN_ENV = 'GITHUB_TOKEN'
const DEFAULT_REPOSITORY_ENV = 'GITHUB_REPOSITORY'

export class GitHubApiError extends Error {
  readonly status: number
  readonly endpoint: string

  constructor(status: number, endpoint: string, bodyText: string) {
    const snippet = bodyText.replace(/\s+/g, ' ').trim().slice(0, 200)
    super(`GitHub API request failed: ${endpoint} responded ${status}${snippet === '' ? '' : `: ${snippet}`}`)
    this.name = 'GitHubApiError'
    this.status = status
    this.endpoint = endpoint
  }
}

export class GitHubClientError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitHubClientError'
  }
}

export interface GitHubIssue {
  number: number
  title: string
  body?: string
  state?: string
}

export interface GitHubComment {
  id: number
  body?: string
  user?: { login?: string } | null
}

export interface GitHubCheckRun {
  name: string
  head_sha: string
  status: 'completed'
  conclusion: 'success' | 'failure' | 'neutral'
  output: { title: string; summary: string }
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
  token?: string
  tokenEnv?: string
  fetchImpl?: typeof fetch
}

export class GitHubClient {
  readonly repository: string
  private readonly root: string
  private readonly token: string | undefined
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
    const tokenEnv = options.tokenEnv ?? DEFAULT_TOKEN_ENV
    this.token = options.token ?? process.env[tokenEnv] ?? undefined
    if (this.token === undefined || this.token === '') {
      throw new GitHubClientError(
        `qare-action needs a GitHub token: set ${tokenEnv} in the environment (or pass { token } to GitHubClient)`,
      )
    }
    this.doFetch = options.fetchImpl ?? globalThis.fetch
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

  async createIssue(title: string, body: string): Promise<GitHubIssue> {
    return this.request('POST', `/repos/${this.repository}/issues`, undefined, { title, body })
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

  async createCheckRun(run: GitHubCheckRun): Promise<void> {
    await this.request('POST', `/repos/${this.repository}/check-runs`, undefined, run)
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

  private async request<T>(method: string, path: string, query?: URLSearchParams, payload?: unknown): Promise<T> {
    const url = new URL(`${this.root}${path}`)
    if (query !== undefined) {
      for (const [key, value] of query) url.searchParams.append(key, value)
    }
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
    if (this.token !== undefined) headers.Authorization = `Bearer ${this.token}`
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
