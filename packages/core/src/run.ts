import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { bootApp, type BootOpts } from './boot.js'
import { judgeRun, toSideResults } from './judge.js'
import { feedRunLedger } from './ledger-feed.js'
import type { Job, JobCommandCheck, JobCriterion } from './job.js'
import { ProfileMissingError, loadProfile, validateProfileConfig, type QaProfile } from './profile.js'
import { RESULT_SCHEMA_VERSION, type CriterionResult, type RunResult } from './result.js'

export const DEFAULT_CHECK_TIMEOUT_MS = 60000
const NO_CHECKS_REASON = 'no checks: model planning lands when nare integration ships'

/**
 * Execute a job's checks against the head revision and write result.json into the
 * job's evidence directory.
 *
 * Limitations of this slice: checks are head commands only (base execution lands
 * with Task 14), and each check's `run` string is split on whitespace and spawned
 * directly without a shell, so quoting, pipes and shell syntax are not interpreted.
 *
 * A check without `env` inherits the harness environment unchanged. A check that
 * carries `env` opts into a minimal deterministic environment (PATH, HOME and the
 * check's own entries), so its checks do not inherit harness secrets.
 *
 * The booted app is intentionally left up after the checks so evidence (logs) can
 * be inspected; teardown is the caller's job (stopApp).
 */
export async function runJob(
  job: Job,
  opts: BootOpts & { ledgerFeed?: { dir: string } } = {},
): Promise<{ result: RunResult }> {
  let profile: QaProfile
  try {
    profile = await resolveProfile(job)
  } catch (error) {
    if (!(error instanceof ProfileMissingError)) throw error
    // A repository that has not onboarded is refused, not a caller mistake
    // (#107). Every criterion is still reported, unverified, naming the gap,
    // so the evidence says what nobody checked and what onboarding needs.
    const criteria: CriterionResult[] = job.criteria.map((criterion) => ({
      id: criterion.id,
      outcome: 'unverified',
      reason: `this repository has no usable .qa/ profile yet, so qare will not claim to have checked it: ${error.message}`,
    }))
    const finished = await finishRun(job, { schemaVersion: RESULT_SCHEMA_VERSION, verdict: 'refused', criteria })
    await feedIfOptedIn(opts, job, finished.result)
    return finished
  }
  const boot = await bootApp(profile, opts)
  if (boot.kind === 'blocked') {
    const criteria: CriterionResult[] = job.criteria.map((criterion) => ({
      id: criterion.id,
      outcome: 'unverified',
      reason: boot.reason ?? 'boot did not come up',
    }))
    const finished = await finishRun(job, { schemaVersion: RESULT_SCHEMA_VERSION, verdict: 'blocked', criteria })
    await feedIfOptedIn(opts, job, finished.result)
    return finished
  }

  const criteria: CriterionResult[] = []
  for (const criterion of job.criteria) criteria.push(await runCriterion(criterion, job))
  // The judge is the verdict decision. Base execution and egress interception
  // land with the orchestrator; today the head side is the whole picture.
  const { verdict } = judgeRun({ base: [], head: toSideResults({ criteria }), egressVerdict: 'allowed' })
  const finished = await finishRun(job, { schemaVersion: RESULT_SCHEMA_VERSION, verdict, criteria })
  await feedIfOptedIn(opts, job, finished.result)
  return finished
}

async function feedIfOptedIn(
  opts: { ledgerFeed?: { dir: string } },
  job: Job,
  result: RunResult,
): Promise<void> {
  if (!opts.ledgerFeed) return
  await feedRunLedger(
    opts.ledgerFeed.dir,
    { id: job.id, headRef: job.headRef },
    result.verdict,
    result.criteria.map((criterion) => ({ criterionId: criterion.id, outcome: criterion.outcome })),
  )
}

async function resolveProfile(job: Job) {
  if ('inline' in job.profile) return validateProfileConfig(job.profile.inline)
  return loadProfile(resolve(job.repoPath, job.profile.path))
}

async function finishRun(job: Job, result: RunResult): Promise<{ result: RunResult }> {
  const full: RunResult = { ...result, job: { id: job.id } }
  await mkdir(job.evidenceDir, { recursive: true })
  await writeFile(join(job.evidenceDir, 'result.json'), `${JSON.stringify(full, null, 2)}\n`)
  return { result: full }
}

