import { mergeVerdicts } from './egress.js'
import { BUILTIN_REDACTION_RULES, redactResult, type RedactionRule } from './redact.js'
import { RESULT_SCHEMA_VERSION, type CriterionOutcome, type CriterionResult, type RunResult, type RunVerdict } from './result.js'
import type { AgentRunRequest, AgentRunner } from './runner.js'

export interface SideResult {
  criterionId: string
  outcome: CriterionOutcome
  detail?: string
}

export interface Regression {
  criterionId: string
  base: 'proven'
  head: 'failed'
  baseDetail?: string
  headDetail?: string
}

export interface CriterionVerdict {
  criterionId: string
  outcome: CriterionOutcome
  regression: boolean
  reason: string
}

export interface JudgeRunInput {
  base: SideResult[]
  head: SideResult[]
  waived?: string[]
  egressVerdict?: 'refused' | 'allowed'
}

export interface JudgeRunResult {
  criteria: CriterionVerdict[]
  regressions: Regression[]
  verdict: RunVerdict
}

/**
 * A regression is anything that worked at base and fails at head, whether or
 * not a criterion covers it. Stable order: first appearance in head.
 */
export function detectRegressions(base: SideResult[], head: SideResult[]): Regression[] {
  const baseById = new Map<string, SideResult>()
  for (const side of base ?? []) baseById.set(side.criterionId, side)
  const regressions: Regression[] = []
  for (const headSide of head ?? []) {
    const baseSide = baseById.get(headSide.criterionId)
    if (baseSide === undefined || baseSide.outcome !== 'proven' || headSide.outcome !== 'failed') continue
    regressions.push({
      criterionId: headSide.criterionId,
      base: 'proven',
      head: 'failed',
      ...(baseSide.detail === undefined ? {} : { baseDetail: baseSide.detail }),
      ...(headSide.detail === undefined ? {} : { headDetail: headSide.detail }),
    })
  }
  return regressions
}

/**
 * Decide criterion verdicts and the run verdict from raw side results only.
 * The head side is the verdict source; criteria proven at base and failed at
 * head are regressions. Waived criteria are never shown as a pass, and an
 * egress refusal is unmaskable.
 */
export function judgeRun(input: JudgeRunInput): JudgeRunResult {
  const base = input.base ?? []
  const head = input.head ?? []
  const waived = new Set(input.waived ?? [])
  const regressions = detectRegressions(base, head)
  const regressed = new Set(regressions.map((regression) => regression.criterionId))

  const headById = new Map<string, SideResult>()
  for (const side of head) headById.set(side.criterionId, side)

  const criteria: CriterionVerdict[] = []
  for (const headSide of head) {
    const criterionId = headSide.criterionId
    const isRegressed = regressed.has(criterionId)
    if (waived.has(criterionId)) {
      criteria.push({ criterionId, outcome: 'unverified', regression: isRegressed, reason: 'waived by human' })
      continue
    }
    if (isRegressed) {
      criteria.push({
        criterionId,
        outcome: 'failed',
        regression: true,
        reason: headSide.detail ?? 'proven at base, failed at head',
      })
      continue
    }
    switch (headSide.outcome) {
      case 'proven':
        criteria.push({ criterionId, outcome: 'proven', regression: false, reason: headSide.detail ?? 'proven at head' })
        break
      case 'failed':
        criteria.push({ criterionId, outcome: 'failed', regression: false, reason: headSide.detail ?? 'failed at head' })
        break
      case 'unverified':
        criteria.push({
          criterionId,
          outcome: 'unverified',
          regression: false,
          reason: headSide.detail ?? 'unverified at head',
        })
        break
    }
  }
  for (const baseSide of base) {
    if (headById.has(baseSide.criterionId)) continue
    if (waived.has(baseSide.criterionId)) {
      criteria.push({
        criterionId: baseSide.criterionId,
        outcome: 'unverified',
        regression: false,
        reason: 'waived by human',
      })
      continue
    }
    criteria.push({
      criterionId: baseSide.criterionId,
      outcome: 'unverified',
      regression: false,
      reason: 'not executed at head',
    })
  }

  const derived = verdictOf(criteria, regressions, waived)
  const verdict = input.egressVerdict === 'refused' ? mergeVerdicts([derived, 'refused']) : derived
  return { criteria, regressions, verdict }
}

