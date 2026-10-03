import type { A11yCounts } from './a11y.js'
import { ADVISORY_CATEGORIES, ADVISORY_SEVERITIES, type AdvisoryFinding, type RunAdvisory } from './advisory.js'
import type { RunEnvironment, RunImage } from './environment.js'
import { parseProfileRef, type JobProfileRef } from './job.js'
import type { MailProof } from './mailbox.js'
import type { ModelUsage } from './metrics.js'
import { isUnsafeProfileName } from './profile.js'

export const RESULT_SCHEMA_VERSION = '1'

export type CriterionOutcome = 'proven' | 'failed' | 'unverified'

export type RunVerdict = 'passed' | 'failed' | 'blocked' | 'refused' | 'waived'

/**
 * What the base side showed for one criterion (#147): the same checks, run
 * against the app booted from the base revision. `proven` and `failed` are
 * what the executed checks decided there. `not-compared` is everything else,
 * with the reason named: a base that did not boot, a check that could not
 * run there, a criterion the profile's limits left out. Not compared is
 * never passed, and never a regression.
 */
export interface CriterionBase {
  outcome: 'proven' | 'failed' | 'not-compared'
  /** Why nothing is compared; carried exactly when the outcome is `not-compared`. */
  reason?: string
  /** The evidence the base side saved for it, under `base/`. */
  evidence?: string[]
}

/**
 * The comparison a two-sided run records on a criterion (#147). `regression`
 * is decided in code from the executed outcomes of both sides: true when the
 * base proved the criterion and the head failed it, false when it failed at
 * the base too (behaviour that does not work yet), and absent when nothing
 * was compared.
 */
interface CriterionComparison {
  base?: CriterionBase
  regression?: boolean
  /**
   * What the accessibility audits of this criterion's checks counted (#149):
   * violations new at the head, ones the base already had, ones the profile
   * accepts, ones reported below the failing impacts, and ones nothing could
   * be compared with. Absent when nothing was audited.
   */
  a11y?: A11yCounts
  /**
   * The messages this criterion's mail checks read (#65): sender, subject, an
   * excerpt and its links, swept of addresses and codes. Harness-produced
   * data, never a model's claim. Absent when no mail check read a message.
   */
  mail?: MailProof[]
}

export interface ProvenCriterionResult extends CriterionComparison {
  id: string
  outcome: 'proven'
  evidence: string[]
  /** Locator repairs recorded while checking this criterion (#83). */
  repairs?: RunRepairRecord[]
  /** The result came from the run's cache, because nothing the check reads had moved (#47). */
  cached?: true
}

export interface FailedCriterionResult extends CriterionComparison {
  id: string
  outcome: 'failed'
  evidence: string[]
  /** Why, when something other than the check itself decided it failed (the verifier). */
  reason?: string
  /** Locator repairs recorded while checking this criterion (#83). */
  repairs?: RunRepairRecord[]
  /** The result came from the run's cache, because nothing the check reads had moved (#47). */
  cached?: true
}

export interface UnverifiedCriterionResult extends CriterionComparison {
  id: string
  outcome: 'unverified'
  reason: string
  evidence?: string[]
  /** Locator repairs recorded while checking this criterion (#83). */
  repairs?: RunRepairRecord[]
  /** The result came from the run's cache, because nothing the check reads had moved (#47). */
  cached?: true
}

export type CriterionResult = ProvenCriterionResult | FailedCriterionResult | UnverifiedCriterionResult

/**
 * One locator repair a run recorded (#83), named for the flow check and
 * action it happened in: the reference as the plan carried it, the reference
 * it was repaired to (or the reason a repair was refused), and the identity
 * comparison that decided it. A repair never names an assertion: an
 * assertion that fails is the check's own outcome, never a repair.
 */
export interface RunRepairRecord {
  check: string
  action: number
  reference: string
  repaired?: string
  identity: string
  status: 'applied' | 'refused'
  refusedReason?: string
}

