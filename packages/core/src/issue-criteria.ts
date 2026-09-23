import { createHash } from 'node:crypto'

import { normalizeWording } from './criterion-identity.js'
import type { PlanCriterionInput } from './plan-step.js'

/**
 * `none-stated`: the issue has no criteria section, so it states nothing to
 * check. `empty-section`: it has the heading and nothing usable under it,
 * which is a malformed statement of criteria rather than an absent one.
 */
export type IssueCriteriaProblem = 'none-stated' | 'empty-section'

export class IssueCriteriaError extends Error {
  readonly problem: IssueCriteriaProblem

  constructor(problem: IssueCriteriaProblem, message: string) {
    super(message)
    this.name = 'IssueCriteriaError'
    this.problem = problem
  }
}

/** The headings this org writes acceptance criteria under. */
const HEADING = /^#{1,6}\s*(acceptance criteria|done when)\s*$/i
const ANY_HEADING = /^#{1,6}\s+\S/
const ITEM = /^\s*[-*]\s*\[[ xX]\]\s*(.+?)\s*$/

/**
 * The id for a criterion, derived from its wording.
 *
 * Deliberately not `mintCriterionId`, which is random: an id read off an issue
 * has to be the same on every run, or a rerun would look like a different set
 * of criteria and nothing could be compared across runs. Normalizing first
 * means punctuation and case changes are the same criterion, which is the same
 * rule `resolveCriterion` uses when matching a reworded one.
 */
export function criterionIdFor(text: string): string {
  const normalized = normalizeWording(text)
  return `c-${createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16)}`
}

/**
 * The acceptance criteria stated in an issue body.
 *
 * Fails closed. An issue with no criteria section, or a section with no items,
 * raises rather than returning an empty list: zero criteria would make a run
 * vacuously green, which is the outcome qare exists to prevent.
 */
export function criteriaFromIssue(body: string): PlanCriterionInput[] {
  const lines = String(body ?? '').split('\n')
  const start = lines.findIndex((line) => HEADING.test(line.trim()))
  if (start === -1)
    throw new IssueCriteriaError(
      'none-stated',
      'the issue states no acceptance criteria: expected a heading "Acceptance criteria" or "Done when"',
    )

  const criteria: PlanCriterionInput[] = []
  const seen = new Set<string>()
  for (const line of lines.slice(start + 1)) {
    if (ANY_HEADING.test(line)) break
    const item = ITEM.exec(line)
    const text = item?.[1]
    if (text === undefined) continue
    const id = criterionIdFor(text)
    // The same wording twice is one criterion, not two: planning it twice
    // would double every check it maps to.
    if (seen.has(id)) continue
    seen.add(id)
    criteria.push({ id, text })
  }

  if (criteria.length === 0)
    throw new IssueCriteriaError(
      'empty-section',
      'the issue has a criteria section with no criteria in it; a run with nothing to check passes nothing',
    )
  return criteria
}

/**
 * The acceptance criteria several issues state between them, each issue read
 * on its own and the same wording counted once.
 *
 * An issue with no criteria section contributes nothing, and when none has
 * one the result is empty: there is nothing to check, and whether that is
 * neutral is the caller's call. A criteria section with nothing usable in it
 * still throws, naming the issue, because a malformed statement of criteria
 * is not the same as stating none.
 */
export function criteriaFromIssues(issues: { name: string; body: string }[]): PlanCriterionInput[] {
  const criteria = new Map<string, PlanCriterionInput>()
  for (const issue of issues) {
    let stated: PlanCriterionInput[]
    try {
      stated = criteriaFromIssue(issue.body)
    } catch (error) {
      if (error instanceof IssueCriteriaError && error.problem === 'none-stated') continue
      if (error instanceof IssueCriteriaError)
        throw new IssueCriteriaError(error.problem, `${issue.name}: ${error.message}`)
      throw error
    }
    for (const criterion of stated) if (!criteria.has(criterion.id)) criteria.set(criterion.id, criterion)
  }
  return [...criteria.values()]
}
