import { createHash } from 'node:crypto'

import { normalizeWording } from './criterion-identity.js'
import type { PlanCriterionInput } from './plan-step.js'

export class IssueCriteriaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IssueCriteriaError'
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
      'the issue has a criteria section with no criteria in it; a run with nothing to check passes nothing',
    )
  return criteria
}
