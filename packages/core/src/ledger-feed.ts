import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FileLedgerStore, integrityOf } from './ledger.js'
import type { LedgerEntry } from './ledger.js'
import { buildLedgerProposal } from './ledger-proposal.js'
import type { VerificationCriterion, VerificationOutcome, VerificationRecord } from './ledger-proposal.js'

export const JOB_CRITERION_PREFIX = 'job'

export interface JobFeedCriterion {
  criterionId: string
  outcome: 'proven' | 'failed' | 'waived' | 'unverified'
}

export interface JobFeedInput {
  runId: string
  sha: string
  timestamp: string
  criteria: JobFeedCriterion[]
}

const OUTCOME_MAP: Record<string, VerificationOutcome> = {
  proven: 'pass',
  failed: 'fail',
  waived: 'waived',
}

export function feedJobProposals(job: JobFeedInput, current: LedgerEntry[]): VerificationRecord {
  void current
  const seen = new Set<string>()
  const criteria: VerificationCriterion[] = []
  for (const criterion of job.criteria) {
    if (seen.has(criterion.criterionId))
      throw new Error(`ledger feed: duplicate job criterion "${criterion.criterionId}"`)
    seen.add(criterion.criterionId)
    const mapped = OUTCOME_MAP[criterion.outcome]
    if (mapped === undefined) continue
    criteria.push({ criterionId: `${JOB_CRITERION_PREFIX}:${criterion.criterionId}`, outcome: mapped })
  }
  if (criteria.length === 0)
    throw new Error('ledger feed: no verifiable job criteria to feed (all unverified)')
  return {
    runId: job.runId,
    sha: job.sha,
    outcome: 'pass',
    evidence: [`run/${job.runId}`],
    timestamp: job.timestamp,
    criteria,
  }
}

export async function writeLedgerProposalPayload(
  dir: string,
  record: VerificationRecord,
  current: LedgerEntry[],
): Promise<void> {
  const proposal = buildLedgerProposal(record, current, integrityOf(current))
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, `ledger-proposal-${record.runId}.json`),
    `${JSON.stringify(proposal, null, 2)}\n`,
  )
}

const SHA_PATTERN = /^[0-9a-f]{40}$/

export async function feedRunLedger(
  dir: string,
  job: { id: string; headRef: string },
  criteria: JobFeedCriterion[],
): Promise<void> {
  if (!SHA_PATTERN.test(job.headRef))
    throw new Error(
      `ledger feed: headRef ${JSON.stringify(job.headRef)} must be a 40-character lowercase hex sha to feed the ledger`,
    )
  const store = new FileLedgerStore(dir)
  const current = await store.load()
  const record = feedJobProposals(
    {
      runId: job.id,
      sha: job.headRef,
      timestamp: new Date().toISOString(),
      criteria,
    },
    current,
  )
  await writeLedgerProposalPayload(dir, record, current)
}