/**
 * The run verdict from criterion verdicts. Waived is only a waiver when every
 * criterion left unverified was waived by a human; one that nobody waived
 * still blocks the run.
 */
export function verdictOf(criteria: CriterionVerdict[], regressions: Regression[], waived: Iterable<string> = []): RunVerdict {
  if (regressions.length > 0 || criteria.some((criterion) => criterion.outcome === 'failed')) return 'failed'
  // An empty run proves nothing: fail closed rather than vacuously passing.
  if (criteria.length === 0) return 'blocked'
  const unverified = criteria.filter((criterion) => criterion.outcome === 'unverified')
  if (unverified.length === 0) return 'passed'
  const waivedIds = new Set(waived)
  return unverified.every((criterion) => waivedIds.has(criterion.criterionId)) ? 'waived' : 'blocked'
}

/**
 * Map executed run criteria onto judge side results: the criterion id and
 * outcome carry the decision, and an unverified reason becomes the detail.
 */
export function toSideResults(result: Pick<RunResult, 'criteria'>): SideResult[] {
  return (result.criteria ?? []).map((criterion) =>
    criterion.outcome === 'unverified'
      ? { criterionId: criterion.id, outcome: criterion.outcome, detail: criterion.reason }
      : { criterionId: criterion.id, outcome: criterion.outcome },
  )
}

/**
 * Model findings are problems only. There is deliberately no "looks good"
 * finding: structurally, no model output can upgrade a verdict.
 */
export interface VerifierFinding {
  criterionId: string
  problem: string
}

/** A proven criterion as the verifier sees it: what it says, and what was saved. */
export interface VerifierClaim {
  criterionId: string
  text: string
  evidence: string[]
}

export interface VerifierInputs {
  instructions: string
  criteria: CriterionVerdict[]
  claims: VerifierClaim[]
  diff: string
}

const VERIFIER_INSTRUCTIONS = [
  'You are the qare verifier: an independent reviewer of a QA run.',
  'You receive the criteria the run claims to have proven, each with its text and the evidence files saved for it, and the diff under review. You can read the evidence files.',
  'Report PROBLEMS ONLY: a finding names a criterion whose evidence does not actually show what the criterion says, or that the diff shows is not met. Report gaps against the criterion, never style.',
  'A finding downgrades its criterion to failed with your problem as the reason. Findings naming criteria you were not given are dropped: your output can never upgrade a verdict or create a criterion.',
  'Answer with {"findings": [{"criterionId": string, "problem": string}]}. An empty list changes nothing.',
].join('\n')

/** The answer shape nare validates the verifier's output against. */
export const VERIFIER_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['findings'],
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['criterionId', 'problem'],
        additionalProperties: false,
        properties: {
          criterionId: { type: 'string' },
          problem: { type: 'string' },
        },
      },
    },
  },
} as const

/**
 * Only proven criteria are put to the verifier: a finding can do nothing to a
 * criterion that already failed or was never verified. A proven criterion the
 * plan has no text for cannot be checked, since a verifier that cannot read
 * the requirement is not checking it, so it is left unverified saying so.
 */
export function prepareVerifierInputs(input: {
  criteria: CriterionVerdict[]
  texts: Record<string, string>
  evidence: Record<string, string[]>
  diff: string
}): VerifierInputs {
  const textOf = (id: string): string | undefined => {
    const text = Object.hasOwn(input.texts, id) ? input.texts[id] : undefined
    return text === undefined || text.trim() === '' ? undefined : text
  }
  const criteria = input.criteria.map((criterion) =>
    criterion.outcome === 'proven' && textOf(criterion.criterionId) === undefined
      ? {
          ...criterion,
          outcome: 'unverified' as const,
          reason: 'verifier could not check it: the plan has no text for this criterion',
        }
      : { ...criterion },
  )
  const claims = criteria
    .filter((criterion) => criterion.outcome === 'proven')
    .map((criterion) => {
      const evidence = Object.hasOwn(input.evidence, criterion.criterionId) ? input.evidence[criterion.criterionId] : undefined
      return { criterionId: criterion.criterionId, text: textOf(criterion.criterionId) as string, evidence: [...(evidence ?? [])] }
    })
  return { instructions: VERIFIER_INSTRUCTIONS, criteria, claims, diff: input.diff }
}

