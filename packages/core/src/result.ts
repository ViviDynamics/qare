export const RESULT_SCHEMA_VERSION = '1'

export type CriterionOutcome = 'proven' | 'failed' | 'unverified'

export type RunVerdict = 'passed' | 'failed' | 'blocked' | 'refused' | 'waived'

export interface ProvenCriterionResult {
  id: string
  outcome: 'proven'
  evidence: string[]
}

export interface FailedCriterionResult {
  id: string
  outcome: 'failed'
  evidence: string[]
  /** Why, when something other than the check itself decided it failed (the verifier). */
  reason?: string
}

export interface UnverifiedCriterionResult {
  id: string
  outcome: 'unverified'
  reason: string
  evidence?: string[]
}

export type CriterionResult = ProvenCriterionResult | FailedCriterionResult | UnverifiedCriterionResult

export interface RunResult {
  schemaVersion: string
  verdict: RunVerdict
  criteria: CriterionResult[]
  job?: { id: string }
  waived?: Array<{ criterionId: string; by: string }>
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

  return {
    schemaVersion,
    verdict: verdict as RunVerdict,
    criteria: input.criteria.map((entry, index) => parseCriterionResult(entry, index)),
    ...(job === undefined ? {} : { job }),
    ...(waived === undefined ? {} : { waived }),
  }
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

  switch (outcome as CriterionOutcome) {
    case 'proven':
      return { id, outcome: 'proven', evidence: requiredEvidence(value.evidence, `${base}.evidence`, id, 'proven') }
    case 'failed': {
      const evidence = requiredEvidence(value.evidence, `${base}.evidence`, id, 'failed')
      return value.reason === undefined
        ? { id, outcome: 'failed', evidence }
        : { id, outcome: 'failed', evidence, reason: nonEmptyString(value.reason, `${base}.reason`, 'reason') }
    }
    case 'unverified': {
      const reason = nonEmptyString(value.reason, `${base}.reason`, 'reason')
      const evidence = value.evidence === undefined ? undefined : relativePathArray(value.evidence, `${base}.evidence`, 'evidence')
      return evidence === undefined
        ? { id, outcome: 'unverified', reason }
        : { id, outcome: 'unverified', reason, evidence }
    }
  }
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
