import { spawn, type ChildProcess } from 'node:child_process'
import { lstat, mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { a11yConfigOf, type A11yCounts, type ProfileA11y } from './a11y.js'
import { DEFAULT_A11Y_THEME, settleA11y, type A11yContext } from './a11y-run.js'
import { parseDurationMs, shellCharacter } from './duration.js'
import { prepareBaseCheckout, type BaseCheckout, type BaseCheckoutInput, type BaseCheckoutOutcome } from './base-checkout.js'
import { collectCriterionFiles, criterionCacheKey, FileCheckCache, planFingerprint, profileFingerprint, resolveRefSha } from './cache.js'
import { Artefacts, type ArtefactField } from './artefacts.js'
import { detectExecution, runEnvironment, type ExecutionKind } from './environment.js'
import { bootApp, CANCEL_DOWN_TIMEOUT_MS, killActiveCompose, stopApp, type BootOpts } from './boot.js'
import { hasMintedProject, isolatedHealthUrl, isolateRun, type RunIsolation } from './isolation.js'
import { matchesStub, type EgressAttempt } from './egress.js'
import { runFlowCheck, runSuiteCheck, type FlowCheckResult, type FlowDriverCapabilities, type FlowPage, type FlowTotpConfig, type FlowTrace } from './flow.js'
import type { FlowRepairRecord } from './locator.js'
import { BROWSER_FLOW_DRIVER, makePlaywrightFlowSession } from './flow-playwright.js'
import { evidenceOf, judgeRun, toBaseSideResults, toSideResults } from './judge.js'
import { JobValidationError, type Job, type JobCheck, type JobCommandCheck, type JobCriterion, type JobFlowCheck, type JobProfileGroup, type JobProfileRef, type JobToolCheck, type SeveralProfilesJob, type SingleProfileJob } from './job.js'
import type { FlowActionStep } from './plan.js'
import { feedRunLedger } from './ledger-feed.js'
import { FileLedgerStore } from './ledger.js'
import { mailReader, mailSourceOf, type DeclaredMailSource, type MailSource } from './mail-source.js'
import { extractCode, mailEvidence, runMailCheck, type ReadMail } from './mailbox.js'
import { connectMcpDriver, connectMcpServer, evaluateToolAssertions, mcpDriverCapabilities, mcpDriverServer, type McpToolResult } from './mcp.js'
import { ProfileMissingError, loadProfile, pathOnTarget, validateProfileConfig, type ProfileCommand, type ReportFormat, type ProfileMcpServer, type ProfileSuite, type ProfileTarget, type QaProfile } from './profile.js'
import { BUILTIN_REDACTION_RULES, REDACTED, redactResult, redactText, redactValue, redactionRules, valueRules, type RedactionRule } from './redact.js'
import { RESULT_SCHEMA_VERSION, type CriterionBase, type CriterionResult, type RunBase, type RunRepairRecord, type RunResult, type RunVerdict } from './result.js'
import { shardCriteria, type LanePlan } from './shards.js'
import { runVisualCheckJob, visualPageUrl, type VisualComparison, type VisualContext, type VisualSessionFactory } from './visual-run.js'
import { mintRunValues, mintedMailAddress, substituteValues, validateRunReferences, validateValueReferences, type RunValues, REFERENCE } from './values.js'
import {
  addQuarantineRecord,
  checkFingerprint,
  openQuarantine,
  quarantineCheckName,
  quarantinedRecord,
  saveQuarantine,
  type QuarantineContext,
  type QuarantineRecord,
} from './quarantine.js'

export const DEFAULT_CHECK_TIMEOUT_MS = 60000
const NO_CHECKS_REASON = 'no checks were given for this criterion, so nothing ran'

/**
 * A host port compose can publish and a health URL can name: an integer in
 * 1..65535 (#53).
 */
function hasUsablePort(port: number | undefined): boolean {
  return port !== undefined && Number.isInteger(port) && port >= 1 && port <= 65535
}

/**
 * How a run handles a check that cannot decide (#50): `attempts` bounds how
 * many times a failing check repeats before it is judged, and `quarantine`
 * is the store the run consults before anything runs and persists unstable
 * checks into. One attempt, the default, is today's behavior: every check
 * is judged on what it did the first time.
 */
interface FlakePolicy {
  attempts: number
  quarantine?: QuarantineContext
}

function flakeAttemptsOf(attempts: number | undefined): number {
  if (attempts === undefined) return 1
  if (!Number.isInteger(attempts) || attempts < 1)
    throw new Error(`a flaky check repeats a whole number of times, one or more, not ${JSON.stringify(attempts)}`)
  return attempts
}

async function flakePolicyOf(opts: { flakeAttempts?: number; quarantineDir?: string }): Promise<FlakePolicy> {
  return {
    attempts: flakeAttemptsOf(opts.flakeAttempts),
    ...(opts.quarantineDir === undefined ? {} : { quarantine: await openQuarantine(opts.quarantineDir) }),
  }
}

/**
 * Write the store the run quarantined checks into, after every criterion has
 * run. A store that could not be read stays as it is: the run has already
 * said so on its own error stream, and no check is quarantined by a store the
 * run cannot read.
 */
async function persistQuarantine(policy: FlakePolicy): Promise<void> {
  if (policy.quarantine === undefined) return
  if (policy.quarantine.unreadable !== undefined) {
    console.error(`quarantine skipped: the store at ${policy.quarantine.dir} could not be read (${policy.quarantine.unreadable}), so this run quarantined nothing`)
    return
  }
  await saveQuarantine(policy.quarantine)
}

/** What one attempt of a check decided, evidence already written. */
interface CheckAttempt {
  status: 'passed' | 'failed' | 'unverified'
  reason?: string
}

/** How a check's attempts fold together: unstable means the run quarantines it. */
type AttemptFold =
  | { kind: 'passed' }
  | { kind: 'failed' }
  | { kind: 'unverified'; reason?: string }
  | { kind: 'unstable'; attempts: number }

/**
 * Run a check up to `attempts` times while it keeps failing, then judge it
 * once from what its attempts did (#50). A check that fails and then passes
 * is unstable: it did not decide, and a check that did not decide is what
 * quarantine is for. A check that fails every attempt is a failure, and a
 * check that passes its first attempt is proven and never runs again. An
 * unverified attempt decides nothing, so it is never retried: the reason
 * says what the harness could not do, and the criterion carries it.
 */
async function settleCheck(run: (attempt: number) => Promise<CheckAttempt>, attempts: number): Promise<AttemptFold> {
  let last = await run(0)
  let attemptsRun = 1
  let sawFailure = false
  while (last.status === 'failed' && attemptsRun < attempts) {
    sawFailure = true
    last = await run(attemptsRun)
    attemptsRun += 1
  }
  if (last.status === 'passed') return sawFailure ? { kind: 'unstable', attempts: attemptsRun } : { kind: 'passed' }
  if (last.status === 'failed') return { kind: 'failed' }
  return { kind: 'unverified', ...(last.reason === undefined ? {} : { reason: last.reason }) }
}

/**
 * Where the flow check gets its browser: the run hands over a session factory,
 * and tests hand over a fake, so the runner never imports the backend twice (#121).
 * The factory receives the profile's masks (#119), so an injected backend takes
 * them like the playwright one and the action log's masks note stays honest.
 * `outbound` lists every connection the session's page attempted, which a run
 * against a target checks against the hosts the profile declares (#122).
 */
export type FlowSessionFactory = (opts: { masks: string[] }) => Promise<{
  capabilities?: FlowDriverCapabilities
  page: FlowPage
  trace?: FlowTrace
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
 * check's own entries), so its checks do not inherit harness secrets. That is the
 * rule for every command step on a host (#91): a host's environment is nobody's
 * contract, so the harness imposes the minimal deterministic one itself, and
 * pull request code never inherits a host's tokens. A containerised run keeps
 * the inherit contract, because the image controls that environment.
 *
 * The booted app is intentionally left up after the checks so evidence (logs) can
 * be inspected; teardown is the caller's job (stopApp).
 *
 * A run that boots an app is isolated per run (#53): its compose project is
 * `qare-<run id>` and its app is published on a host port allocated for the run,
 * so two runs of the same repository at the same time never share a stack, a
 * network, or a port. The isolation is recorded in `isolation.json` in the
 * evidence, and a canceled run stops its own project before exiting. The run's
 * isolation is returned with the result, so the caller can stop what was booted.
 *
 * Everything written to the evidence directory, and the result returned, is
 * redacted with the profile's rules and the built-in ones (#52): evidence is
 * published, and output from the app under test can carry its secrets.
 */
export type RunJobOpts = BootOpts & {
  ledgerFeed?: { dir: string }
  readMail?: ReadMail
  flowSession?: FlowSessionFactory
  /** Where the run's visual checks get their screenshots (#143); the Playwright backend by default. */
  visualSession?: VisualSessionFactory
  /** What the driver behind this run's flows declares (#70); the browser driver by default. */
  flowDriver?: FlowDriverCapabilities
  /** Where the run executes; detected from the process when not pinned (issue #91). */
  execution?: ExecutionKind
  /**
   * How many workers the run shards its independent criteria across (#48).
   * One is the serial run: plan order against the one booted app, which is
   * what every run did before sharding existed.
   */
  workers?: number
  /** How many times a failing check repeats before it is judged (#50). */
  flakeAttempts?: number
  /** Where the run's quarantine store lives; the ledger directory in the pipeline (#50). */
  quarantineDir?: string
  /**
   * Ask for the base side (#147): the same plan, run against the app booted
   * from `baseRef`, so a criterion that worked there and fails at the head is
   * named a regression. Absent, the run has one side, as it always had.
   */
  base?: BaseSideRequest
}

type SideOpts = Omit<RunJobOpts, 'base'>

export interface RunJobOutcome {
  result: RunResult
  isolation?: RunIsolation
  isolations?: Array<{ name: string; isolation: RunIsolation }>
}

/**
 * Run a job. With `opts.base`, a job whose profile boots an app runs both
 * sides (#147): the base first, under an isolation of its own and torn down
 * when its checks are done, then the head. Base evidence lands under `base/`,
 * head evidence under `head/`, and the top-level result.json is the
 * comparison: the head's outcomes and verdict, what the base showed for each
 * criterion, and the regressions the judge computed from the two.
 *
 * A profile that names a target has one side only (#122), and a repository
 * with no profile is refused before anything runs, so both go the one-sided
 * way whatever the caller asked for.
 */
export async function runJob(job: Job, opts: RunJobOpts = {}): Promise<RunJobOutcome> {
  const { base: request, ...sideOpts } = opts
  if (request === undefined || !(await hasSecondSide(job))) return runSide(job, sideOpts)
  return runBothSides(job, sideOpts, request)
}

async function runSide(job: Job, opts: SideOpts = {}, side?: SideContext): Promise<RunJobOutcome> {
  // The run's wall clock (#51): when it started, so the metrics record can
  // say what a run cost in time as well as in model tokens.
  const startedAt = new Date().toISOString()
  // Where this run executes is evidence like the verdict is: recorded in
  // result.json with the version set, so a host run and an image run are
  // readable side by side (issue #91).
  const execution = opts.execution ?? detectExecution()
  if ('profiles' in job) return runSeveralProfiles(job, opts, execution, startedAt, side)
  let profile: QaProfile
  try {
    profile = atBaseTree(await resolveProfileRef(job.repoPath, job.profile), side)
  } catch (error) {
    if (!(error instanceof ProfileMissingError)) throw error
    // The base revision may predate the profile: nothing boots there, and
    // the comparison says so (#147).
    if (side?.name === 'base')
      return refuseRun(job, opts, BUILTIN_REDACTION_RULES, `the base revision has no usable .qa/ profile, so nothing boots at the base: ${error.message}`, undefined, undefined, execution, startedAt)
    // A repository that has not onboarded is refused, not a caller mistake
    // (#107). Every criterion is still reported, unverified, naming the gap,
    // so the evidence says what nobody checked and what onboarding needs.
    return refuseRun(job, opts, BUILTIN_REDACTION_RULES, `this repository has no usable .qa/ profile yet, so qare will not claim to have checked it: ${error.message}`, undefined, undefined, execution, startedAt)
  }
  // A base whose profile names a running target has no app of its own to
  // boot: checking the live target would compare the head with itself (#147).
  if (side?.name === 'base' && profile.target !== undefined)
    return refuseRun(job, opts, BUILTIN_REDACTION_RULES, 'the profile at the base revision names a running target, which has one side only, so nothing boots at the base', undefined, undefined, execution, startedAt)
  // One compose project per run (#53), minted before anything boots. A run
  // against a target boots nothing, so it needs no isolation, and a run that
  // cannot mint one is refused with the reason named: a run that cannot say
  // which project it boots under does not boot.
  let isolation: RunIsolation | undefined
  if (profile.app !== undefined) {
    try {
      isolation = opts.isolation ?? (await isolateRun())
    } catch (error) {
      return refuseRun(job, opts, BUILTIN_REDACTION_RULES, `the harness could not isolate this run, so it will not boot an app: ${error instanceof Error ? error.message : String(error)}`, undefined, undefined, execution, startedAt)
    }
    // A run that boots an app always publishes it on a port of its own: an
    // isolation without a usable one would fall back to the compose default
    // and put two concurrent runs on the same host port, or name a port the
    // health URL cannot, so it is refused (#53). A caller-carried isolation
    // is unvalidated otherwise: only an integer in the host-port range is
    // something compose can publish and a health URL can name.
    if (!hasUsablePort(isolation.port)) {
      return refuseRun(
        job,
        opts,
        BUILTIN_REDACTION_RULES,
        'the run isolation carries no usable app port, so two runs could publish their apps on the same host port; a run that boots an app needs an isolation with a host port in 1..65535 (isolateRun)',
        undefined,
        undefined,
        execution,
        startedAt,
      )
    }
    // A caller-carried isolation is only usable if it is one the harness could
    // have minted: the compose project is `qare-<run id>`, so a leftover stack
    // is always findable by the reap sweep, and a project qare never minted is
    // never touched (#53).
    if (!hasMintedProject(isolation)) {
      return refuseRun(
        job,
        opts,
        BUILTIN_REDACTION_RULES,
        'the run isolation does not carry a usable project: the compose project is qare-<run id>, so a leftover stack is always findable by reap and a project qare never minted is never touched',
        undefined,
        undefined,
        execution,
        startedAt,
      )
    }
  }
  // Run values exist per run, so they are minted here and referenced by name
  // from user-authored strings (#68). An unknown reference fails closed at
  // plan time: nothing boots, and the refusal names the field and the name.
  // The isolation's run id is the run's id: the compose project and the mail
  // address name the same run (#53).
  const values = mintRunValues({
    ...(profile.target === undefined ? {} : { targetUrl: profile.target.url }),
    ...(isolation === undefined ? {} : { runId: isolation.runId }),
    ...(isolation?.port === undefined ? {} : { appPort: String(isolation.port) }),
    ...(profile.mail?.domain === undefined ? {} : { mailDomain: profile.mail.domain }),
  })
  // A run against a target has one side only, and the result says so rather
  // than implying a base comparison it never made (#122).
  const targetNote = profile.target === undefined ? {} : { target: { url: profile.target.url, comparison: 'none' as const } }
  // The seeded second-factor secret and any backup code never reach the
  // evidence either: they sweep alongside the profile's own rules (#64).
  // The rules are built before the plan is validated, so a refusal that
  // publishes minted values still sweeps them with the profile's own (#55).
  const login = profile.app?.login
  const rules = [...redactionRules(profile.redact), ...valueRules([login?.totp?.secret, login?.backupCode?.value]), ...(side?.extraRules ?? [])]
  try {
    validatePlanValues(job.criteria, profile, values, opts.flowDriver ?? mcpDriverCapabilities(profile.mcp) ?? BROWSER_FLOW_DRIVER)
  } catch (error) {
    if (!(error instanceof JobValidationError)) throw error
    return refuseRun(job, opts, rules, error.message, targetNote, isolation, execution, startedAt)
  }
  // The flake policy (#50) is settled before anything runs, so the store is
  // read once and every criterion consults the same one.
  const policy = await flakePolicyOf(opts)
  // The run's check cache (#47): opened after the plan validates, so a refused
  // run writes nothing cached, and before the checks run, so every criterion
  // the run reaches is looked up and recorded. A run without a cache dir
  // executes every check for real. The flake bound is part of what a stored
  // result was proven under (#50): a failure judged under one bound is not
  // served to a run that judged the same checks under another.
  const cache = await openRunCache(job, job.criteria, profile, opts.cacheDir, policy.attempts)
  if (isolation !== undefined) {
    await mkdir(job.evidenceDir, { recursive: true })
    // Evidence is published: this names the compose project a leftover stack
    // runs under, which is what an orchestrator needs to reap it (#53).
    await writeFile(
      join(job.evidenceDir, 'isolation.json'),
      `${JSON.stringify({ run_id: isolation.runId, project: isolation.project, started_at: isolation.startedAt, ...(isolation.port === undefined ? {} : { port: isolation.port }) }, null, 2)}\n`,
    )
  }
  // The health URL is authored in the profile: run values are substituted
  // here (a profile may name the port as {{run.app_port}}), and a local URL
  // is then pinned to the port this run published the app on (#53), so the
  // run proves the app it booted and not another run's.
  const bootedProfile =
    isolation === undefined || profile.app === undefined
      ? profile
      : { ...profile, app: { ...profile.app, health: { ...profile.app.health, http: isolatedHealthUrl(substituteValues(profile.app.health.http, values), isolation.port) } } }
  // A canceled run tears its own project down before the process exits (#53),
  // and the disposer is released when the run finishes either way.
  const cancelCleanup = isolation === undefined ? undefined : installCancelCleanup(bootedProfile, { ...opts, isolation })
  try {
    if (isolation !== undefined) side?.booted.push({ profile: bootedProfile, isolation })
    const boot = await bootApp(bootedProfile, { ...opts, isolation })
    if (boot.kind === 'blocked') {
      const criteria: CriterionResult[] = job.criteria.map((criterion) => ({
        id: criterion.id,
        outcome: 'unverified',
        reason: boot.reason ?? 'boot did not come up',
      }))
      const finished = await finishRun(job, { schemaVersion: RESULT_SCHEMA_VERSION, verdict: 'blocked', criteria, startedAt, ...targetNote }, rules, values, execution)
      await feedIfOptedIn(opts, job, finished.result)
      return { result: finished.result, ...(isolation === undefined ? {} : { isolation }) }
    }

    const mail = mailContextOf(profile, values, opts.readMail)
    // Single-use artefacts are a per-run ledger: what was consumed in this run
    // says nothing about any other run (#69).
    const artefacts = new Artefacts()
    const target = profile.target === undefined ? undefined : targetContext(profile.target)
    // The flow types the code the profile's seeded secret generates; the secret
    // itself never crosses into the plan (#64).
    const totp =
      login?.totp === undefined ? undefined : { ...login.totp, ...(login.backupCode === undefined ? {} : { backupCode: login.backupCode.value }) }
    if (side !== undefined) side.ran = true
    const visual = visualContextOf(profile, profile.redact?.masks ?? [], opts.visualSession, side)
    const flow = {
      session: opts.flowSession,
      masks: profile.redact?.masks ?? [],
      suites: profile.suites,
      target,
      totp,
      mcp: profile.mcp,
      visual,
      a11y: a11yContextOf(profile, visual.comparison, side, job.criteria),
      ...(side === undefined ? {} : { tracesRoot: side.tracesRoot }),
    }
    const criteria = await runCriteriaAcrossLanes(
      job.criteria,
      shardCriteria(job.criteria, opts.workers ?? 1, isolatedSuitesOf(profile)),
      { job, profile, rules, values, mail, artefacts, flow, execution, cache, policy, opts, ...(side?.gate === undefined ? {} : { gate: side.gate }) },
    )
    await persistQuarantine(policy)
    await writeCacheHits(job.evidenceDir, cache?.hits ?? [])
    // The judge is the verdict decision. Base execution and egress interception
    // of a booted stack land with the orchestrator; a target run records what its
    // browser reached, and a host the profile does not declare refuses the run.
    const egressVerdict = target !== undefined && target.undeclared.length > 0 ? 'refused' : 'allowed'
    const { verdict } = judgeRun({ base: [], head: toSideResults({ criteria }), egressVerdict })
    const finished = await finishRun(job, { schemaVersion: RESULT_SCHEMA_VERSION, verdict, criteria, startedAt, ...targetNote }, rules, values, execution)
    await feedIfOptedIn(opts, job, finished.result)
    return { result: finished.result, ...(isolation === undefined ? {} : { isolation }) }
  } finally {
    cancelCleanup?.()
  }
}

/**
 * A several-profile job (#55): one run boots and checks every app the job
 * names, one after another, and writes one result that carries a verdict per
 * app, in the order the job named them. Each group runs exactly as a
 * single-profile run does, under an isolation of its own — its own compose
 * project, network and host port — so one app's stack is never another's, and
 * every project the run boots is one the reap sweep finds.
 *
 * A group that cannot run — a profile that is not there, an isolation that
 * will not mint, a plan value the harness does not mint, a boot that never
 * came up — reports its criteria unverified with the reason named, and the
 * other apps still run: the comment says what happened per app, and the
 * verdict judges the whole from every criterion it saw.
 */
interface ProfileGroupOutcome {
  criteria: CriterionResult[]
  verdict: RunVerdict
  values?: RunValues
  isolation?: RunIsolation
  egressRefused?: boolean
  /** The criteria this group served from the run's cache (#47). */
  cacheHits?: RunCacheContext['hits']
}

async function runSeveralProfiles(
  job: SeveralProfilesJob,
  opts: BootOpts & {
    ledgerFeed?: { dir: string }
    readMail?: ReadMail
    flowSession?: FlowSessionFactory
    visualSession?: VisualSessionFactory
    flowDriver?: FlowDriverCapabilities
    /** How many times a failing check repeats before it is judged (#50). */
    flakeAttempts?: number
    /** Where the run's quarantine store lives; the ledger directory in the pipeline (#50). */
    quarantineDir?: string
  },
  execution: ExecutionKind = detectExecution(),
  startedAt: string = new Date().toISOString(),
  side?: SideContext,
): Promise<RunJobOutcome> {
  const groups = job.profiles
  // Every profile is resolved before any other refusal is decided, and before
  // any app runs: a malformed profile fails closed wherever the run stops, so
  // a refusal about the caller's isolation cannot carry it past validation,
  // and evidence is swept with the union of every app's rules (#55).
  const planned: Array<{ group: JobProfileGroup; profile?: QaProfile; refusal?: string }> = []
  for (const group of groups) {
    try {
      const profile = atBaseTree(await resolveProfileRef(job.repoPath, group.profile), side)
      // The driver mapping is preflighted before anything runs (#94): an
      // action the mapping does not bind refuses this app's group here,
      // wherever the plan came from, so no group runs while a later one's
      // profile is about to refuse its own flows.
      const driver = mcpDriverCapabilities(profile.mcp)
      if (driver !== undefined) {
        const unmapped = [
          ...new Set(
            (group.criteria ?? []).flatMap((criterion) =>
              (criterion.checks ?? []).flatMap((check) =>
                check.kind === 'flow' || check.kind === 'a11y' ? (check.actions ?? []).filter((action) => !driver.actions.includes(action.action)) : [],
              ),
            ),
          ),
        ]
        if (unmapped.length > 0) {
          planned.push({
            group,
            refusal: `this profile maps an MCP driver that does not bind ${unmapped.join(', ')}, so the flow cannot run: a plan names only the intents the mapping binds`,
          })
          continue
        }
      }
      planned.push({ group, profile })
    } catch (error) {
      if (!(error instanceof ProfileMissingError)) throw error
      // Absent is refusal — for this app alone, so the other apps still run (#107).
      planned.push({
        group,
        refusal: `this repository has no usable .qa/ profile for ${group.name} yet, so qare will not claim to have checked it: ${error.message}`,
      })
    }
  }
  const rules: RedactionRule[] = [...BUILTIN_REDACTION_RULES]
  for (const entry of planned) {
    const login = entry.profile?.app?.login
    rules.push(...redactionRules(entry.profile?.redact), ...valueRules([login?.totp?.secret, login?.backupCode?.value]))
  }
  rules.push(...(side?.extraRules ?? []))
  // A caller-carried isolation belongs to a single-profile run: one isolation
  // cannot be several apps' own, so a several-profile run that was handed one
  // refuses instead of quietly sharing it (#55).
  if (opts.isolation !== undefined) {
    const criteria = groups.flatMap((group) =>
      group.criteria.map((criterion) => ({
        id: criterion.id,
        outcome: 'unverified' as const,
        reason: `the run was given an isolation of its own, but a run over several apps gives each app an isolation of its own, so nothing can attach to the one the caller carried; check ${group.name} on its own to reuse an isolation`,
      })),
    )
    const finished = await finishRun(
      job,
      {
        schemaVersion: RESULT_SCHEMA_VERSION,
        verdict: 'refused',
        criteria,
        startedAt,
        profiles: groups.map((group) => ({
          name: group.name,
          verdict: 'refused' as const,
          criteria: group.criteria.map((criterion) => criterion.id),
          profile: group.profile,
        })),
      },
      BUILTIN_REDACTION_RULES,
      undefined,
      execution,
    )
    await feedIfOptedIn(opts, job, finished.result)
    return { result: finished.result }
  }
  // Flow masks are swept the same way, before any app runs: a screenshot one
  // app captures must carry every app's mask regions, or one app's pixels can
  // publish another app's secret (#55).
  const masks = [...new Set(planned.flatMap((entry) => entry.profile?.redact?.masks ?? []))]
  // A several-app result names no target: the result's target metadata says a
  // run against a target has one side only. An app that declares a hosted
  // target is refused for this run, and the other apps still run, so the run
  // never silently drops which URL it was checked against (#55).
  for (const [index, entry] of planned.entries()) {
    if (entry.profile?.target === undefined) continue
    planned[index] = {
      group: entry.group,
      refusal:
        'the profile declares a hosted target, and a run over several apps reports no target of its own; check this app in its own single run so the result can name what it was checked against',
    }
  }
  const criteria: CriterionResult[] = []
  const profiles: Array<{ name: string; verdict: RunVerdict; criteria: string[]; profile: JobProfileRef }> = []
  const recorded: Array<{ name: string; values: RunValues }> = []
  const isolations: Array<{ name: string; isolation: RunIsolation }> = []
  const cacheHits: RunCacheContext['hits'] = []
  // One flake policy for the whole run (#50): every app consults and
  // persists into the same quarantine store.
  const policy = await flakePolicyOf(opts)
  let egressRefused = false
  // Every started group's cancellation disposer is collected here and released
  // only when the whole run is over, so a SIGINT at any point of the run tears
  // down every app the run has booted (#55).
  const cleanups: Array<() => void> = []
  try {
    for (const entry of planned) {
      const outcome: ProfileGroupOutcome =
        entry.refusal !== undefined
          ? { criteria: entry.group.criteria.map((criterion) => ({ id: criterion.id, outcome: 'unverified' as const, reason: entry.refusal! })), verdict: 'refused' }
          : await runProfileGroup(job, entry.group, entry.profile!, rules, masks, opts, cleanups, execution, policy, side)
      criteria.push(...outcome.criteria)
      profiles.push({ name: entry.group.name, verdict: outcome.verdict, criteria: outcome.criteria.map((criterion) => criterion.id), profile: entry.group.profile })
      if (outcome.values !== undefined) recorded.push({ name: entry.group.name, values: outcome.values })
      if (outcome.isolation !== undefined) isolations.push({ name: entry.group.name, isolation: outcome.isolation })
      if (outcome.egressRefused === true) egressRefused = true
      if (outcome.cacheHits !== undefined) cacheHits.push(...outcome.cacheHits)
    }
  } finally {
    for (const cleanup of cleanups) cleanup()
  }
  await persistQuarantine(policy)
  // The minted values of each app are written through the same redaction sweep
  // as everything else the run publishes, with every app's rules applied: the
  // evidence says which app ran under which project, and nothing else (#68).
  for (const entry of recorded) {
    await mkdir(job.evidenceDir, { recursive: true })
    await writeFile(
      join(job.evidenceDir, `values-${entry.name}.json`),
      `${redactText(JSON.stringify(entry.values, null, 2), rules)}\n`,
    )
  }
  const { verdict } = judgeRun({ base: [], head: toSideResults({ criteria }), egressVerdict: egressRefused ? 'refused' : 'allowed' })
  await writeCacheHits(job.evidenceDir, cacheHits)
  const finished = await finishRun(job, { schemaVersion: RESULT_SCHEMA_VERSION, verdict, criteria, startedAt, profiles }, rules, undefined, execution)
  await feedIfOptedIn(opts, job, finished.result)
  return { result: finished.result, ...(isolations.length > 0 ? { isolations } : {}) }
}

async function runProfileGroup(
  job: SeveralProfilesJob,
  group: JobProfileGroup,
  profile: QaProfile,
  rules: RedactionRule[],
  masks: string[],
  opts: BootOpts & {
    ledgerFeed?: { dir: string }
    readMail?: ReadMail
    flowSession?: FlowSessionFactory
    visualSession?: VisualSessionFactory
    flowDriver?: FlowDriverCapabilities
    workers?: number
    /** How many times a failing check repeats before it is judged (#50). */
    flakeAttempts?: number
    /** Where the run's quarantine store lives; the ledger directory in the pipeline (#50). */
    quarantineDir?: string
  },
  cleanups: Array<() => void>,
  execution: ExecutionKind = detectExecution(),
  policy: FlakePolicy = { attempts: 1 },
  side?: SideContext,
): Promise<ProfileGroupOutcome> {
  const unverifiedAll = (reason: string): CriterionResult[] =>
    group.criteria.map((criterion) => ({ id: criterion.id, outcome: 'unverified' as const, reason }))
  // One compose project per app (#53), minted before anything boots, so two
  // apps of one run never share a stack, a network, or a port. A caller-carried
  // isolation is refused before any app runs, so none is reused here.
  let isolation: RunIsolation | undefined
  if (profile.app !== undefined) {
    try {
      isolation = await isolateRun()
    } catch (error) {
      return { criteria: unverifiedAll(`the harness could not isolate the run for ${group.name}, so it will not boot an app: ${error instanceof Error ? error.message : String(error)}`), verdict: 'refused' }
    }
    if (!hasUsablePort(isolation.port)) {
      return {
        criteria: unverifiedAll(`the run isolation for ${group.name} carries no usable app port, so two runs could publish their apps on the same host port; a run that boots an app needs an isolation with a host port in 1..65535 (isolateRun)`),
        verdict: 'refused',
      }
    }
    if (!hasMintedProject(isolation)) {
      return {
        criteria: unverifiedAll(`the run isolation for ${group.name} does not carry a usable project: the compose project is qare-<run id>, so a leftover stack is always findable by reap and a project qare never minted is never touched`),
        verdict: 'refused',
      }
    }
  }
  // Run values are minted per app: the address a mail check waits for, the
  // port an app is published on, and the target it points at name that app's
  // run, while `{{run.id}}` names the run that booted it (#68).
  const values = mintRunValues({
    ...(profile.target === undefined ? {} : { targetUrl: profile.target.url }),
    ...(isolation === undefined ? {} : { runId: isolation.runId }),
    ...(isolation?.port === undefined ? {} : { appPort: String(isolation.port) }),
    ...(profile.mail?.domain === undefined ? {} : { mailDomain: profile.mail.domain }),
  })
  // One isolation file per app, written before validation, so a refusal still
  // names the compose project a leftover stack runs under — the caller holds
  // the isolation either way, which is what an orchestrator needs to reap it
  // (#53, #55).
  if (isolation !== undefined) {
    await mkdir(job.evidenceDir, { recursive: true })
    await writeFile(
      join(job.evidenceDir, `isolation-${group.name}.json`),
      `${JSON.stringify({ run_id: isolation.runId, project: isolation.project, started_at: isolation.startedAt, ...(isolation.port === undefined ? {} : { port: isolation.port }) }, null, 2)}\n`,
    )
  }
  try {
    validatePlanValues(group.criteria, profile, values, opts.flowDriver ?? mcpDriverCapabilities(profile.mcp) ?? BROWSER_FLOW_DRIVER)
  } catch (error) {
    if (!(error instanceof JobValidationError)) throw error
    // The rules sweep the values the refusal publishes: they are the union of
    // every app's, built before any app ran (#55).
    return { criteria: unverifiedAll(error.message), verdict: 'refused', values, ...(isolation === undefined ? {} : { isolation }) }
  }
  // This app's cache (#47): per group, as the isolation and the artefact
  // ledger are, so one app's cached results are never served to another's.
  const cache = await openRunCache(job, group.criteria, profile, opts.cacheDir, policy.attempts)
  const login = profile.app?.login
  const bootedProfile =
    isolation === undefined || profile.app === undefined
      ? profile
      : { ...profile, app: { ...profile.app, health: { ...profile.app.health, http: isolatedHealthUrl(substituteValues(profile.app.health.http, values), isolation.port) } } }
  const cancelCleanup = isolation === undefined ? undefined : installCancelCleanup(bootedProfile, { ...opts, isolation })
  try {
    if (isolation !== undefined) side?.booted.push({ profile: bootedProfile, isolation })
    const boot = await bootApp(bootedProfile, { ...opts, isolation })
    if (boot.kind === 'blocked') {
      return {
        criteria: unverifiedAll(boot.reason ?? 'boot did not come up'),
        verdict: 'blocked',
        values,
        ...(isolation === undefined ? {} : { isolation }),
      }
    }
    const mail = mailContextOf(profile, values, opts.readMail)
    // Single-use artefacts are a per-run ledger; per app, the ledger starts
    // empty, so one app's checks cannot spend another app's artefacts (#69).
    const artefacts = new Artefacts()
    const target = profile.target === undefined ? undefined : targetContext(profile.target)
    const totp =
      login?.totp === undefined ? undefined : { ...login.totp, ...(login.backupCode === undefined ? {} : { backupCode: login.backupCode.value }) }
    // The masks are the union of every app's, built before any app ran, so
    // one app's screenshots cannot publish another app's secret region (#55).
    if (side !== undefined) side.ran = true
    const visual = visualContextOf(profile, masks, opts.visualSession, side)
    const flow = {
      session: opts.flowSession,
      masks,
      suites: profile.suites,
      target,
      totp,
      mcp: profile.mcp,
      visual,
      a11y: a11yContextOf(profile, visual.comparison, side, group.criteria),
      ...(side === undefined ? {} : { tracesRoot: side.tracesRoot }),
    }
    const criteria = await runCriteriaAcrossLanes(
      group.criteria,
      shardCriteria(group.criteria, opts.workers ?? 1, isolatedSuitesOf(profile)),
      { job, profile, rules, values, mail, artefacts, flow, execution, cache, policy, opts, ...(side?.gate === undefined ? {} : { gate: side.gate }) },
    )
    const egressRefused = target !== undefined && target.undeclared.length > 0
    const { verdict } = judgeRun({ base: [], head: toSideResults({ criteria }), egressVerdict: egressRefused ? 'refused' : 'allowed' })
    return { criteria, verdict, values, ...(isolation === undefined ? {} : { isolation }), egressRefused, ...(cache === undefined ? {} : { cacheHits: cache.hits }) }
  } finally {
    // The disposer stays installed until the whole several-app run ends, not
    // just this group: the earlier apps' stacks are still up while a later
    // group runs, so a SIGINT mid-run must tear down every started app, not
    // only the one in flight (#55).
    if (cancelCleanup !== undefined) cleanups.push(cancelCleanup)
  }
}

/**
 * The suite names a profile declares isolated (#48): a suite whose command
 * mutates shared state of the app, so a criterion the ledger verifies by it
 * runs against an app of its own instead of the run's shared one.
 */
function isolatedSuitesOf(profile: QaProfile): Set<string> {
  return new Set(profile.suites.filter((suite) => suite.isolated === true).map((suite) => suite.name))
}

/**
 * Everything the lane executor needs to run one criterion: the pieces a run
 * builds once (the job, the shared booted profile, the rules, the run's
 * values, the mail, the run's artefact ledger, the flow context, the
 * detected execution, the run's cache) plus the boot options a shard boots
 * its own app with (#48).
 */
/**
 * What a criterion's browser checks run with: the flow session seam, the
 * masks, the suites, where a trace is kept, and what its visual checks
 * capture with and compare against (#143).
 */
interface FlowContext {
  session?: FlowSessionFactory
  masks: string[]
  visual: VisualContext
  /** What the accessibility audits of its flows and `a11y` checks run with (#149). */
  a11y: A11yContext
  suites: ProfileSuite[]
  target?: FlowTargetContext
  totp?: FlowTotpConfig
  mcp?: ProfileMcpServer[]
  /** Where traces go; beside the evidence directory when the run names none. */
  tracesRoot?: string
}

/**
 * Where a run's mail checks read from (#65): the source the profile declares,
 * addressed with the run's values, behind the reader a mail check waits on.
 * `label` is what a reason calls it.
 */
interface MailContext {
  label?: string
  readMail?: ReadMail
  source?: MailSource
}

function mailContextOf(profile: QaProfile, values: RunValues, injected: ReadMail | undefined): MailContext {
  const declared: DeclaredMailSource | undefined =
    profile.mail?.source ?? (profile.mail?.inbox === undefined ? undefined : { kind: 'inbox', url: profile.mail.inbox })
  if (declared === undefined) return injected === undefined ? {} : { readMail: injected }
  const source = mailSourceOf({ kind: declared.kind, url: substituteValues(declared.url, values) })
  return {
    // The inbox contract has always been named by its URL alone.
    label: profile.mail?.inbox ?? source.describe,
    readMail: injected ?? mailReader(source),
    source,
  }
}

interface LaneContext {
  job: Job
  profile: QaProfile
  rules: readonly RedactionRule[]
  values: RunValues
  mail: MailContext
  artefacts: Artefacts
  flow: FlowContext
  execution: ExecutionKind
  cache: RunCacheContext | undefined
  /** The run's flake policy (#50): every criterion in every lane consults the same one. */
  policy: FlakePolicy
  opts: BootOpts & { ledgerFeed?: { dir: string }; readMail?: ReadMail; flowSession?: FlowSessionFactory; flowDriver?: FlowDriverCapabilities; workers?: number }
  /**
   * The base side's limits (#147): a reason a criterion does not run at all,
   * asked just before it would. A gated criterion is unverified with that
   * reason, and the comparison reports it as not compared.
   */
  gate?: (criterion: JobCriterion) => string | undefined
}

/**
 * Run one criterion against an app instance of its own (#48). The criterion
 * boots the app under an isolation minted for it — its own compose project,
 * its own host port, its own volumes — so whatever its checks mutate is
 * gone, with the app, when the criterion is done, and no other criterion
 * sharing the run's app can see it. The isolation is recorded in evidence
 * next to the run's, named for the criterion, so a leftover stack is still
 * named for reap (#53). A run against a target has no app to boot, so the
 * criterion runs against the declared target like its neighbours do.
 */
async function runOwnBootCriterion(criterion: JobCriterion, ctx: LaneContext): Promise<CriterionResult> {
  const { job, profile, opts } = ctx
  if (profile.app === undefined)
    return runCriterion(criterion, job, ctx.rules, ctx.values, ctx.mail, ctx.artefacts, ctx.flow, ctx.execution, ctx.cache, ctx.policy, ctx.profile?.commands)
  let shardIsolation: RunIsolation
  try {
    shardIsolation = await isolateRun()
  } catch (error) {
    return { id: criterion.id, outcome: 'unverified', reason: `the criterion's own app did not start: ${(error as Error).message}` }
  }
  await mkdir(job.evidenceDir, { recursive: true })
  // Evidence is published: this names the compose project a leftover stack
  // runs under, which is what an orchestrator needs to reap it (#53).
  await writeFile(
    join(job.evidenceDir, `isolation-${criterion.id}.json`),
    `${JSON.stringify(
      { run_id: shardIsolation.runId, project: shardIsolation.project, started_at: shardIsolation.startedAt, ...(shardIsolation.port === undefined ? {} : { port: shardIsolation.port }) },
      null,
      2,
    )}\n`,
  )
  // The shard keeps the run's values except the identity it now owns: its
  // own run id (the compose project and the mail address name the criterion's
  // app, not the run's), and the host port its app is published on, so a
  // check that names `{{run.app_port}}` names the app this criterion booted.
  const shardValues: RunValues = {
    ...ctx.values,
    id: shardIsolation.runId,
    mail_address: mintedMailAddress(shardIsolation.runId, profile.mail?.domain),
    ...(shardIsolation.port === undefined ? {} : { app_port: String(shardIsolation.port) }),
  }
  const bootedShard = {
    ...profile,
    app: { ...profile.app, health: { ...profile.app.health, http: isolatedHealthUrl(substituteValues(profile.app.health.http, shardValues), shardIsolation.port) } },
  }
  const cancelCleanup = installCancelCleanup(bootedShard, { ...opts, isolation: shardIsolation })
  try {
    const boot = await bootApp(bootedShard, { ...opts, isolation: shardIsolation })
    if (boot.kind === 'blocked') return { id: criterion.id, outcome: 'unverified', reason: boot.reason ?? 'boot did not come up' }
    // The criterion's artefact ledger starts empty: what its flow checks
    // publish or spend belongs to this app alone, never the run's (#69).
    // The criterion's app carries its own catcher, published on its own port:
    // the source is addressed with the shard's values, not the run's (#65).
    const shardMail = mailContextOf(profile, shardValues, opts.readMail)
    return await runCriterion(criterion, job, ctx.rules, shardValues, shardMail, new Artefacts(), ctx.flow, ctx.execution, ctx.cache, ctx.policy, ctx.profile?.commands)
  } finally {
    // The criterion's app is torn down with the criterion: a sharded run
    // leaves no stack of its own holding a port or a volume the next
    // criterion or run could collide with (#48). The run's own app stays
    // with the run, exactly as an unsharded one does.
    await stopApp(bootedShard, { ...opts, isolation: shardIsolation })
    cancelCleanup()
  }
}

/**
 * Run a job's criteria across the lanes its sharding plan names (#48): the
 * independent ones across the workers against the one booted app, the rest
 * one after another in plan order, booting their own app where the job or a
 * suite declares one. Results come back in plan order whatever the workers
 * did, so a sharded run's result.json reads exactly as a serial run's does.
 */
async function runCriteriaAcrossLanes(criteria: JobCriterion[], lanes: LanePlan, ctx: LaneContext): Promise<CriterionResult[]> {
  const results: CriterionResult[] = new Array(criteria.length)
  const criterionAt = (index: number): JobCriterion => {
    const criterion = criteria[index]
    if (criterion === undefined) throw new Error('sharding: the plan named an index that names no criterion')
    return criterion
  }
  const gated = (criterion: JobCriterion): CriterionResult | undefined => {
    const reason = ctx.gate?.(criterion)
    return reason === undefined ? undefined : { id: criterion.id, outcome: 'unverified', reason }
  }
  await Promise.all([
    ...lanes.shared.map((slice) =>
      (async () => {
        for (const index of slice) {
          const criterion = criterionAt(index)
          // A criterion the workers run beside others shares nothing with
          // them: its artefact ledger starts empty, so its flow checks
          // cannot spend or publish what another criterion's do (#69).
          results[index] = gated(criterion) ?? (await runCriterion(criterion, ctx.job, ctx.rules, ctx.values, ctx.mail, new Artefacts(), ctx.flow, ctx.execution, ctx.cache, ctx.policy, ctx.profile?.commands))
        }
      })(),
    ),
    (async () => {
      for (const { index, ownBoot } of lanes.sequential) {
        const criterion = criterionAt(index)
        // The sequential criteria share the run's artefact ledger, in plan
        // order: a mail message's link published by one criterion is what
        // the next one consumes, exactly as a serial run hands it over.
        results[index] =
          gated(criterion) ??
          (ownBoot
            ? await runOwnBootCriterion(criterion, ctx)
            : await runCriterion(criterion, ctx.job, ctx.rules, ctx.values, ctx.mail, ctx.artefacts, ctx.flow, ctx.execution, ctx.cache, ctx.policy, ctx.profile?.commands))
      }
    })(),
  ])
  return results
}

/**
 * What a caller asks of the base side (#147). A checkout of the base revision
 * the caller already has is used as it is; without one the run makes a git
 * worktree of `baseRef` and removes it when the base side is done.
 */
export interface BaseSideRequest {
  repoPath?: string
  /** How the base tree is obtained; `prepareBaseCheckout` by default. */
  checkout?: (input: BaseCheckoutInput) => Promise<BaseCheckoutOutcome>
}

/** An app a side booted, with what stopping it takes. */
interface BootedApp {
  profile: QaProfile
  isolation: RunIsolation
}

/**
 * What makes one side of a two-sided run its own (#147). The side reports
 * back through it: every app it booted, so the base's can be torn down
 * whatever happened, and whether it got as far as running checks.
 */
interface SideContext {
  name: 'base' | 'head'
  /** Traces stay beside the evidence directory, never inside what is published (#52). */
  tracesRoot: string
  booted: BootedApp[]
  ran: boolean
  /** The other side's redaction rules, swept over this side's evidence too. */
  extraRules?: readonly RedactionRule[]
  /**
   * The head profile's masks, in force at the base too (#143): both sides
   * black out the same regions, so masking never shows as a difference.
   */
  extraMasks?: readonly string[]
  /**
   * What the head profile audits accessibility under, by criterion (#149).
   * It is in force at the base too: the two sides are compared under one
   * rule set, so a pull request that turns the audit on finds the old debt
   * at the base instead of failing on it.
   */
  headA11y?: (criterionId: string) => { a11y?: ProfileA11y; visual: QaProfile['visual'] } | undefined
  /** On the head side: where the base side saved its screenshots, and why a criterion has none (#143). */
  visualBase?: Extract<VisualComparison, { with: 'base' }>
  /** The base boots from the base tree: where a compose path of the profile lands there. */
  composePath?: (path: string) => string
  gate?: (criterion: JobCriterion) => string | undefined
}

/**
 * What a side's visual checks run with (#143). A run with one side compares
 * with nothing and says why; the base side of a two-sided run only captures;
 * the head side compares its captures with the ones the base side saved.
 */
function visualContextOf(profile: QaProfile, masks: readonly string[], session: VisualSessionFactory | undefined, side: SideContext | undefined): VisualContext {
  const oneSided: VisualComparison = {
    with: 'nothing',
    reason:
      profile.target !== undefined
        ? 'the profile names a running target, which has one side only, so there is no base to compare with'
        : 'nothing ran at a base revision in this run, so there is no base to compare with',
  }
  return {
    ...(session === undefined ? {} : { session }),
    defaults: profile.visual,
    masks: [...new Set([...masks, ...(side?.extraMasks ?? [])])],
    comparison: side === undefined ? oneSided : side.name === 'base' ? { with: 'base-side' } : (side.visualBase ?? oneSided),
    ...(profile.app === undefined ? {} : { appHealth: profile.app.health.http }),
    ...(profile.target === undefined ? {} : { targetUrl: profile.target.url }),
  }
}

/**
 * What a side's accessibility audits run with (#149): the profile's `a11y`
 * section with its defaults, the widths and themes of its `visual` section,
 * and the comparison its visual checks use. The base side takes the head
 * profile's, so both sides are audited under the same rules.
 */
function a11yContextOf(profile: QaProfile, comparison: VisualComparison, side: SideContext | undefined, criteria: readonly JobCriterion[]): A11yContext {
  const head = side?.name === 'base' ? criteria.map((criterion) => side.headA11y?.(criterion.id)).find((entry) => entry !== undefined) : undefined
  const section = head === undefined ? profile.a11y : head.a11y
  return {
    config: a11yConfigOf(section),
    defaults: head === undefined ? profile.visual : head.visual,
    standing: section?.standing === true,
    comparison,
  }
}

/** The base side as the comparison reads it: the raw result of a base that ran, or why none did. */
type BaseSideOutcome = { status: 'executed'; result: RunResult } | { status: 'not-executed'; reason: string }

const NOT_RUN_AT_BASE = 'not run at the base: '

/**
 * A job has a second side when it boots an app (#147). A target profile is
 * one side by definition (#122), and a profile that cannot be read is the
 * one-sided run's to refuse or to throw on, exactly as before.
 */
async function hasSecondSide(job: Job): Promise<boolean> {
  if ('profiles' in job) return true
  try {
    return (await resolveProfileRef(job.repoPath, job.profile)).app !== undefined
  } catch {
    return false
  }
}

/** The base side boots the base tree's own recipe: its compose file resolves there. */
function atBaseTree(profile: QaProfile, side: SideContext | undefined): QaProfile {
  if (side?.composePath === undefined || profile.app === undefined) return profile
  return { ...profile, app: { ...profile.app, boot: { ...profile.app.boot, compose: side.composePath(profile.app.boot.compose) } } }
}

/** Where a path inside the head checkout lands in the base checkout; undefined for a path outside it. */
function intoBaseTree(headRepo: string, baseRepo: string, absolute: string): string | undefined {
  const rel = relative(headRepo, absolute)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined
  return join(baseRepo, rel)
}

/** The job the base side runs: the same plan, against the base tree, writing under `base/`. */
function baseJobOf(job: Job, basePath: string): Job {
  // A relative profile path resolves against the repo path, so it follows the
  // base tree by itself; an absolute one inside the head checkout is moved.
  const ref = (profile: JobProfileRef): JobProfileRef =>
    'inline' in profile || !isAbsolute(profile.path) ? profile : { path: intoBaseTree(job.repoPath, basePath, profile.path) ?? profile.path }
  const evidenceDir = join(job.evidenceDir, 'base')
  if ('profiles' in job)
    return { ...job, repoPath: basePath, evidenceDir, profiles: job.profiles.map((group) => ({ ...group, profile: ref(group.profile) })) }
  return { ...job, repoPath: basePath, evidenceDir, profile: ref(job.profile) }
}

/** The head's profiles with the criteria each one checks: where the base side's limits and the head's redaction rules are read from. */
async function headProfilesOf(job: Job): Promise<Array<{ profile: QaProfile; criteria: JobCriterion[] }>> {
  const groups = 'profiles' in job ? job.profiles : [{ profile: job.profile, criteria: job.criteria }]
  const loaded: Array<{ profile: QaProfile; criteria: JobCriterion[] }> = []
  for (const group of groups) {
    try {
      loaded.push({ profile: await resolveProfileRef(job.repoPath, group.profile), criteria: group.criteria })
    } catch {
      // A profile the head cannot read sets no limits; the head side says what is wrong with it.
    }
  }
  return loaded
}

/**
 * The base side's limits, from the profile the run was configured with
 * (#147): `base.criteria: ledger` runs only the criteria the ledger at the
 * base already carries as active, and `base.budget` bounds the side's wall
 * clock from the moment it starts. Both are read as a reason a criterion
 * does not run, so what the limits leave out is reported, not dropped.
 */
async function baseLimits(
  profiles: Array<{ profile: QaProfile; criteria: JobCriterion[] }>,
  basePath: string,
): Promise<{ nothingToRun: boolean; gate: (criterion: JobCriterion) => string | undefined }> {
  const ledgerOnly = new Set<string>()
  const off = new Set<string>()
  const budgets = new Map<string, { ms: number; label: string }>()
  for (const { profile, criteria } of profiles) {
    for (const criterion of criteria) {
      if (profile.base?.criteria === 'ledger') ledgerOnly.add(criterion.id)
      if (profile.base?.criteria === 'none') off.add(criterion.id)
      if (profile.base?.budget !== undefined) budgets.set(criterion.id, { ms: parseDurationMs(profile.base.budget), label: profile.base.budget })
    }
  }
  let carried = new Set<string>()
  if (ledgerOnly.size > 0) {
    try {
      const entries = await new FileLedgerStore(join(basePath, '.qa')).load()
      carried = new Set(entries.filter((entry) => entry.status === 'active').map((entry) => entry.criterion))
    } catch {
      // A ledger that cannot be read carries nothing: nothing runs at the base on its word.
    }
  }
  const leftOut = (id: string): boolean => off.has(id) || (ledgerOnly.has(id) && !carried.has(id))
  const all = profiles.flatMap((entry) => entry.criteria)
  const startedMs = Date.now()
  return {
    nothingToRun: all.length > 0 && all.every((criterion) => leftOut(criterion.id)),
    gate: (criterion) => {
      if (off.has(criterion.id)) return `${NOT_RUN_AT_BASE}the profile runs no criteria at the base (base.criteria: none)`
      if (leftOut(criterion.id))
        return `${NOT_RUN_AT_BASE}the profile limits the base side to the criteria already in the ledger, and the ledger at the base does not carry ${criterion.id}`
      const budget = budgets.get(criterion.id)
      if (budget !== undefined && Date.now() - startedMs >= budget.ms)
        return `${NOT_RUN_AT_BASE}the base side's time budget of ${budget.label} was spent before this criterion ran`
      return undefined
    },
  }
}

/**
 * Run the plan against the base revision (#147). Nothing here throws into the
 * run: a base that cannot be checked out, will not boot, or stops half way is
 * a named reason, and the head is checked regardless. Every app the base
 * booted is stopped, and a checkout the run made is removed, before the head
 * starts, so the two sides never contend for the machine.
 */
async function runBaseSide(
  job: Job,
  opts: SideOpts,
  request: BaseSideRequest,
  profiles: Array<{ profile: QaProfile; criteria: JobCriterion[] }>,
  headRules: readonly RedactionRule[],
): Promise<BaseSideOutcome> {
  const booted: BootedApp[] = []
  let checkout: BaseCheckout | undefined
  try {
    // A profile that runs nothing at the base costs nothing there: no
    // checkout, no boot, and the result says the run had one side.
    if (profiles.length > 0 && profiles.every(({ profile }) => profile.base?.criteria === 'none'))
      return { status: 'not-executed', reason: 'the profile runs no criteria at the base (base.criteria: none)' }
    const outcome = await (request.checkout ?? prepareBaseCheckout)({
      repoPath: job.repoPath,
      baseRef: job.baseRef,
      headRef: job.headRef,
      ...(request.repoPath === undefined ? {} : { given: request.repoPath }),
    })
    if (!outcome.ok) return { status: 'not-executed', reason: outcome.reason }
    checkout = outcome.checkout
    const basePath = checkout.path
    const limits = await baseLimits(profiles, basePath)
    if (limits.nothingToRun)
      return {
        status: 'not-executed',
        reason: "the profile's limits leave nothing to run at the base: the ledger at the base carries none of the criteria this run checks",
      }
    const side: SideContext = {
      name: 'base',
      tracesRoot: resolve(job.evidenceDir, '..', 'traces', 'base'),
      booted,
      ran: false,
      extraRules: headRules,
      extraMasks: profiles.flatMap(({ profile }) => profile.redact?.masks ?? []),
      headA11y: (criterionId) => {
        const owner = profiles.find(({ criteria }) => criteria.some((criterion) => criterion.id === criterionId))?.profile
        return owner === undefined ? undefined : { ...(owner.a11y === undefined ? {} : { a11y: owner.a11y }), visual: owner.visual }
      },
      composePath: (path) => intoBaseTree(job.repoPath, basePath, resolve(path)) ?? (isAbsolute(path) ? path : resolve(basePath, path)),
      gate: limits.gate,
    }
    // The base side is a comparison, not a record: it feeds no ledger and
    // quarantines nothing, it boots under isolations of its own whatever the
    // caller carried for the head, and its cache is its own, because both
    // sides resolve the same two revisions and would otherwise share keys.
    const baseOpts: SideOpts = { ...opts }
    delete baseOpts.isolation
    delete baseOpts.ledgerFeed
    delete baseOpts.quarantineDir
    if (opts.cacheDir !== undefined) baseOpts.cacheDir = join(opts.cacheDir, 'base')
    const { result } = await runSide(baseJobOf(job, basePath), baseOpts, side)
    if (!side.ran) {
      const first = result.criteria.find((criterion) => criterion.outcome === 'unverified')
      return { status: 'not-executed', reason: first?.outcome === 'unverified' ? first.reason : `the base side reached no check (verdict ${result.verdict})` }
    }
    return { status: 'executed', result }
  } catch (error) {
    return { status: 'not-executed', reason: `the base side stopped before it finished: ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    const downTimeoutMs = opts.downTimeoutMs !== undefined && opts.downTimeoutMs > 0 ? opts.downTimeoutMs : CANCEL_DOWN_TIMEOUT_MS
    for (const app of booted) await stopApp(app.profile, { ...opts, isolation: app.isolation, downTimeoutMs })
    try {
      await checkout?.dispose()
    } catch (error) {
      console.error(`the base checkout could not be removed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * Both sides of a run (#147): the base, then the head, then the comparison.
 * The head is the verdict source, as it always was. The base only says which
 * head failures are regressions, so nothing the base does can turn a
 * criterion green, and what was not run there is "not compared".
 */
async function runBothSides(job: Job, opts: SideOpts, request: BaseSideRequest): Promise<RunJobOutcome> {
  const startedAt = new Date().toISOString()
  const profiles = await headProfilesOf(job)
  const headRules = profiles.flatMap(({ profile }) => [
    ...redactionRules(profile.redact),
    ...valueRules([profile.app?.login?.totp?.secret, profile.app?.login?.backupCode?.value]),
  ])
  const base = await runBaseSide(job, opts, request, profiles, headRules)
  // The comparison is what the ledger hears about, once, so the head side
  // feeds nothing itself.
  const headOpts: SideOpts = { ...opts }
  delete headOpts.ledgerFeed
  const headSide: SideContext = {
    name: 'head',
    tracesRoot: resolve(job.evidenceDir, '..', 'traces', 'head'),
    booted: [],
    ran: false,
    // The base screenshots of a visual check are the ones the base side just
    // saved (#143): there is no second way to capture a base.
    visualBase: { with: 'base', evidenceDir: join(job.evidenceDir, 'base'), why: (criterionId) => noBaseScreenshots(base, criterionId) },
  }
  const head = await runSide({ ...job, evidenceDir: join(job.evidenceDir, 'head') }, headOpts, headSide)
  const compared = redactResult(compareSides(job, head.result, base, startedAt), [...BUILTIN_REDACTION_RULES, ...headRules])
  await mkdir(job.evidenceDir, { recursive: true })
  await writeFile(join(job.evidenceDir, 'result.json'), `${JSON.stringify(compared, null, 2)}\n`)
  await feedIfOptedIn(opts, job, compared)
  return {
    result: compared,
    ...(head.isolation === undefined ? {} : { isolation: head.isolation }),
    ...(head.isolations === undefined ? {} : { isolations: head.isolations }),
  }
}

/** Why the base side saved no screenshots for a criterion's visual check (#143). */
function noBaseScreenshots(base: BaseSideOutcome, criterionId: string): string {
  if (base.status === 'not-executed') return `the base side did not run: ${base.reason}`
  const criterion = base.result.criteria.find((entry) => entry.id === criterionId)
  if (criterion?.outcome !== 'unverified') return 'the base side saved nothing for this check'
  return criterion.reason.startsWith(NOT_RUN_AT_BASE) ? criterion.reason : `unverified at the base: ${criterion.reason}`
}

/**
 * The comparison of the two sides, decided in code (rule 3). Each head
 * criterion carries what the base showed for it, and the judge computes the
 * regressions from the executed outcomes of both: proven at the base, failed
 * at the head. A base outcome that is not an executed pass or failure is
 * `not-compared`, with its reason, and takes no part in that.
 */
function compareSides(job: Job, head: RunResult, base: BaseSideOutcome, startedAt: string): RunResult {
  const under = (side: 'base' | 'head', paths: string[]): string[] => paths.map((path) => `${side}/${path}`)
  const atBase = new Map((base.status === 'executed' ? base.result.criteria : []).map((criterion) => [criterion.id, criterion]))
  const baseOf = (id: string): CriterionBase => {
    if (base.status === 'not-executed') return { outcome: 'not-compared', reason: `the base side did not run: ${base.reason}` }
    const criterion = atBase.get(id)
    if (criterion === undefined) return { outcome: 'not-compared', reason: 'the base side reported nothing for this criterion' }
    const evidence = under('base', evidenceOf(criterion))
    const saved = evidence.length === 0 ? {} : { evidence }
    if (criterion.outcome !== 'unverified') return { outcome: criterion.outcome, ...saved }
    return {
      outcome: 'not-compared',
      reason: criterion.reason.startsWith(NOT_RUN_AT_BASE) ? criterion.reason : `unverified at the base: ${criterion.reason}`,
      ...saved,
    }
  }
  const criteria: CriterionResult[] = head.criteria.map((criterion) => ({
    ...criterion,
    ...('evidence' in criterion && criterion.evidence !== undefined ? { evidence: under('head', criterion.evidence) } : {}),
    base: baseOf(criterion.id),
  }))
  // The judge is handed both sides, and it alone says what regressed.
  const regressed = new Set(
    judgeRun({ base: toBaseSideResults({ criteria }), head: toSideResults({ criteria }) }).regressions.map((regression) => regression.criterionId),
  )
  const status: RunBase =
    base.status === 'executed' ? { ref: job.baseRef, status: 'executed' } : { ref: job.baseRef, status: 'not-executed', reason: base.reason }
  return {
    ...head,
    criteria: criteria.map((criterion) => {
      if (criterion.outcome !== 'failed') return criterion
      if (regressed.has(criterion.id)) return { ...criterion, regression: true }
      return criterion.base?.outcome === 'failed' ? { ...criterion, regression: false } : criterion
    }),
    base: status,
    startedAt,
    finishedAt: new Date().toISOString(),
  }
}

/** Refuse the whole run without booting: every criterion is reported unverified, naming the gap. */
async function refuseRun(
  job: SingleProfileJob,
  opts: BootOpts & { ledgerFeed?: { dir: string } },
  rules: readonly RedactionRule[],
  reason: string,
  targetNote: Pick<RunResult, 'target'> = {},
  isolation?: RunIsolation,
  execution: ExecutionKind = detectExecution(),
  startedAt: string = new Date().toISOString(),
): Promise<{ result: RunResult; isolation?: RunIsolation }> {
  const criteria: CriterionResult[] = job.criteria.map((criterion) => ({
    id: criterion.id,
    outcome: 'unverified',
    reason,
  }))
  // The wall clock starts when the run did, not when the refusal did: work
  // done before the refusal (profile resolution, isolation) is time the run
  // spent (#51).
  const finished = await finishRun(job, { schemaVersion: RESULT_SCHEMA_VERSION, verdict: 'refused', criteria, startedAt, ...targetNote }, rules, undefined, execution)
  await feedIfOptedIn(opts, job, finished.result)
  return { result: finished.result, ...(isolation === undefined ? {} : { isolation }) }
}

/**
 * On cancel (SIGINT/SIGTERM) the run stops its own compose project before the
 * process exits (#53): a canceled run must not leave its stack holding the
 * port and network the next run could otherwise queue behind. The handlers are
 * removed when the run finishes normally, so an exit qare chose carries no
 * stale cleanup. The down is bounded, so a compose call that never settles
 * cannot hold the exit open, and the exit waits for every canceled run's down,
 * so two runs sharing a process never leave the later run's stack behind the
 * earlier run's exit (#53).
 */
const pendingStops = new Set<Promise<void>>()

export function installCancelCleanup(profile: QaProfile, opts: BootOpts): () => void {
  const stop = (): void => {
    // The compose children this run still has in flight are killed first, so
    // no orphaned up can keep provisioning the project after the down has
    // run (#53). Only this run's project is killed: a concurrent run in the
    // same process must not lose its own children to this cancellation. A
    // caller-carried isolation naming a project outside the harness namespace
    // is never addressed: neither the kill nor the down touches it (#53).
    const isolation = opts.isolation
    if (isolation !== undefined && hasMintedProject(isolation)) killActiveCompose(isolation.project)
    // A caller override at or below 0 would opt the cancellation out of its
    // own guarantee, so it is normalized to the default bound.
    const downTimeoutMs = opts.downTimeoutMs !== undefined && opts.downTimeoutMs > 0 ? opts.downTimeoutMs : CANCEL_DOWN_TIMEOUT_MS
    const stopped = stopApp(profile, { ...opts, downTimeoutMs }).catch(() => {})
    // The deadline is the exit guarantee: when the down hangs past it, the
    // timeout is reported, the wait resolves anyway, and the exit runs,
    // leaving the stack to reap (#53).
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    const entry = Promise.race([
      stopped,
      new Promise<void>((resolve) => {
        timeoutTimer = setTimeout(() => {
          console.error(
            `canceled run ${isolation?.runId ?? ''}: the compose down did not settle within ${downTimeoutMs}ms; the leftover stack is left for reap`,
          )
          resolve()
        }, downTimeoutMs)
      }),
    ])
    pendingStops.add(entry)
    void entry.finally(() => {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
      pendingStops.delete(entry)
      if (pendingStops.size === 0) process.exit(4)
    })
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  return () => {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
}

/**
 * Walk every user-authored string that can carry a `{{run.<name>}}` reference and
 * reject unknown names before anything boots. The seed command is validated here
 * even though its execution lands with the orchestrator, so a bad name in the
 * seed is still a plan-time failure. The driver's own declaration is walked the
 * same way: a flow naming an action the driver lacks refuses the run before
 * anything boots, naming the action and the driver (#70).
 */
function validatePlanValues(criteria: JobCriterion[], profile: QaProfile, values: RunValues, flowDriver: FlowDriverCapabilities): void {
  if (profile.app !== undefined) {
    validateValueReferences(profile.app.seed.command, values, 'app.seed.command')
    // The health URL may name the port the run publishes the app on (#53).
    validateValueReferences(profile.app.health.http, values, 'app.health.http')
  }
  // A mail source may be published behind a port the run mints (#65).
  if (profile.mail?.source !== undefined) validateValueReferences(profile.mail.source.url, values, 'mail.source.url')
  // Mail artefact names are validated in walk order: a check may only read an
  // artefact from a mail check that has already waited for its message (#69),
  // and only for the fields that check actually exposes (#64).
  const mailChecks = new Map<string, { count: number; code: boolean }>()
  for (const [criterionIndex, criterion] of criteria.entries()) {
    for (const [checkIndex, check] of (criterion.checks ?? []).entries()) {
      const base = `criteria[${criterionIndex}].checks[${checkIndex}]`
      if (check.kind === 'mail') {
        validateValueReferences(check.address, values, `${base}.address`)
        for (const field of ['from', 'subject', 'body'] as const) {
          const value = check[field]
          if (value !== undefined) validateValueReferences(value, values, `${base}.${field}`)
        }
        if (check.name !== undefined) {
          const seen = mailChecks.get(check.name) ?? { count: 0, code: false }
          mailChecks.set(check.name, { count: seen.count + 1, code: seen.code || check.code !== undefined })
        }
        continue
      }
      if (check.kind === 'a11y' && check.url !== undefined) {
        // The page an a11y check audits is named as a visual check names
        // its page (#149): it may carry run values, and stays on the target.
        validateValueReferences(check.url, values, `${base}.url`)
        if (profile.target !== undefined && check.url.startsWith('/') && pathOnTarget(profile.target.url, check.url) === undefined)
          throw new JobValidationError(`${base}.url`, `the path ${JSON.stringify(check.url)} climbs out of the target ${profile.target.url}; a path on the target stays below its URL`)
      }
      if (check.kind === 'flow' || check.kind === 'a11y') {
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
          if (!flowDriver.actions.includes(action.action))
            throw new JobValidationError(
              `${base}.actions[${actionIndex}].action`,
              `flow action ${JSON.stringify(action.action)} is not one of the actions the ${flowDriver.name} driver declares, so the plan cannot run against it`,
            )
          mapFlowStrings(action, (value, field) => {
            validateValueReferences(value, values, `${base}.actions[${actionIndex}].${field}`, allow(`${base}.actions[${actionIndex}].${field}`))
            return value
          })
          if (profile.target !== undefined && action.action === 'open' && action.url.startsWith('/') && pathOnTarget(profile.target.url, action.url) === undefined)
            throw new JobValidationError(`${base}.actions[${actionIndex}].url`, `the path ${JSON.stringify(action.url)} climbs out of the target ${profile.target.url}; a path on the target stays below its URL`)
        }
        if (check.kind === 'a11y') continue
        const suiteIndex = check.suite === undefined ? -1 : profile.suites.findIndex((suite) => suite.name === check.suite)
        const suite = profile.suites[suiteIndex]
        if (suite !== undefined) validateRunReferences(suite.command, values, `suites[${suiteIndex}].command`)
        continue
      }
      if (check.kind === 'visual') {
        // The page a visual check captures may name run values, and on a
        // target it is a path below the target URL, like a flow's (#143).
        if (check.url !== undefined) {
          validateValueReferences(check.url, values, `${base}.url`)
          if (profile.target !== undefined && check.url.startsWith('/') && pathOnTarget(profile.target.url, check.url) === undefined)
            throw new JobValidationError(`${base}.url`, `the path ${JSON.stringify(check.url)} climbs out of the target ${profile.target.url}; a path on the target stays below its URL`)
        }
        continue
      }
      if (check.kind === 'tool') {
        // A tool check calls a tool the profile named, either in the driver
        // mapping or in the allowlist (#94): anything else would reach a host
        // tool the profile never declared, so the plan refuses here.
        // A tool check runs in the execute step, so only the tools of
        // servers allowed there are reachable (#94): the steps gate holds
        // against the run, not just the planner.
        const registered = new Set(
          (profile.mcp ?? [])
            .filter((entry) => entry.steps.includes('execute'))
            .flatMap((entry) => [...entry.tools, ...Object.values(entry.driver ?? {}).map((map) => map.tool)]),
        )
        if (!registered.has(check.tool))
          throw new JobValidationError(
            `${base}.tool`,
            `refused: ${JSON.stringify(check.tool)} is not a tool the profile's MCP servers register for the execute step; a tool check calls only a tool the profile named`,
          )
        const allow = (field: string) => (name: string): boolean => {
          if (!name.startsWith('mail.')) return false
          validateMailArtefactName(name, mailChecks, field)
          return true
        }
        for (const [key, value] of Object.entries(check.args ?? {})) {
          if (key.includes('{{'))
            throw new JobValidationError(`${base}.args.${key}`, 'an argument name names a variable and is not a substitution site; put the reference in the value')
          validateValueReferences(value, values, `${base}.args.${key}`, allow(`${base}.args.${key}`))
        }
        for (const [index, assertion] of check.assert.entries()) {
          const assertionBase = `${base}.assert[${index}]`
          for (const field of ['contains', 'matches'] as const) {
            const value = assertion[field]
            if (value !== undefined) validateValueReferences(value, values, `${assertionBase}.${field}`, allow(`${assertionBase}.${field}`))
          }
          if (typeof assertion.equals === 'string')
            validateValueReferences(assertion.equals, values, `${assertionBase}.equals`, allow(`${assertionBase}.equals`))
        }
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
function validateMailArtefactName(name: string, mailChecks: Map<string, { count: number; code: boolean }>, field: string): void {
  const parts = name.split('.')
  const [kind, checkName, artefact] = parts
  if (kind !== 'mail' || checkName === undefined || (artefact !== 'link' && artefact !== 'code') || parts.length !== 3) {
    throw new JobValidationError(field, `unknown artefact ${JSON.stringify(`{{${name}}}`)}; a mail check exposes {{mail.<name>.link}}, the first link in the message it read, and {{mail.<name>.code}}, the one-time code read from its body, and a mail check name carries no dot`)
  }
  const entry = mailChecks.get(checkName)
  if (entry === undefined) {
    throw new JobValidationError(field, `no mail check named ${checkName} runs before this check; an artefact is read from a mail check that has already waited for its message`)
  }
  if (entry.count > 1) {
    throw new JobValidationError(field, `${entry.count} earlier mail checks are named ${checkName}; the artefact reference is ambiguous, so rename one of them`)
  }
  if (artefact === 'code' && !entry.code) {
    throw new JobValidationError(field, `the mail check named ${checkName} declares no code section, so it exposes no {{mail.${checkName}.code}}; give it a code section with a pattern, or read {{mail.${checkName}.link}}`)
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

async function resolveProfileRef(repoPath: string, ref: JobProfileRef): Promise<QaProfile> {
  if ('inline' in ref) return validateProfileConfig(ref.inline)
  const dir = resolve(repoPath, ref.path)
  // A profile that lives directly in .qa/ shares the root's fixtures and
  // stubs when it keeps none of its own, exactly as discovery loads it (#55).
  const qaDir = resolve(repoPath, '.qa')
  const shared = dirname(dir) === qaDir ? { resources: qaDir } : undefined
  // The two layouts are mutually exclusive wherever they are read, not only
  // at discovery (#55): a named profile loaded from a repository whose .qa
  // root also carries a config.yml is a layout nobody can select from, so the
  // run refuses instead of reading whichever one it happens to find.
  if (dirname(dir) === qaDir && (await exists(join(qaDir, 'config.yml'))) && (await exists(join(dir, 'config.yml'))))
    throw new Error(
      `either one profile at ${qaDir}, or named profiles in its subdirectories, not both; the job names ${ref.path}, and the root form at ${join(qaDir, 'config.yml')} cannot be read alongside it`,
    )
  return loadProfile(dir, shared)
}

function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false)
}

async function finishRun(
  job: Job,
  result: RunResult,
  rules: readonly RedactionRule[],
  values?: RunValues,
  execution: ExecutionKind = detectExecution(),
): Promise<{ result: RunResult }> {
  // The run records where and with which versions it executed (issue #91):
  // the same fact the evidence comment states, written before redaction so
  // the version set is part of the published result itself.
  // The wall clock (#51) rides the result: the caller names when the run
  // started, and the result names when it was written.
  const full: RunResult = redactResult(
    { ...result, job: { id: job.id }, environment: runEnvironment(execution), finishedAt: new Date().toISOString() },
    rules,
  )
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

/**
 * The run's check cache (#47). A criterion whose inputs have not moved — the
 * same checks as authored, the same plan, the same profile, the same base and
 * head revisions — replays the result the earlier run published instead of
 * re-running the checks, so a second run spends its time on what moved.
 */
interface RunCacheContext {
  cache: FileCheckCache
  baseSha: string
  headSha: string
  planHash: string
  profileHash: string
  /** The flake bound this run judged under (#50): a result proven under one bound is not the result of another. */
  flakeAttempts: number
  hits: Array<{ criterion: string; key: string }>
}

/**
 * Open the run's cache, or leave the run uncached. The key speaks in
 * revisions, not in refs, so the job's refs are resolved once here; a run
 * that cannot name what it checked out executes uncached rather than risking
 * a false hit, and says so on stderr where the driver can read it.
 */
async function openRunCache(job: Job, criteria: JobCriterion[], profile: QaProfile, cacheDir: string | undefined, flakeAttempts = 1): Promise<RunCacheContext | undefined> {
  if (cacheDir === undefined) return undefined
  const [baseSha, headSha] = await Promise.all([resolveRefSha(job.repoPath, job.baseRef), resolveRefSha(job.repoPath, job.headRef)])
  if (baseSha === undefined || headSha === undefined) {
    console.error(`caching skipped: ${job.repoPath} at ${JSON.stringify(baseSha === undefined ? job.baseRef : job.headRef)} could not be resolved to a revision, so the run executes uncached`)
    return undefined
  }
  return {
    cache: new FileCheckCache(cacheDir),
    baseSha,
    headSha,
    planHash: planFingerprint(criteria),
    profileHash: profileFingerprint(profile),
    flakeAttempts,
    hits: [],
  }
}

/**
 * The cache key of one criterion over the run's parts (#47).
 */
function cacheKeyFor(criterion: JobCriterion, checks: JobCheck[], cache: RunCacheContext): string {
  return criterionCacheKey({
    criterionId: criterion.id,
    checks,
    baseSha: cache.baseSha,
    headSha: cache.headSha,
    planHash: cache.planHash,
    profileHash: cache.profileHash,
  })
}

/**
 * Write the run's cache summary: every criterion that was served from the
 * cache, named by criterion and by key, so a reader can tell a replayed
 * criterion from a re-run one without diffing result.json. The hits of every
 * group of a several-app run are merged into this one summary.
 */
async function writeCacheHits(evidenceDir: string, hits: RunCacheContext['hits']): Promise<void> {
  if (hits.length === 0) return
  await mkdir(evidenceDir, { recursive: true })
  await writeFile(
    join(evidenceDir, 'cache.json'),
    `${JSON.stringify({ version: 1, hits }, null, 2)}\n`,
  )
}

async function runCriterion(
  criterion: JobCriterion,
  job: Job,
  rules: readonly RedactionRule[],
  values: RunValues,
  mail: MailContext,
  artefacts: Artefacts,
  flow: FlowContext,
  execution: ExecutionKind,
  cache: RunCacheContext | undefined,
  policy: FlakePolicy,
  commands: Record<string, ProfileCommand> | undefined,
): Promise<CriterionResult> {
  const checks = criterion.checks ?? []
  if (checks.length === 0)
    return {
      id: criterion.id,
      outcome: 'unverified',
      reason: criterion.unrunnable ?? NO_CHECKS_REASON,
    }

  // A criterion one of whose checks is quarantined never runs (#50): a
  // quarantined check cannot decide, so the criterion reports unverified
  // with the record the store carries, and no check of it runs at all. The
  // cache from an earlier run is not replayed either: whatever it once
  // published, the quarantined check decides this run, and quarantine
  // never turns a criterion green.
  const held = checks
    .map((check, index) => ({ index, record: quarantinedRecord(policy.quarantine, checkFingerprint(criterion.id, check)) }))
    .filter((hit): hit is { index: number; record: QuarantineRecord } => hit.record !== undefined)
  if (held.length > 0) {
    const evidence: string[] = []
    let reason: string | undefined
    for (const { index, record } of held) {
      const checkDir = join('checks', criterion.id, String(index))
      await mkdir(join(job.evidenceDir, checkDir), { recursive: true })
      await writeFile(join(job.evidenceDir, checkDir, 'quarantined.json'), `${JSON.stringify(record, null, 2)}\n`)
      evidence.push(`${checkDir}/quarantined.json`)
      if (reason === undefined) reason = `quarantined (${record.quarantinedAt}): ${record.reason}`
    }
    return { id: criterion.id, outcome: 'unverified', reason: reason ?? 'quarantined', evidence }
  }

  // A criterion whose inputs have not moved replays the result the earlier
  // run published, whatever that result was (#47): the cache never re-judges
  // a stored outcome, it serves it back with the marker attached.
  if (cache !== undefined) {
    const replayed = await replayCriterion(criterion, checks, job, cache)
    if (replayed !== undefined) return replayed
  }

  const evidence: string[] = []
  // The repairs the flow checks proposed (#83), carried onto the criterion
  // result so the run's comment can name them.
  const criterionRepairs: RunRepairRecord[] = []
  let failed = false
  let unverifiedReason: string | undefined
  // An unstable fold is this run's transient judgment (#50): the quarantine
  // store decides what the next run does, so the cache must not pin the
  // unverified outcome past the record that caused it.
  let quarantinedHere = false
  // A visual check the base side saved no screenshots for is unverified this
  // run only (#143): the next run's base may boot, so the cache must not
  // serve this run's missing comparison back to it.
  let notCacheable = false
  // What the accessibility audits found, per check (#149): the counts the
  // result carries, and why an audit failed a check, which names the rule
  // and the element so the failure reads without opening the record.
  const a11yCounts = new Map<number, A11yCounts>()
  const failedReasons = new Map<number, string>()
  // The values a run publishes or consumes — a mail message's link, its
  // one-time code — are secrets like any other: they join the profile's
  // redaction rules for every piece of evidence written after them (#64).
  const sweepRules = [...rules]
  // Per-attempt evidence directories (#50): the first attempt writes the
  // plain directory, and each repeat writes its own, so the evidence shows
  // every attempt a check was given and never overwrites one with another.
  const dirFor = (index: number, attempt: number): string =>
    attempt === 0 ? join('checks', criterion.id, String(index)) : join('checks', criterion.id, `${index}-attempt${attempt + 1}`)
  for (const [index, check] of checks.entries()) {
    const substituted = substituteCheck(check, values)
    // A check whose attempts failed and then passed is unstable (#50): the run
    // records it in the quarantine store with a reason and a date, and this
    // criterion reports unverified. Quarantining never turns a criterion green.
    const quarantinedReason = (fold: { kind: 'unstable'; attempts: number }): string => {
      const record: QuarantineRecord = {
        check: redactText(quarantineCheckName(check, criterion.id, index), sweepRules),
        fingerprint: checkFingerprint(criterion.id, check),
        criterion: criterion.id,
        reason: `unstable: the check failed and passed across ${fold.attempts} attempts of this run`,
        quarantinedAt: new Date().toISOString(),
      }
      if (policy.quarantine !== undefined) addQuarantineRecord(policy.quarantine, record)
      return `quarantined (${record.quarantinedAt}): ${record.reason}`
    }
    const foldCriterion = (fold: AttemptFold): void => {
      if (fold.kind === 'failed') failed = true
      else if (fold.kind === 'unstable') {
        quarantinedHere = true
        if (unverifiedReason === undefined) unverifiedReason = quarantinedReason(fold)
      } else if (fold.kind === 'unverified' && unverifiedReason === undefined) unverifiedReason = fold.reason
    }
    if (substituted.kind === 'mail') {
      const fold = await settleCheck(async (attempt) => {
        const checkDir = dirFor(index, attempt)
        const outcome = await runMailCheck(
          substituted,
          mail.label,
          mail.readMail,
          substituted.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
        )
        if (outcome.status === 'unverified') return { status: 'unverified', reason: outcome.reason }
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
            return {
              status: 'unverified' as const,
              reason: `the message read by mail check ${substituted.name ?? substituted.address} carries no one-time code${
                substituted.code.pattern === undefined ? '' : ` matching ${JSON.stringify(substituted.code.pattern)}`
              }`,
            }
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
        return { status: 'passed' as const }
      }, policy.attempts)
      foldCriterion(fold)
      continue
    }
    if (substituted.kind === 'flow' || substituted.kind === 'a11y') {
      // A flow can read a mail check's one-time code or link the way a command
      // does, at run time and per run (#64). Resolution happens per attempt:
      // a single-use artefact is spent by the attempt that reads it, and the
      // artefact contract says a retry requires a fresh message, so the next
      // attempt reports the spent artefact unverified instead of reusing what
      // the first one consumed. An artefact that is gone skips the flow
      // unverified, and the flow never runs.
      const fold = await settleCheck(async (attempt) => {
        // An a11y check is a flow whose pages are audited (#149): the page it
        // names is the page it opens, resolved as a visual check's is, so
        // each side of a run audits its own app. A flow is audited when the
        // profile makes the audit standing; a suite runs a browser of its
        // own, which nothing here can audit.
        let authored = substituted.actions
        if (substituted.kind === 'a11y' && authored === undefined) {
          const page = visualPageUrl(substituted.url, flow.visual, values)
          if (!page.ok) return { status: 'unverified' as const, reason: page.reason.replace("the visual check's url", "the a11y check's url").replace('a visual check has no page to capture', 'an a11y check has no page to audit') }
          authored = [{ action: 'open', url: page.url }]
        }
        const audited = substituted.kind === 'a11y' || (flow.a11y.standing && substituted.actions !== undefined)
        const named = substituted.kind === 'a11y' ? { widths: substituted.widths, themes: substituted.themes } : {}
        const themes = named.themes ?? flow.a11y.defaults.themes
        const a11y: A11yRun | undefined = audited
          ? {
              context: flow.a11y,
              widths: named.widths ?? flow.a11y.defaults.widths,
              themes: themes.length === 0 ? [DEFAULT_A11Y_THEME] : themes,
              standing: substituted.kind === 'flow',
              criterionId: criterion.id,
              index,
            }
          : undefined
        const resolvedActions = resolveFlowArtefacts(authored ?? [], artefacts, criterion.id)
        if (!resolvedActions.ok) return { status: 'unverified' as const, reason: resolvedActions.reason }
        // The flow types what it read from mail: those values join the sweep.
        if (resolvedActions.values.length > 0) sweepRules.push(...valueRules(resolvedActions.values))
        const outcome = await runFlowCheckJob(
          substituted.kind === 'flow'
            ? { ...substituted, actions: resolvedActions.actions }
            : {
                kind: 'flow',
                ...(substituted.name === undefined ? {} : { name: substituted.name }),
                actions: resolvedActions.actions,
                ...(substituted.timeoutMs === undefined ? {} : { timeoutMs: substituted.timeoutMs }),
              },
          flow.suites,
          flow.session,
          flow.target,
          flow.totp,
          resolvedActions.values,
          resolvedActions.codes,
          values,
          job.repoPath,
          job.evidenceDir,
          dirFor(index, attempt),
          sweepRules,
          flow.masks,
          execution,
          flow.mcp,
          flow.tracesRoot,
          a11y,
        )
        evidence.push(...outcome.evidence)
        if (outcome.transient === true) notCacheable = true
        // Each attempt audits afresh: the counts are the last attempt's.
        if (outcome.a11y !== undefined) a11yCounts.set(index, outcome.a11y)
        if (outcome.status === 'failed' && outcome.reason !== undefined && outcome.a11yFailed === true)
          failedReasons.set(index, redactText(outcome.reason, sweepRules))
        else failedReasons.delete(index)
        // A repair is recorded with the criterion and check it happened in (#83),
        // so the comment can name it. Its free text is swept by the run's own
        // dynamic rules first — mail values and generated codes included —
        // because the result redaction later on only knows the profile's rules.
        if (outcome.repairs !== undefined)
          criterionRepairs.push(
            ...outcome.repairs.map((repair) => ({
              ...repair,
              check: redactText(substituted.name ?? `${criterion.id} check ${index}`, sweepRules),
              reference: redactText(repair.reference, sweepRules),
              ...(repair.repaired === undefined ? {} : { repaired: redactText(repair.repaired, sweepRules) }),
              ...(repair.refusedReason === undefined ? {} : { refusedReason: redactText(repair.refusedReason, sweepRules) }),
            })),
          )
        if (outcome.status === 'failed') return { status: 'failed' as const }
        // The flow's reason quotes what the action saw, and the flow types
        // what it read from mail: the dynamic sweep covers model- and
        // evidence-facing text alike, result.json included (#64).
        return {
          status: outcome.status,
          reason: outcome.reason === undefined ? undefined : redactText(outcome.reason, sweepRules),
        }
      }, policy.attempts)
      foldCriterion(fold)
      continue
    }
    if (substituted.kind === 'tool') {
      // A tool check talks to the host's MCP server, never to a model (#94):
      // the call, the result and the matcher verdicts are redacted evidence.
      const fold = await settleCheck(async (attempt) => {
        const outcome = await runToolCheckJob(substituted, flow.mcp, job.evidenceDir, dirFor(index, attempt), sweepRules)
        evidence.push(...outcome.evidence)
        if (outcome.status === 'failed') return { status: 'failed' as const }
        return {
          status: outcome.status,
          reason: outcome.reason === undefined ? undefined : redactText(outcome.reason, sweepRules),
        }
      }, policy.attempts)
      foldCriterion(fold)
      continue
    }
    if (substituted.kind === 'visual') {
      // A visual check captures through the screenshot seam and compares
      // with what the base side saved (#143). The outcome is decided in
      // code from the captures and the diffs, never by a model.
      const fold = await settleCheck(async (attempt) => {
        const page = visualPageUrl(substituted.url, flow.visual, values)
        if (!page.ok) return { status: 'unverified' as const, reason: page.reason }
        const checkDir = dirFor(index, attempt)
        const target = flow.target
        const outcome = await runVisualCheckJob({
          check: substituted,
          pageUrl: page.url,
          criterionId: criterion.id,
          index,
          evidenceDir: job.evidenceDir,
          checkDir,
          rules: sweepRules,
          context: flow.visual,
          defaultTimeoutMs: DEFAULT_CHECK_TIMEOUT_MS,
          ...(target === undefined
            ? {}
            : {
                recordOutbound: async (attempts: readonly EgressAttempt[]) => {
                  const undeclared = await recordOutbound(attempts, target, join(job.evidenceDir, checkDir), sweepRules)
                  target.undeclared.push(...undeclared)
                  return undeclared
                },
              }),
        })
        evidence.push(...outcome.evidence)
        if (outcome.transient === true) notCacheable = true
        if (outcome.status === 'failed') return { status: 'failed' as const }
        return { status: outcome.status, reason: outcome.reason === undefined ? undefined : redactText(outcome.reason, sweepRules) }
      }, policy.attempts)
      foldCriterion(fold)
      continue
    }
    // The shell-syntax rule judges the AUTHORED command, before artefact
    // values are substituted: a mail link like a URL with an ampersand is
    // data for the no-shell spawn, while an authored `&&` is a plan written
    // for a shell this runner does not provide (#64).
    const shellSyntax = unrunnableCommandReason(substituted.run)
    if (shellSyntax !== undefined) {
      if (unverifiedReason === undefined) unverifiedReason = shellSyntax
      continue
    }
    const fold = await settleCheck(async (attempt) => {
      // Artefact resolution happens per attempt (#64): the artefact is
      // observed during this run, not minted at plan time, and a single-use
      // artefact is spent by the attempt that reads it. The artefact contract
      // says a retry requires a fresh message, so the next attempt reports
      // the spent artefact unverified instead of reusing what the first one
      // consumed, and an artefact that is gone is never run.
      const resolved = resolveArtefactFields(substituted, artefacts, criterion.id)
      if (!resolved.ok) return { status: 'unverified' as const, reason: resolved.reason }
      const cwd = resolveCheckCwd(resolved.check.cwd, job.repoPath)
      if (cwd === undefined)
        return {
          status: 'unverified' as const,
          reason: `check cwd ${JSON.stringify(resolved.check.cwd ?? '')} escapes the repository path; refusing to run it`,
        }
      const timeoutMs = resolved.check.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS
      // A command that echoes what it consumed writes it to stdout: the value
      // is a secret like any other, so the check's evidence is swept with it (#64).
      if (resolved.consumed.length > 0) sweepRules.push(...valueRules(resolved.consumed.map((consumed) => consumed.artefact)))
      const checkDir = dirFor(index, attempt)
      const selection = resolveSelection(resolved.check, commands)
      const outcome = await runCommandCheck(resolved.check, cwd, timeoutMs, execution, selection)
      await mkdir(join(job.evidenceDir, checkDir), { recursive: true })
      await writeFile(join(job.evidenceDir, checkDir, 'stdout.txt'), redactText(truncationNote(outcome, 'stdout'), sweepRules))
      await writeFile(join(job.evidenceDir, checkDir, 'stderr.txt'), redactText(truncationNote(outcome, 'stderr'), sweepRules))
      if (outcome.selected !== undefined) {
        await writeFile(
          join(job.evidenceDir, checkDir, 'selected.txt'),
          outcome.selected.length === 0 ? '' : `${redactText(outcome.selected.join('\n'), sweepRules)}\n`,
        )
        evidence.push(`${checkDir}/selected.txt`)
      }
      evidence.push(`${checkDir}/stdout.txt`, `${checkDir}/stderr.txt`)
      // The command, its outcome and the exit code it closed with are evidence
      // like the streams are (#152): a check that passes silently (test -f,
      // grep -q) writes no output, and a verifier reading only empty streams
      // cannot tell that the harness ran and captured anything at all.
      const record = { command: resolved.check.run, outcome: outcome.status, ...(outcome.code === undefined ? {} : { exit_code: outcome.code }) }
      await writeFile(join(job.evidenceDir, checkDir, 'command.json'), `${JSON.stringify(redactValue(record, sweepRules), null, 2)}\n`)
      evidence.push(`${checkDir}/command.json`)
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
      if (outcome.status === 'failed') return { status: 'failed' as const }
      return { status: outcome.status, reason: outcome.reason }
    }, policy.attempts)
    foldCriterion(fold)
  }

  // The audits' counts, summed over the criterion's checks (#149). A
  // criterion nothing audited carries none.
  const audited: { a11y?: A11yCounts } = {}
  if (a11yCounts.size > 0) {
    const sum: A11yCounts = { new: 0, existing: 0, accepted: 0, reported: 0, uncompared: 0 }
    for (const counts of a11yCounts.values()) for (const key of Object.keys(sum) as Array<keyof A11yCounts>) sum[key] += counts[key]
    audited.a11y = sum
  }
  let composed: CriterionResult
  if (failed) {
    composed = {
      id: criterion.id,
      outcome: 'failed',
      evidence,
      ...(failedReasons.size === 0 ? {} : { reason: [...failedReasons.values()].join('; ') }),
      ...(criterionRepairs.length === 0 ? {} : { repairs: criterionRepairs }),
      ...audited,
    }
  } else if (unverifiedReason !== undefined) {
    composed = {
      id: criterion.id,
      outcome: 'unverified',
      reason: unverifiedReason,
      ...(criterionRepairs.length === 0 ? {} : { repairs: criterionRepairs }),
      ...audited,
    }
  } else if (criterion.skipped !== undefined) {
    // Everything that ran passed, but the plan asked for more than ran.
    composed = {
      id: criterion.id,
      outcome: 'unverified',
      reason: criterion.skipped,
      evidence,
      ...(criterionRepairs.length === 0 ? {} : { repairs: criterionRepairs }),
      ...audited,
    }
  } else {
    composed = { id: criterion.id, outcome: 'proven', evidence, ...(criterionRepairs.length === 0 ? {} : { repairs: criterionRepairs }), ...audited }
  }
  // What ran this time is what the cache stores (#47): the criterion's
  // published result and every evidence file it wrote, under a key over the
  // checks as authored and the revisions they ran against, with the flake
  // bound the result was proven under (#50). A partial run — a check that
  // never decided — still composes one of these outcomes, and the cache
  // stores that too: the composition already folded it in. An unstable
  // outcome is never stored: it is this run's transient judgment, the
  // quarantine store already decides what the next run does, and a replay
  // of it would outlive the record that caused it.
  if (cache !== undefined && !quarantinedHere && !notCacheable) {
    await cache.cache.put(cacheKeyFor(criterion, checks, cache), {
      version: 1,
      criterion: criterion.id,
      result: composed as unknown as Record<string, unknown>,
      files: await collectCriterionFiles(job.evidenceDir, criterion.id),
      flakeAttempts: cache.flakeAttempts,
    })
  }
  return composed
}

/**
 * Serve one criterion from the run's cache (#47). The key is over the checks
 * as the plan authored them — not as the run substituted them, so a minted
 * run value can never collide two runs — plus the plan and profile hashes and
 * both revisions the run resolved to. A hit writes the stored evidence files
 * back into this run's evidence directory, so the published evidence is what
 * the original run published, and the result is the stored one with the cache
 * marker attached. A miss returns undefined and the checks run for real.
 */
async function replayCriterion(
  criterion: JobCriterion,
  checks: JobCheck[],
  job: Job,
  cache: RunCacheContext,
): Promise<CriterionResult | undefined> {
  const key = cacheKeyFor(criterion, checks, cache)
  const entry = await cache.cache.get(key)
  if (entry === undefined || entry.criterion !== criterion.id) return undefined
  // A result is only served to a run that judged under the same flake bound
  // (#50): a failure or a pass proven with one attempts left is not the
  // result of a run that gave the checks another, so it re-runs for real.
  if ((entry.flakeAttempts ?? 1) !== cache.flakeAttempts) return undefined
  for (const file of entry.files) {
    const target = join(job.evidenceDir, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.content, file.encoding)
  }
  cache.hits.push({ criterion: criterion.id, key })
  const stored = entry.result as unknown as CriterionResult
  return { ...stored, id: criterion.id, cached: true }
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
  if (check.kind === 'visual') return check.url === undefined ? check : { ...check, url: substituteValues(check.url, values) }
  if (check.kind === 'a11y')
    return {
      ...check,
      ...(check.url === undefined ? {} : { url: substituteValues(check.url, values) }),
      ...(check.actions === undefined ? {} : { actions: check.actions.map((action) => mapFlowStrings(action, (value) => substituteValues(value, values))) }),
    }
  if (check.kind === 'tool') {
    // A tool check's strings — argument values and matcher text alike — may
    // name run values, exactly as a command's do (#94).
    return {
      ...check,
      ...(check.args === undefined
        ? {}
        : { args: Object.fromEntries(Object.entries(check.args).map(([key, value]) => [key, substituteValues(value, values)])) }),
      assert: check.assert.map((assertion) => ({
        ...assertion,
        ...(assertion.contains === undefined ? {} : { contains: substituteValues(assertion.contains, values) }),
        ...(assertion.matches === undefined ? {} : { matches: substituteValues(assertion.matches, values) }),
        ...(typeof assertion.equals === 'string' ? { equals: substituteValues(assertion.equals, values) } : {}),
      })),
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

/** What auditing one flow takes (#149): the side's context, the widths and themes, and where the check sits. */
interface A11yRun {
  context: A11yContext
  widths: readonly number[]
  themes: readonly string[]
  /** The profile made the audit standing; no plan asked for it. */
  standing: boolean
  criterionId: string
  index: number
}

interface FlowJobOutcome {
  status: 'passed' | 'failed' | 'unverified'
  reason?: string
  evidence: string[]
  repairs?: FlowRepairRecord[]
  /** What the flow's audits counted, when it was audited (#149). */
  a11y?: A11yCounts
  /** The flow itself passed, and the audit is what failed the check. */
  a11yFailed?: true
  /** The outcome is this run's only: the base had no audit to compare with. */
  transient?: true
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
  mailArtefacts: string[],
  mailCodes: string[],
  values: RunValues,
  repoPath: string,
  evidenceDir: string,
  checkDir: string,
  rules: readonly RedactionRule[],
  masks: string[],
  execution: ExecutionKind,
  mcp?: ProfileMcpServer[],
  tracesRoot?: string,
  a11y?: A11yRun,
): Promise<FlowJobOutcome> {
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
    const outcome = await runSuiteCheck({ name: suite.name, command }, { cwd: repoPath, timeoutMs: check.timeoutMs, execution })
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
  // When the profile maps an MCP driver, the run drives the host's own tools
  // by default; an injected session still wins, so tests and callers keep
  // their seam (#94).
  const factory =
    session ?? (mcpDriverServer(mcp) !== undefined ? makeMcpFlowSession(mcpDriverServer(mcp)!, join(evidenceDir, checkDir), rules) : makePlaywrightFlowSession)
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
    // Every artefact the flow lays on the page, generated or read from mail,
    // is swept from the action log at write time (#64). Screenshots are
    // withheld while a CODE is on the page: a mail link is not a secret, a
    // one-time value is (#64).
    const generatedCodes: string[] = [...mailArtefacts]
    const work = runFlowCheck({
      actions: target === undefined ? check.actions ?? [] : (check.actions ?? []).map((action) => onTarget(action, target.url)),
      page: started.page,
      trace: started.trace,
      outDir: join(evidenceDir, checkDir),
      tracesDir: join(tracesRoot ?? resolve(evidenceDir, '..', 'traces'), checkDir),
      redactLog: (text) => {
        let out = redactText(text, rules)
        for (const code of generatedCodes) out = out.split(code).join(REDACTED)
        return out
      },
      masks,
      totp,
      generatedCodes,
      codesOnPage: mailCodes.length > 0,
      ...(a11y === undefined ? {} : { a11y: { tags: a11y.context.config.tags, widths: a11y.widths, themes: a11y.themes } }),
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
    // The audits the flow made are settled into an outcome and a record
    // (#149), in code. A flow that timed out hands back no audits, and the
    // timeout is then what the check reports.
    let settled: Awaited<ReturnType<typeof settleA11y>> | undefined
    if (a11y !== undefined && outcome?.a11y !== undefined) {
      settled = await settleA11y({
        check: { ...(check.name === undefined ? {} : { name: check.name }), standing: a11y.standing },
        audited: outcome.a11y,
        context: a11y.context,
        criterionId: a11y.criterionId,
        index: a11y.index,
        evidenceDir,
        checkDir,
        // The codes the flow put on the page are swept from the record too.
        rules: [...rules, ...valueRules(generatedCodes)],
      })
      evidence.push(...settled.evidence)
    }
    const audited = settled === undefined ? {} : { a11y: settled.counts }
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
          ...(outcome?.repairs === undefined ? {} : { repairs: outcome.repairs }),
          ...audited,
        }
      }
    }
    if (outcome === undefined) return { status: 'unverified', reason: stopped ?? 'the flow stopped without an outcome', evidence }
    if (outcome.outcome === 'unverified')
      return {
        status: 'unverified',
        reason: outcome.reason,
        evidence,
        ...(outcome.repairs === undefined ? {} : { repairs: outcome.repairs }),
        ...audited,
      }
    // The flow decides first: a failed assert is the check's failure whatever
    // the audits found. A flow that passed takes the audit's outcome (#149).
    if (outcome.outcome === 'passed' && settled !== undefined && settled.status !== 'passed')
      return {
        status: settled.status,
        ...(settled.reason === undefined ? {} : { reason: settled.reason }),
        ...(outcome.repairs === undefined ? {} : { repairs: outcome.repairs }),
        evidence,
        ...audited,
        ...(settled.status === 'failed' ? { a11yFailed: true as const } : {}),
        ...(settled.transient === true ? { transient: true as const } : {}),
      }
    return {
      status: outcome.outcome,
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      ...(outcome.repairs === undefined ? {} : { repairs: outcome.repairs }),
      evidence,
      ...audited,
    }
  } finally {
    await started.dispose()
  }
}

/**
 * A flow session over the host's own tools (#94): every action becomes the
 * mapped tool call, and every call and its result land in the check's
 * `tool-calls.json`, redacted before anything is written. There is no trace
 * to zip: the call log is the trace.
 */
function makeMcpFlowSession(mcp: ProfileMcpServer, dir: string, rules: readonly RedactionRule[]): FlowSessionFactory {
  return async () => {
    const session = await connectMcpDriver(mcp, {
      redact: (value) => redactValue(value, rules),
      record: async (calls) => {
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, 'tool-calls.json'), `${JSON.stringify(calls, null, 2)}\n`)
      },
    })
    return {
      capabilities: session.capabilities,
      page: session.page,
      // No trace: the call log is the trace, so the session names no file the
      // run would otherwise record and never write.
      dispose: session.dispose,
    }
  }
}

/**
 * Execute one tool check (#94): call a host tool through the profile's MCP
 * server and judge its result only on the matchers the plan named, never a
 * model. The call and its result are recorded redacted in `tool.json`;
 * anything that is not the criterion's fault — no server at all, a tool that
 * will not answer, a call outliving its timeout — is unverified, not failed.
 */
async function runToolCheckJob(
  check: JobToolCheck,
  mcp: ProfileMcpServer[] | undefined,
  evidenceDir: string,
  checkDir: string,
  rules: readonly RedactionRule[],
): Promise<{ status: 'passed' | 'failed' | 'unverified'; reason?: string; evidence: string[] }> {
  if (mcp === undefined)
    return { status: 'unverified', reason: 'the profile registers no MCP server, so a tool check has nothing to call', evidence: [] }
  // The check calls a tool on one server's allowlist: the first entry that
  // names it and may run in the execute step. A tool two entries allowlist is
  // reached on the first.
  const entry = mcp.find((one) => one.steps.includes('execute') && one.tools.includes(check.tool))
  if (entry === undefined)
    return {
      status: 'unverified',
      reason: `no MCP server that may run in the execute step allowlists ${JSON.stringify(check.tool)}`,
      evidence: [],
    }
  const timeoutMs = check.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS
  let result: McpToolResult | undefined
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      (async () => {
        const source = await connectMcpServer(entry, { callTimeoutMs: timeoutMs })
        try {
          result = await source.callResult(check.tool, check.args ?? {})
        } finally {
          await source.close()
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the tool call exceeded its ${timeoutMs} ms timeout`)), timeoutMs)
        timer.unref()
      }),
    ])
  } catch (error) {
    const cause = (error as Error & { cause?: Error }).cause
    return {
      status: 'unverified',
      reason: `the tool ${JSON.stringify(check.tool)} did not answer: ${cause ?? (error as Error).message}`,
      evidence: [],
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  if (result === undefined) return { status: 'unverified', reason: 'the tool call never finished', evidence: [] }
  const failures = evaluateToolAssertions(check.assert, result)
  const passed = !result.isError && failures.length === 0
  const reason = result.isError
    ? `the tool ${JSON.stringify(check.tool)} reported an error: ${result.text}`
    : failures.length > 0
      ? `the tool result failed ${failures.length} assertion(s): ${failures.join('; ')}`
      : undefined
  const dir = join(evidenceDir, checkDir)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'tool.json'),
    `${JSON.stringify(
      redactValue(
        {
          tool: check.tool,
          ...(check.args === undefined ? {} : { args: check.args }),
          result: {
            text: result.text,
            isError: result.isError,
            ...(result.structured === undefined ? {} : { structured: result.structured }),
          },
          assertions: failures,
          outcome: passed ? 'passed' : 'failed',
        },
        rules,
      ),
      null,
      2,
    )}\n`,
  )
  return { status: passed ? 'passed' : 'failed', ...(reason === undefined ? {} : { reason }), evidence: [`${checkDir}/tool.json`] }
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
    case 'choose':
      return { ...action, value: map(action.value, 'value') }
    case 'assertText':
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
  // Every reference is resolved before any one is spent: a failure on a
  // later reference must not burn earlier single-use values (#64).
  for (const name of names) {
    // The reference names the mail check between the `mail.` namespace and the
    // artefact field: {{mail.<name>.link}} reads from the mail check <name>.
    // Plan time refuses anything else, so a shape that reaches this point is
    // the run's own bug, and a literal left in a command is not an option.
    const [namespace, checkName, field] = name.split('.')
    if (namespace !== 'mail' || checkName === undefined || (field !== 'link' && field !== 'code') || name.split('.').length !== 3) {
      return { ok: false, reason: `malformed artefact reference {{${name}}}; a reference is {{mail.<name>.link}} or {{mail.<name>.code}}` }
    }
  }
  for (const name of names) {
    const [, checkName, field] = name.split('.') as [string, string, ArtefactField]
    const outcome = artefacts.peek(checkName, field)
    if (!outcome.ok) return outcome
    resolved.set(name, outcome.artefact)
    consumed.push({ source: `mail.${checkName}`, artefact: outcome.artefact })
  }
  for (const name of names) {
    const [, checkName, field] = name.split('.') as [string, string, ArtefactField]
    artefacts.spend(checkName, field, consumer)
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
): { ok: true; actions: FlowActionStep[]; values: string[]; codes: string[] } | { ok: false; reason: string } {
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
  const codes: string[] = []
  // The shape of every reference first, then every reference resolved before
  // any one is spent: a failure on a later reference must not burn earlier
  // single-use values (#64).
  for (const name of names) {
    const [namespace, checkName, field] = name.split('.')
    if (namespace !== 'mail' || checkName === undefined || (field !== 'link' && field !== 'code') || name.split('.').length !== 3) {
      return { ok: false, reason: `malformed artefact reference {{${name}}}; a reference is {{mail.<name>.link}} or {{mail.<name>.code}}` }
    }
  }
  for (const name of names) {
    const [, checkName, field] = name.split('.') as [string, string, ArtefactField]
    const outcome = artefacts.peek(checkName, field)
    if (!outcome.ok) return outcome
    resolved.set(name, outcome.artefact)
    values.push(outcome.artefact)
    if (field === 'code') codes.push(outcome.artefact)
  }
  for (const name of names) {
    const [, checkName, field] = name.split('.') as [string, string, ArtefactField]
    artefacts.spend(checkName, field, consumer)
  }
  const substitute = (text: string): string =>
    [...resolved.entries()].reduce((acc, [name, artefact]) => acc.split(`{{${name}}}`).join(artefact), text)
  return { ok: true, actions: actions.map((action) => mapFlowStrings(action, (value) => substitute(value))), values, codes }
}

interface CheckOutcome {
  status: 'passed' | 'failed' | 'unverified'
  reason?: string
  stdout: string
  stderr: string
  stdoutTruncated?: boolean
  stderrTruncated?: boolean
  code?: number
  selected?: string[]
}

/** The selection a declared test command carries (#157): which placeholder is
 * the filter, and the machine-readable format the command's report is read
 * from. Present only when the profile declares both. */
interface Selection {
  filter: string
  report: ReportFormat
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
 * Command checks are split on whitespace and spawned without a shell, so a
 * character with shell meaning cannot reach the intent it was written with
 * (#64): the command would run with it as a literal token and fail for a
 * reason that has nothing to do with the criterion. Named here, unverified,
 * rather than failed: a check that cannot run disproves nothing.
 */
/**
 * The runner's shell-syntax judgment, shared with plan-time validation (#136).
 * It lives in duration.ts, a module with no imports, so the profile's command
 * validation (#93) reads the same class without a cycle through this module.
 */
export { shellCharacter } from './duration.js'
function unrunnableCommandReason(run: string): string | undefined {
  const character = shellCharacter(run)
  if (character === undefined) return undefined
  return `the planned command cannot run: command checks are split on whitespace and spawned without a shell, so ${JSON.stringify(character)} is not interpreted`
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

/**
 * The environment a command step runs under. A check that carries `env` always
 * opts into the minimal deterministic environment (PATH, HOME and its own
 * entries). On a containerised run a check without `env` inherits the harness
 * environment unchanged, which the image controls. On a host nothing controls
 * it, so the minimal deterministic environment is the rule for every command
 * step there (#91): pull request code never inherits a host's tokens.
 */
function checkEnvironment(env: JobCommandCheck['env'], execution: ExecutionKind | undefined): NodeJS.ProcessEnv | undefined {
  if (execution !== 'native' && env === undefined) return undefined
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '',
    ...(env ?? {}),
  }
}

/**
 * The selection a check verifies with: the filter value the plan filled into
 * the declared command's filter placeholder, and the report format the
 * profile declared for reading it (#157). The check's run is matched against
 * every declared command's run shape - same tokens, placeholders taking the
 * filled values - and one match resolves it. None or several leave the check
 * a plain command, and the verifier's exercise rule still applies to it.
 */
function resolveSelection(
  check: JobCommandCheck,
  commands: Record<string, ProfileCommand> | undefined,
): Selection | undefined {
  if (commands === undefined) return undefined
  const tokens = check.run.split(/\s+/).filter((token) => token !== '')
  const matches = Object.values(commands).filter((command) => {
    if (command.filter === undefined || command.report === undefined) return false
    const template = command.run.split(/\s+/).filter((token) => token !== '')
    if (template.length !== tokens.length) return false
    return template.every((token, index) => tokenFillsTemplate(token, tokens[index]))
  })
  if (matches.length !== 1) return undefined
  const declared = matches[0]
  if (declared === undefined || declared.filter === undefined || declared.report === undefined) return undefined
  const template = declared.run.split(/\s+/).filter((token) => token !== '')
  const position = template.findIndex((token) => token.includes(`{{${declared.filter}}}`))
  if (position < 0) return undefined
  const templateToken = template[position]
  if (templateToken === undefined) return undefined
  const filter = placeholderValue(templateToken, tokens[position])
  if (filter === undefined) return undefined
  return { filter, report: declared.report }
}

/**
 * Whether a template token matches the token the plan filled in. `{{name}}`
 * takes the whole token; a placeholder embedded in a token, such as
 * `--testNamePattern={{name}}`, matches the token whose constants agree; a
 * constant must be equal.
 */
export function tokenFillsTemplate(template: string, filled: string | undefined): boolean {
  if (filled === undefined) return false
  if (template.startsWith('{{') && template.endsWith('}}')) return true
  const embedded = /\{\{[^{}]+\}\}/.exec(template)
  if (embedded === null) return template === filled
  const prefix = template.slice(0, embedded.index)
  const suffix = template.slice(embedded.index + embedded[0].length)
  return filled.startsWith(prefix) && filled.endsWith(suffix) && filled.length >= prefix.length + suffix.length
}

/**
 * The value a placeholder of a template token takes: the whole filled token
 * for a whole-token placeholder, the text around the constants for one
 * embedded in a token.
 */
export function placeholderValue(template: string, filled: string | undefined): string | undefined {
  if (filled === undefined) return undefined
  if (template.startsWith('{{') && template.endsWith('}}')) return filled
  const embedded = /\{\{[^{}]+\}\}/.exec(template)
  if (embedded === null) return undefined
  const prefix = template.slice(0, embedded.index)
  const suffix = template.slice(embedded.index + embedded[0].length)
  if (!filled.startsWith(prefix) || !filled.endsWith(suffix)) return undefined
  return filled.slice(prefix.length, filled.length - suffix.length)
}

function testNames(report: ReportFormat, stdout: string): string[] | undefined {
  if (report === 'vitest-json') {
    try {
      const parsed: unknown = JSON.parse(stdout)
      if (typeof parsed !== 'object' || parsed === null) return undefined
      const testResults = (parsed as { testResults?: unknown }).testResults
      if (!Array.isArray(testResults)) return undefined
      const names: string[] = []
      for (const entry of testResults) {
        const assertionResults = (entry as { assertionResults?: unknown }).assertionResults
        if (!Array.isArray(assertionResults)) return undefined
        for (const assertion of assertionResults) {
          const status = (assertion as { status?: unknown }).status
          if (status === 'skipped' || status === 'todo') continue
          const name = (assertion as { fullName?: unknown }).fullName
          if (typeof name !== 'string') return undefined
          names.push(name)
        }
      }
      return names
    } catch {
      return undefined
    }
  }
  if (report === 'junit-xml') {
    const names: string[] = []
    for (const part of stdout.split(/(?=<testcase\b)/).slice(1)) {
      const name = /<testcase\b[^>]*\bname="([^"]*)"/.exec(part)?.[1]
      if (name === undefined) continue
      if (part.includes('<skipped')) continue
      names.push(name)
    }
    return names
  }
  const names: string[] = []
  for (const line of stdout.split('\n')) {
    const tap = /^(?:ok|not ok) \d+ (?:- )?(.+)$/.exec(line.trim())
    if (tap === null || tap[1] === undefined) continue
    if (/\#\s*skip/i.test(tap[1])) continue
    names.push(tap[1].split(' #')[0]?.trim() ?? '')
  }
  return names
}

function selectionVerdict(
  selection: Selection,
  stdout: string,
): { status: 'passed'; selected: string[] } | { status: 'unverified'; reason: string; selected?: string[] } {
  const names = testNames(selection.report, stdout)
  if (names === undefined)
    return {
      status: 'unverified',
      reason: `the check's report could not be read as ${selection.report}, so the filter's selection is unknown`,
    }
  let matchesName: (name: string) => boolean
  try {
    const pattern = new RegExp(selection.filter)
    matchesName = (name) => pattern.test(name)
  } catch {
    matchesName = (name) => name.includes(selection.filter)
  }
  const selected = names.filter((name) => matchesName(name))
  if (selected.length === 0)
    return {
      status: 'unverified',
      reason: `the filter ${selection.filter} selected none of the ${names.length} tests the command ran, so nothing it names was exercised`,
      selected: [],
    }
  if (selected.length === names.length)
    return {
      status: 'unverified',
      reason: `the filter ${selection.filter} selected all ${names.length} tests: a whole-suite run does not prove a filtered criterion`,
      selected,
    }
  return { status: 'passed', selected }
}

export function runCommandCheck(
  check: JobCommandCheck,
  cwd: string,
  timeoutMs: number,
  execution?: ExecutionKind,
  selection?: Selection,
): Promise<CheckOutcome> {
  const env = checkEnvironment(check.env, execution)
  return new Promise((resolve) => {
    const tokens = check.run.split(/\s+/).filter((token) => token !== '')
    // detached puts the check in its own process group so a group-wide kill also
    // reaches grandchildren that inherited the stdio pipes.
    const child = spawn(tokens[0] ?? '', tokens.slice(1), {
      cwd,
      ...(env === undefined ? {} : { env }),
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
      // A spawn failure is a binary the plan named that this host does not
      // have: nothing ran, so nothing about the change was tested, and the
      // reason names the same planning gap the shell guard does (#64).
      settle({ status: 'unverified', reason: `the planned command cannot run: ${String(error)}`, stdout, stderr })
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
      else if (code === 0) {
        if (selection === undefined)
          settle({ status: 'passed', code, stdout, stderr, stdoutTruncated, stderrTruncated })
        else {
          const verdict = selectionVerdict(selection, stdout)
          settle({
            code,
            stdout,
            stderr,
            stdoutTruncated,
            stderrTruncated,
            ...verdict,
          })
        }
      } else
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