/**
 * The only consumption path for verifier output: a finding against a proven
 * criterion downgrades it to failed. Nothing a finding says can upgrade an
 * outcome, rewrite another reason, or create a criterion.
 */
export function consumeVerifierFindings(criteria: CriterionVerdict[], findings: VerifierFinding[]): CriterionVerdict[] {
  const problems = new Map<string, string>()
  for (const finding of findings ?? []) {
    if (!problems.has(finding.criterionId)) problems.set(finding.criterionId, finding.problem)
  }
  return (criteria ?? []).map((criterion) => {
    const problem = problems.get(criterion.criterionId)
    if (problem === undefined || criterion.outcome !== 'proven') return criterion
    return { ...criterion, outcome: 'failed' as const, reason: `verifier: ${problem}` }
  })
}

/**
 * A verifier that gave no readable answer checked nothing, so nothing it was
 * asked about stays proven: each proven criterion becomes unverified, naming
 * why. Leaving them proven would let a pass stand that the second check never
 * saw.
 */
function verifierUnavailable(criteria: CriterionVerdict[], why: string): CriterionVerdict[] {
  return criteria.map((criterion) =>
    criterion.outcome === 'proven'
      ? { ...criterion, outcome: 'unverified' as const, reason: `verifier did not answer: ${why}` }
      : criterion,
  )
}

/**
 * Hand the proven claims to the model through the agent runner seam and
 * consume its findings. The verifier reads evidence with a read-only tool set,
 * and its answer is schema-constrained.
 *
 * It fails closed: a runner that throws, a run that does not complete, or an
 * answer that is not a findings list leaves every proven criterion unverified
 * with the reason named, never proven. With nothing proven there is nothing to
 * downgrade, so no model call is made.
 */
export async function runVerifier(
  runner: AgentRunner,
  inputs: VerifierInputs,
  request: Partial<Omit<AgentRunRequest, 'prompt'>> = {},
): Promise<CriterionVerdict[]> {
  const criteria = inputs.criteria ?? []
  if (inputs.claims.length === 0) return criteria
  const payload = JSON.stringify({ criteria: inputs.claims, diff: inputs.diff })
  let result: Awaited<ReturnType<AgentRunner['run']>>
  try {
    result = await runner.run({
      system: request.system ?? '',
      toolPolicy: request.toolPolicy ?? 'read-only',
      outputSchema: request.outputSchema ?? JSON.stringify(VERIFIER_OUTPUT_SCHEMA),
      budget: request.budget ?? { maxOutputTokens: 4096 },
      prompt: `${inputs.instructions}\n\n${payload}`,
    })
  } catch (error) {
    return verifierUnavailable(criteria, error instanceof Error ? error.message : String(error))
  }
  if (result.status !== 'completed')
    return verifierUnavailable(
      criteria,
      `the run stopped (${result.stopReason})${result.error === undefined ? '' : `: ${result.error}`}`,
    )
  const findings = parseVerifierFindings(result.output)
  if (findings === undefined) return verifierUnavailable(criteria, 'its answer was not a findings list')
  return consumeVerifierFindings(criteria, findings)
}

