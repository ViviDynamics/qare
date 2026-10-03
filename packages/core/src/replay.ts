import { judgeExecuted } from './judge.js'
import { NO_DIFF } from './plan-step.js'
import { BUILTIN_REDACTION_RULES } from './redact.js'
import type { Plan } from './plan.js'
import type { RunResult } from './result.js'

/**
 * A stored verdict replayed against the raw artifacts (#54). `verdict`,
 * `outcome` and `reason` name where the two disagree; `criteria` names a
 * criterion one side has and the other does not.
 */
export interface ReplayDifference {
  criterionId?: string
  field: 'verdict' | 'outcome' | 'reason' | 'criteria'
  stored: string
  replayed: string
}

/** The judged-result.json a run stored, as bytes and as parsed data. */
export interface StoredVerdict {
  bytes: string
  result: RunResult
}

export interface ReplayReport {
  /** The verdict recomputed from the artifacts alone. */
  result: RunResult
  /** The recomputed result, serialized exactly as judge writes it. */
  bytes: string
  /** Whether a judged-result.json was stored with the run. */
  stored: boolean
  /** Whether the stored file and the recompute are byte for byte the same. */
  identical: boolean
  /** Where the stored verdict and the recompute disagree. */
  differences: ReplayDifference[]
  /** Why the two can differ, when the reason is known. */
  explanation?: string
}

/**
 * Re-run a verdict from its artifacts (#54): the stored plan and raw results
 * in, the judged verdict out, through the one path `qare judge` uses, with no
 * verifier, so no model is called and nothing is reached. Against a stored
 * judged-result.json it says whether the recompute reproduces it byte for
 * byte, and when it does not, every criterion that moved and why.
 */
export async function replayRun(input: {
  plan: Plan
  executed: RunResult
  stored?: StoredVerdict
}): Promise<ReplayReport> {
  const texts = Object.fromEntries(input.plan.criteria.map((criterion) => [criterion.id, criterion.text]))
  const { result } = await judgeExecuted(input.executed, {
    texts,
    diff: NO_DIFF,
    rules: BUILTIN_REDACTION_RULES,
  })
  const bytes = `${JSON.stringify(result, null, 2)}\n`
  if (input.stored === undefined)
    return { result, bytes, stored: false, identical: false, differences: [] }
  const identical = withoutAdvisory(input.stored.bytes) === bytes
  const differences = identical ? [] : compare(input.stored.result, result)
  const explanation =
    differences.length === 0 && !identical
      ? 'the verdicts agree, but the stored file is not what the recompute writes byte for byte'
      : downgradedByVerifier(input.stored.result, result)
        ? 'the stored verdict carries a downgrade the verifier model made; replaying without a model recomputes the verdict the code alone decides'
        : differences.length === 0
          ? undefined
          : 'the stored verdict does not follow from these artifacts; judge the same result.json with --runner none and compare the two'
  return { result, bytes, stored: true, identical, differences, ...(explanation === undefined ? {} : { explanation }) }
}

/**
 * The stored verdict as judge wrote it before the advisory review added its
 * key (#150). The recompute calls no model, so it has no review to add, and
 * the review is no part of the verdict: a stored file that differs only by
 * that key reproduces. Bytes that are not a JSON object, or carry no such
 * key, are compared as they are.
 */
function withoutAdvisory(bytes: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes)
  } catch {
    return bytes
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !('advisory' in parsed)) return bytes
  const rest: Record<string, unknown> = { ...parsed }
  delete rest.advisory
  return `${JSON.stringify(rest, null, 2)}\n`
}

function compare(stored: RunResult, replayed: RunResult): ReplayDifference[] {
  const differences: ReplayDifference[] = []
  if (stored.verdict !== replayed.verdict)
    differences.push({ field: 'verdict', stored: stored.verdict, replayed: replayed.verdict })
  const storedById = new Map(stored.criteria.map((criterion) => [criterion.id, criterion]))
  const replayedById = new Map(replayed.criteria.map((criterion) => [criterion.id, criterion]))
  for (const criterion of replayed.criteria) {
    const before = storedById.get(criterion.id)
    if (before === undefined) {
      differences.push({ criterionId: criterion.id, field: 'criteria', stored: 'absent', replayed: criterion.outcome })
      continue
    }
    if (before.outcome !== criterion.outcome)
      differences.push({ criterionId: criterion.id, field: 'outcome', stored: before.outcome, replayed: criterion.outcome })
    else if (reasonOf(before) !== reasonOf(criterion))
      differences.push({
        criterionId: criterion.id,
        field: 'reason',
        stored: reasonOf(before) ?? '',
        replayed: reasonOf(criterion) ?? '',
      })
  }
  for (const criterion of stored.criteria)
    if (!replayedById.has(criterion.id))
      differences.push({ criterionId: criterion.id, field: 'criteria', stored: criterion.outcome, replayed: 'absent' })
  return differences
}

function downgradedByVerifier(stored: RunResult, replayed: RunResult): boolean {
  return stored.criteria.some(
    (criterion) =>
      criterion.outcome === 'failed' &&
      reasonOf(criterion)?.startsWith('verifier:') === true &&
      replayed.criteria.find((replayed) => replayed.id === criterion.id)?.outcome === 'proven',
  )
}

function reasonOf(criterion: RunResult['criteria'][number]): string | undefined {
  return 'reason' in criterion ? criterion.reason : undefined
}