/**
 * A run against an app qare did not boot (#122). There is only the one side,
 * so `comparison` is always `none`: nothing ran at a base revision, and no
 * regression was looked for.
 */
export interface RunTarget {
  url: string
  comparison: 'none'
}

/**
 * The build a run launched and drove through a client driver (#72): which
 * driver, and the executable as the profile names it. Like a target it has
 * one side, so `comparison` is `none`: nothing ran at a base revision.
 */
export interface RunClient {
  driver: string
  executable: string
  comparison: 'none'
}

/**
 * The base side of a two-sided run (#147): the ref the job named as "before",
 * and whether the plan executed there. A base that did not execute (no
 * checkout, no profile, a boot that never came up) names why, and every
 * criterion of the run is then `not-compared`.
 */
export interface RunBase {
  ref: string
  status: 'executed' | 'not-executed'
  reason?: string
}

export interface RunResult {
  schemaVersion: string
  verdict: RunVerdict
  criteria: CriterionResult[]
  job?: { id: string }
  waived?: Array<{ criterionId: string; by: string }>
  target?: RunTarget
  /** The build the run launched, when its profile names a client (#72). */
  client?: RunClient
  /** The base side this run compared the head against (#147); absent on a one-sided run. */
  base?: RunBase
  /** Where and with which versions this run executed (issue #91). */
  environment?: RunEnvironment
  /**
   * The profiles a several-profile run checked, in the order the job named
   * them (#55): one verdict per app, and the criterion ids that belong to it,
   * so a reader can see what each app was asked and which app a criterion
   * checked. Each entry carries the profile reference the job checked — the
   * inline profile itself, or the path under the .qa root — because judge and
   * redact re-read the rules from the result and the .qa artifact alone.
   * Absent when the run checked one profile.
   */
  profiles?: Array<{ name: string; verdict: RunVerdict; criteria: string[]; profile?: JobProfileRef }>
  /**
   * The run's wall clock (#51): when the run started and when its result was
   * written, as ISO 8601 timestamps. Absent on results written before the
   * fields existed, which still load and judge the same.
   */
  startedAt?: string
  finishedAt?: string
  /**
   * What the verifier model spent judging this run (#51), when a model judged
   * it. The planning model's spend rides the plan; the metrics record joins
   * the two with the run's wall clock and verdict.
   */
  judgeUsage?: ModelUsage
  /**
   * What the advisory UX review reported (#150): a model's findings for a
   * person to read. It is a key of its own because it is no part of the
   * verdict: nothing that computes an outcome or a verdict reads it.
   */
  advisory?: RunAdvisory
}

const CRITERION_OUTCOMES: CriterionOutcome[] = ['proven', 'failed', 'unverified']
export const RUN_VERDICTS: readonly RunVerdict[] = ['passed', 'failed', 'blocked', 'refused', 'waived']

export class ResultValidationError extends Error {
  readonly field: string

  constructor(field: string, message: string) {
    super(`${field}: ${message}`)
    this.name = 'ResultValidationError'
    this.field = field
  }
}