function parseVerifierFindings(output: unknown): VerifierFinding[] | undefined {
  if (typeof output !== 'string') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return undefined
  }
  const findings = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.findings)
      ? parsed.findings
      : undefined
  if (findings === undefined) return undefined
  if (
    !findings.every(
      (finding) =>
        isRecord(finding) && typeof finding.criterionId === 'string' && typeof finding.problem === 'string',
    )
  )
    return undefined
  return findings as VerifierFinding[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The judged result: the executed result with judge's criteria and verdict
 * folded in. Evidence is carried from the run, and a reason the run already
 * gave a failed criterion survives being judged again.
 */
export function judgedResult(
  loaded: RunResult,
  verdict: RunVerdict,
  criteria: CriterionVerdict[],
  evidenceById: Map<string, string[]>,
): RunResult {
  const executed = new Map(loaded.criteria.map((criterion) => [criterion.id, criterion]))
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    verdict,
    criteria: criteria.map((criterion) => {
      const evidence = evidenceById.get(criterion.criterionId) ?? []
      if (criterion.outcome === 'unverified')
        return {
          id: criterion.criterionId,
          outcome: 'unverified',
          reason: criterion.reason,
          ...(evidence.length === 0 ? {} : { evidence }),
        }
      if (criterion.outcome === 'failed') {
        // A check that failed speaks through its evidence. A criterion judge
        // failed after the check proved it (the verifier) carries the reason,
        // or the comment would show a failure with nothing saying why, and a
        // reason the result already carried survives being judged again.
        const before = executed.get(criterion.criterionId)
        const reason =
          before?.outcome !== 'failed' ? criterion.reason : 'reason' in before ? before.reason : undefined
        return reason === undefined
          ? { id: criterion.criterionId, outcome: 'failed', evidence }
          : { id: criterion.criterionId, outcome: 'failed', evidence, reason }
      }
      return { id: criterion.criterionId, outcome: criterion.outcome, evidence }
    }),
    ...(loaded.job === undefined ? {} : { job: { id: loaded.job.id } }),
    ...(loaded.waived === undefined ? {} : { waived: loaded.waived }),
    ...(loaded.target === undefined ? {} : { target: loaded.target }),
  }
}

/** The evidence a criterion result names; none for one that carries none. */
export function evidenceOf(criterion: CriterionResult): string[] {
  return 'evidence' in criterion ? criterion.evidence ?? [] : []
}

export interface JudgeExecutedOptions {
  /** Each criterion's text, which the verifier checks the evidence against. */
  texts: Record<string, string>
  /** The change under review, or NO_DIFF when there is none. */
  diff: string
  /** The verifier's model; absent to judge from the evidence alone. */
  verifier?: AgentRunner
  rules?: readonly RedactionRule[]
}

/**
 * Judge an executed result: the one path from result.json to the judged
 * verdict, shared by `qare judge` and `qare check` so they can never disagree.
 * Waivers are honoured, a proven criterion is put to the verifier when one is
 * given, and a refused run stays refused, with no model call: it executed
 * nothing. Returns the redacted judged result and the criteria the verifier
 * changed.
 */
export async function judgeExecuted(
  executed: RunResult,
  opts: JudgeExecutedOptions,
): Promise<{ result: RunResult; changed: CriterionVerdict[] }> {
  const waived = executed.waived?.map((entry) => entry.criterionId) ?? []
  const judged = judgeRun({ base: [], head: toSideResults(executed), waived })
  const evidenceById = new Map(executed.criteria.map((criterion) => [criterion.id, evidenceOf(criterion)]))
  let criteria = judged.criteria
  if (opts.verifier !== undefined && executed.verdict !== 'refused') {
    criteria = await runVerifier(
      opts.verifier,
      prepareVerifierInputs({ criteria: judged.criteria, texts: opts.texts, evidence: Object.fromEntries(evidenceById), diff: opts.diff }),
    )
  }
  const changed = criteria.filter((criterion, index) => criterion.outcome !== judged.criteria[index]?.outcome)
  // A refused run executed nothing, so there is nothing to judge: recomputing
  // it from all-unverified criteria would read it back as blocked.
  const verdict = executed.verdict === 'refused' ? 'refused' : verdictOf(criteria, judged.regressions, waived)
  const result = redactResult(judgedResult(executed, verdict, criteria, evidenceById), opts.rules ?? BUILTIN_REDACTION_RULES)
  return { result, changed }
}
