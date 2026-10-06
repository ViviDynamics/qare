import type { A11yCounts } from './a11y.js'
import { mergeVerdicts } from './egress.js'
import { BUILTIN_REDACTION_RULES, redactResult, type RedactionRule } from './redact.js'
import { RESULT_SCHEMA_VERSION, type CriterionBase, type CriterionOutcome, type CriterionResult, type RunResult, type RunVerdict } from './result.js'
import type { ModelUsage } from './metrics.js'
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
 * The base side as the judge reads it out of a result (#147): the criteria
 * the base's executed checks decided, proven or failed. A criterion that was
 * not compared is left out, so it can never be read as having worked at the
 * base, and a one-sided result yields an empty base, as it always did.
 */
export function toBaseSideResults(result: Pick<RunResult, 'criteria'>): SideResult[] {
  return (result.criteria ?? []).flatMap((criterion) =>
    criterion.base === undefined || criterion.base.outcome === 'not-compared' ? [] : [{ criterionId: criterion.id, outcome: criterion.base.outcome }],
  )
}

/**
 * Model findings are problems only. There is deliberately no "looks good"
 * finding: structurally, no model output can upgrade a verdict.
 */
export interface VerifierFinding {
  criterionId: string
  problem: string
  /** What the finding claims (#157, #244). `contradicted`: evidence the run
   * saved, or the diff, shows the criterion is not met, which fails it.
   * `unexercised`, or no kind at all: the evidence does not show the
   * criterion either way, which leaves it unverified. A model's doubt about a
   * check is not an observation that the application is wrong. */
  kind?: 'unexercised' | 'contradicted'
  /** The evidence file, or `diff`, that shows the contradiction. A
   * contradiction that names none is treated as thin evidence. */
  evidence?: string
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
  'Say which kind of problem it is. kind "contradicted": an evidence file, or the diff, shows the criterion is NOT met; name that file (or "diff") in "evidence". It downgrades the criterion to failed. Omit kind when the evidence simply does not show the criterion, for example a check that looked for a name where the criterion states a relationship: that downgrades the criterion to unverified. Doubt about a check is never "contradicted".',
  'Findings naming criteria you were not given are dropped: your output can never upgrade a verdict or create a criterion.',
  'When a criterion was proven by a filtered test command, check that the evidence shows the filter actually selecting tests: a report whose filter selected nothing, or the whole suite, exercised the criterion only by accident. Say so with kind "unexercised".',
  'Answer with {"findings": [{"criterionId": string, "problem": string, "kind": "contradicted"_OR_"unexercised"_OR_omit, "evidence": string_ONLY_WITH_contradicted}]}. An empty list changes nothing.',
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
          kind: { type: 'string', enum: ['unexercised', 'contradicted'] },
          evidence: { type: 'string' },
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
 * The only consumption path for verifier output. A finding against a proven
 * criterion downgrades it: to failed when it names evidence the run saved
 * for that criterion, or a diff the run supplied, as contradicting it, and to
 * unverified otherwise, because a check
 * that was too weak proved nothing and disproved nothing (#244). Nothing a
 * finding says can upgrade an outcome, rewrite another reason, or create a
 * criterion.
 */
export function consumeVerifierFindings(
  criteria: CriterionVerdict[],
  findings: VerifierFinding[],
  trusted: { claims: readonly VerifierClaim[]; diff: string } = { claims: [], diff: '' },
): CriterionVerdict[] {
  const first = new Map<string, VerifierFinding>()
  for (const finding of findings ?? []) {
    if (!first.has(finding.criterionId)) first.set(finding.criterionId, finding)
  }
  // A contradiction counts only when it cites something the run handed the
  // verifier: an evidence file saved for that criterion, or a diff that was
  // really supplied. A citation of anything else is the model's word alone.
  const cites = (finding: VerifierFinding): string | undefined => {
    const cited = typeof finding.evidence === 'string' ? finding.evidence.trim() : ''
    if (finding.kind !== 'contradicted' || cited === '') return undefined
    if (cited === 'diff') return trusted.diff.trim() === '' ? undefined : cited
    const saved = trusted.claims.find((claim) => claim.criterionId === finding.criterionId)?.evidence ?? []
    return saved.includes(cited) ? cited : undefined
  }
  return (criteria ?? []).map((criterion) => {
    const finding = first.get(criterion.criterionId)
    if (finding === undefined || criterion.outcome !== 'proven') return criterion
    const shownBy = cites(finding)
    if (shownBy !== undefined)
      return { ...criterion, outcome: 'failed' as const, reason: `verifier: ${finding.problem} (${shownBy})` }
    return { ...criterion, outcome: 'unverified' as const, reason: `verifier: ${finding.problem}` }
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
): Promise<{ verdicts: CriterionVerdict[]; usage: ModelUsage | undefined }> {
  const criteria = inputs.criteria ?? []
  if (inputs.claims.length === 0) return { verdicts: criteria, usage: undefined }
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
    return { verdicts: verifierUnavailable(criteria, error instanceof Error ? error.message : String(error)), usage: undefined }
  }
  // The verifier's spend counts whatever it decided (#51): an unavailable
  // verifier cost tokens the same as a decisive one.
  if (result.status !== 'completed')
    return {
      verdicts: verifierUnavailable(
        criteria,
        `the run stopped (${result.stopReason})${result.error === undefined ? '' : `: ${result.error}`}`,
      ),
      usage: result.usage,
    }
  const findings = parseVerifierFindings(result.output)
  if (findings === undefined) return { verdicts: verifierUnavailable(criteria, 'its answer was not a findings list'), usage: result.usage }
  return { verdicts: consumeVerifierFindings(criteria, findings, { claims: inputs.claims, diff: inputs.diff }), usage: result.usage }
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
  regressed: ReadonlySet<string> = new Set(),
): RunResult {
  const executed = new Map(loaded.criteria.map((criterion) => [criterion.id, criterion]))
  // What the base showed survives judging, and the regression flag is set
  // here from the judge's own computation over the executed outcomes of both
  // sides (#147), never copied from the result being judged: proven at the
  // base and failed at the head is a regression, failed at both is behaviour
  // that does not work yet, and a criterion the verifier failed after its
  // check passed is neither, because no model output creates a regression.
  const sidesOf = (criterion: CriterionVerdict): { base?: CriterionBase; regression?: boolean } => {
    const before = executed.get(criterion.criterionId)
    if (before?.base === undefined) return {}
    if (regressed.has(criterion.criterionId)) return { base: before.base, regression: true }
    if (criterion.outcome === 'failed' && before.outcome === 'failed' && before.base.outcome === 'failed') return { base: before.base, regression: false }
    return { base: before.base }
  }
  // What the accessibility audits counted is the harness's own record (#149):
  // it survives judging as it was written, or the comment could not list the
  // violations a judged run found.
  const comparisonOf = (criterion: CriterionVerdict): { base?: CriterionBase; regression?: boolean; a11y?: A11yCounts } => {
    const a11y = executed.get(criterion.criterionId)?.a11y
    return { ...sidesOf(criterion), ...(a11y === undefined ? {} : { a11y }) }
  }
  // Judging can only downgrade a criterion, so an app summary computed at run
  // time can go stale: it is recomputed from the final criteria of its subset
  // — the job's order and names kept — or the per-app heading would contradict
  // the table and the judged verdict (#55).
  const waived = new Set((loaded.waived ?? []).map((waiver) => waiver.criterionId))
  const profiles = loaded.profiles?.map((profile) => {
    const ids = new Set(profile.criteria)
    const subset = criteria.filter((criterion) => ids.has(criterion.criterionId))
    return { ...profile, verdict: judgedProfileVerdict(profile.verdict, subset, waived) }
  })
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    verdict,
    criteria: criteria.map((criterion) => {
      const evidence = evidenceById.get(criterion.criterionId) ?? []
      const comparison = comparisonOf(criterion)
      if (criterion.outcome === 'unverified')
        return {
          id: criterion.criterionId,
          outcome: 'unverified',
          reason: criterion.reason,
          ...(evidence.length === 0 ? {} : { evidence }),
          ...comparison,
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
          ? { id: criterion.criterionId, outcome: 'failed', evidence, ...comparison }
          : { id: criterion.criterionId, outcome: 'failed', evidence, reason, ...comparison }
      }
      return { id: criterion.criterionId, outcome: criterion.outcome, evidence, ...comparison }
    }),
    ...(loaded.job === undefined ? {} : { job: { id: loaded.job.id } }),
    ...(loaded.waived === undefined ? {} : { waived: loaded.waived }),
    // The run's wall clock survives judging (#51), or the judged result could
    // not say how long the run took and the metrics record would have
    // nothing to join the verifier's spend to.
    ...(loaded.startedAt === undefined ? {} : { startedAt: loaded.startedAt }),
    ...(loaded.finishedAt === undefined ? {} : { finishedAt: loaded.finishedAt }),
    ...(loaded.judgeUsage === undefined ? {} : { judgeUsage: loaded.judgeUsage }),
    ...(loaded.target === undefined ? {} : { target: loaded.target }),
    // Which base the run compared against, and whether it executed (#147).
    ...(loaded.base === undefined ? {} : { base: loaded.base }),
    // Where the run executed is evidence like the verdict is, so judging it
    // again does not erase it (issue #91).
    ...(loaded.environment === undefined ? {} : { environment: loaded.environment }),
    // The per-app report survives judging and replay, or `qare judge` and the
    // action would render the single-table comment over a several-app run (#55).
    ...(profiles === undefined ? {} : { profiles }),
  }
}

/**
 * The verdict an app's summary carries after judging. A criterion the judge
 * failed fails the app; a `passed` summary whose criteria are no longer all
 * proven is downgraded exactly as the whole run's verdict is; a refusal, a
 * block or a waiver the run recorded stays, because judging did not change
 * the facts those came from.
 */
function judgedProfileVerdict(
  original: RunVerdict,
  subset: CriterionVerdict[],
  waived: Set<string>,
): RunVerdict {
  if (subset.some((criterion) => criterion.outcome === 'failed')) return 'failed'
  if (original === 'passed') {
    const unverified = subset.filter((criterion) => criterion.outcome === 'unverified')
    if (unverified.length === 0) return 'passed'
    return unverified.every((criterion) => waived.has(criterion.criterionId)) ? 'waived' : 'blocked'
  }
  return original
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
): Promise<{ result: RunResult; changed: CriterionVerdict[]; judgeUsage: ModelUsage | undefined }> {
  const waived = executed.waived?.map((entry) => entry.criterionId) ?? []
  // Both sides (#147): the base rides the executed result, so the judge is
  // handed it wherever the result is judged, and it computes the regressions.
  const judged = judgeRun({ base: toBaseSideResults(executed), head: toSideResults(executed), waived })
  const regressed = new Set(judged.regressions.map((regression) => regression.criterionId))
  const evidenceById = new Map(executed.criteria.map((criterion) => [criterion.id, evidenceOf(criterion)]))
  let criteria = judged.criteria
  let judgeUsage: ModelUsage | undefined
  if (opts.verifier !== undefined && executed.verdict !== 'refused') {
    const verified = await runVerifier(
      opts.verifier,
      prepareVerifierInputs({ criteria: judged.criteria, texts: opts.texts, evidence: Object.fromEntries(evidenceById), diff: opts.diff }),
    )
    criteria = verified.verdicts
    judgeUsage = verified.usage
  }
  const changed = criteria.filter((criterion, index) => criterion.outcome !== judged.criteria[index]?.outcome)
  // A refused run executed nothing, so there is nothing to judge: recomputing
  // it from all-unverified criteria would read it back as blocked.
  const verdict = executed.verdict === 'refused' ? 'refused' : verdictOf(criteria, judged.regressions, waived)
  const result = redactResult(judgedResult(executed, verdict, criteria, evidenceById, regressed), opts.rules ?? BUILTIN_REDACTION_RULES)
  // What the verifier model spent (#51): part of the run's metrics, riding
  // the judged result the same way the plan's spend rides the plan.
  const full = { ...result, ...(judgeUsage === undefined ? {} : { judgeUsage }) }
  return { result: full, changed, judgeUsage }
}
