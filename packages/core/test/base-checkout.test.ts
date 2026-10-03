import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { prepareBaseCheckout } from '../src/index.js'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=qare test', '-c', 'user.email=qare@example.test', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim()
}

/** A repository with two commits: `app.txt` says `before` at the first and `after` at the second. */
function twoCommitRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'qare-base-repo-'))
  git(repo, 'init', '--quiet', '--initial-branch=main')
  mkdirSync(join(repo, 'apps', 'web'), { recursive: true })
  writeFileSync(join(repo, 'app.txt'), 'before\n')
  writeFileSync(join(repo, 'apps', 'web', 'page.txt'), 'old page\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '--quiet', '-m', 'before')
  writeFileSync(join(repo, 'app.txt'), 'after\n')
  writeFileSync(join(repo, 'apps', 'web', 'page.txt'), 'new page\n')
  git(repo, 'commit', '--quiet', '-am', 'after')
  return repo
}

test('without a checkout handed in, the run makes a detached worktree of the base and removes it (#147)', async () => {
  const repo = twoCommitRepo()
  const outcome = await prepareBaseCheckout({ repoPath: repo, baseRef: 'HEAD~1', headRef: 'HEAD' })
  if (!outcome.ok) throw new Error(outcome.reason)
  expect(outcome.checkout.path).not.toBe(repo)
  expect(readFileSync(join(outcome.checkout.path, 'app.txt'), 'utf8')).toBe('before\n')
  // The head checkout is left exactly as it was.
  expect(readFileSync(join(repo, 'app.txt'), 'utf8')).toBe('after\n')
  expect(git(repo, 'status', '--porcelain')).toBe('')

  await outcome.checkout.dispose()
  expect(existsSync(outcome.checkout.path)).toBe(false)
  expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1)
})

test('a job whose repo path is a directory inside the repository gets the same directory of the base (#147)', async () => {
  const repo = twoCommitRepo()
  const outcome = await prepareBaseCheckout({ repoPath: join(repo, 'apps', 'web'), baseRef: 'HEAD~1', headRef: 'HEAD' })
  if (!outcome.ok) throw new Error(outcome.reason)
  expect(readFileSync(join(outcome.checkout.path, 'page.txt'), 'utf8')).toBe('old page\n')
  await outcome.checkout.dispose()
})

test('a base checkout the caller already has is used as it is, and left alone (#147)', async () => {
  const given = mkdtempSync(join(tmpdir(), 'qare-base-given-'))
  writeFileSync(join(given, 'app.txt'), 'before\n')
  const outcome = await prepareBaseCheckout({ repoPath: mkdtempSync(join(tmpdir(), 'qare-head-')), baseRef: 'main', headRef: 'HEAD', given })
  if (!outcome.ok) throw new Error(outcome.reason)
  expect(outcome.checkout.path).toBe(given)
  await outcome.checkout.dispose()
  expect(existsSync(join(given, 'app.txt'))).toBe(true)

  const missing = await prepareBaseCheckout({ repoPath: given, baseRef: 'main', headRef: 'HEAD', given: join(given, 'nowhere') })
  expect(missing).toEqual({ ok: false, reason: expect.stringContaining('is not a directory') })
})

test('no base checkout is a named reason, never an exception (#147)', async () => {
  const repo = twoCommitRepo()
  const unknown = await prepareBaseCheckout({ repoPath: repo, baseRef: 'no-such-ref', headRef: 'HEAD' })
  expect(unknown).toEqual({ ok: false, reason: expect.stringContaining('"no-such-ref" does not name a commit') })

  // The same revision on both sides is one side: there is nothing to compare.
  const same = await prepareBaseCheckout({ repoPath: repo, baseRef: 'main', headRef: 'HEAD' })
  expect(same).toEqual({ ok: false, reason: expect.stringContaining('the same revision') })

  const plain = await prepareBaseCheckout({ repoPath: mkdtempSync(join(tmpdir(), 'qare-not-a-repo-')), baseRef: 'main', headRef: 'HEAD' })
  expect(plain).toEqual({ ok: false, reason: expect.stringContaining('does not name a commit') })

  // A ref is data, never an option to git.
  const option = await prepareBaseCheckout({ repoPath: repo, baseRef: '--help', headRef: 'HEAD' })
  expect(option.ok).toBe(false)
  expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1)
})

test('a machine without git says so, and points at the checkout the caller can hand in (#147)', async () => {
  const outcome = await prepareBaseCheckout({ repoPath: twoCommitRepo(), baseRef: 'HEAD~1', headRef: 'HEAD', gitBinary: 'qare-no-such-git' })
  expect(outcome).toEqual({ ok: false, reason: expect.stringContaining('git is not available') })
  if (!outcome.ok) expect(outcome.reason).toContain('--base-repo')
})
