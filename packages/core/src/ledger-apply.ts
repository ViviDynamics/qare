import { appendChange, integrityOf, type LedgerChange } from './ledger.js'
import type { LedgerEntry } from './ledger.js'
import { buildLedgerProposal } from './ledger-proposal.js'
import type { LedgerProposal, VerificationRecord } from './ledger-proposal.js'

export function applyLedgerProposal(
  proposal: LedgerProposal,
  record: VerificationRecord,
  current: LedgerEntry[],
  changes: LedgerChange[] = [],
): { next: LedgerEntry[]; changes: LedgerChange[] } {
  const fingerprint = integrityOf(current)
  if (proposal.baseFingerprint !== fingerprint)
    throw new Error(
      `ledger apply: proposal is stale: baseFingerprint ${proposal.baseFingerprint} does not match current ledger ${fingerprint}`,
    )
  for (const change of proposal.body.changes) {
    if (change.from !== 'proposed' || change.to !== 'active')
      throw new Error(
        `ledger apply: criterion "${change.criterion}" cannot be weakened by the run that needs it (proposed change ${change.from} → ${change.to})`,
      )
  }
  const expected = buildLedgerProposal(record, current, fingerprint)
  if (
    proposal.runId !== expected.runId ||
    proposal.proposedAt !== expected.proposedAt ||
    proposal.baseSha !== expected.baseSha ||
    proposal.outcome !== expected.outcome ||
    proposal.schemaVersion !== expected.schemaVersion ||
    proposal.ledgerText !== expected.ledgerText ||
    proposal.body.summary !== expected.body.summary ||
    proposal.body.changes.length !== expected.body.changes.length
  )
    throw new Error('ledger apply: proposal does not match its verification record')
  for (let index = 0; index < proposal.body.changes.length; index++) {
    const submitted = proposal.body.changes[index]
    const derived = expected.body.changes[index]
    if (submitted === undefined || derived === undefined ||
      submitted.criterion !== derived.criterion ||
      submitted.from !== derived.from ||
      submitted.to !== derived.to ||
      submitted.reason !== derived.reason
    )
      throw new Error('ledger apply: proposal does not match its verification record')
  }
  const promoted = new Set(proposal.body.changes.map((change) => change.criterion))
  const next = current.map((entry) =>
    promoted.has(entry.criterion) ? { ...entry, status: 'active' as const } : entry,
  )
  // Every criterion the run proved, promoted or already active, is recorded:
  // the ledger always knows when each statement was last proven, so a stale
  // criterion becomes current again the moment a later run passes it (#58).
  const proven = proposal.body.changes
    .map((change) => change.criterion)
    .concat(
      record.criteria
        .filter((criterion) => criterion.outcome === 'pass' && !promoted.has(criterion.criterionId))
        .map((criterion) => criterion.criterionId)
        .filter((id) => next.find((entry) => entry.criterion === id)?.status === 'active'),
    )
  if (proven.length === 0) return { next, changes: [...changes] }
  const promotedCount = promoted.size
  const reproven = proven.length - promotedCount
  const reason =
    promotedCount > 0
      ? `run ${record.runId}: pass on ${promotedCount} criterion(s) promotes proposed → active`
      : `run ${record.runId}: pass on ${reproven} criterion(s), already active`
  // A promotion is a verification: the history records when each criterion
  // was last proven and by what run.
  const recorded = appendChange(changes, {
    kind: 'verify',
    actor: record.runId,
    timestamp: record.timestamp,
    reason,
    criteria: proven,
  })
  return { next, changes: recorded }
}
