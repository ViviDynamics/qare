import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Artefacts } from './artefacts.js'
import { bootApp, type BootOpts } from './boot.js'
import { matchesStub, type EgressAttempt } from './egress.js'
import { runFlowCheck, runSuiteCheck, type FlowCheckResult, type FlowPage, type FlowTotpConfig, type FlowTrace } from './flow.js'
import { makePlaywrightFlowSession } from './flow-playwright.js'
import { judgeRun, toSideResults } from './judge.js'
import { JobValidationError, type Job, type JobCheck, type JobCommandCheck, type JobCriterion, type JobFlowCheck } from './job.js'
import type { FlowActionStep } from './plan.js'
import { feedRunLedger } from './ledger-feed.js'
import { extractCode, httpMailbox, mailEvidence, runMailCheck, type ReadMail } from './mailbox.js'
import { ProfileMissingError, loadProfile, pathOnTarget, validateProfileConfig, type ProfileSuite, type ProfileTarget, type QaProfile } from './profile.js'
import { BUILTIN_REDACTION_RULES, REDACTED, redactResult, redactText, redactValue, redactionRules, valueRules, type RedactionRule } from './redact.js'
import { RESULT_SCHEMA_VERSION, type CriterionResult, type RunResult } from './result.js'
import { mintRunValues, substituteValues, validateRunReferences, validateValueReferences, type RunValues, REFERENCE } from './values.js'

export const DEFAULT_CHECK_TIMEOUT_MS = 60000
const NO_CHECKS_REASON = 'no checks were given for this criterion, so nothing ran'

/**
 * Where the flow check gets its browser: the run hands over a session factory,
 * and tests hand over a fake, so the runner never imports the backend twice (#121).
 * The factory receives the profile's masks (#119), so an injected backend takes
 * them like the playwright one and the action log's masks note stays honest.
 * `outbound` lists every connection the session's page attempted, which a run
 * against a target checks against the hosts the profile declares (#122).
 */
export type FlowSessionFactory = (opts: { masks: string[] }) => Promise<{
  page: FlowPage
  trace: FlowTrace
  dispose: () => Promise<void>
  outbound?: () => EgressAttempt[]
}>

/** What a target run's flow checks need: where relative URLs point, and which hosts they may reach. */
interface FlowTargetContext {
  url: string
  hosts: string[]
  /** Undeclared connections found so far; any one of them refuses the run. */
  undeclared: string[]
}

