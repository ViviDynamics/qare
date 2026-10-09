import { createHash } from 'node:crypto'
import type { LedgerDocument } from './ledger.js'
import { standingMainPasses, type MainPasses } from './main-passes.js'
import type { CriterionResult, RunResult } from './result.js'

/**
 * Findings on `main` (#154). A run against `main` has no pull request to
 * comment on, so what it finds becomes GitHub issues: one per problem, found
 * again by a hidden marker (the pattern of the stub issues, #31), updated
 * while the problem stands and closed when a run proves the criterion again.
 *
 * Everything here is decided in code from the executed result and the ledger
 * (rule 3): which criteria are findings, of which kind, who is named and why.
 * No model output is read. Nothing here touches the network; the judge-side
 * step that holds the GitHub identity does the asking and the writing.
 */

/** The label a regression carries: the documented signal an orchestrator picks an issue up by. */
export const QA_REGRESSION_LABEL = 'qa-regression'
/** The label of the one issue a run files when nothing could boot or be reached. */
export const QA_ENVIRONMENT_LABEL = 'qa-environment'
/** The label of a failure nothing shows ever passed: not a regression, so never handed off as one. */
export const QA_FAILURE_LABEL = 'qa-failure'

export const ENVIRONMENT_FINGERPRINT = 'mf-environment'

/**
 * When a criterion last passed: the run that proved it, and when. It comes
 * from the ledger's last `verify` record naming the criterion, or from the
 * record of passes on the default branch (#295), which also names the
 * revision that passed.
 */
export interface LastProven {
  run: string
  at: string
  /** The revision the passing run checked, when the record of passes names it. */
  sha?: string
  /** When the pass was recorded, which is when the run that proved it finished, when the record of passes says. */
  recordedAt?: string
}

/** A criterion a run on `main` failed. */
export interface MainFinding {
  kind: 'regression' | 'failure'
  fingerprint: string
  criterionId: string
  /** The criterion in plain words, when the ledger carries them. */
  text?: string
  /**
   * Set when the record of passes holds a pass of the very revision this
   * run checked (#295): the criterion passed here, in that run, and fails
   * here now. Nothing landed in between, so it is a failure of the revision
   * and not a regression from an earlier one, and no older pass is its
   * last pass.
   */
  passedHere?: { run: string; recordedAt?: string }
  outcome: 'failed'
  /** Why, when something other than the check itself decided it failed. */
  reason?: string
  evidence: string[]
  /** The check references the ledger maps the criterion to: what blame reads a pull request's files against. */
  checks: string[]
  /** When the ledger last saw it pass. Absent: the ledger has no record of a pass. */
  lastProven?: LastProven
}

/** A run in which nothing could boot or be reached: one finding for the whole run. */
export interface EnvironmentFinding {
  kind: 'environment'
  fingerprint: typeof ENVIRONMENT_FINGERPRINT
  /** The distinct reasons the criteria carry, in the order they first appear. */
  reasons: string[]
  /** The criteria the run could not check. */
  criteria: string[]
}

export interface MainRunClassification {
  /** Set when nothing booted; the run then has no per-criterion findings. */
  environment?: EnvironmentFinding
  findings: MainFinding[]
  /** Criteria the run proved: an open issue for one of them is closed. */
  recovered: string[]
  /** Criteria held by a quarantined check (#50): they file nothing and prove nothing. */
  flaky: string[]
  /** A check executed, so the environment came up: an open environment issue is closed. */
  environmentUp: boolean
}

type UnverifiedCause = 'waived' | 'quarantine' | 'verifier' | 'held' | 'refused' | 'not-selected' | 'unplanned' | 'environment'

/**
 * Why a criterion is unverified, read from the start of its reason, where the
 * code that wrote it names the cause. Only what none of the named causes
 * claims is the environment. A criterion nothing was planned for (#294: on
 * main, one whose ledger checks name no suite) was never run, which says
 * nothing about whether the app boots, so it is not the environment either.
 */
function unverifiedCause(reason: string): UnverifiedCause {
  if (reason.startsWith('waived by ')) return 'waived'
  if (reason.startsWith('quarantined')) return 'quarantine'
  if (reason.startsWith('verifier ')) return 'verifier'
  if (reason.startsWith('held for an open question')) return 'held'
  if (reason.startsWith('refused: ')) return 'refused'
  if (reason.startsWith('not selected')) return 'not-selected'
  if (reason.startsWith('the planner could not plan it')) return 'unplanned'
  return 'environment'
}

/**
 * The check an evidence path belongs to: `checks/<criterion>/<index>`, with a
 * repeated attempt folded into the check it repeats, so a flake policy that
 * ran a check twice does not change what failed.
 */
function checkOf(path: string): string {
  const parts = path.split(/[\\/]/)
  if (parts[0] === 'checks' && parts.length >= 3) return `checks/${parts[1] ?? ''}/${(parts[2] ?? '').replace(/-attempt\d+$/, '')}`
  return parts.length > 1 ? parts.slice(0, -1).join('/') : ''
}

/**
 * The fingerprint of a finding: the criterion id plus a failure signature,
 * the checks that produced the evidence and how the criterion failed (its
 * checks, or the verifier overturning them). The reason's wording and the
 * files' names stay out: they move between runs of the same problem, and a
 * fingerprint that moved would open a second issue for it.
 */
