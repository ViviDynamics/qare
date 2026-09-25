import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Artefacts } from './artefacts.js'
import { bootApp, type BootOpts } from './boot.js'
import { judgeRun, toSideResults } from './judge.js'
import { feedRunLedger } from './ledger-feed.js'
import { JobValidationError, type Job, type JobCheck, type JobCommandCheck, type JobCriterion } from './job.js'
import { httpMailbox, mailEvidence, runMailCheck, type ReadMail } from './mailbox.js'
import { ProfileMissingError, loadProfile, validateProfileConfig, type QaProfile } from './profile.js'
import { BUILTIN_REDACTION_RULES, redactResult, redactText, redactValue, redactionRules, type RedactionRule } from './redact.js'
import { RESULT_SCHEMA_VERSION, type CriterionResult, type RunResult } from './result.js'
import { mintRunValues, substituteValues, validateValueReferences, type RunValues, REFERENCE } from './values.js'

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
 *
 * Everything written to the evidence directory, and the result returned, is
 * redacted with the profile's rules and the built-in ones (#52): evidence is
 * published, and output from the app under test can carry its secrets.
 */
export async function runJob(
  job: Job,
  opts: BootOpts & { ledgerFeed?: { dir: string }; readMail?: ReadMail } = {},
): Promise<{ result: RunResult }> {
  let profile: QaProfile
  try {
    profile = await resolveProfile(job)
  } catch (error) {
    if (!(error instanceof ProfileMissingError)) throw error
    // A repository that has not onboarded is refused, not a caller mistake
    // (#107). Every criterion is still reported, unverified, naming the gap,
    // so the evidence says what nobody checked and what onboarding needs.
    return refuseRun(job, opts, BUILTIN_REDACTION_RULES, `this repository has no usable .qa/ profile yet, so qare will not claim to have checked it: ${error.message}`)
  }
  // Run values exist per run, so they are minted here and referenced by name
  // from user-authored strings (#68). An unknown reference fails closed at
  // plan time: nothing boots, and the refusal names the field and the name.
  const values = mintRunValues()
  try {
    validatePlanValues(job, profile, values)
  } catch (error) {
    if (!(error instanceof JobValidationError)) throw error
    return refuseRun(job, opts, BUILTIN_REDACTION_RULES, error.message)
  }
  const rules = redactionRules(profile.redact)
  const boot = await bootApp(profile, opts)
  if (boot.kind === 'blocked') {
    const criteria: CriterionResult[] = job.criteria.map((criterion) => ({
      id: criterion.id,
      outcome: 'unverified',
      reason: boot.reason ?? 'boot did not come up',
    }))
    const finished = await finishRun(job, { schemaVersion: RESULT_SCHEMA_VERSION, verdict: 'blocked', criteria }, rules, values)
    await feedIfOptedIn(opts, job, finished.result)
    return finished
  }

  const criteria: CriterionResult[] = []
  const mail = {
    inbox: profile.mail?.inbox,
    readMail: opts.readMail ?? (profile.mail?.inbox === undefined ? undefined : httpMailbox(profile.mail.inbox)),
  }
  // Single-use artefacts are a per-run ledger: what was consumed in this run
  // says nothing about any other run (#69).
  const artefacts = new Artefacts()
  for (const criterion of job.criteria) criteria.push(await runCriterion(criterion, job, rules, values, mail, artefacts))
  // The judge is the verdict decision. Base execution and egress interception
  // land with the orchestrator; today the head side is the whole picture.
  const { verdict } = judgeRun({ base: [], head: toSideResults({ criteria }), egressVerdict: 'allowed' })
  const finished = await finishRun(job, { schemaVersion: RESULT_SCHEMA_VERSION, verdict, criteria }, rules, values)
  await feedIfOptedIn(opts, job, finished.result)
  return finished
}