/**
 * Execute a job's checks against the head revision and write result.json into the
 * job's evidence directory.
 *
 * Limitations of this slice: checks run against the head revision only (base
 * execution lands with the orchestrator), and each command's `run` string is
 * split on whitespace and spawned directly without a shell, so quoting, pipes
 * and shell syntax are not interpreted. Flow checks run last-in-class: suite
 * flows through their declared command, action flows through the page seam.
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
  opts: BootOpts & { ledgerFeed?: { dir: string }; readMail?: ReadMail; flowSession?: FlowSessionFactory } = {},
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
  const values = mintRunValues(profile.target === undefined ? {} : { targetUrl: profile.target.url })
  // A run against a target has one side only, and the result says so rather
  // than implying a base comparison it never made (#122).
  const targetNote = profile.target === undefined ? {} : { target: { url: profile.target.url, comparison: 'none' as const } }
  try {
    validatePlanValues(job, profile, values)
  } catch (error) {
    if (!(error instanceof JobValidationError)) throw error
    return refuseRun(job, opts, BUILTIN_REDACTION_RULES, error.message, targetNote)
  }
  // The seeded second-factor secret and any backup code never reach the
  // evidence either: they sweep alongside the profile's own rules (#64).
  const login = profile.app?.login
  const rules = [...redactionRules(profile.redact), ...valueRules([login?.totp?.secret, login?.backupCode?.value])]
  const boot = await bootApp(profile, opts)
  if (boot.kind === 'blocked') {
    const criteria: CriterionResult[] = job.criteria.map((criterion) => ({
      id: criterion.id,
      outcome: 'unverified',
      reason: boot.reason ?? 'boot did not come up',
    }))
    const finished = await finishRun(job, { schemaVersion: RESULT_SCHEMA_VERSION, verdict: 'blocked', criteria, ...targetNote }, rules, values)
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
  const target = profile.target === undefined ? undefined : targetContext(profile.target)
  // The flow types the code the profile's seeded secret generates; the secret
  // itself never crosses into the plan (#64).
  const totp =
    login?.totp === undefined ? undefined : { ...login.totp, ...(login.backupCode === undefined ? {} : { backupCode: login.backupCode.value }) }
  const flow = { session: opts.flowSession, masks: profile.redact?.masks ?? [], suites: profile.suites, target, totp }
  for (const criterion of job.criteria) criteria.push(await runCriterion(criterion, job, rules, values, mail, artefacts, flow))
  // The judge is the verdict decision. Base execution and egress interception
  // of a booted stack land with the orchestrator; a target run records what its
  // browser reached, and a host the profile does not declare refuses the run.
  const egressVerdict = target !== undefined && target.undeclared.length > 0 ? 'refused' : 'allowed'
  const { verdict } = judgeRun({ base: [], head: toSideResults({ criteria }), egressVerdict })
  const finished = await finishRun(job, { schemaVersion: RESULT_SCHEMA_VERSION, verdict, criteria, ...targetNote }, rules, values)
  await feedIfOptedIn(opts, job, finished.result)
  return finished
}

/** Refuse the whole run without booting: every criterion is reported unverified, naming the gap. */
async function refuseRun(
  job: Job,
  opts: BootOpts & { ledgerFeed?: { dir: string } },
  rules: readonly RedactionRule[],
  reason: string,
  targetNote: Pick<RunResult, 'target'> = {},
): Promise<{ result: RunResult }> {
  const criteria: CriterionResult[] = job.criteria.map((criterion) => ({
    id: criterion.id,
    outcome: 'unverified',
    reason,
  }))
  const finished = await finishRun(job, { schemaVersion: RESULT_SCHEMA_VERSION, verdict: 'refused', criteria, ...targetNote }, rules)
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
  if (profile.app !== undefined) validateValueReferences(profile.app.seed.command, values, 'app.seed.command')
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
      if (check.kind === 'flow') {
        // Flow strings and the command of the suite a flow names carry run
        // values too, such as {{run.target_url}} (#122), and may read a mail
        // check's one-time code or link (#64). Braces that are neither are
        // the page's or the suite's own, and pass through untouched.
        const allow = (field: string) => (name: string): boolean => {
          if (name.startsWith('run.')) return false
          if (!name.startsWith('mail.')) return true
          validateMailArtefactName(name, mailChecks, field)
          return true
        }
        for (const [actionIndex, action] of (check.actions ?? []).entries()) {
          mapFlowStrings(action, (value, field) => {
            validateValueReferences(value, values, `${base}.actions[${actionIndex}].${field}`, allow(`${base}.actions[${actionIndex}].${field}`))
            return value
          })
          if (profile.target !== undefined && action.action === 'open' && action.url.startsWith('/') && pathOnTarget(profile.target.url, action.url) === undefined)
            throw new JobValidationError(`${base}.actions[${actionIndex}].url`, `the path ${JSON.stringify(action.url)} climbs out of the target ${profile.target.url}; a path on the target stays below its URL`)
        }
        const suiteIndex = check.suite === undefined ? -1 : profile.suites.findIndex((suite) => suite.name === check.suite)
        const suite = profile.suites[suiteIndex]
        if (suite !== undefined) validateRunReferences(suite.command, values, `suites[${suiteIndex}].command`)
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
  if (kind !== 'mail' || checkName === undefined || (artefact !== 'link' && artefact !== 'code') || parts.length !== 3) {
    throw new JobValidationError(field, `unknown artefact ${JSON.stringify(`{{${name}}}`)}; a mail check exposes {{mail.<name>.link}}, the first link in the message it read, and {{mail.<name>.code}}, the one-time code read from its body, and a mail check name carries no dot`)
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
  flow: { session?: FlowSessionFactory; masks: string[]; suites: ProfileSuite[]; target?: FlowTargetContext; totp?: FlowTotpConfig },
): Promise<CriterionResult> {
  const checks = criterion.checks ?? []
  if (checks.length === 0)
    return {
      id: criterion.id,
      outcome: 'unverified',
      reason: criterion.unrunnable ?? NO_CHECKS_REASON,
    }

  const evidence: string[] = []
  let failed = false
  let unverifiedReason: string | undefined
  // The values a run publishes or consumes — a mail message's link, its
  // one-time code — are secrets like any other: they join the profile's
  // redaction rules for every piece of evidence written after them (#64).
  const sweepRules = [...rules]
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
      // A mail check that reads a one-time code publishes it for later checks
      // as {{mail.<name>.code}} (#64). A message with no code in it is
      // unverified, named: the check cannot vouch for a code it never saw.
      let code: string | undefined
      if (substituted.code !== undefined) {
        code = extractCode(outcome.message.body, substituted.code.pattern)
        if (code === undefined) {
          if (unverifiedReason === undefined)
            unverifiedReason = `the message read by mail check ${substituted.name ?? substituted.address} carries no one-time code${
              substituted.code.pattern === undefined ? '' : ` matching ${JSON.stringify(substituted.code.pattern)}`
            }`
          continue
        }
      }
      // The values this check publishes — the message's link, the extracted
      // code — are swept from the message evidence and from every check that
      // follows in this criterion, not just here (#64).
      const published = [...(messageEvidence.links[0] === undefined ? [] : [messageEvidence.links[0]]), ...(code === undefined ? [] : [code])]
      if (published.length > 0) sweepRules.push(...valueRules(published))
      const text = JSON.stringify(redactValue(messageEvidence, sweepRules), null, 2)
      await writeFile(join(job.evidenceDir, checkDir, 'message.json'), `${text}\n`)
      evidence.push(`${checkDir}/message.json`)
      // The artefact a later `{{mail.<name>.link}}` reference reads is the first
      // link of the message this check waited for (#69).
      if (substituted.name !== undefined)
        artefacts.publish(substituted.name, { link: messageEvidence.links[0], ...(code === undefined ? {} : { code }) }, substituted.singleUse === true)
      continue
    }
    if (substituted.kind === 'flow') {
      // A flow can read a mail check's one-time code or link the way a command
      // does, at run time and per run (#64). An artefact that is gone skips
      // the flow unverified, and the flow never runs.
      const resolvedActions = resolveFlowArtefacts(substituted.actions ?? [], artefacts, criterion.id)
      if (!resolvedActions.ok) {
        if (unverifiedReason === undefined) unverifiedReason = resolvedActions.reason
        continue
      }
      // The flow types what it read from mail: those values join the sweep.
      if (resolvedActions.values.length > 0) sweepRules.push(...valueRules(resolvedActions.values))
      const outcome = await runFlowCheckJob(
        { ...substituted, actions: resolvedActions.actions },
        flow.suites,
        flow.session,
        flow.target,
        flow.totp,
        resolvedActions.values,
        values,
        job.repoPath,
        job.evidenceDir,
        checkDir,
        sweepRules,
        flow.masks,
      )
      evidence.push(...outcome.evidence)
      if (outcome.status === 'failed') failed = true
      else if (outcome.status === 'unverified' && unverifiedReason === undefined)
        unverifiedReason = outcome.reason
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
    // A command that echoes what it consumed writes it to stdout: the value is
    // a secret like any other, so the check's evidence is swept with it (#64).
    if (resolved.consumed.length > 0) sweepRules.push(...valueRules(resolved.consumed.map((consumed) => consumed.artefact)))
    const outcome = await runCommandCheck(resolved.check, cwd, timeoutMs)
    await mkdir(join(job.evidenceDir, checkDir), { recursive: true })
    await writeFile(join(job.evidenceDir, checkDir, 'stdout.txt'), redactText(truncationNote(outcome, 'stdout'), sweepRules))
    await writeFile(join(job.evidenceDir, checkDir, 'stderr.txt'), redactText(truncationNote(outcome, 'stderr'), sweepRules))
    evidence.push(`${checkDir}/stdout.txt`, `${checkDir}/stderr.txt`)
    if (resolved.consumed.length > 0) {
      const consumption = {
        artefacts: resolved.consumed.map((consumedArtefact) => ({ source: consumedArtefact.source, artefact: consumedArtefact.artefact })),
        consumed_by: { criterion: criterion.id, check: index },
        response: { status: outcome.status, evidence: [`${checkDir}/stdout.txt`, `${checkDir}/stderr.txt`] },
      }
      await writeFile(
        join(job.evidenceDir, checkDir, 'consumed.json'),
        `${JSON.stringify(redactValue(consumption, sweepRules), null, 2)}\n`,
      )
      evidence.push(`${checkDir}/consumed.json`)
    }
    if (outcome.status === 'failed') failed = true
    else if (outcome.status === 'unverified' && unverifiedReason === undefined)
      unverifiedReason = outcome.reason
  }

  if (failed) return { id: criterion.id, outcome: 'failed', evidence }
  if (unverifiedReason !== undefined) return { id: criterion.id, outcome: 'unverified', reason: unverifiedReason }
  // Everything that ran passed, but the plan asked for more than ran.
  if (criterion.skipped !== undefined) return { id: criterion.id, outcome: 'unverified', reason: criterion.skipped, evidence }
  return { id: criterion.id, outcome: 'proven', evidence }
}

/**
 * Substitute `{{run.<name>}}` references in a check's user-authored strings with
 * the run's minted values. Unknown names never reach this point: the plan-time
 * walk already refused the run.
 */
function substituteCheck(check: JobCheck, values: RunValues): JobCheck {
  // A flow's vocabulary is fixed and closed, but the strings it carries (a
  // URL, a typed value, a text to assert) may name run values (#122).
  if (check.kind === 'flow') {
    if (check.actions === undefined) return check
    return { ...check, actions: check.actions.map((action) => mapFlowStrings(action, (value) => substituteValues(value, values))) }
  }
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
 * Execute one flow check (#121). A suite flow runs the suite's command from the
 * profile and records the outcome in `suite.txt`; an actions flow drives the
 * page seam and records the action log and screenshots. The trace is kept out
 * of the published evidence: redaction cannot read a zip (#52). Anything that
 * is not the page's fault — no suite by that name, a backend that will not
 * start, a flow outliving its timeout — is unverified, never failed.
 */
async function runFlowCheckJob(
  check: JobFlowCheck,
  suites: ProfileSuite[],
  session: FlowSessionFactory | undefined,
  target: FlowTargetContext | undefined,
  totp: FlowTotpConfig | undefined,
  resolvedCodes: string[],
  values: RunValues,
  repoPath: string,
  evidenceDir: string,
  checkDir: string,
  rules: readonly RedactionRule[],
  masks: string[],
): Promise<{ status: 'passed' | 'failed' | 'unverified'; reason?: string; evidence: string[] }> {
  const inEvidence = (names: readonly string[]): string[] => names.map((name) => `${checkDir}/${name}`)
  if (check.suite !== undefined) {
    const suite = suites.find((entry) => entry.name === check.suite)
    if (suite === undefined) {
      return {
        status: 'unverified',
        reason: `no suite named ${JSON.stringify(check.suite)} in the profile's suites; the flow is unverified, not failed`,
        evidence: [],
      }
    }
    // The suite's command names run values like any command check, so a suite
    // on a target run learns where the target is from {{run.target_url}}.
    // A suite runs its own browser, which qare cannot see: like a command
    // check, its traffic is not recorded, and the SPEC says so.
    const command = substituteValues(suite.command, values)
    const outcome = await runSuiteCheck({ name: suite.name, command }, { cwd: repoPath, timeoutMs: check.timeoutMs })
    const dir = join(evidenceDir, checkDir)
    await mkdir(dir, { recursive: true })
    const text = redactText(
      JSON.stringify(
        { suite: suite.name, command, outcome: outcome.outcome, ...(outcome.reason === undefined ? {} : { reason: outcome.reason }) },
        null,
        2,
      ),
      rules,
    )
    await writeFile(join(dir, 'suite.txt'), `${text}\n`)
    return {
      status: outcome.outcome,
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      evidence: inEvidence(['suite.txt']),
    }
  }
  // The masks are the profile's own (#119): they black out their page regions
  // in every screenshot the backend takes, and the action log names them.
  const factory = session ?? makePlaywrightFlowSession
  const timeoutMs = check.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS
  let started
  try {
    started = await factory({ masks })
  } catch (error) {
    // A backend that will not start says nothing about the change: without a
    // browser the flow is unverifiable, which is an outcome and not a failure.
    return { status: 'unverified', reason: `the flow backend did not start: ${(error as Error).message}`, evidence: [] }
  }
  if (target !== undefined && started.outbound === undefined) {
    // Fail closed: a run against a target holds what its browser reached
    // against the declared hosts, and a backend that cannot say is not trusted.
    await started.dispose()
    return {
      status: 'unverified',
      reason: 'the flow backend does not report the hosts its browser reached, so a run against a target cannot vouch for them',
      evidence: [],
    }
  }
  try {
    // Every code the flow lays on the page, generated or read from mail, is
    // swept from the action log at write time (#64).
    const generatedCodes: string[] = [...resolvedCodes]
    const work = runFlowCheck({
      actions: target === undefined ? check.actions ?? [] : (check.actions ?? []).map((action) => onTarget(action, target.url)),
      page: started.page,
      trace: started.trace,
      outDir: join(evidenceDir, checkDir),
      tracesDir: resolve(evidenceDir, '..', 'traces', checkDir),
      redactLog: (text) => {
        let out = redactText(text, rules)
        for (const code of generatedCodes) out = out.split(code).join(REDACTED)
        return out
      },
      masks,
      totp,
      generatedCodes,
      codesOnPage: resolvedCodes.length > 0,
    })
    // The losing branch of the race is drained, so a flow that finishes late
    // after a timeout does not crash the run with an unhandled rejection.
    void work.catch(() => {})
    let outcome: FlowCheckResult | undefined
    let stopped: string | undefined
    try {
      outcome = await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error(`flow exceeded its ${timeoutMs} ms timeout`)), timeoutMs)
          timer.unref()
        }),
      ])
    } catch (error) {
      stopped = (error as Error).message
    }
    const evidence = outcome === undefined ? [] : inEvidence(outcome.evidence)
    // Recorded however the flow ended: a flow that timed out has still
    // reached whatever it reached.
    if (target !== undefined) {
      const undeclared = await recordOutbound(started.outbound?.() ?? [], target, join(evidenceDir, checkDir), rules)
      evidence.push(...inEvidence(['outbound.json']))
      if (undeclared.length > 0) {
        target.undeclared.push(...undeclared)
        return {
          status: 'unverified',
          reason: `refused: undeclared host: ${undeclared.join(', ')}; the target profile does not list it in target.hosts`,
          evidence,
        }
      }
    }
    if (outcome === undefined) return { status: 'unverified', reason: stopped ?? 'the flow stopped without an outcome', evidence }
    if (outcome.outcome === 'unverified') return { status: 'unverified', reason: outcome.reason, evidence }
    return { status: outcome.outcome, ...(outcome.reason === undefined ? {} : { reason: outcome.reason }), evidence }
  } finally {
    await started.dispose()
  }
}