export function mainFindingFingerprint(criterionId: string, outcome: 'failed', evidence: string[], reason?: string): string {
  const checks = [...new Set(evidence.map(checkOf))].sort()
  const how = reason !== undefined && unverifiedCause(reason) === 'verifier' ? 'verifier' : 'check'
  const digest = createHash('sha256').update(JSON.stringify([criterionId, outcome, how, checks]), 'utf8').digest('hex')
  return `mf-${digest.slice(0, 16)}`
}

function lastProvenOf(ledger: LedgerDocument, passes: MainPasses | undefined): Map<string, LastProven> {
  const last = new Map<string, LastProven>()
  for (const change of ledger.changes) {
    if (change.kind !== 'verify') continue
    for (const criterion of change.criteria) last.set(criterion, { run: change.actor, at: change.timestamp })
  }
  if (passes === undefined) return last
  // The record of passes on the default branch (#295): a pass that still
  // stands for the criterion as the ledger words it today. Where the ledger
  // records one too, the later of the two is the last pass.
  for (const [criterion, pass] of standingMainPasses(passes, ledger)) {
    const recorded = last.get(criterion)
    const later = recorded === undefined || !(Date.parse(recorded.at) > Date.parse(pass.at))
    if (later) last.set(criterion, { run: pass.run, at: pass.at, sha: pass.sha, recordedAt: pass.recordedAt })
  }
  return last
}

function reasonOf(criterion: CriterionResult): string | undefined {
  return 'reason' in criterion && typeof criterion.reason === 'string' ? criterion.reason : undefined
}

/**
 * What a judged result of a run on `main` amounts to. A failed criterion is
 * a finding: a regression when the ledger recorded a pass, the record of
 * passes on the default branch holds one that still stands (#295), or the
 * run's own base side proved it (#147), a plain failure otherwise. A proven criterion
 * recovers. A run in which no check executed and every criterion is
 * unverified for the environment's sake is one environment finding. A
 * quarantined check, a waiver, a held question and a refusal file nothing:
 * each has a place of its own.
 */
export function classifyMainRun(result: RunResult, ledger: LedgerDocument, passes?: MainPasses, headSha?: string): MainRunClassification {
  const lastProven = lastProvenOf(ledger, passes)
  // The passes of the revision this run checked: a criterion that fails
  // where it passed has no earlier revision to have regressed from.
  const here = new Map(
    passes === undefined || headSha === undefined ? [] : [...standingMainPasses(passes, ledger)].filter(([, pass]) => pass.sha === headSha),
  )
  const entries = new Map(ledger.entries.map((entry) => [entry.criterion, entry]))
  const findings: MainFinding[] = []
  const recovered: string[] = []
  const flaky: string[] = []
  const down: Array<{ id: string; reason: string }> = []
  let unplanned = 0
  for (const criterion of result.criteria) {
    if (criterion.outcome === 'proven') {
      recovered.push(criterion.id)
      continue
    }
    if (criterion.outcome === 'unverified') {
      const cause = unverifiedCause(criterion.reason)
      if (cause === 'quarantine') flaky.push(criterion.id)
      if (cause === 'environment') down.push({ id: criterion.id, reason: criterion.reason })
      if (cause === 'unplanned') unplanned += 1
      continue
    }
    const entry = entries.get(criterion.id)
    const passedHere = here.get(criterion.id)
    // A pass of this revision stands in the way of any older one: it is the
    // last pass there is, and it is not one to count changes from.
    const proven = passedHere === undefined ? lastProven.get(criterion.id) : undefined
    const reason = reasonOf(criterion)
    findings.push({
      kind: proven !== undefined || criterion.regression === true ? 'regression' : 'failure',
      fingerprint: mainFindingFingerprint(criterion.id, 'failed', criterion.evidence, reason),
      criterionId: criterion.id,
      ...(entry?.text === undefined ? {} : { text: entry.text }),
      outcome: 'failed',
      ...(reason === undefined ? {} : { reason }),
      evidence: [...criterion.evidence],
      checks: [...(entry?.checks ?? [])],
      ...(proven === undefined ? {} : { lastProven: proven }),
      ...(passedHere === undefined ? {} : { passedHere: { run: passedHere.run, recordedAt: passedHere.recordedAt } }),
    })
  }
  const environmentUp = recovered.length > 0 || findings.length > 0
  // Nothing executed and everything that could have run is unverified for the
  // environment's sake: the run could not boot or reach the app. One finding,
  // whatever the count. A criterion nothing was planned for could not have
  // run in any environment, so it neither makes this finding nor hides it.
  if (result.verdict === 'blocked' && !environmentUp && down.length > 0 && down.length === result.criteria.length - unplanned) {
    return {
      environment: {
        kind: 'environment',
        fingerprint: ENVIRONMENT_FINGERPRINT,
        reasons: [...new Set(down.map((entry) => entry.reason))],
        criteria: down.map((entry) => entry.id),
      },
      findings: [],
      recovered: [],
      flaky,
      environmentUp: false,
    }
  }
  return { findings, recovered, flaky, environmentUp }
}
