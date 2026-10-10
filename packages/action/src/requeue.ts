import { parseRefusedRegistry, parseStubIssueMarkers, requeueTargets } from '@qare/core'
import type { StubIssueRefusedEntry } from '@qare/core'
import type { GitHubClient } from './github.js'

export const REQUEUE_COMMENT = '/qa'

/**
 * The `git diff` arguments that read the merged stubs: the change between two
 * revisions, under the profile directory. The directory is `.qa` unless the
 * repository keeps its profile elsewhere and says so (#145). It is a path
 * inside the repository and nothing else: never an option, never absolute,
 * never a way out through `..`.
 */
export function stubDiffArgs(spec: string, profile = '.qa'): string[] {
  const dir = profile.replace(/\/+$/, '')
  if (dir === '' || dir.startsWith('-') || dir.startsWith('/') || dir.split('/').includes('..'))
    throw new Error(`--profile must be a directory inside the repository (got ${JSON.stringify(profile)})`)
  return ['diff', '--unified=0', spec, '--', `${dir}/`]
}

export function stubKeysFromDiffText(diffText: string): string[] {
  const keys = new Set<string>()
  for (const line of diffText.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue
    // only flow-style `hosts: ["a.example", "b.example"]` entries are recognized;
    // block-sequence profiles under .qa/ must use the flow style for requeue pickup
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
  const issues = await client.searchOwnIssues('qare-stub:')
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