/** Refuse the whole run without booting: every criterion is reported unverified, naming the gap. */
async function refuseRun(
  job: Job,
  opts: BootOpts & { ledgerFeed?: { dir: string } },
  rules: readonly RedactionRule[],
  reason: string,
): Promise<{ result: RunResult }> {
  const criteria: CriterionResult[] = job.criteria.map((criterion) => ({
    id: criterion.id,
    outcome: 'unverified',
    reason,
  }))
  const finished = await finishRun(job, { schemaVersion: RESULT_SCHEMA_VERSION, verdict: 'refused', criteria }, rules)
  await feedIfOptedIn(opts, job, finished.result)
  return finished
}

/**
 * Walk every user-authored string that can carry a `{{run.<name>}}` reference and
 * reject unknown names before anything boots. The seed command is validated here
 * even though its execution lands with the orchestrator, so a bad name in the
 * seed is still a plan-time failure.
 */
function validatePlanValues(job: Job, profile: QaProfile, values: RunValues): void {
  validateValueReferences(profile.app.seed.command, values, 'app.seed.command')
  // Mail artefact names are validated in walk order: a check may only read an
  // artefact from a mail check that has already waited for its message (#69).
  const mailChecks = new Map<string, number>()
  for (const [criterionIndex, criterion] of job.criteria.entries()) {
    for (const [checkIndex, check] of (criterion.checks ?? []).entries()) {
      const base = `criteria[${criterionIndex}].checks[${checkIndex}]`
      if (check.kind === 'mail') {
        validateValueReferences(check.address, values, `${base}.address`)
        for (const field of ['from', 'subject', 'body'] as const) {
          const value = check[field]
          if (value !== undefined) validateValueReferences(value, values, `${base}.${field}`)
        }
        if (check.name !== undefined) mailChecks.set(check.name, (mailChecks.get(check.name) ?? 0) + 1)
        continue
      }
      const allow = (field: string) => (name: string): boolean => {
        if (!name.startsWith('mail.')) return false
        validateMailArtefactName(name, mailChecks, field)
        return true
      }
      validateValueReferences(check.run, values, `${base}.run`, allow(`${base}.run`))
      if (check.cwd !== undefined) validateValueReferences(check.cwd, values, `${base}.cwd`, allow(`${base}.cwd`))
      for (const [key, value] of Object.entries(check.env ?? {})) {
        if (key.includes('{{'))
          throw new JobValidationError(`${base}.env.${key}`, 'an env key names a variable and is not a substitution site; put the reference in the value')
        validateValueReferences(value, values, `${base}.env.${key}`, allow(`${base}.env.${key}`))
      }
    }
  }
}

/**
 * Fail closed on a `{{mail.<name>.<field>}}` reference the runner cannot honor:
 * an unknown field, a mail check that has not run yet, or a name that two earlier
 * mail checks share. The seed command and a mail check's own matchers never carry
 * artefact references at all: a mail artefact does not exist before a run starts.
 */
