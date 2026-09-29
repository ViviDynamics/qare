import type { Contradiction } from './ledger-contradict.js'
import { createHash } from 'node:crypto'
import { verdictOf, type CriterionVerdict } from './judge.js'
import type { ResolutionClassification } from './ledger.js'
import type { RunResult } from './result.js'

export const QUESTION_MARKER_PREFIX = '<!-- qare:question '

/**
 * Where a conflict came from, and so where its question may go (#41). A pull
 * request's conflicts ride that PR's evidence comment; a conflict in the
 * criteria themselves goes to the linked issue, mentioning its author; a
 * sweep's conflict goes to the finding's issue, mentioning the person the
 * finding blames.
 */
export type ResolutionSource =
  | { kind: 'pull-request' }
  | { kind: 'criteria-issue'; issue: number; author: string }
  | { kind: 'sweep'; finding: number; blame?: string }

/**
 * A conflict the resolution order settled without a word from anyone. The
 * recorded classification is the answer's, which a human gave when the
 * question was answered and the ledger keeps with who decided and why.
 */
export interface SettledConflict {
  criterion: string
  replacement?: string
  classification: ResolutionClassification
  basis: 'executed-evidence' | 'ledger-history'
  /** The recorded decision, when history settled it. */
  by?: string
  why?: string
}

/** One question, asked once, with QARE's recommendation and a default. */
export interface ResolutionQuestion {
  /** Content-addressed over the conflict's pair, so the same conflict is the same question everywhere. */
  id: string
  criterion: string
  replacement?: string
  /** QARE's recommendation for the pair, from the classifier's word. */
  recommendation: ResolutionClassification
  reason: string
  source: ResolutionSource
}

export interface ResolutionReport {
  settled: SettledConflict[]
  questions: ResolutionQuestion[]
}

/** The criteria a question holds: the conflicted rule and, when named, its replacement. */
export function affectedBy(question: ResolutionQuestion): string[] {
  return question.replacement === undefined
    ? [question.criterion]
    : [question.criterion, question.replacement]
}

/**
 * The question id for a conflict: content-addressed over the pair of criteria
 * it is about, never over the run. The same conflict in a later run is the
 * same question, so a question asked once is found again by id — on GitHub,
 * by the marker, and in the ledger, by the recorded answer.
 */
export function questionIdFor(criterion: string, replacement?: string): string {
  const hash = createHash('sha256')
    .update(`${criterion}\u0000${replacement ?? ''}`, 'utf8')
    .digest('hex')
  return `q-${hash.slice(0, 16)}`
}

export function questionMarker(id: string): string {
  return `${QUESTION_MARKER_PREFIX}${id} -->`
}

function recordedAnswer(
  ledger: Array<{ resolution?: { question: string; classification: ResolutionClassification; by: string; why: string } }>,
  questionId: string,
): { classification: ResolutionClassification; by: string; why: string } | undefined {
  for (const entry of ledger) {
    const resolution = entry.resolution
    if (resolution?.question === questionId) return resolution
  }
  return undefined
}

/**
 * The resolution order (#41): executed evidence settles a conflict first; the
 * ledger's own history — the recorded answers — settles it second; a question
 * is asked last, one per conflict, with QARE's recommendation attached and the
 * hold as the default. Nothing is applied here: a settled supersede is still
 * only as authoritative as the ledger entry that carries it, and a question's
 * default holds the affected criteria until a human answers.
 */
