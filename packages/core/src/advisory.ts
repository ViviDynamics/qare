import { createHash } from 'node:crypto'
import type { ModelUsage } from './metrics.js'
import { BUILTIN_REDACTION_RULES, redactAdvisory, type RedactionRule } from './redact.js'
import type { RunResult } from './result.js'
import type { AgentRunRequest, AgentRunner } from './runner.js'

/**
 * The advisory UX review (#150). Some problems a change introduces are
 * judgement calls no criterion states: a confusing flow, an inconsistent
 * label, an error message that does not help. A model can spot them, and a
 * model decides nothing (rule 3), so what it reports here is advisory: shown
 * to a person, kept under a key of its own, and read by nothing that computes
 * a verdict.
 *
 * The boundary is structural. A finding has no field that names an outcome,
 * the only way one enters a result is `reviewJudged`, which copies the judged
 * result and adds the `advisory` key, and the judge builds its result from
 * named fields that do not include it.
 */

export const ADVISORY_SEVERITIES = ['high', 'medium', 'low'] as const
export type AdvisorySeverity = (typeof ADVISORY_SEVERITIES)[number]

/** What a finding is about. A fixed list, so a finding's identity does not ride on wording. */
export const ADVISORY_CATEGORIES = ['label', 'error-message', 'consistency', 'flow', 'copy', 'layout', 'feedback', 'other'] as const
export type AdvisoryCategory = (typeof ADVISORY_CATEGORIES)[number]

/** One thing the reviewer pointed out on one screen. A person reads it; nothing else does. */
export interface AdvisoryFinding {
  /** What a person types to dismiss or promote it: screen, category and element, hashed. */
  id: string
  /** The screen: the evidence directory of the check that drove it. */
  screen: string
  /** The criterion that check belongs to. Context for the reader, never a judgement of it. */
  criterionId: string
  category: AdvisoryCategory
  severity: AdvisorySeverity
  /** What the reviewer saw. */
  saw: string
  /** Why it matters to a person using the screen. */
  why: string
  /** The element it is about, by role and accessible name, when it names one. */
  element?: string
  /** The screenshot the harness saved of the screen (rule 4); absent when it saved none. */
  screenshot?: string
}

/** The `advisory` key of a judged result. Nothing that decides a verdict reads it. */
export interface RunAdvisory {
  /** `unavailable` when the reviewer gave no readable answer; the reason says why. */
  status: 'reviewed' | 'unavailable'
  reason?: string
  /** The screens the reviewer was asked about. */
  screens: string[]
  findings: AdvisoryFinding[]
  /** Findings left out because a person dismissed them on this change, by id. */
  dismissed?: string[]
  /** What the reviewer model spent. */
  usage?: ModelUsage
}

/** A screen as the reviewer is handed it: the text evidence it can read, and the screenshot code attaches. */
export interface AdvisoryScreen {
  screen: string
  criterionId: string
  files: string[]
  screenshot?: string
}

/** A finding a person dismissed, as qare recorded it on the pull request. */
export interface DismissedFinding {
  id: string
  screen: string
  category: string
  saw: string
  element?: string
}

const MAX_FINDINGS = 20
const MAX_TEXT = 600
const MAX_ELEMENT = 160
/** QA.md rides the prompt, and the prompt is one argument (nare#29): a long one is cut, and says so. */
const MAX_CONTEXT = 20_000

/** The evidence a flow or an audit leaves when it drove a page: its presence is what makes a directory a screen. */
function isPageEvidence(name: string): boolean {
  return name === 'actions.log' || name === 'a11y.json' || /^assert-\d+\.json$/.test(name)
}

/** `checks/<criterion>/<index>`, the directory one check writes into; a file anywhere else has no screen. */
function checkDirOf(path: string): string | undefined {
  const parts = path.split('/')
  return parts.length >= 4 && parts[0] === 'checks' ? parts.slice(0, 3).join('/') : undefined
}

function isScreenshot(path: string): boolean {
  return path.toLowerCase().endsWith('.png')
}

