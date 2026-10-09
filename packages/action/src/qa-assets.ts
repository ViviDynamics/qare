import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { MAIN_PASSES_PATH, type RunResult } from '@qare/core'
import { GitHubApiError, GitHubClientError, type GitHubClient, type GithubTreeEntry } from './github.js'

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
    const files: Array<{ evidencePath: string; content: Buffer }> = []
    for (const evidencePath of screenshotsOf(result)) {
      try {
        files.push({ evidencePath, content: await readFile(join(evidenceDir, evidencePath)) })
      } catch {
        // Not on disk, so it was not captured: named but never linked (rule 4).
        continue
      }
    }
    if (files.length === 0) return {}

    const date = this.today()
    await this.commitOntoBranch(
      files.map(({ evidencePath, content }) => ({ path: this.runPath(evidencePath, date), content })),
      `qa-assets: screenshots for run ${this.headSha.slice(0, 12)} on ${date}`,
    )
    const links: Record<string, string> = {}
    for (const { evidencePath } of files) links[evidencePath] = this.branchUrl(evidencePath, date)
    return links
  }

  private runPath(evidencePath: string, date: string): string {
    return `runs/${date}/${this.headSha}/${this.runId}/${evidencePath}`
  }

  /**
   * The run's metrics record rides the same append-only branch (#51), under a
   * path naming the run: the numbers stay in the repository as data after the
   * artifact expires, one JSON file per run, and the sweep joins them into
   * one store.
   */
  async pushMetrics(record: unknown): Promise<string> {
    const date = this.today()
    const path = `metrics/${date}/${this.headSha}/${this.runId}.json`
    await this.commitOntoBranch(
      [{ path, content: Buffer.from(JSON.stringify(record, null, 2), 'utf8') }],
      `qa-assets: metrics for run ${this.headSha.slice(0, 12)} on ${date}`,
    )
    return path
  }

  /**
   * The record of what runs on the default branch proved (#295) rides the
   * same branch, at one path: each push is a new commit that carries the
   * whole record, so the branch's history is the record's history.
   *
   * The record is read where it is written. `build` is handed the record as
   * the branch head holds it at that moment (undefined when there is none)
   * and returns the text to write; when another run's push lands first and
   * this one is refused, the head is read again and `build` is asked again,
   * so a pass another run recorded meanwhile is built on, never written
   * over. `build` throws to refuse: then nothing is written.
   */
  async pushMainPasses(build: (current: string | undefined) => Promise<string>): Promise<string> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const parent = await this.client.getBranchHead(this.branch)
      const current = parent === undefined ? undefined : (await this.client.getContents(MAIN_PASSES_PATH, parent))?.toString('utf8')
      const blob = await this.client.createBlob(Buffer.from(await build(current), 'utf8'))
      const parentTree = parent === undefined ? undefined : await this.client.getCommitTree(parent)
      const tree = await this.client.createTree([{ path: MAIN_PASSES_PATH, mode: '100644', type: 'blob', sha: blob }], parentTree)
      const sha = await this.client.createCommit(`qa-assets: passes on the default branch at ${this.headSha.slice(0, 12)}`, tree, parent === undefined ? [] : [parent])
      try {
        await this.client.pushBranch(this.branch, sha, parent)
        return MAIN_PASSES_PATH
      } catch (error) {
        // Only a race is worth another try: the branch moved (GitHub refuses
        // an update that is not a fast forward, or a branch that now
        // exists). Anything else, a refusal for want of access above all, is
        // real the first time.
        const raced = error instanceof GitHubApiError && (error.status === 409 || error.status === 422)
        if (!raced || attempt === 3) throw error
      }
    }
    return MAIN_PASSES_PATH
  }

  /**
   * One commit on top of the branch head, holding every file, pushed so the
   * branch only moves forward. Two qa-assets pushes can race: another run's
   * commit lands between the head this push read and the update it sends, and
   * GitHub refuses a ref update that is not a fast forward. Rather than lose
   * the run's evidence to the race, the push reads the branch head afresh,
   * rebuilds the tree and commit on top of it and tries again, three times,
   * before the failure is real: the blob shas are content-addressed, so only
   * the tree and the commit are rebuilt.
   */
  private async commitOntoBranch(files: Array<{ path: string; content: Buffer }>, message: string): Promise<void> {
    const blobs: Array<{ path: string; sha: string }> = []
    for (const file of files) blobs.push({ path: file.path, sha: await this.client.createBlob(file.content) })
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const parent = await this.client.getBranchHead(this.branch)
      const parentTree = parent === undefined ? undefined : await this.client.getCommitTree(parent)
      const entries: GithubTreeEntry[] = blobs.map((blob) => ({ path: blob.path, mode: '100644', type: 'blob', sha: blob.sha }))
      const tree = await this.client.createTree(entries, parentTree)
      const sha = await this.client.createCommit(message, tree, parent === undefined ? [] : [parent])
      try {
        await this.client.pushBranch(this.branch, sha, parent)
        return
      } catch (error) {
        if (attempt === 3) throw error
      }
    }
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
