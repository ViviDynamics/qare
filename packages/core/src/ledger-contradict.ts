import { criterionIdFor } from './issue-criteria.js'
import { integrityOf, serializeLedger, type LedgerEntry } from './ledger.js'
import type { AgentRunner } from './runner.js'

export const CONTRADICTION_SCHEMA_VERSION = '1'

/**
 * What a run said about one criterion it covered (#40). The id is the one the
 * run was given: content-addressed when the criteria came off an issue, and
 * the words themselves are not carried here, so a ledger entry is matched by
 * its id, or by its own words when the entry carries them in `note`.
 */
export interface ExecutedCriterion {
  id: string
  outcome: 'proven' | 'failed' | 'unverified'
  /** Why the verifier failed it, when it said why. */
  reason?: string
}

/** A new or changed rule the diff proposes, with the words it was stated in. */
export interface IntroducedCriterion {
  id: string
  text: string
}

/**
 * One conflict between an active ledger entry and what the change did to it.
 * `basis` records what settled the classification: executed evidence, or the
 * classifier's word when the evidence was silent. A supersede is only ever
 * proposed here, never applied.
 */
export interface Contradiction {
  criterion: string
  criterionText?: string
  replacement?: string
  classification: 'supersede' | 'regression'
  basis: 'executed-evidence' | 'model'
  reason: string
}

/**
 * The fold one supersede would apply to the ledger: the old rule stands down
 * and names what replaced it. Never applied by this step.
 */
export interface ContradictionChange {
  criterion: string
  from: 'active'
  to: 'superseded'
  replacement?: string
  basis: 'executed-evidence' | 'model'
  reason: string
}

export interface ContradictionReport {
  schemaVersion: string
  runId: string
  contradictions: Contradiction[]
  changes: ContradictionChange[]
  /** The ledger with the proposal folded in, canonically serialized. */
  ledgerText: string
  /** The integrity of the folded entries, which names the proposal branch. */
  fingerprint: string
}

export interface ContradictionInput {
  runId: string
  executed: ExecutedCriterion[]
  introduced: IntroducedCriterion[]
  ledger: LedgerEntry[]
  /** The model second: without one, every failure stands as a regression. */
  classifier?: AgentRunner
  /** The change under test, as context for the classifier. */
  diff?: string
}

export class ContradictionClassifierError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContradictionClassifierError'
  }
}

class CorrectionNeeded extends Error {}

const CLASSIFIER_SYSTEM =
  'You read a criteria ledger and the evidence a change just produced. ' +
  'The ledger holds active rules the product already honored. The change ' +
  'under test introduced new or changed rules, and the run executed both ' +
  'kinds: some rules were proven, some failed. You propose which active ' +
  'rules the change contradicts, and, when it does, which introduced rule ' +
  'would replace one. You propose a pair only for a rule the evidence ' +
  'failed or that the change plainly puts at odds. You never decide a ' +
  'ledger change: what you propose lands only as a proposal a review applies.'

function classifierSchema(): string {
  return JSON.stringify({
    type: 'object',
    properties: {
      pairs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            criterion: { type: 'string' },
            replacement: { type: 'string' },
            intendsReplacement: { type: 'boolean' },
            reason: { type: 'string' },
          },
          required: ['criterion', 'intendsReplacement'],
        },
      },
    },
    required: ['pairs'],
  })
}

function classifierPrompt(input: ContradictionInput, correction?: string): string {
  const active = input.ledger
    .filter((entry) => entry.status === 'active')
    .map((entry) => ({ id: entry.criterion, words: entry.note ?? '' }))
  const introduced = input.introduced.map((criterion) => ({
    id: criterion.id,
    words: criterion.text,
    outcome: outcomeOf(criterion.id, input.executed),
  }))
  const failed = input.ledger
    .filter((entry) => entry.status === 'active')
    .map((entry) => ({
      id: entry.criterion,
      words: entry.note ?? '',
      outcome: outcomeForEntry(entry, input.executed),
    }))
    .filter((entry) => entry.outcome !== undefined)
  const parts = [
    'The active rules in the ledger:',
    JSON.stringify(active),
    'The rules the change introduces, with the outcome the run recorded:',
    JSON.stringify(introduced),
    'The active rules the run executed, with their outcomes:',
    JSON.stringify(failed),
  ]
  if (input.diff !== undefined) parts.push(`The change under test:\n${input.diff}`)
  if (correction !== undefined) parts.push(`Your last answer was refused: ${correction}. Answer again.`)
  return parts.join('\n\n')
}

