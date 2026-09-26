import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { RunResult } from '@qare/core'
import { GitHubClientError, type GitHubClient, type GithubTreeEntry } from './github.js'

/**
 * The screenshot push of ADR-0002: the run's screenshots land on an orphan
 * `qa-assets` branch, under a path naming the run (date, head SHA and the
 * Actions run id), so evidence links keep resolving after the artifact
 * expires. The branch is append-only: each push is one new commit on top of
 * the branch head, and the history is never rewritten. The run id keeps a
 * rerun of the same commit on the same day from rewriting the path an earlier
 * comment links to.
 */
export const QA_ASSETS_BRANCH = 'qa-assets'

export interface ScreenshotPusher {
  /**
   * Pushes every screenshot the result lists, and returns the branch link for
   * each pushed file, keyed by the evidence path. A file that is not pushed
   * has no entry, so the comment can never link to it (CONSTITUTION rule 4).
   */
  push(result: RunResult, evidenceDir: string): Promise<Record<string, string>>
}

/** The run's screenshot paths: the `.png` files the result lists, deduplicated, in order. */
export function screenshotsOf(result: RunResult): string[] {
  const seen = new Set<string>()
  for (const criterion of result.criteria) {
    for (const path of criterion.evidence ?? []) {
      // The result contract already refuses absolute paths and `..`; skipping
      // them here too keeps a malformed path from naming a branch file.
      if (path === '' || isAbsolute(path) || path.includes('..') || !path.toLowerCase().endsWith('.png')) continue
      seen.add(path)
    }
  }
  return [...seen]
}

export class GitHubQaAssetsPusher implements ScreenshotPusher {
  private readonly client: GitHubClient
  private readonly headSha: string
  private readonly branch: string
  private readonly runId: string
  private readonly today: () => string

  constructor(
    client: GitHubClient,
    headSha: string,
    opts: { branch?: string; runId?: string; today?: () => string } = {},
  ) {
    if (!/^[0-9a-f]{40}$/.test(headSha))
      throw new GitHubClientError(`a head SHA is 40 lowercase hex characters (got ${JSON.stringify(headSha)})`)
    this.client = client
    this.headSha = headSha
    this.branch = opts.branch ?? QA_ASSETS_BRANCH
    this.runId = opts.runId ?? defaultRunId()
    this.today = opts.today ?? defaultToday
  }

  /**
   * One commit holds every screenshot of the run. The branch link is GitHub's
   * raw URL, which serves the image from the branch, not the artifact.
   */
  async push(result: RunResult, evidenceDir: string): Promise<Record<string, string>> {
    const files: Array<{ evidencePath: string; file: string }> = []
    for (const evidencePath of screenshotsOf(result)) {
      const file = join(evidenceDir, evidencePath)
      try {
        await readFile(file)
      } catch {
        // Not on disk, so it was not captured: named but never linked (rule 4).
        continue
      }
      files.push({ evidencePath, file })
    }
    if (files.length === 0) return {}

    const date = this.today()
    const parent = await this.client.getBranchHead(this.branch)
    const parentTree = parent === undefined ? undefined : await this.client.getCommitTree(parent)
    const entries: GithubTreeEntry[] = []
    for (const { evidencePath, file } of files) {
      const sha = await this.client.createBlob(await readFile(file))
      entries.push({ path: this.runPath(evidencePath, date), mode: '100644', type: 'blob', sha })
    }
    const tree = await this.client.createTree(entries, parentTree)
    const sha = await this.client.createCommit(
      `qa-assets: screenshots for run ${this.headSha.slice(0, 12)} on ${date}`,
      tree,
      parent === undefined ? [] : [parent],
    )
    await this.client.pushBranch(this.branch, sha, parent)
    const links: Record<string, string> = {}
    for (const { evidencePath } of files) links[evidencePath] = this.branchUrl(evidencePath, date)
    return links
  }

  private runPath(evidencePath: string, date: string): string {
    return `runs/${date}/${this.headSha}/${this.runId}/${evidencePath}`
  }

  private branchUrl(evidencePath: string, date: string): string {
    return `https://github.com/${this.client.repository}/raw/${this.branch}/${this.runPath(evidencePath, date)}`
  }
}

function defaultToday(): string {
  return new Date().toISOString().slice(0, 10)
}

/** The workflow run this execution belongs to: run id plus attempt, so a rerun never writes under a previous attempt's path. */
function defaultRunId(): string {
  const run = process.env.GITHUB_RUN_ID ?? 'unidentified-run'
  const attempt = process.env.GITHUB_RUN_ATTEMPT ?? '1'
  return `${run}-${attempt}`
}
