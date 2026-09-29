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
  if (promoted.size === 0) return { next, changes: [...changes] }
  // A promotion is a verification: the run proved the criterion, and the
  // history records when it was last proven and by what run (#58).
  const recorded = appendChange(changes, {
    kind: 'verify',
    actor: record.runId,
    timestamp: record.timestamp,
    reason: `run ${record.runId}: pass on ${promoted.size} criterion(s) promotes proposed → active`,
    criteria: [...promoted],
  })
  return { next, changes: recorded }
}