function outcomeOf(id: string, executed: ExecutedCriterion[]): ExecutedCriterion['outcome'] | undefined {
  return executed.find((criterion) => criterion.id === id)?.outcome
}

/**
 * The outcome a run recorded for a ledger entry, matched the way
 * `entryForExecuted` matches: by the entry's id, or by its own words when the
 * executed id was content-addressed from them. Wherever this is read, the
 * note-derived fallback is read too, so a hand-minted entry is never mistaken
 * for a rule the run did not execute.
 */
function outcomeForEntry(
  entry: Pick<LedgerEntry, 'criterion' | 'note'>,
  executed: ExecutedCriterion[],
): ExecutedCriterion['outcome'] | undefined {
  return executed.find(
    (criterion) =>
      criterion.id === entry.criterion ||
      (entry.note !== undefined && criterionIdFor(entry.note) === criterion.id),
  )?.outcome
}

interface NominatedPair {
  criterion: string
  replacement?: string
  intendsReplacement: boolean
  reason?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsePairs(answer: unknown, activeIds: Set<string>, introducedIds: Set<string>): NominatedPair[] {
  if (!isRecord(answer)) throw new CorrectionNeeded('the classifier returned no JSON object')
  if (!Array.isArray(answer.pairs)) throw new CorrectionNeeded('the classifier returned no "pairs" array')
  const pairs: NominatedPair[] = []
  for (const [index, entry] of answer.pairs.entries()) {
    const field = `pairs[${index}]`
    if (!isRecord(entry)) throw new CorrectionNeeded(`${field} must be a JSON object`)
    for (const key of Object.keys(entry)) {
      if (!['criterion', 'replacement', 'intendsReplacement', 'reason'].includes(key))
        throw new CorrectionNeeded(`${field}.${key}: unknown field in a nominated pair`)
    }
    const criterion = entry.criterion
    if (typeof criterion !== 'string' || criterion.trim() === '')
      throw new CorrectionNeeded(`${field}.criterion must name an active ledger criterion`)
    if (!activeIds.has(criterion))
      throw new CorrectionNeeded(`${field}.criterion ${JSON.stringify(criterion)} is not an active ledger criterion`)
    const replacement = entry.replacement
    if (replacement !== undefined && replacement !== null) {
      if (typeof replacement !== 'string' || replacement.trim() === '')
        throw new CorrectionNeeded(`${field}.replacement must name an introduced criterion`)
      if (!introducedIds.has(replacement))
        throw new CorrectionNeeded(
          `${field}.replacement ${JSON.stringify(replacement)} is not a rule the change introduces`,
        )
      if (replacement === criterion)
        throw new CorrectionNeeded(`${field}: a criterion cannot replace itself`)
    }
    if (typeof entry.intendsReplacement !== 'boolean')
      throw new CorrectionNeeded(`${field}.intendsReplacement must be true or false`)
    if (entry.intendsReplacement && replacement === undefined)
      throw new CorrectionNeeded(`${field}: an intended replacement must name the rule that replaces one`)
    pairs.push({
      criterion,
      replacement: replacement ?? undefined,
      intendsReplacement: entry.intendsReplacement,
      reason: typeof entry.reason === 'string' && entry.reason.trim() !== '' ? entry.reason : 'the classifier proposed this pair',
    })
  }
  return pairs
}

/**
 * Ask the classifier which active rules the change conflicts with, and which
 * introduced rule would replace one. One correction round, carrying the
 * reason, then it raises: a classifier that cannot answer names the failure
 * rather than letting a quieter answer through.
 */
async function nominatePairs(
  input: ContradictionInput,
  activeIds: Set<string>,
  introducedIds: Set<string>,
): Promise<NominatedPair[]> {
  if (input.classifier === undefined) return []
  let correction: string | undefined
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const run = await input.classifier.run({
      prompt: classifierPrompt(input, correction),
      system: CLASSIFIER_SYSTEM,
      toolPolicy: 'none',
      outputSchema: classifierSchema(),
      budget: { maxOutputTokens: 2048 },
    })
    if (run.status !== 'completed')
      throw new ContradictionClassifierError(
        `the contradiction classifier did not complete (stop reason ${run.stopReason})` +
          (run.error ? `: ${run.error}` : ''),
      )
    if (typeof run.output !== 'string')
      throw new ContradictionClassifierError('the contradiction classifier returned no answer to read')
    try {
      return parsePairs(JSON.parse(run.output), activeIds, introducedIds)
    } catch (error) {
      if (error instanceof CorrectionNeeded) correction = error.message
      else throw new ContradictionClassifierError(`the contradiction classifier returned unreadable JSON: ${String(error)}`)
    }
  }
  throw new ContradictionClassifierError(`the classifier could not produce a usable answer: ${correction}`)
}