/** The screenshot that shows a screen best: where it failed, else where it ended, else the last capture on the way. */
function screenshotOf(dir: string, shots: string[]): string | undefined {
  const named = (name: string): string | undefined => shots.find((shot) => shot === `${dir}/${name}`)
  const captures = shots
    .map((shot) => ({ shot, index: /^capture-(\d+)\.png$/.exec(shot.slice(dir.length + 1))?.[1] }))
    .filter((entry): entry is { shot: string; index: string } => entry.index !== undefined)
    .sort((a, b) => Number(a.index) - Number(b.index))
  return named('failure.png') ?? named('final.png') ?? captures.at(-1)?.shot ?? shots[0]
}

/**
 * The screens a run's flows visited, read from the head evidence each
 * criterion lists. The run checks the criteria of the change, so these are
 * the screens the change touched. A check that drove no page (a command, a
 * suite running its own browser) is no screen, and the base side's evidence
 * is not reviewed: it shows what the change replaced.
 */
export function advisoryScreens(result: Pick<RunResult, 'criteria'>): AdvisoryScreen[] {
  const screens: AdvisoryScreen[] = []
  for (const criterion of result.criteria ?? []) {
    const byDir = new Map<string, string[]>()
    for (const path of criterion.evidence ?? []) {
      const dir = checkDirOf(path)
      if (dir === undefined) continue
      byDir.set(dir, [...(byDir.get(dir) ?? []), path])
    }
    for (const [dir, paths] of byDir) {
      if (!paths.some((path) => isPageEvidence(path.slice(dir.length + 1)))) continue
      const screenshot = screenshotOf(dir, paths.filter(isScreenshot))
      screens.push({
        screen: dir,
        criterionId: criterion.id,
        files: paths.filter((path) => !isScreenshot(path)),
        ...(screenshot === undefined ? {} : { screenshot }),
      })
    }
  }
  return screens
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function capped(text: string, max: number): string {
  const flat = oneLine(text)
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/**
 * What "the same finding on the same screen" means in code: the screen, the
 * category and the element the finding names, whatever its wording. A finding
 * that names no element is held by what it saw instead. A model that rewords
 * a dismissed finding and names its element differently gets past this; the
 * list of dismissed findings it is handed is what covers that half.
 */
export function advisoryFindingId(finding: { screen: string; category: string; element?: string | undefined; saw: string }): string {
  const element = finding.element === undefined ? '' : oneLine(finding.element).toLowerCase()
  const subject = element === '' ? `saw:${oneLine(finding.saw).toLowerCase()}` : `element:${element}`
  return createHash('sha256').update([finding.screen, finding.category, subject].join('\n')).digest('hex').slice(0, 8)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * The only way a reviewer's answer becomes findings. The answer is read as
 * data and rebuilt field by field: the screen must be one the reviewer was
 * given, the criterion and the screenshot are attached here from that screen,
 * and anything else the model wrote is not carried. A finding a person
 * dismissed is left out and counted. An answer that is not a findings list
 * yields nothing at all.
 */
export function consumeUxFindings(
  output: unknown,
  screens: readonly AdvisoryScreen[],
  dismissed: readonly DismissedFinding[],
): { findings: AdvisoryFinding[]; dismissed: string[] } | undefined {
  if (typeof output !== 'string') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.findings)) return undefined
  const byScreen = new Map(screens.map((screen) => [screen.screen, screen]))
  const dismissedIds = new Set(dismissed.map((finding) => finding.id))
  const kept = new Map<string, AdvisoryFinding>()
  const left = new Set<string>()
  for (const raw of parsed.findings) {
    if (!isRecord(raw)) return undefined
    const { screen, category, severity, saw, why, element } = raw
    if (!nonEmpty(screen) || !nonEmpty(saw) || !nonEmpty(why)) return undefined
    if (typeof category !== 'string' || !(ADVISORY_CATEGORIES as readonly string[]).includes(category)) return undefined
    if (typeof severity !== 'string' || !(ADVISORY_SEVERITIES as readonly string[]).includes(severity)) return undefined
    if (element !== undefined && typeof element !== 'string') return undefined
    const known = byScreen.get(screen)
    if (known === undefined) continue
    const named = element === undefined || element.trim() === '' ? undefined : capped(element, MAX_ELEMENT)
    const finding = { screen, category: category as AdvisoryCategory, saw: capped(saw, MAX_TEXT), element: named }
    const id = advisoryFindingId(finding)
    if (dismissedIds.has(id)) {
      left.add(id)
      continue
    }
    if (kept.has(id)) continue
    kept.set(id, {
      id,
      screen,
      category: finding.category,
      severity: severity as AdvisorySeverity,
      saw: finding.saw,
      why: capped(why, MAX_TEXT),
      ...(named === undefined ? {} : { element: named }),
      criterionId: known.criterionId,
      ...(known.screenshot === undefined ? {} : { screenshot: known.screenshot }),
    })
  }
  const rank = (finding: AdvisoryFinding): number => ADVISORY_SEVERITIES.indexOf(finding.severity)
  // A stable sort: the most severe first, the model's order within a severity.
  const findings = [...kept.values()].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_FINDINGS)
  return { findings, dismissed: [...left] }
}

