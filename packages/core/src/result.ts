import type { RunEnvironment } from './environment.js'
import { parseProfileRef, type JobProfileRef } from './job.js'
import { isUnsafeProfileName } from './profile.js'

export const RESULT_SCHEMA_VERSION = '1'

export type CriterionOutcome = 'proven' | 'failed' | 'unverified'

export type RunVerdict = 'passed' | 'failed' | 'blocked' | 'refused' | 'waived'

export interface ProvenCriterionResult {
  id: string
  outcome: 'proven'
  evidence: string[]
  /** Locator repairs recorded while checking this criterion (#83). */
  repairs?: RunRepairRecord[]
  /** The result came from the run's cache, because nothing the check reads had moved (#47). */
  cached?: true
}

export interface FailedCriterionResult {
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

export interface UnverifiedCriterionResult {
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

export interface RunResult {
  schemaVersion: string
  verdict: RunVerdict
  criteria: CriterionResult[]
  job?: { id: string }
  waived?: Array<{ criterionId: string; by: string }>
  target?: RunTarget
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
}

const CRITERION_OUTCOMES: CriterionOutcome[] = ['proven', 'failed', 'unverified']
const RUN_VERDICTS: RunVerdict[] = ['passed', 'failed', 'blocked', 'refused', 'waived']

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
  const environment = parseEnvironment(input.environment)
  const profiles = parseProfiles(input.profiles)

  return {
    schemaVersion,
    verdict: verdict as RunVerdict,
    criteria: input.criteria.map((entry, index) => parseCriterionResult(entry, index)),
    ...(job === undefined ? {} : { job }),
    ...(waived === undefined ? {} : { waived }),
    ...(target === undefined ? {} : { target }),
    ...(environment === undefined ? {} : { environment }),
    ...(profiles === undefined ? {} : { profiles }),
  }
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
  const withCached = <T>(record: T): T => (cached === undefined ? record : { ...record, ...cached })

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
