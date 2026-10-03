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
