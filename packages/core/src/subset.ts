import type { LedgerEntry } from './ledger.js'
import { PLAN_SCHEMA_VERSION, type Plan } from './plan.js'
import { checkTarget } from './selection.js'

/**
 * One ledger criterion an orchestrator named, resolved against the ledger's
 * own state. The suites its checks name are what a run can execute for it;
 * its path references name code the checks exercise, which is selection's
 * business (#45) and not something a run can execute.
 */
export interface ResolvedCriterion {
  id: string
  text: string
  suites: string[]
}

export class CriteriaSubsetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CriteriaSubsetError'
  }
}

/**
 * Resolve the named criteria for a subset run (#46): every id named must
 * resolve, and the run is asked for exactly these, so the failure is
 * all-or-nothing — one error naming every id that cannot be served and the
 * state it is in, never a quiet skip. A criterion resolves when its ledger
 * statement is proposed or active; a criterion the ledger does not carry, or
 * one that is retired or superseded, is named and refused. A ledger carries
 * each criterion once — parseLedgerEntries refuses duplicates — so the entry
 * found is the criterion's single statement.
 */
export function resolveCriteriaSubset(entries: LedgerEntry[], ids: string[]): ResolvedCriterion[] {
  if (ids.length === 0)
    throw new CriteriaSubsetError('no criteria named: a subset run that names nothing has nothing to run')
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) throw new CriteriaSubsetError(`criterion ${id} is named more than once, and a subset run reports exactly the criteria it was asked for`)
    seen.add(id)
  }
  const offenders: string[] = []
  for (const id of ids) {
    const entry = entries.find((candidate) => candidate.criterion === id)
    if (entry === undefined) offenders.push(`${id} is not in the ledger`)
    else if (entry.status === 'retired') offenders.push(`${id} is retired`)
    else if (entry.status === 'superseded') offenders.push(`${id} is superseded`)
  }
  if (offenders.length > 0)
    throw new CriteriaSubsetError(`refused, so the run asks for exactly what it names: ${offenders.join(', ')}`)
  return ids.map((id) => {
    const entry = entries.find((candidate) => candidate.criterion === id)!
    const suites: string[] = []
    for (const check of entry.checks ?? []) {
      const target = checkTarget(check)
      if (target !== undefined && target.kind === 'suite') suites.push(target.suite)
    }
    return { id, text: entry.text ?? entry.criterion, suites }
  })
}

/**
 * The plan a subset run executes: one criterion per resolved entry, checked
 * by the suites its ledger checks name (a suite runs its own command, which
 * the runner executes without a browser), and unplannable when no check
 * names one, so the run reports why nothing executed rather than implying a
 * pass.
 */
export function criteriaSubsetPlan(resolved: ResolvedCriterion[]): Plan {
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    criteria: resolved.map((criterion): Plan['criteria'][number] =>
      criterion.suites.length === 0
        ? {
            id: criterion.id,
            text: criterion.text,
            unplannable: 'its ledger checks name no suite, so the runner has nothing to execute for it',
          }
        : {
            id: criterion.id,
            text: criterion.text,
            checks: criterion.suites.map((suite) => ({ kind: 'flow' as const, name: suite, suite })),
          },
    ),
  }
}
