import { mergeVerdicts } from './egress.js'
import type { CriterionOutcome, RunResult, RunVerdict } from './result.js'
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
  let anyWaived = false
  for (const headSide of head) {
    const criterionId = headSide.criterionId
    const isRegressed = regressed.has(criterionId)
    if (waived.has(criterionId)) {
      anyWaived = true
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
      anyWaived = true
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

  const derived = deriveVerdict(criteria, regressions, anyWaived)
  const verdict = input.egressVerdict === 'refused' ? mergeVerdicts([derived, 'refused']) : derived
  return { criteria, regressions, verdict }
}

function deriveVerdict(criteria: CriterionVerdict[], regressions: Regression[], anyWaived: boolean): RunVerdict {
  if (regressions.length > 0 || criteria.some((criterion) => criterion.outcome === 'failed')) return 'failed'
  // An empty run proves nothing: fail closed rather than vacuously passing.
  if (criteria.length === 0) return 'blocked'
  if (!criteria.some((criterion) => criterion.outcome === 'unverified')) return 'passed'
  return anyWaived ? 'waived' : 'blocked'
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

export interface VerifierInputs {
  instructions: string
  criteria: CriterionVerdict[]
  diff: string
  evidence: string[]
}

const VERIFIER_INSTRUCTIONS = [
  'You are the qare verifier: an independent reviewer of a QA run.',
  'You receive quality criteria with their outcomes, the diff under review, and the evidence list.',
  'You report PROBLEMS ONLY: every finding is a JSON object {"criterionId": string, "problem": string} naming a criterion that the diff or evidence shows is not actually proven.',
  'A finding against a proven criterion downgrades it to failed with your problem as the reason. Findings against failed or unverified criteria are ignored, and findings naming criteria that were not given are dropped: your output can never upgrade a verdict or create a criterion.',
  'Reply with a JSON array of findings, or an object {"findings": [...]} where an empty list changes nothing. No prose.',
].join('\n')

export function prepareVerifierInputs(input: {
  criteria: CriterionVerdict[]
  diff: string
  evidence: string[]
}): VerifierInputs {
  return {
    instructions: VERIFIER_INSTRUCTIONS,
    criteria: input.criteria.map((criterion) => ({ ...criterion })),
    diff: input.diff,
    evidence: [...input.evidence],
  }
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
 * Hand the verifier inputs to the model through the agent runner seam and
 * consume its findings. Parse failure fails closed: the criteria come back
 * unchanged and no finding is applied.
 */
export async function runVerifier(
  runner: AgentRunner,
  inputs: VerifierInputs,
  request: Partial<Omit<AgentRunRequest, 'prompt'>> = {},
): Promise<CriterionVerdict[]> {
  const criteria = inputs.criteria ?? []
  const payload = JSON.stringify({
    criteria: criteria.map((criterion) => ({ criterionId: criterion.criterionId, outcome: criterion.outcome })),
    diff: inputs.diff,
    evidence: inputs.evidence,
  })
  const result = await runner.run({
    system: request.system ?? '',
    toolPolicy: request.toolPolicy ?? 'none',
    outputSchema: request.outputSchema ?? '',
    budget: request.budget ?? { maxOutputTokens: 0 },
    prompt: `${inputs.instructions}\n\n${payload}`,
  })
  const findings = result.status === 'completed' ? parseVerifierFindings(result.output) : undefined
  if (findings === undefined) return criteria
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
