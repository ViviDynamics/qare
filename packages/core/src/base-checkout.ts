import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The base revision's tree (#147): the counterpart of the job's `repoPath`,
 * checked out at `baseRef`, which the base side of a run boots and checks.
 */
export interface BaseCheckout {
  path: string
  /** Remove what the run made. A checkout the caller handed in is left alone. */
  dispose: () => Promise<void>
}

export type BaseCheckoutOutcome = { ok: true; checkout: BaseCheckout } | { ok: false; reason: string }

export interface BaseCheckoutInput {
  /** The head checkout the job names. */
  repoPath: string
  baseRef: string
  headRef: string
  /** A checkout of the base the caller already has; used as it is. */
  given?: string
  /** Where a worktree the run makes is put; the system temp directory by default. */
  tmpRoot?: string
  /** The git program; a seam for a machine that has none. */
  gitBinary?: string
}

interface GitOutcome {
  ok: boolean
  stdout: string
  stderr: string
  missing: boolean
}

function runGit(binary: string, cwd: string, args: string[]): Promise<GitOutcome> {
  return new Promise((resolve) => {
    execFile(binary, args, { cwd }, (error, stdout, stderr) => {
      resolve({
        ok: error === null,
        stdout: String(stdout).trim(),
        stderr: String(stderr).trim(),
        missing: (error as NodeJS.ErrnoException | null)?.code === 'ENOENT',
      })
    })
  })
}

const COMMIT_ID = /^[0-9a-f]{40,64}$/

/**
 * Get the tree the base side runs against. A checkout the caller already has
 * is used as it is: the pipeline hands one in, because its run image carries
 * no git. Otherwise the run makes a detached git worktree of `baseRef` beside
 * nothing of the head's, so the head checkout is never touched, and removes it
 * when the base side is done.
 *
 * Every way this can fail is a named reason, never an exception: a run with no
 * base checkout still checks the head, and reports each criterion as not
 * compared with that reason.
 */
export async function prepareBaseCheckout(input: BaseCheckoutInput): Promise<BaseCheckoutOutcome> {
  if (input.given !== undefined) {
    const given = input.given
    const isDirectory = (await stat(given).catch(() => undefined))?.isDirectory() ?? false
    if (!isDirectory) return { ok: false, reason: `the base checkout handed in at ${given} is not a directory` }
    return { ok: true, checkout: { path: given, dispose: async () => {} } }
  }
  const git = input.gitBinary ?? 'git'
  // A ref is data: `--end-of-options` keeps one that starts with a dash from
  // being read as an option, and only the commit id it resolves to is ever
  // handed to the command that writes.
  const resolveCommit = (ref: string): Promise<GitOutcome> => runGit(git, input.repoPath, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`])
  const base = await resolveCommit(input.baseRef)
  if (base.missing)
    return {
      ok: false,
      reason: 'git is not available here to check out the base revision, and no base checkout was handed in (qare run --base-repo <dir>, or QARE_BASE_REPO)',
    }
  if (!base.ok || !COMMIT_ID.test(base.stdout))
    return { ok: false, reason: `the base ref ${JSON.stringify(input.baseRef)} does not name a commit in the repository at ${input.repoPath}, so there is no base revision to check out` }
  const head = await resolveCommit(input.headRef)
  if (head.ok && head.stdout === base.stdout)
    return { ok: false, reason: `the base ref ${JSON.stringify(input.baseRef)} and the head ref ${JSON.stringify(input.headRef)} name the same revision (${base.stdout.slice(0, 12)}), so there is nothing to compare` }
  // The job's repo path may be a directory inside the repository: the base
  // side gets the same directory of the base tree.
  const prefix = await runGit(git, input.repoPath, ['rev-parse', '--show-prefix'])
  if (!prefix.ok) return { ok: false, reason: `git could not place ${input.repoPath} inside its repository: ${firstLine(prefix.stderr)}` }
  const dir = await mkdtemp(join(input.tmpRoot ?? tmpdir(), 'qare-base-'))
  const added = await runGit(git, input.repoPath, ['worktree', 'add', '--detach', '--quiet', dir, base.stdout])
  if (!added.ok) {
    await rm(dir, { recursive: true, force: true })
    return { ok: false, reason: `git could not check out the base revision ${base.stdout.slice(0, 12)}: ${firstLine(added.stderr)}` }
  }
  return {
    ok: true,
    checkout: {
      path: join(dir, prefix.stdout),
      dispose: async () => {
        const removed = await runGit(git, input.repoPath, ['worktree', 'remove', '--force', dir])
        if (removed.ok) return
        // A worktree git will not remove is removed by hand, and its record
        // pruned, so a base checkout never outlives the run that made it.
        await rm(dir, { recursive: true, force: true })
        await runGit(git, input.repoPath, ['worktree', 'prune'])
      },
    },
  }
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? ''
}