const UX_REVIEW_INSTRUCTIONS = [
  'You are the qare UX reviewer. You read what a QA run saw of the screens a change touched, and point out user-experience problems that no acceptance criterion states.',
  'You receive the screens. Each has the criterion its check belongs to, and the evidence files saved for it: the action log of the flow that drove the page, accessibility snapshots of the page (the role, accessible name and state of each element), and the accessibility audit record when one was made. You can read those files. You cannot see the screenshots, so report only what the files show, and nothing about colour, spacing or anything else only pixels would show.',
  'Report what a person using the screen would trip over: a control with no label, or a label that does not say what it does; an error message that does not say what went wrong or what to do next; wording or a pattern that differs from the screens around it, from QA.md or from the house rules; a flow with a confusing or missing step; an action that gives no feedback.',
  'Your findings are advisory. They are shown to a person and decide nothing: you cannot prove, fail or change a criterion, so do not say whether one is met.',
  'Each finding names the screen exactly as it was given, a category (label, error-message, consistency, flow, copy, layout, feedback or other), a severity (high: a person cannot finish the task or is likely to make a mistake; medium: a person is slowed or confused; low: polish), what you saw, why it matters, and the element it is about, by role and accessible name, when there is one.',
  'The findings under "dismissed" were raised on this change before and a person dismissed them. Do not report them again, however you would word them.',
  'Answer with {"findings": [{"screen": string, "category": string, "severity": string, "saw": string, "why": string, "element": string_OR_omit}]}. An empty list is an answer: most screens are fine.',
].join('\n')

/** The answer shape nare validates the reviewer's output against. No field names a criterion, an outcome or a file. */
export const UX_REVIEW_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['findings'],
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['screen', 'category', 'severity', 'saw', 'why'],
        additionalProperties: false,
        properties: {
          screen: { type: 'string' },
          category: { type: 'string', enum: [...ADVISORY_CATEGORIES] },
          severity: { type: 'string', enum: [...ADVISORY_SEVERITIES] },
          saw: { type: 'string' },
          why: { type: 'string' },
          element: { type: 'string' },
        },
      },
    },
  },
} as const

export interface UxReviewInputs {
  screens: readonly AdvisoryScreen[]
  /** Each criterion's text, as context for the screen its check drove. */
  texts: Record<string, string>
  /** The profile's QA.md: what the app is and what matters in it. */
  qaMd?: string
  /** The profile's house rules: a design system, voice and tone, patterns to hold to. */
  houseRules?: readonly string[]
  /** What a person dismissed on this change already. */
  dismissed?: readonly DismissedFinding[]
}

function unavailable(screens: readonly AdvisoryScreen[], reason: string, usage?: ModelUsage): RunAdvisory {
  return { status: 'unavailable', reason, screens: screens.map((screen) => screen.screen), findings: [], ...(usage === undefined ? {} : { usage }) }
}

/**
 * Hand the screens to the model through the agent runner seam, with the
 * read-only tool set the verifier uses, and consume its findings. With no
 * screen there is nothing to review and no model is called.
 *
 * It never throws and never decides: a runner that throws, a run that does
 * not complete, or an answer that is not a findings list is `unavailable`
 * with the reason named and no findings. The run's verdict was computed
 * before this was called and is not an input to it.
 */
