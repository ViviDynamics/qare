import {
  missingStubsFromResult,
  parseRefusedRegistry,
  refusedRegistryLine,
  stubIssueDraft,
  stubIssueMarker,
} from '@qare/core'
import type { RunResult, StubIssueDraft, StubIssuePoster } from '@qare/core'
import type { GitHubClient } from './github.js'

export class GitHubStubIssuePoster implements StubIssuePoster {
  private readonly client: GitHubClient

  constructor(client: GitHubClient) {
    this.client = client
  }

  async fileIfMissing(draft: StubIssueDraft): Promise<number> {
    const marker = stubIssueMarker(draft.key)
    const hits = await this.client.searchIssues(`repo:${this.client.repository} in:body "${marker}"`)
    const existing = hits[0]
    if (existing !== undefined) return existing.number
    const created = await this.client.createIssue(draft.title, draft.body)
    return created.number
  }

  async addToRegistry(issue: number, pr: number): Promise<void> {
    const current = await this.client.getIssue(issue)
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