export function resolveContradictions(
  contradictions: Contradiction[],
  ledger: Array<{ resolution?: { question: string; classification: ResolutionClassification; by: string; why: string } }>,
  source: ResolutionSource,
): ResolutionReport {
  const settled: SettledConflict[] = []
  const questions = new Map<string, ResolutionQuestion>()
  for (const contradiction of contradictions) {
    if (contradiction.basis === 'executed-evidence') {
      settled.push({
        criterion: contradiction.criterion,
        ...(contradiction.replacement === undefined ? {} : { replacement: contradiction.replacement }),
        classification: contradiction.classification,
        basis: 'executed-evidence',
      })
      continue
    }
    const id = questionIdFor(contradiction.criterion, contradiction.replacement)
    const answer = recordedAnswer(ledger, id)
    if (answer !== undefined) {
      settled.push({
        criterion: contradiction.criterion,
        ...(contradiction.replacement === undefined ? {} : { replacement: contradiction.replacement }),
        classification: answer.classification,
        basis: 'ledger-history',
        by: answer.by,
        why: answer.why,
      })
      continue
    }
    if (questions.has(id)) continue
    questions.set(id, {
      id,
      criterion: contradiction.criterion,
      ...(contradiction.replacement === undefined ? {} : { replacement: contradiction.replacement }),
      recommendation: contradiction.classification,
      reason: contradiction.reason,
      source,
    })
  }
  return { settled, questions: [...questions.values()] }
}

/**
 * Hold the criteria an open question touches (#41). Only the affected
 * criteria are held: a failed criterion does not red the run while the
 * question over it is open — it is held `unverified` with the question named
 * — and a proven criterion is never touched, because evidence proved it and
 * no question unproves it. The verdict is recomputed by the one rule judge
 * uses, so a held run reads `blocked`, never a silent pass, and a refused
 * run stays refused.
 */
export function holdForQuestions(result: RunResult, questions: ResolutionQuestion[]): RunResult {
  if (questions.length === 0) return result
  const held = new Map(questions.flatMap((question) => affectedBy(question).map((id) => [id, question])))
  const criteria = result.criteria.map((criterion) => {
    const question = held.get(criterion.id)
    if (question === undefined) return criterion
    if (criterion.outcome === 'proven') return criterion
    const reason = `held for an open question (${question.id}) — ${question.reason}`
    return criterion.outcome === 'unverified' ? { ...criterion, reason } : { ...criterion, outcome: 'unverified' as const, reason }
  })
  if (result.verdict === 'refused') return { ...result, criteria }
  const waived = new Set((result.waived ?? []).map((waiver) => waiver.criterionId))
  const verdicts = verdictsOf(criteria)
  // A held criterion is no longer a failure, so the regressions the run
  // recorded stand: they are outcomes the base side proved, not questions.
  const verdict = verdictOf(verdicts, [], waived)
  // Each app's summary is recomputed from the same rule over its subset, so
  // the heading cannot contradict the table (the stale-summary problem #55).
  const profiles = result.profiles?.map((profile) => {
    const ids = new Set(profile.criteria)
    return { ...profile, verdict: verdictOf(verdicts.filter((verdict) => ids.has(verdict.criterionId)), [], waived) }
  })
  return profiles === undefined ? { ...result, verdict, criteria } : { ...result, verdict, criteria, profiles }
}

function verdictsOf(criteria: RunResult['criteria']): CriterionVerdict[] {
  return criteria.map((criterion) => ({
    criterionId: criterion.id,
    outcome: criterion.outcome,
    // A held criterion is not a regression: the base side proved nothing
    // here, and the hold exists so the question, not the failure, is read.
    regression: false,
    reason: 'reason' in criterion && typeof criterion.reason === 'string' ? criterion.reason : '',
  }))
}

/**
 * The question as a GitHub comment body: the conflict in the pair's own
 * words, QARE's recommendation with its reason, and the default — hold — made
 * plain. The marker at the top is how "asked once" is found again, and the
 * mention is placed by the poster, never rendered into the body from unvetted
 * text.
 */
export function renderQuestion(question: ResolutionQuestion): string {
  const pair = question.replacement === undefined
    ? `\`${question.criterion}\``
    : `\`${question.replacement}\` replacing \`${question.criterion}\``
  return [
    questionMarker(question.id),
    '',
    '## QARE asks',
    '',
    `The change conflicts with ${pair}, and the evidence could not settle whether that is intended.`,
    '',
    `QARE's recommendation: **${question.recommendation === 'supersede' ? 'the old rule is superseded on purpose' : 'this is an unintended regression'}**.`,
    '',
    `Why: ${question.reason}`,
    '',
    'Until someone answers, only these criteria are held as `unverified`; the rest of the run reports normally. An answer is recorded in the ledger with who decided and why.',
  ].join('\n')
}