/**
 * Match an executed criterion to the ledger entry it ran against: by the id
 * it was given, or by the entry's own words when the entry carries them in
 * `note` and the executed id was content-addressed from those same words.
 */
function entryForExecuted(executed: ExecutedCriterion, ledger: LedgerEntry[]): LedgerEntry | undefined {
  return (
    ledger.find((entry) => entry.criterion === executed.id) ??
    ledger.find((entry) => entry.note !== undefined && criterionIdFor(entry.note) === executed.id)
  )
}

/**
 * Detect the conflicts between a change and the criteria ledger, and
 * classify each one (#40).
 *
 * Executed evidence comes first: an active rule the run failed is a conflict
 * whatever anybody says, and a replacement the run proved settles a supersede
 * without a word from the model. The classifier comes second: it proposes the
 * pairing between a failed rule and the rule that would replace it, and it
 * proposes conflicts the run did not reach, but its word alone is recorded as
 * the model's, and what it proposes lands only as a proposal. Without a
 * classifier, pairing is impossible, so every failure stands as a regression.
 */
export async function detectContradictions(input: ContradictionInput): Promise<ContradictionReport> {
  const active = input.ledger.filter((entry) => entry.status === 'active')
  const introducedIds = new Set(input.introduced.map((criterion) => criterion.id))
  const activeIds = new Set(active.map((entry) => entry.criterion))

  const failedActives = new Map<string, string | undefined>()
  for (const executed of input.executed) {
    if (executed.outcome !== 'failed') continue
    const entry = entryForExecuted(executed, input.ledger)
    if (entry === undefined || entry.status !== 'active') continue
    failedActives.set(entry.criterion, executed.reason)
  }

  const nominated = await nominatePairs(input, activeIds, introducedIds)

  const candidates = new Map<string, { replacement?: string; intendsReplacement: boolean; reason?: string }>()
  for (const [criterion, reason] of failedActives)
    candidates.set(criterion, { replacement: undefined, intendsReplacement: false, reason })
  for (const pair of nominated) {
    const existing = candidates.get(pair.criterion)
    if (existing !== undefined && existing.replacement !== undefined && pair.replacement !== undefined) {
      if (existing.replacement !== pair.replacement)
        throw new ContradictionClassifierError(
          `the classifier paired criterion ${pair.criterion} with both ${existing.replacement} and ${pair.replacement}; ` +
            'which one replaces it needs review, not a guess, so the conflict is refused',
        )
      continue
    }
    if (existing !== undefined) {
      if (pair.replacement !== undefined) existing.replacement = pair.replacement
      existing.intendsReplacement = pair.intendsReplacement
      if (pair.reason !== undefined) existing.reason = `${existing.reason ?? ''} ${pair.reason}`.trim()
      continue
    }
    candidates.set(pair.criterion, {
      replacement: pair.replacement,
      intendsReplacement: pair.intendsReplacement,
      reason: pair.reason,
    })
  }

  const contradictions: Contradiction[] = []
  for (const [criterion, candidate] of candidates) {
    const entry = input.ledger.find((ledgerEntry) => ledgerEntry.criterion === criterion)
    if (entry === undefined) continue
    const oldOutcome = outcomeForEntry(entry, input.executed)
    const replacementOutcome =
      candidate.replacement === undefined ? undefined : outcomeOf(candidate.replacement, input.executed)
    const words = entry.note === undefined ? undefined : entry.note
    const detail = candidate.reason === undefined ? '' : ` (${candidate.reason})`
    if (oldOutcome === 'failed' && candidate.replacement === undefined) {
      contradictions.push({
        criterion,
        ...(words === undefined ? {} : { criterionText: words }),
        classification: 'regression',
        basis: 'executed-evidence',
        reason: `the rule failed in run ${input.runId}${detail}`,
      })
      continue
    }
    if (oldOutcome === 'failed' && replacementOutcome === 'proven') {
      contradictions.push({
        criterion,
        ...(words === undefined ? {} : { criterionText: words }),
        replacement: candidate.replacement,
        classification: 'supersede',
        basis: 'executed-evidence',
        reason: `the rule failed in run ${input.runId} and the replacement was proven in the same run${detail}`,
      })
      continue
    }
    if (oldOutcome === 'failed' && candidate.replacement !== undefined) {
      if (candidate.intendsReplacement) {
        contradictions.push({
          criterion,
          ...(words === undefined ? {} : { criterionText: words }),
          replacement: candidate.replacement,
          classification: 'supersede',
          basis: 'model',
          reason: 'the classifier read the change as replacing the rule, and the replacement is not proven yet',
        })
      } else {
        contradictions.push({
          criterion,
          ...(words === undefined ? {} : { criterionText: words }),
          classification: 'regression',
          basis: 'model',
          reason: 'the classifier read the change as not replacing the rule, so the failure stands as a regression',
        })
      }
      continue
    }
    if (candidate.replacement !== undefined && replacementOutcome === 'proven') {
      if (!candidate.intendsReplacement) {
        contradictions.push({
          criterion,
          ...(words === undefined ? {} : { criterionText: words }),
          classification: 'regression',
          basis: 'model',
          reason: 'the classifier read the change as not replacing the rule, so the conflict stands as a regression',
        })
        continue
      }
      contradictions.push({
        criterion,
        ...(words === undefined ? {} : { criterionText: words }),
        replacement: candidate.replacement,
        classification: 'supersede',
        basis: 'model',
        reason: 'the classifier put the change at odds with the rule; the run did not execute the rule itself',
      })
    }
  }

  const fold = new Map(contradictions
    .filter((contradiction) => contradiction.classification === 'supersede')
    .map((contradiction): [string, Contradiction] => [contradiction.criterion, contradiction]))
  const changes: ContradictionChange[] = []
  for (const contradiction of fold.values()) {
    changes.push({
      criterion: contradiction.criterion,
      from: 'active',
      to: 'superseded',
      ...(contradiction.replacement === undefined ? {} : { replacement: contradiction.replacement }),
      basis: contradiction.basis,
      reason: contradiction.reason,
    })
  }
  const folded = input.ledger.map((entry) => {
    if (fold.has(entry.criterion)) return { ...entry, status: 'superseded' as const }
    return entry
  })
  const replacements = new Map<string, string[]>()
  for (const contradiction of contradictions) {
    if (contradiction.classification !== 'supersede') continue
    if (contradiction.replacement === undefined) continue
    const superseded = replacements.get(contradiction.replacement) ?? []
    replacements.set(contradiction.replacement, [...superseded, contradiction.criterion])
  }
  const linked = foldedEntries(folded, replacements)

  return {
    schemaVersion: CONTRADICTION_SCHEMA_VERSION,
    runId: input.runId,
    contradictions,
    changes,
    ledgerText: serializeLedger(linked),
    fingerprint: integrityOf(linked),
  }
}

