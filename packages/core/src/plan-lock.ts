import { createHash } from 'node:crypto'
import type { Plan, PlanCheck, PlanCriterion } from './plan.js'

const CHECK_FIELDS = ['kind', 'name', 'command', 'suite', 'actions', 'screenshot', 'widths', 'themes', 'address', 'from', 'subject', 'body', 'timeoutMs', 'inferred']

export interface PlanComparison {
  matches: boolean
  findings: string[]
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(entry => stableStringify(entry)).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).filter(key => record[key] !== undefined).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
  }
  if (value === undefined) return 'null'
  return JSON.stringify(value)
}

function canonicalCheck(check: PlanCheck): PlanCheck {
  const canonical: Record<string, unknown> = { kind: check.kind, name: check.name }
  if (check.kind === 'command') {
    canonical.command = check.command
  } else if (check.kind === 'flow') {
    if (check.suite !== undefined) canonical.suite = check.suite
    if (check.actions !== undefined) canonical.actions = [...check.actions]
  } else if (check.kind === 'mail') {
    canonical.address = check.address
    if (check.from !== undefined) canonical.from = check.from
    if (check.subject !== undefined) canonical.subject = check.subject
    if (check.body !== undefined) canonical.body = check.body
    if (check.timeoutMs !== undefined) canonical.timeoutMs = check.timeoutMs
  } else {
    canonical.screenshot = check.screenshot
    if (check.widths !== undefined) canonical.widths = [...check.widths]
    if (check.themes !== undefined) canonical.themes = [...check.themes]
  }
  if (check.inferred !== undefined) canonical.inferred = check.inferred
  return canonical as unknown as PlanCheck
}

function compareCanonically(a: unknown, b: unknown): number {
  const ak = stableStringify(a)
  const bk = stableStringify(b)
  return ak < bk ? -1 : ak > bk ? 1 : 0
}

function canonicalChecks(checks: PlanCheck[] | undefined): PlanCheck[] {
  return (checks ?? []).map(canonicalCheck).sort(compareCanonically)
}

function canonicalCriterion(criterion: PlanCriterion): PlanCriterion {
  if ('checks' in criterion)
    return { id: criterion.id, text: criterion.text, checks: canonicalChecks(criterion.checks) }
  return { id: criterion.id, text: criterion.text, unplannable: criterion.unplannable }
}

function canonicalizePlan(plan: Plan): Plan {
  return {
    schemaVersion: plan.schemaVersion,
    criteria: plan.criteria.map(canonicalCriterion).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : compareCanonically(a, b))),
  }
}

function fingerprintBody(plan: Plan): unknown {
  return {
    schemaVersion: plan.schemaVersion,
    criteria: plan.criteria.map(criterion => ({
      id: criterion.id,
      checks: 'checks' in criterion ? canonicalChecks(criterion.checks) : [],
    })).sort(compareCanonically),
  }
}

export function fingerprintPlan(plan: Plan): string {
  return createHash('sha256').update(stableStringify(fingerprintBody(plan))).digest('hex')
}

export function lockPlan(plan: Plan): { locked: Plan; fingerprint: string } {
  return { locked: canonicalizePlan(plan), fingerprint: fingerprintPlan(plan) }
}

export function comparePlan(current: Plan, locked: Plan): PlanComparison {
  if (fingerprintPlan(current) === fingerprintPlan(locked)) return { matches: true, findings: [] }
  const findings = collectFindings(current, locked)
  if (findings.length === 0) findings.push('plan fingerprint changed without a named criterion or check edit')
  return { matches: false, findings }
}

function collectFindings(current: Plan, locked: Plan): string[] {
  const findings: string[] = []
  const currentById = new Map(current.criteria.map(criterion => [criterion.id, criterion] as const))
  const lockedById = new Map(locked.criteria.map(criterion => [criterion.id, criterion] as const))
  const ids = [...new Set([...currentById.keys(), ...lockedById.keys()])].sort()
  for (const id of ids) {
    const currentCriterion = currentById.get(id)
    const lockedCriterion = lockedById.get(id)
    if (currentCriterion === undefined) {
      findings.push(`criterion ${id}: criterion removed`)
      continue
    }
    if (lockedCriterion === undefined) {
      findings.push(`criterion ${id}: criterion added`)
      continue
    }
    const currentChecks = canonicalChecks('checks' in currentCriterion ? currentCriterion.checks : undefined)
    const lockedChecks = canonicalChecks('checks' in lockedCriterion ? lockedCriterion.checks : undefined)
    compareChecks(id, currentChecks, lockedChecks, findings)
  }
  return findings
}

function compareChecks(criterionId: string, current: PlanCheck[], locked: PlanCheck[], findings: string[]): void {
  const currentEntries = current.map((check, index) => ({ check, key: stableStringify(check), index }))
  const lockedEntries = locked.map(check => ({ check, key: stableStringify(check) }))
  const matchedLocked = new Set<number>()
  const unmatchedCurrent: { check: PlanCheck; key: string; index: number }[] = []
  for (const entry of currentEntries) {
    const index = lockedEntries.findIndex((locked, i) => !matchedLocked.has(i) && locked.key === entry.key)
    if (index === -1) unmatchedCurrent.push(entry)
    else matchedLocked.add(index)
  }
  const unmatchedLocked = lockedEntries.filter((_, index) => !matchedLocked.has(index))
  const pairs = Math.min(unmatchedCurrent.length, unmatchedLocked.length)
  for (const [position, entry] of unmatchedCurrent.slice(0, pairs).entries()) {
    const lockedEntry = unmatchedLocked[position]
    if (lockedEntry === undefined) continue
    diffCheck(criterionId, entry.index, entry.check, lockedEntry.check, findings)
  }
  for (const entry of unmatchedCurrent.slice(pairs)) {
    findings.push(`criterion ${criterionId}: check added: ${describeCheck(entry.check)}`)
  }
  for (const entry of unmatchedLocked.slice(pairs)) {
    findings.push(`criterion ${criterionId}: check removed: ${describeCheck(entry.check)}`)
  }
}

function diffCheck(criterionId: string, currentIndex: number, current: PlanCheck, locked: PlanCheck, findings: string[]): void {
  const currentRecord = current as unknown as Record<string, unknown>
  const lockedRecord = locked as unknown as Record<string, unknown>
  for (const field of CHECK_FIELDS) {
    const before = lockedRecord[field]
    const after = currentRecord[field]
    if (stableStringify(before) !== stableStringify(after))
      findings.push(`criterion ${criterionId}: check ${currentIndex} changed: ${field} ${formatValue(before)} -> ${formatValue(after)}`)
  }
}

function formatValue(value: unknown): string {
  return value === undefined ? 'absent' : JSON.stringify(value)
}

function describeCheck(check: PlanCheck): string {
  if (check.kind === 'command') return `command "${check.name}" (${check.command})`
  if (check.kind === 'flow') {
    return check.suite !== undefined
      ? `flow "${check.name}" (suite ${check.suite})`
      : `flow "${check.name}" (actions ${JSON.stringify(check.actions ?? [])})`
  }
  if (check.kind === 'mail') return `mail "${check.name}" (${check.address})`
  return `visual "${check.name}" (screenshot ${check.screenshot})`
}
