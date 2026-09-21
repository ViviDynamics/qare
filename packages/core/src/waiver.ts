import type { CriterionResult, RunResult, RunVerdict } from './result.js'

const OWNER_REPO_PATTERN = /^[\w][\w.-]*\/[\w][\w.-]*$/
const WAIVE_COMMAND_PATTERN = /^\/qa-waive\s+(.+)$/

export interface ForkContext {
  headRepo: string
  baseRepo: string
}

export interface ForkRefusal {
  verdict: 'refused'
  reason: string
}

export function isFork(ctx: ForkContext): boolean {
  return ctx.headRepo.toLowerCase() !== ctx.baseRepo.toLowerCase()
}

export function refuseFork(ctx: ForkContext): ForkRefusal {
  const headRepo = typeof ctx.headRepo === 'string' && OWNER_REPO_PATTERN.test(ctx.headRepo)
    ? ctx.headRepo
    : undefined
  return {
    verdict: 'refused',
    reason:
      headRepo === undefined
        ? 'refused: fork pull request cannot run qare; secrets are never shared with forks'
        : `refused: fork pull request (${headRepo}) cannot run qare; secrets are never shared with forks`,
  }
}

export interface ParsedWaiver {
  criterionIds: string[]
}

export function parseWaiver(input: { body?: string; label?: string }): ParsedWaiver | { rejected: string } {
  let raw: string | undefined
  if (typeof input.body === 'string') {
    const match = WAIVE_COMMAND_PATTERN.exec(input.body.trim())
    if (match !== null) raw = match[1]
  }
  if (raw === undefined) {
    if (input.label === 'qa-waived')
      return { rejected: 'qa-waived label names no criteria; comment /qa-waive <ids> instead' }
    return { rejected: 'not a /qa-waive command' }
  }
  const ids = raw
    .split(/[,\s]+/)
    .filter((id) => id !== '')
    .filter((id) => isWaivableId(id))
  if (ids.length === 0) return { rejected: 'no valid criterion ids' }
  return { criterionIds: ids }
}

function isWaivableId(id: string): boolean {
  return !id.includes(':') && !/[/\\]|\.\./.test(id) && !/[\x00-\x1f\x7f]/.test(id)
}

export interface WaiverRecord {
  criterionId: string
  by: string
}

export function recordWaiver(
  result: RunResult,
  waiver: { criterionIds: string[]; by: string },
): RunResult {
  if (result.verdict === 'refused') return result
  const by = sanitizeActor(waiver.by)
  const named = new Set(waiver.criterionIds)
  const criteria: CriterionResult[] = result.criteria.map((criterion) =>
    named.has(criterion.id)
      ? { id: criterion.id, outcome: 'unverified', reason: `waived by ${by}` }
      : criterion,
  )
  return {
    ...result,
    verdict: deriveWaivedVerdict(result.verdict, criteria, named.size > 0),
    criteria,
    waived: [...named].map((criterionId) => ({ criterionId, by })),
  }
}

function deriveWaivedVerdict(
  current: RunVerdict,
  criteria: CriterionResult[],
  anyWaived: boolean,
): RunVerdict {
  if (criteria.some((criterion) => criterion.outcome === 'failed')) return 'failed'
  if (!anyWaived) return current
  if (criteria.some((criterion) => criterion.outcome === 'unverified')) return 'waived'
  if (criteria.length === 0) return 'blocked'
  return 'waived'
}

function sanitizeActor(by: string): string {
  return String(by ?? '')
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .trim()
}
