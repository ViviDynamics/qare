import { mergeVerdicts } from './egress.js'
import type { CriterionOutcome, RunVerdict } from './result.js'

export interface SideResult {
  criterionId: string
  outcome: CriterionOutcome
  detail?: string
}

export interface Regression {
  criterionId: string
  base: 'proven'
  head: 'failed'
  baseDetail?: string
  headDetail?: string
}

export interface CriterionVerdict {
  criterionId: string
  outcome: CriterionOutcome
  regression: boolean
  reason: string
}

export interface JudgeRunInput {
  base: SideResult[]
  head: SideResult[]
  waived?: string[]
  egressVerdict?: 'refused' | 'allowed'
}

export interface JudgeRunResult {
  criteria: CriterionVerdict[]
  regressions: Regression[]
  verdict: RunVerdict
}

/**
 * A regression is anything that worked at base and fails at head, whether or
 * not a criterion covers it. Stable order: first appearance in head.
 */
export function detectRegressions(base: SideResult[], head: SideResult[]): Regression[] {
  const baseById = new Map<string, SideResult>()
  for (const side of base ?? []) baseById.set(side.criterionId, side)
  const regressions: Regression[] = []
  for (const headSide of head ?? []) {
    const baseSide = baseById.get(headSide.criterionId)
    if (baseSide === undefined || baseSide.outcome !== 'proven' || headSide.outcome !== 'failed') continue
    regressions.push({
      criterionId: headSide.criterionId,
      base: 'proven',
      head: 'failed',
      ...(baseSide.detail === undefined ? {} : { baseDetail: baseSide.detail }),
      ...(headSide.detail === undefined ? {} : { headDetail: headSide.detail }),
    })
  }
  return regressions
}

/**
 * Decide criterion verdicts and the run verdict from raw side results only.
 * The head side is the verdict source; criteria proven at base and failed at
 * head are regressions. Waived criteria are never shown as a pass, and an
 * egress refusal is unmaskable.
 */
export function judgeRun(input: JudgeRunInput): JudgeRunResult {
  const base = input.base ?? []
  const head = input.head ?? []
  const waived = new Set(input.waived ?? [])
  const regressions = detectRegressions(base, head)
  const regressed = new Set(regressions.map((regression) => regression.criterionId))

  const headById = new Map<string, SideResult>()
  for (const side of head) headById.set(side.criterionId, side)

  const criteria: CriterionVerdict[] = []
  let anyWaived = false
  for (const headSide of head) {
    const criterionId = headSide.criterionId
    const isRegressed = regressed.has(criterionId)
    if (waived.has(criterionId)) {
      anyWaived = true
      criteria.push({ criterionId, outcome: 'unverified', regression: isRegressed, reason: 'waived by human' })
      continue
    }
    if (isRegressed) {
      criteria.push({
        criterionId,
        outcome: 'failed',
        regression: true,
        reason: headSide.detail ?? 'proven at base, failed at head',
      })
      continue
    }
    switch (headSide.outcome) {
      case 'proven':
        criteria.push({ criterionId, outcome: 'proven', regression: false, reason: headSide.detail ?? 'proven at head' })
        break
      case 'failed':
        criteria.push({ criterionId, outcome: 'failed', regression: false, reason: headSide.detail ?? 'failed at head' })
        break
      case 'unverified':
        criteria.push({
          criterionId,
          outcome: 'unverified',
          regression: false,
          reason: headSide.detail ?? 'unverified at head',
        })
        break
    }
  }
  for (const baseSide of base) {
    if (headById.has(baseSide.criterionId)) continue
    if (waived.has(baseSide.criterionId)) {
      anyWaived = true
      criteria.push({
        criterionId: baseSide.criterionId,
        outcome: 'unverified',
        regression: false,
        reason: 'waived by human',
      })
      continue
    }
    criteria.push({
      criterionId: baseSide.criterionId,
      outcome: 'unverified',
      regression: false,
      reason: 'not executed at head',
    })
  }

  const derived = deriveVerdict(criteria, regressions, anyWaived)
  const verdict = input.egressVerdict === 'refused' ? mergeVerdicts([derived, 'refused']) : derived
  return { criteria, regressions, verdict }
}

function deriveVerdict(criteria: CriterionVerdict[], regressions: Regression[], anyWaived: boolean): RunVerdict {
  if (regressions.length > 0 || criteria.some((criterion) => criterion.outcome === 'failed')) return 'failed'
  if (!criteria.some((criterion) => criterion.outcome === 'unverified')) return 'passed'
  return anyWaived ? 'waived' : 'blocked'
}
