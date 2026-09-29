import type { LedgerEntry } from './ledger.js'
import { pathUnderArea } from './monorepo.js'
import { DEFAULT_CHECK_TIMEOUT_MS } from './run.js'

/**
 * One check reference a ledger entry declares, resolved to what it touches.
 *
 * A reference is either `suite:<name>`, naming a suite whose checks drive
 * screens, or a repository-relative path with an optional `:fragment` after
 * it (a line number, a test name), which names the code the check exercises.
 * A reference that parses to neither, such as a bare `suite:` with no name,
 * is unusable and contributes nothing: the mapping misses quietly rather
 * than inventing a target.
 */
export type CheckTarget = { kind: 'suite'; suite: string } | { kind: 'path'; path: string }

export function checkTarget(check: string): CheckTarget | undefined {
  if (check.startsWith('suite:')) {
    const suite = check.slice('suite:'.length)
    return suite === '' || /[\s:]/.test(suite) ? undefined : { kind: 'suite', suite }
  }
  const at = check.indexOf(':')
  const path = at === -1 ? check : check.slice(0, at)
  if (path === '') return undefined
  return { kind: 'path', path }
}

/**
 * The standing smoke suite: a criterion whose checks name it runs on every
 * selection, whatever the diff touches. It is a suite name, so an entry opts
 * in with a `suite:smoke` check reference.
 */
export const DEFAULT_SMOKE_SUITE = 'smoke'

/** The estimated cost of one check when nothing better is declared. */
export const DEFAULT_SELECTION_BUDGET_MS = 900000

export type SelectedReason = 'impact' | 'smoke' | 'unmapped'

export type UnselectedReason = 'unaffected' | 'budget' | 'status'

export interface SelectedCriterion {
  criterion: string
  text?: string
  reason: SelectedReason
}

export interface UnselectedCriterion {
  criterion: string
  text?: string
  reason: UnselectedReason
  /** For `status`, which status keeps it from running. */
  detail?: string
}

export interface SelectionReport {
  selected: SelectedCriterion[]
  notSelected: UnselectedCriterion[]
  touched: string[]
  budgetMs: number
  estimatedMs: number
}

export interface SelectionOptions {
  touched: string[]
  /** Selection stops adding criteria when the estimated cost would exceed it. */
  budgetMs?: number
  smokeSuite?: string
  /** The estimated cost of one check, when no per-check cost is declared. */
  checkCostMs?: number
}

/**
 * Two paths overlap when either sits at a segment boundary inside the other:
 * a check that names `apps/billing` is affected by a change to
 * `apps/admin-ui`, never by one to `apps/admin/src`, and the reverse holds,
 * so a check under a directory a change deletes is selected too.
 */
function overlaps(touched: string, path: string): boolean {
  return pathUnderArea(touched, path) || pathUnderArea(path, touched)
}

/**
 * Select the criteria a change could affect (#45).
 *
 * The mapping is the ledger's own: each entry declares the checks it is
 * verified by, and each check names the code it exercises or the suite whose
 * screens it drives. A criterion is selected when a check's code path overlaps
 * a touched path, when it names the standing smoke suite, or when the ledger
 * maps it to nothing a diff can be matched against: what cannot be proven
 * unaffected runs, so selection errs toward checking more, never less. What
 * was not selected is reported, never passed.
 *
 * The smoke set runs first and is never cut by the budget; the criteria the
 * diff points at fill what remains of it, then the unmapped ones. Every
 * bucket is ordered by criterion id, so the same ledger and the same diff
 * select the same criteria.
 */
export function selectCriteria(entries: LedgerEntry[], options: SelectionOptions): SelectionReport {
  const smokeSuite = options.smokeSuite ?? DEFAULT_SMOKE_SUITE
  const checkCostMs = options.checkCostMs ?? DEFAULT_CHECK_TIMEOUT_MS
  const touched = [...options.touched].sort()
  const budgetMs = options.budgetMs ?? DEFAULT_SELECTION_BUDGET_MS

  const byId = (a: LedgerEntry, b: LedgerEntry): number => (a.criterion < b.criterion ? -1 : a.criterion > b.criterion ? 1 : 0)
  const withText = (entry: LedgerEntry): { criterion: string; text?: string } =>
    entry.text === undefined ? { criterion: entry.criterion } : { criterion: entry.criterion, text: entry.text }

  const impact: Array<{ item: SelectedCriterion; cost: number; standing: boolean }> = []
  const smoke: Array<{ item: SelectedCriterion; cost: number }> = []
  const unmapped: Array<{ item: SelectedCriterion; cost: number }> = []
  const notSelected: UnselectedCriterion[] = []

  for (const entry of [...entries].sort(byId)) {
    const base = withText(entry)
    if (entry.status === 'superseded' || entry.status === 'retired') {
      notSelected.push({ ...base, reason: 'status', detail: entry.status })
      continue
    }
    const checks = entry.checks ?? []
    const targets = checks.map(checkTarget).filter((target) => target !== undefined) as CheckTarget[]
    const paths = targets.filter((target) => target.kind === 'path').map((target) => target.path)
    const cost = Math.max(1, checks.length) * checkCostMs
    const isSmoke = targets.some((target) => target.kind === 'suite' && target.suite === smokeSuite)
    const isImpact = paths.some((path) => touched.some((touchedPath) => overlaps(touchedPath, path)))
    if (isImpact) {
      // The reason the diff selects it outranks the smoke suite, but a smoke
      // criterion stands above the budget whichever reason names it.
      impact.push({ item: { ...base, reason: 'impact' }, cost, standing: isSmoke })
      continue
    }
    if (isSmoke) {
      smoke.push({ item: { ...base, reason: 'smoke' }, cost })
      continue
    }
    if (paths.length === 0) {
      // No code path to match a diff against, whatever else the entry names:
      // a suite's screens cannot be mapped to code without inventing it.
      unmapped.push({ item: { ...base, reason: 'unmapped' }, cost })
      continue
    }
    notSelected.push({ ...base, reason: 'unaffected' })
  }

  const selected: SelectedCriterion[] = []
  let estimatedMs = 0
  const fits = (cost: number): boolean => estimatedMs + cost <= budgetMs
  for (const { item, cost } of smoke) {
    // The smoke set stands: it is selected whatever the budget says, and the
    // estimate is honest when it passes the budget.
    selected.push(item)
    estimatedMs += cost
  }
  for (const { item, cost, standing } of impact) {
    if (standing || fits(cost)) {
      selected.push(item)
      estimatedMs += cost
    } else notSelected.push({ ...item, reason: 'budget' })
  }
  for (const { item, cost } of unmapped) {
    if (fits(cost)) {
      selected.push(item)
      estimatedMs += cost
    } else notSelected.push({ ...item, reason: 'budget' })
  }
  return { selected, notSelected, touched, budgetMs, estimatedMs }
}

