import { parseRefusedRegistry, parseStubIssueMarkers, requeueTargets } from '@qare/core'
import type { StubIssueRefusedEntry } from '@qare/core'
import type { GitHubClient } from './github.js'

export const REQUEUE_COMMENT = '/qa'

export function stubKeysFromDiffText(diffText: string): string[] {
  const keys = new Set<string>()
  for (const line of diffText.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue
    for (const block of line.matchAll(/hosts:\s*\[[^\]]*\]/g)) {
      for (const quoted of block[0].matchAll(/"([^"]+)"/g)) {
        const key = quoted[1]
        if (key !== undefined) keys.add(key)
      }
    }
  }
  return [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

export async function requeueUnblocked(
  client: GitHubClient,
  mergedKeys: string[],
  comment: string = REQUEUE_COMMENT,
): Promise<number[]> {
  const issues = await client.searchIssues(`repo:${client.repository} in:body "qare-stub:"`)
  const refused: StubIssueRefusedEntry[] = []
  for (const issue of issues) {
    const keys = parseStubIssueMarkers(issue.body ?? '')
    for (const pr of parseRefusedRegistry(issue.body ?? '')) {
      refused.push({ pr, keys })
    }
  }
  const targets = requeueTargets(mergedKeys ?? [], refused)
  for (const pr of targets) {
    await client.postIssueComment(pr, comment)
  }
  return targets
}