function validateMailArtefactName(name: string, mailChecks: Map<string, number>, field: string): void {
  const parts = name.split('.')
  const [kind, checkName, artefact] = parts
  if (kind !== 'mail' || checkName === undefined || artefact !== 'link' || parts.length !== 3) {
    throw new JobValidationError(field, `unknown artefact ${JSON.stringify(`{{${name}}}`)}; a mail check exposes {{mail.<name>.link}}, the first link in the message it read, and a mail check name carries no dot`)
  }
  const count = mailChecks.get(checkName) ?? 0
  if (count === 0) {
    throw new JobValidationError(field, `no mail check named ${checkName} runs before this check; an artefact is read from a mail check that has already waited for its message`)
  }
  if (count > 1) {
    throw new JobValidationError(field, `${count} earlier mail checks are named ${checkName}; the artefact reference is ambiguous, so rename one of them`)
  }
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

async function finishRun(
  job: Job,
  result: RunResult,
  rules: readonly RedactionRule[],
  values?: RunValues,
): Promise<{ result: RunResult }> {
  const full: RunResult = redactResult({ ...result, job: { id: job.id } }, rules)
  await mkdir(job.evidenceDir, { recursive: true })
  await writeFile(join(job.evidenceDir, 'result.json'), `${JSON.stringify(full, null, 2)}\n`)
  if (values !== undefined) {
    // Evidence is published, so the minted values go through the same redaction
    // sweep as everything else the run writes (#68).
    const text = redactText(JSON.stringify(values, null, 2), rules)
    await writeFile(join(job.evidenceDir, 'values.json'), `${text}\n`)
  }
  return { result: full }
}

async function runCriterion(
  criterion: JobCriterion,
  job: Job,
  rules: readonly RedactionRule[],
  values: RunValues,
  mail: { inbox?: string; readMail?: ReadMail },
  artefacts: Artefacts,
): Promise<CriterionResult> {
  const checks = criterion.checks ?? []
  if (checks.length === 0)
    return { id: criterion.id, outcome: 'unverified', reason: NO_CHECKS_REASON }

  const evidence: string[] = []
  let failed = false
  let unverifiedReason: string | undefined
  for (const [index, check] of checks.entries()) {
    const substituted = substituteCheck(check, values)
    const checkDir = join('checks', criterion.id, String(index))
    if (substituted.kind === 'mail') {
      const outcome = await runMailCheck(
        substituted,
        mail.inbox,
        mail.readMail,
        substituted.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
      )
      if (outcome.status === 'unverified') {
        if (unverifiedReason === undefined) unverifiedReason = outcome.reason
        continue
      }
      await mkdir(join(job.evidenceDir, checkDir), { recursive: true })
      // Redacted value by value, before the JSON is built: a text pass over the
      // serialized form can eat a closing quote and publish half the record.
      const messageEvidence = mailEvidence(outcome.message, outcome.waitMs, outcome.polls)
      const text = JSON.stringify(redactValue(messageEvidence, rules), null, 2)
      await writeFile(join(job.evidenceDir, checkDir, 'message.json'), `${text}\n`)
      evidence.push(`${checkDir}/message.json`)
      // The artefact a later `{{mail.<name>.link}}` reference reads is the first
      // link of the message this check waited for (#69).
      if (substituted.name !== undefined)
        artefacts.publish(substituted.name, messageEvidence.links[0], substituted.singleUse === true)
      continue
    }
    // Run-time artefact resolution happens last, immediately before the check
    // executes: the artefact is observed during this run, not minted at plan
    // time. A check whose artefact is gone is skipped unverified and never runs.
    const resolved = resolveArtefactFields(substituted, artefacts, criterion.id)
    if (!resolved.ok) {
      if (unverifiedReason === undefined) unverifiedReason = resolved.reason
      continue
    }
    const cwd = resolveCheckCwd(resolved.check.cwd, job.repoPath)
    if (cwd === undefined) {
      const reason = `check cwd ${JSON.stringify(resolved.check.cwd ?? '')} escapes the repository path; refusing to run it`
      if (unverifiedReason === undefined) unverifiedReason = reason
      continue
    }
    const timeoutMs = resolved.check.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS
    const outcome = await runCommandCheck(resolved.check, cwd, timeoutMs)
    await mkdir(join(job.evidenceDir, checkDir), { recursive: true })
    await writeFile(join(job.evidenceDir, checkDir, 'stdout.txt'), redactText(truncationNote(outcome, 'stdout'), rules))
    await writeFile(join(job.evidenceDir, checkDir, 'stderr.txt'), redactText(truncationNote(outcome, 'stderr'), rules))
    evidence.push(`${checkDir}/stdout.txt`, `${checkDir}/stderr.txt`)
    if (resolved.consumed.length > 0) {
      const consumption = {
        artefacts: resolved.consumed.map((consumedArtefact) => ({ source: consumedArtefact.source, artefact: consumedArtefact.artefact })),
        consumed_by: { criterion: criterion.id, check: index },
        response: { status: outcome.status, evidence: [`${checkDir}/stdout.txt`, `${checkDir}/stderr.txt`] },
      }
      await writeFile(
        join(job.evidenceDir, checkDir, 'consumed.json'),
        `${JSON.stringify(redactValue(consumption, rules), null, 2)}\n`,
      )
      evidence.push(`${checkDir}/consumed.json`)
    }
    if (outcome.status === 'failed') failed = true
    else if (outcome.status === 'unverified' && unverifiedReason === undefined)
      unverifiedReason = outcome.reason
  }

  if (failed) return { id: criterion.id, outcome: 'failed', evidence }
  if (unverifiedReason !== undefined) return { id: criterion.id, outcome: 'unverified', reason: unverifiedReason }
  return { id: criterion.id, outcome: 'proven', evidence }
}

/**
 * Substitute `{{run.<name>}}` references in a check's user-authored strings with
 * the run's minted values. Unknown names never reach this point: the plan-time
 * walk already refused the run.
 */
function substituteCheck(check: JobCheck, values: RunValues): JobCheck {
  if (check.kind === 'mail') {
    return {
      ...check,
      address: substituteValues(check.address, values),
      ...(check.from === undefined ? {} : { from: substituteValues(check.from, values) }),
      ...(check.subject === undefined ? {} : { subject: substituteValues(check.subject, values) }),
      ...(check.body === undefined ? {} : { body: substituteValues(check.body, values) }),
    }
  }
  return {
    ...check,
    run: substituteValues(check.run, values),
    ...(check.cwd === undefined ? {} : { cwd: substituteValues(check.cwd, values) }),
    ...(check.env === undefined
      ? {}
      : {
          env: Object.fromEntries(
            Object.entries(check.env).map(([key, value]) => [key, substituteValues(value, values)]),
          ),
        }),
  }
}

interface ResolvedArtefacts {
  ok: true
  check: JobCommandCheck
  consumed: { source: string; artefact: string }[]
}

/**
 * Substitute `{{mail.<name>.link}}` references in a command check's strings at
 * run time, from the artefacts the run has observed so far (#69). A reference
 * the registry cannot resolve — no message, no links, or a single-use artefact
 * that is already spent — returns the reason the check is skipped unverified,
 * and the check never runs.
 */
function resolveArtefactFields(
  check: JobCommandCheck,
  artefacts: Artefacts,
  consumer: string,
): ResolvedArtefacts | { ok: false; reason: string } {
  const names = new Set<string>()
  for (const text of [check.run, ...(check.cwd === undefined ? [] : [check.cwd]), ...Object.values(check.env ?? {})]) {
    for (const match of text.matchAll(REFERENCE)) {
      const name = match[1] ?? ''
      if (name.startsWith('mail.')) names.add(name)
    }
  }
  const consumed: { source: string; artefact: string }[] = []
  const resolved = new Map<string, string>()
  for (const name of names) {
    // The reference names the mail check between the `mail.` namespace and the
    // artefact field: {{mail.<name>.link}} reads from the mail check <name>.
    // Plan time refuses anything else, so a shape that reaches this point is
    // the run's own bug, and a literal left in a command is not an option.
    const [namespace, checkName] = name.split('.')
    if (namespace !== 'mail' || checkName === undefined) {
      return { ok: false, reason: `malformed artefact reference {{${name}}}; a reference is {{mail.<name>.link}}` }
    }
    const outcome = artefacts.resolve(checkName, consumer)
    if (!outcome.ok) return outcome
    resolved.set(name, outcome.artefact)
    consumed.push({ source: `mail.${checkName}`, artefact: outcome.artefact })
  }
  const substitute = (text: string): string =>
    [...resolved.entries()].reduce((acc, [name, artefact]) => acc.split(`{{${name}}}`).join(artefact), text)
  return {
    ok: true,
    check: {
      ...check,
      run: substitute(check.run),
      ...(check.cwd === undefined ? {} : { cwd: substitute(check.cwd) }),
      ...(check.env === undefined
        ? {}
        : {
            env: Object.fromEntries(
              Object.entries(check.env).map(([key, value]) => [key, substitute(value)]),
            ),
          }),
    },
    consumed,
  }
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