function targetContext(target: ProfileTarget): FlowTargetContext {
  // The target's own host is always reachable; target.hosts names the rest.
  return { url: target.url, hosts: [new URL(target.url).hostname, ...target.hosts], undeclared: [] }
}

/** A path in an `open` action is a page on the target: it resolves below the target URL. */
function onTarget(action: FlowActionStep, url: string): FlowActionStep {
  if (action.action !== 'open' || !action.url.startsWith('/')) return action
  // Plan time refused a path that climbs out of the target.
  return { ...action, url: pathOnTarget(url, action.url) ?? action.url }
}

/**
 * Map the strings in a flow action that may carry run values, by field name.
 * The one list of them: plan-time validation and substitution both walk it.
 */
function mapFlowStrings(action: FlowActionStep, map: (value: string, field: string) => string): FlowActionStep {
  switch (action.action) {
    case 'open':
      return { ...action, url: map(action.url, 'url') }
    case 'type':
      return { ...action, value: map(action.value, 'value') }
    case 'assert':
      return { ...action, text: map(action.text, 'text') }
    default:
      return action
  }
}

/**
 * Write every host a target run's flow reached into `outbound.json`, and return
 * the connections to hosts the profile does not declare, one per host and port.
 * Only web traffic counts: a `data:` or `blob:` URL never leaves the browser.
 */
