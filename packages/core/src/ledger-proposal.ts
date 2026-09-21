import { serializeLedger, type LedgerEntry, type LedgerStatus } from './ledger.js'

export const LEDGER_PROPOSAL_SCHEMA_VERSION = '1'

export type VerificationOutcome = 'pass' | 'fail' | 'waived'

export interface VerificationCriterion {
  criterionId: string
  outcome: VerificationOutcome
}

export interface VerificationRecord {
  runId: string
  sha: string
  outcome: VerificationOutcome
  evidence: string[]
  timestamp: string
  criteria: VerificationCriterion[]
}

export class VerificationRecordValidationError extends Error {
  readonly field: string

  constructor(field: string, message: string) {
    super(`${field}: ${message}`)
    this.name = 'VerificationRecordValidationError'
    this.field = field
  }
}

function fail(field: string, message: string): never {
  throw new VerificationRecordValidationError(field, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown, field: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    fail(field, `${label} must be a non-empty string`)
  return value
}

const OUTCOMES: VerificationOutcome[] = ['pass', 'fail', 'waived']

function parseOutcome(value: unknown, field: string): VerificationOutcome {
  if (typeof value !== 'string' || !OUTCOMES.includes(value as VerificationOutcome))
    fail(field, `unknown outcome ${JSON.stringify(value)} (expected "pass", "fail" or "waived")`)
  return value as VerificationOutcome
}

function parseSha(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{40}$/.test(value))
    fail(field, `commit sha ${JSON.stringify(value)} must be a 40-character hex commit sha`)
  return value.toLowerCase()
}

function parseTimestamp(value: unknown, field: string): string {
  const text = nonEmptyString(value, field, 'timestamp')
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(text))
    fail(
      field,
      `timestamp ${JSON.stringify(text)} must be a strict ISO-8601 instant (e.g. "2026-09-21T00:00:00.000Z")`,
    )
  const parsed = new Date(text)
  if (Number.isNaN(parsed.getTime()))
    fail(
      field,
      `timestamp ${JSON.stringify(text)} must be a strict ISO-8601 instant (e.g. "2026-09-21T00:00:00.000Z")`,
    )
  const canonical = parsed.toISOString()
  if (canonical !== text && canonical !== `${text.slice(0, -1)}.000Z`)
    fail(
      field,
      `timestamp ${JSON.stringify(text)} must be a strict ISO-8601 instant (e.g. "2026-09-21T00:00:00.000Z")`,
    )
  return canonical
}

function parseEvidence(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) fail(field, 'must be an array of evidence references')
  if (value.length === 0) fail(field, 'must carry at least one evidence reference')
  return value.map((entry, index) => {
    const link = nonEmptyString(entry, `${field}[${index}]`, 'evidence reference')
    if (/[\r\n]/.test(link)) fail(`${field}[${index}]`, 'evidence reference must not contain newlines')
    return link
  })
}

function validateCriterionId(id: string, field: string): string {
  if (id.includes(':'))
    fail(field, `criterion id "${id}" contains ":"; ":" is reserved for namespace prefixes`)
  if (/[/\\]|\.\./.test(id) || /[\x00-\x1f\x7f]/.test(id))
    fail(
      field,
      `criterion id ${JSON.stringify(id)} must not contain path separators, ".." or control characters`,
    )
  return id
}

function parseCriterionOutcome(value: unknown, index: number): VerificationCriterion {
  const base = `criteria[${index}]`
  if (!isRecord(value)) fail(base, 'criterion outcome must be a JSON object')
  for (const key of Object.keys(value)) {
    if (key !== 'criterionId' && key !== 'outcome') fail(`${base}.${key}`, 'unknown field in verification criterion')
  }
  const criterionId = validateCriterionId(
    nonEmptyString(value.criterionId, `${base}.criterionId`, 'criterion id'),
    `${base}.criterionId`,
  )
  return { criterionId, outcome: parseOutcome(value.outcome, `${base}.outcome`) }
}

export function parseVerificationRecord(input: unknown): VerificationRecord {
  if (!isRecord(input)) fail('record', 'verification record must be a JSON object')
  const allowed = new Set(['runId', 'sha', 'outcome', 'evidence', 'timestamp', 'criteria'])
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) fail(key, 'unknown field in verification record')
  }
  return {
    runId: nonEmptyString(input.runId, 'runId', 'run id'),
    sha: parseSha(input.sha, 'sha'),
    outcome: parseOutcome(input.outcome, 'outcome'),
    evidence: parseEvidence(input.evidence, 'evidence'),
    timestamp: parseTimestamp(input.timestamp, 'timestamp'),
    criteria: parseCriteria(input.criteria, 'criteria'),
  }
}

function parseCriteria(value: unknown, field: string): VerificationCriterion[] {
  if (!Array.isArray(value)) fail(field, 'must be an array of criterion outcomes')
  const seen = new Set<string>()
  const parsed = value.map((entry, index) => parseCriterionOutcome(entry, index))
  for (const criterion of parsed) {
    if (seen.has(criterion.criterionId))
      fail(field, `duplicate criterion "${criterion.criterionId}" in verification record`)
    seen.add(criterion.criterionId)
  }
  return parsed
}

export interface LedgerProposalChange {
  criterion: string
  from: LedgerStatus
  to: LedgerStatus
  reason: string
}

export interface LedgerProposal {
  schemaVersion: string
  runId: string
  proposedAt: string
  baseFingerprint: string
  baseSha: string
  outcome: VerificationOutcome
  body: { summary: string; changes: LedgerProposalChange[] }
  ledgerText: string
}

export function buildLedgerProposal(
  record: VerificationRecord,
  current: LedgerEntry[],
  baseFingerprint: string,
): LedgerProposal {
  const byCriterion = new Map(current.map((entry) => [entry.criterion, entry]))
  const changes: LedgerProposalChange[] = []
  for (const criterion of record.criteria) {
    if (criterion.outcome !== 'pass') continue
    const entry = byCriterion.get(criterion.criterionId)
    if (entry === undefined || entry.status !== 'proposed') continue
    changes.push({
      criterion: entry.criterion,
      from: entry.status,
      to: 'active',
      reason: `run ${record.runId}: pass on "${entry.criterion}" promotes proposed → active`,
    })
  }
  return {
    schemaVersion: LEDGER_PROPOSAL_SCHEMA_VERSION,
    runId: record.runId,
    proposedAt: record.timestamp,
    baseFingerprint,
    baseSha: record.sha,
    outcome: record.outcome,
    body: {
      summary: `run ${record.runId}: ${changes.length} criterion(s) proposed→active`,
      changes,
    },
    ledgerText: serializeLedger(current),
  }
}
