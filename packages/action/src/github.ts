import { GitHubApiError, GitHubClientError } from './errors.js'
import { DEFAULT_API_ROOT, resolveIdentity, type GitHubIdentity } from './identity.js'

export { GitHubApiError, GitHubClientError } from './errors.js'

const DEFAULT_REPOSITORY_ENV = 'GITHUB_REPOSITORY'

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