export async function runUxReview(
  runner: AgentRunner,
  inputs: UxReviewInputs,
  request: Partial<Omit<AgentRunRequest, 'prompt'>> = {},
): Promise<RunAdvisory | undefined> {
  const screens = inputs.screens
  if (screens.length === 0) return undefined
  const dismissed = inputs.dismissed ?? []
  const context = inputs.qaMd === undefined || inputs.qaMd.trim() === '' ? undefined : inputs.qaMd
  const payload = JSON.stringify({
    screens: screens.map((screen) => {
      const text = Object.hasOwn(inputs.texts, screen.criterionId) ? inputs.texts[screen.criterionId] : undefined
      return { screen: screen.screen, criterion: { id: screen.criterionId, ...(text === undefined ? {} : { text }) }, files: screen.files }
    }),
    ...(context === undefined
      ? {}
      : { qaMd: context.length <= MAX_CONTEXT ? context : `${context.slice(0, MAX_CONTEXT)}\n[QA.md cut at ${MAX_CONTEXT} characters]` }),
    ...(inputs.houseRules === undefined || inputs.houseRules.length === 0 ? {} : { houseRules: inputs.houseRules }),
    ...(dismissed.length === 0
      ? {}
      : {
          dismissed: dismissed.map((finding) => ({
            screen: finding.screen,
            category: finding.category,
            saw: finding.saw,
            ...(finding.element === undefined ? {} : { element: finding.element }),
          })),
        }),
  })
  let result: Awaited<ReturnType<AgentRunner['run']>>
  try {
    result = await runner.run({
      system: request.system ?? '',
      toolPolicy: request.toolPolicy ?? 'read-only',
      outputSchema: request.outputSchema ?? JSON.stringify(UX_REVIEW_OUTPUT_SCHEMA),
      budget: request.budget ?? { maxOutputTokens: 4096 },
      prompt: `${UX_REVIEW_INSTRUCTIONS}\n\n${payload}`,
    })
  } catch (error) {
    return unavailable(screens, error instanceof Error ? error.message : String(error))
  }
  if (result.status !== 'completed')
    return unavailable(screens, `the run stopped (${result.stopReason})${result.error === undefined ? '' : `: ${result.error}`}`, result.usage)
  const consumed = consumeUxFindings(result.output, screens, dismissed)
  if (consumed === undefined) return unavailable(screens, 'its answer was not a findings list', result.usage)
  return {
    status: 'reviewed',
    screens: screens.map((screen) => screen.screen),
    findings: consumed.findings,
    ...(consumed.dismissed.length === 0 ? {} : { dismissed: consumed.dismissed }),
    usage: result.usage,
  }
}

export interface ReviewJudgedOptions extends Omit<UxReviewInputs, 'screens'> {
  /** The reviewer's model; absent to make no review. */
  reviewer?: AgentRunner
  /** Criteria whose screens are left out: the ones of a profile that turned the review off. */
  skip?: (criterionId: string) => boolean
  rules?: readonly RedactionRule[]
}

/**
 * Review a judged result. The verdict and the criteria are already decided
 * and are returned as they came: the one thing this adds is the `advisory`
 * key. A refused run executed nothing, so it has nothing to look at. A result
 * that is not reviewed carries no `advisory` key, so findings of an earlier
 * judging never ride into a run nobody reviewed.
 */
export async function reviewJudged(result: RunResult, opts: ReviewJudgedOptions): Promise<RunResult> {
  const unreviewed = (): RunResult => {
    if (result.advisory === undefined) return result
    const rest: RunResult = { ...result }
    delete rest.advisory
    return rest
  }
  if (opts.reviewer === undefined || result.verdict === 'refused') return unreviewed()
  const screens = advisoryScreens(result).filter((screen) => opts.skip?.(screen.criterionId) !== true)
  const advisory = await runUxReview(opts.reviewer, {
    screens,
    texts: opts.texts,
    ...(opts.qaMd === undefined ? {} : { qaMd: opts.qaMd }),
    ...(opts.houseRules === undefined ? {} : { houseRules: opts.houseRules }),
    ...(opts.dismissed === undefined ? {} : { dismissed: opts.dismissed }),
  })
  if (advisory === undefined) return unreviewed()
  return { ...result, advisory: redactAdvisory(advisory, opts.rules ?? BUILTIN_REDACTION_RULES) }
}
