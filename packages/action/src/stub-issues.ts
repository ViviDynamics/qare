import {
  missingStubsFromResult,
  parseRefusedRegistry,
  parseStubIssueMarkers,
  refusedRegistryLine,
  stubIssueDraft,
  stubIssueMarker,
} from '@qare/core'
import type { RunResult, StubIssueDraft, StubIssuePoster } from '@qare/core'
import { GitHubClientError, type GitHubClient } from './github.js'

export class GitHubStubIssuePoster implements StubIssuePoster {
  private readonly client: GitHubClient

  constructor(client: GitHubClient) {
    this.client = client
  }

  async fileIfMissing(draft: StubIssueDraft): Promise<number> {
    // Search-then-create is racy: GitHub's search index lags issue creation by
    // minutes, so two runs can both miss and both create a duplicate stub issue.
    // Tolerated because requeue is driven by the qare-refused registry lines on
    // the issue body — a duplicate still carries the registry and each refused
    // PR is re-queued exactly once per registry entry.
    const marker = stubIssueMarker(draft.key)
    const hits = await this.client.searchOwnIssues(marker)
    const existing = hits.find((issue) => parseStubIssueMarkers(issue.body ?? '').includes(draft.key))
    if (existing !== undefined) return existing.number
    const created = await this.client.createIssue(draft.title, draft.body)
    return created.number
  }

  async addToRegistry(issue: number, pr: number): Promise<void> {
    const current = await this.client.getIssue(issue)
    const author = await this.client.identity.login()
    if (current.user?.login !== author) throw new GitHubClientError(`issue #${issue} is not owned by ${author}; refused registry was not changed`)
    if (parseRefusedRegistry(current.body ?? '').includes(pr)) return
    await this.client.patchIssueBody(issue, appendRegistryLine(current.body ?? '', pr))
  }

  async comment(pr: number, body: string): Promise<void> {
    await this.client.postIssueComment(pr, body)
  }
}

export interface FiledStubIssue {
  key: string
  issue: number
}

export async function fileRefusalStubs(
  poster: StubIssuePoster,
  result: RunResult,
  pr: number,
): Promise<FiledStubIssue[]> {
  if (result.verdict !== 'refused') return []
  const filed: FiledStubIssue[] = []
  for (const missing of missingStubsFromResult(result)) {
    const draft = stubIssueDraft(missing)
    const issue = await poster.fileIfMissing(draft)
    await poster.addToRegistry(issue, pr)
    await poster.comment(pr, refusalComment(missing.host, issue))
    filed.push({ key: draft.key, issue })
  }
  return filed
}

export function refusalComment(host: string, issue: number): string {
  return `QARE refused this run: \`${host}\` has no stub. Tracked in #${issue} (${stubIssueMarker(host)}); ` +
    'this pull request is registered on the stub issue and will be re-queued with /qa when the stub lands.'
}

export function appendRegistryLine(body: string, pr: number): string {
  return [body.replace(/\s+$/, ''), '', refusedRegistryLine(pr)].join('\n')
}
