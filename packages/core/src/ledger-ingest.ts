import { BROWSER_FLOW_DRIVER } from './flow-playwright.js'
import { normalizeWording } from './criterion-identity.js'
import { IssueCriteriaError, criteriaFromIssue } from './issue-criteria.js'
import { integrityOf, serializeLedger, type LedgerEntry } from './ledger.js'
import { type PlanCriterion } from './plan.js'
import { NO_DIFF, planRun, type PlanCriterionInput } from './plan-step.js'
import type { AgentRunner } from './runner.js'

/**
 * One place a criterion was stated, in the words ingest read it in: an issue
 * or a pull request body, with the author of that body and the canonical link
 * back to it. Proposals name every source that stated their criterion, so a
 * ledger reader can trace the rule to where it was asked for.
 */
export interface IngestSource {
  kind: 'issue' | 'pr'
  number: number
  author: string
  link: string
  body: string
}

/** A criterion already in the ledger under the same wording, so not proposed. */
export interface IngestDuplicate {
  id: string
  text: string
  status: string
  sources: IngestSource[]
}

/** A criterion no check can prove, with the reason and where it was stated. */
export interface UncheckableCriterion {
  id: string
  text: string
  sources: IngestSource[]
  why: string
}

export interface IngestOutcome {
  proposals: LedgerEntry[]
  duplicates: IngestDuplicate[]
  uncheckable: UncheckableCriterion[]
  /** The existing ledger with the proposals folded in, canonically serialized. */
  ledgerText: string
  /** The integrity of the resulting entries, which names the proposal branch. */
  fingerprint: string
}

/**
 * Turn the acceptance criteria stated in issues and pull requests into
 * proposals for the criteria ledger (#37).
 *
 * Every source is read on its own and the same wording counts once. A
 * criterion the ledger already carries is reported as a duplicate and never
 * proposed again, whatever its status: active, retired and superseded rules
 * were all decided by a human, and a second entry under the same words would
 * not be. A criterion the planner cannot map to a runnable check is reported
 * as uncheckable and never proposed: an entry nobody can prove is noise. What
 * is left becomes a `proposed` entry whose source links name where the words
 * came from, whose proof suggests the kind of check that would carry it, and
 * whose note carries the words themselves.
 */
export async function ingestCriteria(
  sources: IngestSource[],
  opts: {
    ledger: LedgerEntry[]
    planner: AgentRunner
    suites?: string[]
    target?: string
  },
): Promise<IngestOutcome> {
  const stated = groupByWording(sources)
  const duplicates: IngestDuplicate[] = []
  const candidates: PlanCriterionInput[] = []
  for (const [id, candidate] of stated) {
    // Two ways to say "the ledger already carries this": the entry's id is the
    // wording's hash, the way every pipeline-adopted entry is named, or the
    // entry's note carries the same words, which covers a rule adopted under a
    // hand-minted id. Either way the wording is decided, so not proposing.
    const existing = opts.ledger.find(
      (entry) => entry.criterion === id || normalizeWording(entry.note ?? '') === normalizeWording(candidate.text),
    )
    if (existing !== undefined) {
      duplicates.push({ id, text: candidate.text, status: existing.status, sources: candidate.sources })
      continue
    }
    candidates.push({ id, text: candidate.text })
  }

  // The planner is asked once, with no diff under review: these are one-off
  // checks of the app as it runs now, not criteria about a change. When every
  // criterion is already carried there is nothing to plan, and planning is
  // skipped rather than failing, because duplicates are the day's normal work.
  // A planner that cannot run at all fails the ingest rather than marking
  // every criterion uncheckable, because an outage is not a judgement about
  // the words and no comment should be posted in its name.
  const plan =
    candidates.length === 0
      ? { criteria: [] as PlanCriterion[] }
      : await planRun(opts.planner, {
          criteria: candidates,
          ...(opts.suites === undefined ? {} : { suites: opts.suites }),
          ...(opts.target === undefined ? {} : { target: opts.target }),
          driver: BROWSER_FLOW_DRIVER,
          diff: NO_DIFF,
        })
  const planned = new Map<string, PlanCriterion>(plan.criteria.map((criterion) => [criterion.id, criterion]))

  const proposals: LedgerEntry[] = []
  const uncheckable: UncheckableCriterion[] = []
  for (const candidate of candidates) {
    const plannedCriterion = planned.get(candidate.id)
    if (plannedCriterion === undefined)
      throw new Error(`ledger ingest: the plan does not cover criterion ${candidate.id}`)
    if ('unplannable' in plannedCriterion) {
      uncheckable.push({
        id: candidate.id,
        text: candidate.text,
        sources: stated.get(candidate.id)!.sources,
        why: plannedCriterion.unplannable,
      })
      continue
    }
    proposals.push({
      criterion: candidate.id,
      status: 'proposed',
      source: stated.get(candidate.id)!.sources.map((source) => source.link),
      proof: proofFor(plannedCriterion.checks),
      note: candidate.text,
    })
  }

  const resulting = [...opts.ledger, ...proposals]
  return {
    proposals,
    duplicates,
    uncheckable,
    ledgerText: serializeLedger(resulting),
    fingerprint: integrityOf(resulting),
  }
}