function foldedEntries(
  folded: LedgerEntry[],
  replacements: Map<string, string[]>,
): LedgerEntry[] {
  return folded.map((entry) => {
    const superseded = replacements.get(entry.criterion)
    if (superseded === undefined) return entry
    const supersedes = entry.supersedes ?? []
    const missing = superseded.filter((id) => !supersedes.includes(id))
    if (missing.length === 0) return entry
    return { ...entry, supersedes: [...supersedes, ...missing] }
  })
}

/**
 * Read the executed evidence off a judged run result: the criteria outcomes
 * the run recorded, in the shape the ledger needs. Fails named on a shape
 * the detector cannot read rather than guessing at one.
 */
export function executedFromResult(result: unknown): ExecutedCriterion[] {
  if (!isRecord(result)) throw new Error('contradiction: result must be a JSON object')
  if (!Array.isArray(result.criteria)) throw new Error('contradiction: result.criteria must be an array')
  return result.criteria.map((entry: unknown, index: number) => {
    const field = `result.criteria[${index}]`
    if (!isRecord(entry)) throw new Error(`contradiction: ${field} must be a JSON object`)
    if (typeof entry.id !== 'string' || entry.id.trim() === '')
      throw new Error(`contradiction: ${field}.id must be a criterion id`)
    if (entry.outcome !== 'proven' && entry.outcome !== 'failed' && entry.outcome !== 'unverified')
      throw new Error(
        `contradiction: ${field}.outcome ${JSON.stringify(entry.outcome)} is not a run outcome (expected "proven", "failed" or "unverified")`,
      )
    return {
      id: entry.id,
      outcome: entry.outcome,
      ...(typeof entry.reason === 'string' && entry.reason.trim() !== '' ? { reason: entry.reason } : {}),
    }
  })
}