async function runCriterion(criterion: JobCriterion, job: Job): Promise<CriterionResult> {
  const checks = criterion.checks ?? []
  if (checks.length === 0)
    return { id: criterion.id, outcome: 'unverified', reason: NO_CHECKS_REASON }

  const evidence: string[] = []
  let failed = false
  let unverifiedReason: string | undefined
  for (const [index, check] of checks.entries()) {
    const cwd = resolveCheckCwd(check.cwd, job.repoPath)
    if (cwd === undefined) {
      const reason = `check cwd ${JSON.stringify(check.cwd ?? '')} escapes the repository path; refusing to run it`
      if (unverifiedReason === undefined) unverifiedReason = reason
      continue
    }
    const timeoutMs = check.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS
    const outcome = await runCommandCheck(check, cwd, timeoutMs)
    const checkDir = join('checks', criterion.id, String(index))
    await mkdir(join(job.evidenceDir, checkDir), { recursive: true })
    await writeFile(join(job.evidenceDir, checkDir, 'stdout.txt'), truncationNote(outcome, 'stdout'))
    await writeFile(join(job.evidenceDir, checkDir, 'stderr.txt'), truncationNote(outcome, 'stderr'))
    evidence.push(`${checkDir}/stdout.txt`, `${checkDir}/stderr.txt`)
    if (outcome.status === 'failed') failed = true
    else if (outcome.status === 'unverified' && unverifiedReason === undefined)
      unverifiedReason = outcome.reason
  }

  if (failed) return { id: criterion.id, outcome: 'failed', evidence }
  if (unverifiedReason !== undefined) return { id: criterion.id, outcome: 'unverified', reason: unverifiedReason }
  return { id: criterion.id, outcome: 'proven', evidence }
}

interface CheckOutcome {
  status: 'passed' | 'failed' | 'unverified'
  reason?: string
  stdout: string
  stderr: string
  stdoutTruncated?: boolean
  stderrTruncated?: boolean
  code?: number
}

const MAX_CAPTURE_BYTES = 1024 * 1024
const KILL_GRACE_MS = 500
const HARD_SETTLE_GRACE_MS = 250

/**
 * Resolve a check's cwd against the job's repoPath, refusing absolute paths and
 * anything that escapes the repository. Returns undefined when refused.
 */
function resolveCheckCwd(cwd: string | undefined, repoPath: string): string | undefined {
  if (cwd === undefined) return repoPath
  if (isAbsolute(cwd)) return undefined
  const full = resolve(repoPath, cwd)
  const rel = relative(repoPath, full)
  if (rel === '..' || rel.startsWith(`..${sep}`)) return undefined
  return full
}

/**
 * Kill the check's process group, not just the direct child: checks routinely
 * fork children that inherit the stdio pipes, and killing only the parent would
 * leave those grandchildren holding the pipes open, which stalls `close`.
 */
function killCheck(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    child.kill(signal)
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch {
    child.kill(signal)
  }
}

export function runCommandCheck(check: JobCommandCheck, cwd: string, timeoutMs: number): Promise<CheckOutcome> {
  return new Promise((resolve) => {
    const tokens = check.run.split(/\s+/).filter((token) => token !== '')
    // detached puts the check in its own process group so a group-wide kill also
    // reaches grandchildren that inherited the stdio pipes.
    const child = spawn(tokens[0] ?? '', tokens.slice(1), {
      cwd,
      ...(check.env === undefined
        ? {}
        : { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', ...check.env } }),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    let stdout = ''
    let stderr = ''
    let stdoutTruncated = false
    let stderrTruncated = false
    let timedOut = false
    let settled = false
    let killTimer: NodeJS.Timeout | undefined
    const settle = (outcome: CheckOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(hardTimer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      resolve(outcome)
    }
    const timer = setTimeout(() => {
      timedOut = true
      killCheck(child, 'SIGTERM')
      killTimer = setTimeout(() => killCheck(child, 'SIGKILL'), KILL_GRACE_MS)
    }, timeoutMs)
    // Last resort: a grandchild that inherited the stdio pipes can keep `close`
    // from firing forever, so resolve hard at the deadline regardless.
    const hardTimer = setTimeout(
      () =>
        settle({
          status: 'unverified',
          reason: `check timed out after ${timeoutMs}ms`,
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
        }),
      timeoutMs + KILL_GRACE_MS + HARD_SETTLE_GRACE_MS,
    )
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_CAPTURE_BYTES) stdout += chunk
      else stdoutTruncated = true
    })
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_CAPTURE_BYTES) stderr += chunk
      else stderrTruncated = true
    })
    child.on('error', (error) => {
      settle({ status: 'unverified', reason: `check could not start: ${String(error)}`, stdout, stderr })
    })
    child.on('close', (code) => {
      if (timedOut)
        settle({
          status: 'unverified',
          reason: `check timed out after ${timeoutMs}ms`,
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
        })
      else if (code === 0)
        settle({ status: 'passed', stdout, stderr, stdoutTruncated, stderrTruncated })
      else
        settle({
          status: 'failed',
          code: code === null ? undefined : code,
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
        })
    })
  })
}

function truncationNote(outcome: CheckOutcome, stream: 'stdout' | 'stderr'): string {
  const text = stream === 'stdout' ? outcome.stdout : outcome.stderr
  const truncated = stream === 'stdout' ? outcome.stdoutTruncated : outcome.stderrTruncated
  return truncated === true ? `${text}\n[truncated at 1 MiB]\n` : text
}