interface GroupedCriterion {
  text: string
  sources: IngestSource[]
}

function groupByWording(sources: IngestSource[]): Map<string, GroupedCriterion> {
  const grouped = new Map<string, GroupedCriterion>()
  for (const source of sources) {
    let stated: PlanCriterionInput[]
    try {
      stated = criteriaFromIssue(source.body)
    } catch (error) {
      if (error instanceof IssueCriteriaError && error.problem === 'none-stated') continue
      if (error instanceof IssueCriteriaError)
        throw new IssueCriteriaError(error.problem, `${source.kind} #${source.number}: ${error.message}`)
      throw error
    }
    for (const criterion of stated) {
      const group = grouped.get(criterion.id) ?? { text: criterion.text, sources: [] }
      if (!group.sources.some((seen) => seen.link === source.link)) group.sources.push(source)
      grouped.set(criterion.id, group)
    }
  }
  return grouped
}

/** Every check a command proves stays a command; anything else needs a flow. */
function proofFor(checks: { kind?: string }[]): string {
  return checks.length > 0 && checks.every((check) => check.kind === 'command') ? 'command' : 'flow'
}

/**
 * The marker that ties a comment to one criterion, so a rerun never repeats
 * itself: the marker is content-addressed to the words, so the same words
 * comment once and reworded ones comment again.
 */
export function ingestCommentMarker(criterionId: string): string {
  return `qare-ingest:${criterionId}`
}

/**
 * Whether an issue's comments already carry the marker, which is how a rerun
 * keeps its promise to comment once.
 */
export function hasIngestComment(comments: string[], criterionId: string): boolean {
  const marker = ingestCommentMarker(criterionId)
  return comments.some((body) => body.includes(marker))
}

/**
 * Where the house style for acceptance criteria is written down (#56). Ingest
 * links it wherever it asks a human for a rewrite, so the ask carries its own
 * how-to: one behavior per criterion, a stated proof type, an observable
 * outcome.
 */
export const WRITING_CRITERIA_GUIDE =
  'https://github.com/ViviDynamics/qare/blob/main/docs/writing-criteria.md'

/**
 * The comment an uncheckable criterion earns: it names the author of the
 * source that stated the criterion, says why no check can carry it, and asks
 * for a wording a check can prove, with the marker hidden inside.
 */
export function renderUncheckableComment(uncheckable: UncheckableCriterion): string {
  const author = uncheckable.sources[0]?.author
  return [
    `${author === undefined ? 'This criterion' : `@${author}`} — the criterion \`${uncheckable.text}\` cannot be proposed to the criteria ledger as written: ${uncheckable.why}.`,
    '',
    `To propose it, restate it as something a check can prove: name what to run or what to do, and what should hold as a result (for example, \`the payouts page shows the 1099 notice for a host paid past the annual threshold\`). Once the wording states an observable outcome, ingest will propose it. The house style, with worked rewrites of weak criteria, is the criteria guide: ${WRITING_CRITERIA_GUIDE}.`,
    '',
    `<!-- ${ingestCommentMarker(uncheckable.id)} -->`,
  ].join('\n')
}