async function recordOutbound(
  attempts: readonly EgressAttempt[],
  target: FlowTargetContext,
  dir: string,
  rules: readonly RedactionRule[],
): Promise<string[]> {
  const reached = new Map<string, { host: string; port: number; protocol: string; declared: boolean; count: number }>()
  for (const attempt of attempts) {
    const key = `${attempt.host}:${attempt.port} (${attempt.protocol})`
    const entry = reached.get(key)
    if (entry !== undefined) entry.count += 1
    else reached.set(key, { ...attempt, declared: matchesStub(attempt.host, [{ hosts: target.hosts }]), count: 1 })
  }
  const entries = [...reached.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  await mkdir(dir, { recursive: true })
  const record = {
    target: target.url,
    declared: target.hosts,
    reached: entries.map(([, entry]) => ({ host: entry.host, port: entry.port, protocol: entry.protocol, declared: entry.declared, count: entry.count })),
  }
  await writeFile(join(dir, 'outbound.json'), `${JSON.stringify(redactValue(record, rules), null, 2)}\n`)
  return entries.filter(([, entry]) => !entry.declared).map(([key]) => key)
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
    const [namespace, checkName, field] = name.split('.')
    if (namespace !== 'mail' || checkName === undefined || (field !== 'link' && field !== 'code') || name.split('.').length !== 3) {
      return { ok: false, reason: `malformed artefact reference {{${name}}}; a reference is {{mail.<name>.link}} or {{mail.<name>.code}}` }
    }
    const outcome = artefacts.resolve(checkName, field, consumer)
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

/**
 * Substitute `{{mail.<name>.<field>}}` references in a flow's open URLs and
 * typed values at run time (#64). Returns the resolved actions with the values
 * substituted, plus every artefact value that landed on the page, so the
 * caller sweeps them from the action log like the flow's own codes.
 */
function resolveFlowArtefacts(
  actions: FlowActionStep[],
  artefacts: Artefacts,
  consumer: string,
): { ok: true; actions: FlowActionStep[]; values: string[] } | { ok: false; reason: string } {
  const names = new Set<string>()
  for (const action of actions) {
    mapFlowStrings(action, (value) => {
      for (const match of value.matchAll(REFERENCE)) {
        const name = match[1] ?? ''
        if (name.startsWith('mail.')) names.add(name)
      }
      return value
    })
  }
  const resolved = new Map<string, string>()
  const values: string[] = []
  for (const name of names) {
    const [namespace, checkName, field] = name.split('.')
    if (namespace !== 'mail' || checkName === undefined || (field !== 'link' && field !== 'code') || name.split('.').length !== 3) {
      return { ok: false, reason: `malformed artefact reference {{${name}}}; a reference is {{mail.<name>.link}} or {{mail.<name>.code}}` }
    }
    const outcome = artefacts.resolve(checkName, field, consumer)
    if (!outcome.ok) return outcome
    resolved.set(name, outcome.artefact)
    values.push(outcome.artefact)
  }
  const substitute = (text: string): string =>
    [...resolved.entries()].reduce((acc, [name, artefact]) => acc.split(`{{${name}}}`).join(artefact), text)
  return { ok: true, actions: actions.map((action) => mapFlowStrings(action, (value) => substitute(value))), values }
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
