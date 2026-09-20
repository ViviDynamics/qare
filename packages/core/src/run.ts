import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { bootApp, type BootOpts } from './boot.js'
import type { Job, JobCommandCheck, JobCriterion } from './job.js'
import { loadProfile, validateProfileConfig } from './profile.js'
import { RESULT_SCHEMA_VERSION, type CriterionResult, type RunResult, type RunVerdict } from './result.js'

const DEFAULT_CHECK_TIMEOUT_MS = 60000
const NO_CHECKS_REASON = 'no checks: model planning lands when nare integration ships'

/**
 * Execute a job's checks against the head revision and write result.json into the
 * job's evidence directory.
 *
 * Limitations of this slice: checks are head commands only (base execution lands
 * with Task 14), and each check's `run` string is split on whitespace and spawned
 * directly without a shell, so quoting, pipes and shell syntax are not interpreted.
 */
export async function runJob(job: Job, opts: BootOpts = {}): Promise<{ result: RunResult }> {
  const profile = await resolveProfile(job)
  const boot = await bootApp(profile, opts)
  if (boot.kind === 'blocked') {
    const criteria: CriterionResult[] = job.criteria.map((criterion) => ({
      id: criterion.id,
      outcome: 'unverified',
      reason: boot.reason ?? 'boot did not come up',
    }))
    return finishRun(job, { schemaVersion: RESULT_SCHEMA_VERSION, verdict: 'blocked', criteria })
  }

  const criteria: CriterionResult[] = []
  for (const criterion of job.criteria) criteria.push(await runCriterion(criterion, job))
  const anyFailed = criteria.some((criterion) => criterion.outcome === 'failed')
  const allProven = criteria.length > 0 && criteria.every((criterion) => criterion.outcome === 'proven')
  const verdict: RunVerdict = anyFailed ? 'failed' : allProven ? 'passed' : 'blocked'
  return finishRun(job, { schemaVersion: RESULT_SCHEMA_VERSION, verdict, criteria })
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
    const timeoutMs = check.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS
    const outcome = await runCommandCheck(check, job.repoPath, timeoutMs)
    const checkDir = join('checks', criterion.id, String(index))
    await mkdir(join(job.evidenceDir, checkDir), { recursive: true })
    await writeFile(join(job.evidenceDir, checkDir, 'stdout.txt'), outcome.stdout)
    await writeFile(join(job.evidenceDir, checkDir, 'stderr.txt'), outcome.stderr)
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
}

function runCommandCheck(check: JobCommandCheck, cwd: string, timeoutMs: number): Promise<CheckOutcome> {
  return new Promise((resolve) => {
    const tokens = check.run.split(/\s+/).filter((token) => token !== '')
    const child = spawn(tokens[0] ?? '', tokens.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ status: 'unverified', reason: `check could not start: ${String(error)}`, stdout, stderr })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut)
        resolve({ status: 'unverified', reason: `check timed out after ${timeoutMs}ms`, stdout, stderr })
      else if (code === 0) resolve({ status: 'passed', stdout, stderr })
      else resolve({ status: 'failed', stdout, stderr })
    })
  })
}