function fail(field: string, message: string): never {
  throw new ResultValidationError(field, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown, field: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    fail(field, `${label} must be a non-empty string`)
  return value
}

function assertRelativePath(path: string, field: string): void {
  if (
    path.startsWith('/') ||
    path.startsWith('\\') ||
    path.startsWith('//') ||
    /^[a-zA-Z]:[\\/]/.test(path)
  )
    fail(field, `evidence reference "${path}" must be a relative path`)
  if (path.split(/[\\/]/).includes('..'))
    fail(field, `evidence reference "${path}" must stay inside the evidence directory (".." is not allowed)`)
}

function relativePathArray(value: unknown, field: string, label: string): string[] {
  if (!Array.isArray(value)) fail(field, `${label} must be an array of relative paths`)
  return value.map((entry, index) => {
    const path = nonEmptyString(entry, `${field}[${index}]`, `${label} entry`)
    assertRelativePath(path, `${field}[${index}]`)
    return path
  })
}

export function loadResult(text: string): RunResult {
  let input: unknown
  try {
    input = JSON.parse(text)
  } catch (error) {
    throw new ResultValidationError(
      'json',
      `result.json is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  return parseResult(input)
}

export function parseResult(input: unknown): RunResult {
  if (!isRecord(input)) fail('result', 'result.json must be a JSON object')

  const { schemaVersion } = input
  if (typeof schemaVersion !== 'string')
    fail('schemaVersion', `result.json must carry a schemaVersion string (this loader understands "${RESULT_SCHEMA_VERSION}")`)
  if (schemaVersion !== RESULT_SCHEMA_VERSION)
    fail('schemaVersion', `unknown schemaVersion "${schemaVersion}" (this loader understands "${RESULT_SCHEMA_VERSION}")`)

  const verdict = input.verdict
  if (typeof verdict !== 'string' || !RUN_VERDICTS.includes(verdict as RunVerdict))
    fail('verdict', `unknown verdict ${JSON.stringify(verdict)} (expected "passed", "failed", "blocked", "refused" or "waived")`)

  if (!Array.isArray(input.criteria)) fail('criteria', 'result.json must carry a criteria array')

  const job = parseJobSummary(input.job)
  const waived = parseWaived(input.waived)
  const target = parseTarget(input.target)
  const client = parseClient(input.client)
  const base = parseRunBase(input.base)
  const environment = parseEnvironment(input.environment)
  const profiles = parseProfiles(input.profiles)
  const timestamps = parseTimestamps(input)
  const judgeUsage = parseModelUsage(input.judgeUsage, 'judgeUsage')
  const advisory = parseAdvisory(input.advisory)

  return {
    schemaVersion,
    verdict: verdict as RunVerdict,
    criteria: input.criteria.map((entry, index) => parseCriterionResult(entry, index)),
    ...(job === undefined ? {} : { job }),
    ...(waived === undefined ? {} : { waived }),
    ...(target === undefined ? {} : { target }),
    ...(client === undefined ? {} : { client }),
    ...(base === undefined ? {} : { base }),
    ...(environment === undefined ? {} : { environment }),
    ...(profiles === undefined ? {} : { profiles }),
    ...(timestamps === undefined ? {} : { startedAt: timestamps.startedAt, finishedAt: timestamps.finishedAt }),
    ...(judgeUsage === undefined ? {} : { judgeUsage }),
    ...(advisory === undefined ? {} : { advisory }),
  }
}

/**
 * The advisory key is optional (#150): a run nobody reviewed, and a result
 * written before the review existed, carry none. One that is there is read
 * field by field, so a finding holds exactly what a finding has: nothing in
 * it names an outcome, and its screenshot is a path inside the evidence.
 */
function parseAdvisory(value: unknown): RunAdvisory | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) fail('advisory', 'result.json advisory must be a JSON object with status, screens and findings')
  const status = value.status
  if (status !== 'reviewed' && status !== 'unavailable')
    fail('advisory.status', `unknown advisory status ${JSON.stringify(status)} (expected "reviewed" or "unavailable")`)
  if (status === 'unavailable' && value.reason === undefined) fail('advisory.reason', 'a review that was not made names why')
  const reason = value.reason === undefined ? undefined : nonEmptyString(value.reason, 'advisory.reason', 'reason')
  const screens = relativePathArray(value.screens, 'advisory.screens', 'advisory screens')
  if (!Array.isArray(value.findings)) fail('advisory.findings', 'advisory.findings must be an array of findings')
  const findings = value.findings.map((entry, index): AdvisoryFinding => {
    const base = `advisory.findings[${index}]`
    if (!isRecord(entry)) fail(base, 'an advisory finding must be a JSON object')
    const id = advisoryId(entry.id, `${base}.id`)
    const screen = nonEmptyString(entry.screen, `${base}.screen`, 'screen')
    assertRelativePath(screen, `${base}.screen`)
    const { category, severity } = entry
    if (typeof category !== 'string' || !(ADVISORY_CATEGORIES as readonly string[]).includes(category))
      fail(`${base}.category`, `unknown category ${JSON.stringify(category)} (expected one of ${ADVISORY_CATEGORIES.join(', ')})`)
    if (typeof severity !== 'string' || !(ADVISORY_SEVERITIES as readonly string[]).includes(severity))
      fail(`${base}.severity`, `unknown severity ${JSON.stringify(severity)} (expected one of ${ADVISORY_SEVERITIES.join(', ')})`)
    let screenshot: string | undefined
    if (entry.screenshot !== undefined) {
      screenshot = nonEmptyString(entry.screenshot, `${base}.screenshot`, 'screenshot')
      assertRelativePath(screenshot, `${base}.screenshot`)
    }
    return {
      id,
      screen,
      criterionId: nonEmptyString(entry.criterionId, `${base}.criterionId`, 'criterion id'),
      category: category as AdvisoryFinding['category'],
      severity: severity as AdvisoryFinding['severity'],
      saw: nonEmptyString(entry.saw, `${base}.saw`, 'what the reviewer saw'),
      why: nonEmptyString(entry.why, `${base}.why`, 'why it matters'),
      ...(entry.element === undefined ? {} : { element: nonEmptyString(entry.element, `${base}.element`, 'element') }),
      ...(screenshot === undefined ? {} : { screenshot }),
    }
  })
  let dismissed: string[] | undefined
  if (value.dismissed !== undefined) {
    if (!Array.isArray(value.dismissed)) fail('advisory.dismissed', 'advisory.dismissed must be an array of finding ids')
    dismissed = value.dismissed.map((entry, index) => advisoryId(entry, `advisory.dismissed[${index}]`))
  }
  const usage = parseModelUsage(value.usage, 'advisory.usage')
  return {
    status,
    ...(reason === undefined ? {} : { reason }),
    screens,
    findings,
    ...(dismissed === undefined ? {} : { dismissed }),
    ...(usage === undefined ? {} : { usage }),
  }
}

/** A finding's id is the eight hex characters its identity hashes to: what a person types back. */
function advisoryId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}$/.test(value)) fail(field, 'an advisory finding id is 8 lowercase hex characters')
  return value
}

/**
 * The wall clock is optional, so a result.json written before the fields
 * existed still loads (#51). Both fields travel together: a run that carries
 * one carries both, and a malformed pair is named, not guessed around.
 */
function parseTimestamps(input: Record<string, unknown>): { startedAt: string; finishedAt: string } | undefined {
  const { startedAt, finishedAt } = input
  if (startedAt === undefined && finishedAt === undefined) return undefined
  if (!isIsoTimestamp(startedAt) || !isIsoTimestamp(finishedAt))
    fail('startedAt', 'startedAt and finishedAt must both be ISO 8601 timestamps')
  return { startedAt: startedAt as string, finishedAt: finishedAt as string }
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) && !isNaN(new Date(value).getTime()) && value === new Date(value).toISOString()
}

function parseModelUsage(value: unknown, field: string): ModelUsage | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || typeof value.inputTokens !== 'number' || typeof value.outputTokens !== 'number')
    fail(field, `${field} must be a JSON object with inputTokens and outputTokens numbers`)
  requireCountable(`${field}.inputTokens`, value.inputTokens)
  requireCountable(`${field}.outputTokens`, value.outputTokens)
  return { inputTokens: value.inputTokens, outputTokens: value.outputTokens }
}

/** A token count is a count: finite, and at least zero as the schema says. */
function requireCountable(field: string, count: number): void {
  if (!Number.isFinite(count) || count < 0) fail(field, `${field} must be a number of at least 0, not ${JSON.stringify(count)}`)
}

/**
 * The execution environment is optional, so a result.json written before the
 * field existed still loads: an old artifact judges the same after an upgrade.
 */
function parseEnvironment(value: unknown): RunEnvironment | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) fail('environment', 'result.json environment must be a JSON object with execution and versions')
  const execution = value.execution
  if (execution !== 'native' && execution !== 'containerised')
    fail('environment.execution', `unknown execution ${JSON.stringify(execution)} (expected "native" or "containerised")`)
  if (!isRecord(value.versions)) fail('environment.versions', 'environment.versions must be a JSON object')
  return {
    execution,
    versions: {
      qare: nonEmptyString(value.versions.qare, 'environment.versions.qare', 'qare version'),
      node: nonEmptyString(value.versions.node, 'environment.versions.node', 'node version'),
      nareContract: typeof value.versions.nareContract === 'number'
        ? value.versions.nareContract
        : fail('environment.versions.nareContract', 'nare contract must be a number'),
    },
    ...(value.image === undefined ? {} : { image: parseRunImage(value.image) }),
  }
}

/** The image record is optional with the same backward-compatibility rule: a
 * result written before it existed still loads, and one written with it names
 * the image that produced the run (#88). */
function parseRunImage(value: unknown): RunImage {
  if (!isRecord(value)) fail('environment.image', 'environment.image must be a JSON object')
  const drivers: Record<string, string> = {}
  if (value.drivers !== undefined) {
    if (!isRecord(value.drivers))
      fail('environment.image.drivers', 'environment.image.drivers must be a JSON object of names to versions')
    for (const [key, entry] of Object.entries(value.drivers))
      drivers[key] = nonEmptyString(entry, 'environment.image.drivers', `driver ${key}`)
  }
  const versions = value.versions
  if (!isRecord(versions)) fail('environment.image.versions', 'environment.image.versions must be a JSON object')
  return {
    name: nonEmptyString(value.name, 'environment.image.name', 'image name'),
    ref: nonEmptyString(value.ref, 'environment.image.ref', 'image ref'),
    digest: nonEmptyString(value.digest, 'environment.image.digest', 'image digest'),
    ...(value.flavour === undefined ? {} : { flavour: nonEmptyString(value.flavour, 'environment.image.flavour', 'image flavour') }),
    ...(Object.keys(drivers).length === 0 ? {} : { drivers }),
    versions: {
      qare: nonEmptyString(versions.qare, 'environment.image.versions.qare', 'qare version'),
      nare: nonEmptyString(versions.nare, 'environment.image.versions.nare', 'nare version'),
      node: nonEmptyString(versions.node, 'environment.image.versions.node', 'node version'),
    },
  }
}

function parseProfiles(
  value: unknown,
): Array<{ name: string; verdict: RunVerdict; criteria: string[]; profile?: JobProfileRef }> | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value))
    fail('profiles', 'result.json profiles must be an array of { name, verdict, criteria, profile }')
  if (value.length === 0) fail('profiles', 'result.json profiles must not be empty when present')
  return value.map((entry, index) => {
    if (!isRecord(entry)) fail(`profiles[${index}]`, 'profile entry must be a JSON object')
    const name = nonEmptyString(entry.name, `profiles[${index}].name`, 'profile name')
    if (isUnsafeProfileName(name))
      fail(`profiles[${index}].name`, `profile name ${JSON.stringify(name)} must not contain path separators, ".." or control characters; judge and redact read every named profile from the .qa root the run publishes, so a crafted name cannot point outside it`)
    const verdict = entry.verdict
    if (typeof verdict !== 'string' || !RUN_VERDICTS.includes(verdict as RunVerdict))
      fail(`profiles[${index}].verdict`, `unknown verdict ${JSON.stringify(verdict)} (expected "passed", "failed", "blocked", "refused" or "waived")`)
    if (!Array.isArray(entry.criteria))
      fail(`profiles[${index}].criteria`, 'profile entry must carry the criterion ids the profile checked')
    // The profile reference the run checked: judge and redact re-read the
    // rules from the result and the .qa artifact alone, so the reference is
    // carried here rather than reconstructed from the app's name alone.
    const profile = entry.profile === undefined ? undefined : parseProfileRef(entry.profile)
    return {
      name,
      verdict: verdict as RunVerdict,
      criteria: entry.criteria.map((criterion, criterionIndex) =>
        nonEmptyString(criterion, `profiles[${index}].criteria[${criterionIndex}]`, 'criterion id'),
      ),
      ...(profile === undefined ? {} : { profile }),
    }
  })
}

function parseTarget(value: unknown): RunTarget | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) fail('target', 'result.json target must be a JSON object with url and comparison')
  const url = nonEmptyString(value.url, 'target.url', 'target URL')
  if (value.comparison !== 'none')
    fail('target.comparison', `unknown comparison ${JSON.stringify(value.comparison)} (a run against a target has one side, so it is "none")`)
  return { url, comparison: 'none' }
}

function parseClient(value: unknown): RunClient | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) fail('client', 'result.json client must be a JSON object with driver, executable and comparison')
  const driver = nonEmptyString(value.driver, 'client.driver', 'client driver')
  const executable = nonEmptyString(value.executable, 'client.executable', 'client executable')
  if (value.comparison !== 'none')
    fail('client.comparison', `unknown comparison ${JSON.stringify(value.comparison)} (a run against a client build has one side, so it is "none")`)
  return { driver, executable, comparison: 'none' }
}

/**
 * The base side is optional, so a one-sided result and one written before the
 * field existed still load (#147). A base that did not execute says why.
 */
function parseRunBase(value: unknown): RunBase | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) fail('base', 'result.json base must be a JSON object with ref and status')
  const ref = nonEmptyString(value.ref, 'base.ref', 'base ref')
  if (value.status !== 'executed' && value.status !== 'not-executed')
    fail('base.status', `unknown base status ${JSON.stringify(value.status)} (expected "executed" or "not-executed")`)
  if (value.status === 'executed')
    return value.reason === undefined ? { ref, status: 'executed' } : { ref, status: 'executed', reason: nonEmptyString(value.reason, 'base.reason', 'reason') }
  if (value.reason === undefined) fail('base.reason', 'a base side that did not execute names why')
  return { ref, status: 'not-executed', reason: nonEmptyString(value.reason, 'base.reason', 'reason') }
}

/**
 * What the base showed for a criterion, and whether the criterion regressed
 * (#147). A regression is only ever carried over a base that proved the
 * criterion and a head that did not: a hand-written result cannot claim one
 * the two sides do not show.
 */
function parseComparison(value: Record<string, unknown>, field: string, outcome: CriterionOutcome): { base?: CriterionBase; regression?: boolean } {
  let base: CriterionBase | undefined
  if (value.base !== undefined) {
    const record = value.base
    if (!isRecord(record)) fail(`${field}.base`, 'base must be a JSON object with an outcome')
    if (record.outcome !== 'proven' && record.outcome !== 'failed' && record.outcome !== 'not-compared')
      fail(`${field}.base.outcome`, `unknown base outcome ${JSON.stringify(record.outcome)} (expected "proven", "failed" or "not-compared")`)
    if (record.outcome === 'not-compared' && record.reason === undefined)
      fail(`${field}.base.reason`, 'a criterion that was not compared with the base names why')
    base = {
      outcome: record.outcome,
      ...(record.reason === undefined ? {} : { reason: nonEmptyString(record.reason, `${field}.base.reason`, 'reason') }),
      ...(record.evidence === undefined ? {} : { evidence: relativePathArray(record.evidence, `${field}.base.evidence`, 'base evidence') }),
    }
  }
  if (value.regression === undefined) return base === undefined ? {} : { base }
  if (typeof value.regression !== 'boolean') fail(`${field}.regression`, 'regression must be a boolean')
  if (value.regression && (base?.outcome !== 'proven' || outcome === 'proven'))
    fail(`${field}.regression`, 'a regression is a criterion the base proved and the head did not; this one carries no such pair')
  if (!value.regression && base?.outcome !== 'failed')
    fail(`${field}.regression`, 'regression is false only for a criterion that failed at the base too')
  return { ...(base === undefined ? {} : { base }), regression: value.regression }
}

function parseWaived(value: unknown): Array<{ criterionId: string; by: string }> | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) fail('waived', 'result.json waived must be an array of { criterionId, by }')
  if (value.length === 0) fail('waived', 'result.json waived must not be empty when present')
  return value.map((entry, index) => {
    if (!isRecord(entry)) fail(`waived[${index}]`, 'waiver entry must be a JSON object')
    return {
      criterionId: nonEmptyString(entry.criterionId, `waived[${index}].criterionId`, 'criterion id'),
      by: nonEmptyString(entry.by, `waived[${index}].by`, 'waiver actor'),
    }
  })
}

function parseJobSummary(value: unknown): { id: string } | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) fail('job', 'result.json job must be a JSON object carrying an id')
  return { id: nonEmptyString(value.id, 'job.id', 'job id') }
}

function parseCriterionResult(value: unknown, index: number): CriterionResult {
  const base = `criteria[${index}]`
  if (!isRecord(value)) fail(base, 'criterion result must be a JSON object')

  const id = nonEmptyString(value.id, `${base}.id`, 'id')

  const outcome = value.outcome
  if (typeof outcome !== 'string' || !CRITERION_OUTCOMES.includes(outcome as CriterionOutcome))
    fail(`${base}.outcome`, `unknown outcome ${JSON.stringify(outcome)} (expected "proven", "failed" or "unverified")`)

  const repairs = value.repairs === undefined ? undefined : parseRepairs(value.repairs, `${base}.repairs`)
  const withRepairs = <T>(record: T): T => (repairs === undefined ? record : { ...record, repairs })

  // A cached marker is written only as true: a result either is replayed from
  // the run's cache or it is not, so any other value is a malformed record.
  if (value.cached !== undefined && value.cached !== true)
    fail(`${base}.cached`, 'cached must be true when present')
  const cached = value.cached === undefined ? undefined : ({ cached: true } as const)
  const comparison = parseComparison(value, base, outcome as CriterionOutcome)
  const a11y = value.a11y === undefined ? undefined : parseA11yCounts(value.a11y, `${base}.a11y`)
  const mail = value.mail === undefined ? undefined : parseMailProofs(value.mail, `${base}.mail`)
  const withCached = <T>(record: T): T => ({ ...record, ...(cached ?? {}), ...comparison, ...(a11y === undefined ? {} : { a11y }), ...(mail === undefined ? {} : { mail }) })

  switch (outcome as CriterionOutcome) {
    case 'proven':
      return withCached(
        withRepairs({
          id,
          outcome: 'proven',
          evidence: requiredEvidence(value.evidence, `${base}.evidence`, id, 'proven'),
        }),
      )
    case 'failed': {
      const evidence = requiredEvidence(value.evidence, `${base}.evidence`, id, 'failed')
      return withCached(
        withRepairs(
          value.reason === undefined
            ? { id, outcome: 'failed', evidence }
            : { id, outcome: 'failed', evidence, reason: nonEmptyString(value.reason, `${base}.reason`, 'reason') },
        ),
      )
    }
    case 'unverified': {
      const reason = nonEmptyString(value.reason, `${base}.reason`, 'reason')
      const evidence = value.evidence === undefined ? undefined : relativePathArray(value.evidence, `${base}.evidence`, 'evidence')
      return withCached(
        withRepairs(
          evidence === undefined ? { id, outcome: 'unverified', reason } : { id, outcome: 'unverified', reason, evidence },
        ),
      )
    }
  }
}

/** What a criterion's accessibility audits counted (#149): five whole numbers, none below zero. */
function parseA11yCounts(value: unknown, base: string): A11yCounts {
  if (!isRecord(value)) fail(base, 'a11y must be a JSON object counting new, existing, accepted, reported and uncompared violations')
  const count = (key: keyof A11yCounts): number => {
    const entry = value[key]
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0) fail(`${base}.${key}`, `a11y.${key} must be a whole number of at least 0`)
    return entry
  }
  return { new: count('new'), existing: count('existing'), accepted: count('accepted'), reported: count('reported'), uncompared: count('uncompared') }
}

/** The messages a criterion's mail checks read (#65): text fields and a list of links. */
function parseMailProofs(value: unknown, base: string): MailProof[] {
  if (!Array.isArray(value)) fail(base, 'mail must be an array of the messages the mail checks read')
  return value.map((entry, index) => {
    const at = `${base}[${index}]`
    if (!isRecord(entry)) fail(at, 'a mail message must be a JSON object with check, from, subject, excerpt and links')
    const text = (key: 'check' | 'from' | 'subject' | 'excerpt'): string => {
      const field = entry[key]
      if (typeof field !== 'string') fail(`${at}.${key}`, `mail.${key} must be a string`)
      return field
    }
    const record = { check: text('check'), from: text('from'), subject: text('subject'), excerpt: text('excerpt') }
    const links = entry.links
    if (!Array.isArray(links) || !links.every((link): link is string => typeof link === 'string')) fail(`${at}.links`, 'mail.links must be an array of strings')
    return { ...record, links }
  })
}

/** The repairs a criterion result may carry (#83), each named for its check and action. */
function parseRepairs(value: unknown, base: string): RunRepairRecord[] {
  if (!Array.isArray(value)) fail(base, 'repairs must be an array of repair records')
  return value.map((entry, index) => {
    const field = `${base}[${index}]`
    if (!isRecord(entry)) fail(field, 'a repair record must be a JSON object')
    const check = nonEmptyString(entry.check, `${field}.check`, 'check name')
    const action = entry.action
    if (typeof action !== 'number' || !Number.isInteger(action) || action < 0)
      fail(`${field}.action`, 'a repair record names the action it repaired, by index')
    const reference = nonEmptyString(entry.reference, `${field}.reference`, 'reference')
    const identity = nonEmptyString(entry.identity, `${field}.identity`, 'identity comparison')
    const status = entry.status
    if (status !== 'applied' && status !== 'refused')
      fail(`${field}.status`, `unknown repair status ${JSON.stringify(status)} (expected "applied" or "refused")`)
    if (status === 'refused' && entry.refusedReason === undefined)
      fail(`${field}.refusedReason`, 'a refused repair names the reason it went to review')
    if (status === 'applied' && entry.repaired === undefined)
      fail(`${field}.repaired`, 'an applied repair names the reference it re-pointed to')
    return {
      check,
      action,
      reference,
      ...(entry.repaired === undefined ? {} : { repaired: nonEmptyString(entry.repaired, `${field}.repaired`, 'repaired reference') }),
      identity,
      status,
      ...(entry.refusedReason === undefined ? {} : { refusedReason: nonEmptyString(entry.refusedReason, `${field}.refusedReason`, 'refusal reason') }),
    }
  })
}

function requiredEvidence(
  value: unknown,
  field: string,
  id: string,
  outcome: 'proven' | 'failed',
): string[] {
  if (!Array.isArray(value))
    fail(field, `criterion "${id}" is ${outcome} without evidence references; the harness produced no evidence, and a criterion is ${outcome} only by evidence`)
  const paths = relativePathArray(value, field, 'evidence')
  if (paths.length === 0)
    fail(field, `criterion "${id}" is ${outcome} with zero evidence references; carry at least one`)
  return paths
}
