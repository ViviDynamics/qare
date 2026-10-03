import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { EgressAttempt } from './egress.js'
import { isolatedHealthUrl } from './isolation.js'
import type { JobVisualCheck } from './job.js'
import { MAX_VISUAL_WIDTH } from './plan.js'
import { diffPngs } from './png.js'
import { pathOnTarget } from './profile.js'
import { redactValue, type RedactionRule } from './redact.js'
import { substituteValues, type RunValues } from './values.js'
import { runVisualCheck, type VisualCheckOpts, type VisualDiff, type VisualRevision, type VisualScreenshot } from './visual.js'
import { disposeBrowser, makePlaywrightScreenshot, outboundOf } from './visual-playwright.js'

type ScreenshotFn = NonNullable<VisualCheckOpts['screenshot']>

/**
 * Where a visual check gets its screenshots (#143): the run hands over a
 * session factory, and tests hand over a fake, exactly as a flow check gets
 * its browser. The factory receives the masks in force (#119). `outbound`
 * lists every connection the captures attempted, which a run against a target
 * holds against the hosts its profile declares (#122).
 */
export type VisualSessionFactory = (opts: { masks: string[] }) => Promise<{
  screenshot: ScreenshotFn
  dispose: () => Promise<void>
  outbound?: () => EgressAttempt[]
}>

/** The Playwright screenshot backend, as a session. */
export const playwrightVisualSession: VisualSessionFactory = async ({ masks }) => {
  const screenshot = await makePlaywrightScreenshot({ masks })
  return { screenshot, dispose: () => disposeBrowser(screenshot), outbound: () => outboundOf(screenshot) ?? [] }
}

/**
 * What a side of a run compares its captures with.
 *
 * - `nothing`: the run has one side (a target, or a run nobody asked a base
 *   of), so the head's captures are the evidence, and the record says why
 *   nothing was compared.
 * - `base-side`: this is the base side of a two-sided run (#147). It captures
 *   and compares nothing; the head side reads what it saved.
 * - `base`: this is the head side. Its captures are compared with the ones
 *   the base side saved under `evidenceDir`. `why` names the reason there are
 *   none for a criterion, when there are none.
 */
export type VisualComparison =
  | { with: 'nothing'; reason: string }
  | { with: 'base-side' }
  | { with: 'base'; evidenceDir: string; why: (criterionId: string) => string }

/** What a run's visual checks run with: the screenshot seam, the profile's defaults and masks, and the comparison. */
export interface VisualContext {
  session?: VisualSessionFactory
  /** The profile's `visual` section: the widths and themes of a check that names none. */
  defaults: { widths: number[]; themes: string[] }
  masks: string[]
  comparison: VisualComparison
  /** The health URL of the app the run boots, as the profile authors it; absent on a target run. */
  appHealth?: string
  /** The target the run checks, when it boots nothing (#122). */
  targetUrl?: string
}

export const VISUAL_RECORD = 'visual.json'

/** The theme captured when neither the check nor the profile names one: the browser's own default colour scheme. */
const DEFAULT_THEME = 'light'

/**
 * The page a visual check captures. A path is a page of the app under test:
 * below the target URL on a target run, and on the origin the run proved
 * healthy on a run that booted the app, so each side of a two-sided run
 * captures its own app. Anything else is a URL, taken as written.
 */
export function visualPageUrl(
  url: string | undefined,
  context: Pick<VisualContext, 'appHealth' | 'targetUrl'>,
  values: RunValues,
): { ok: true; url: string } | { ok: false; reason: string } {
  if (url !== undefined && !url.startsWith('/')) {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return { ok: true, url: parsed.href }
    } catch {
      // Named below.
    }
    return { ok: false, reason: `the visual check's url ${JSON.stringify(url)} is neither a path on the app nor an http(s) URL` }
  }
  if (context.targetUrl !== undefined) {
    if (url === undefined) return { ok: true, url: context.targetUrl }
    const onTarget = pathOnTarget(context.targetUrl, url)
    if (onTarget === undefined) return { ok: false, reason: `the path ${JSON.stringify(url)} climbs out of the target ${context.targetUrl}` }
    return { ok: true, url: onTarget }
  }
  if (context.appHealth === undefined) return { ok: false, reason: 'the profile names neither an app nor a target, so a visual check has no page to capture' }
  const port = values.app_port === undefined ? undefined : Number(values.app_port)
  const health = isolatedHealthUrl(substituteValues(context.appHealth, values), port)
  try {
    return { ok: true, url: new URL(url ?? '/', new URL(health).origin).href }
  } catch {
    return { ok: false, reason: `the app's health URL ${JSON.stringify(health)} names no origin a page can be captured on` }
  }
}

export interface VisualCheckJobInput {
  check: JobVisualCheck
  /** The page, already resolved (`visualPageUrl`). */
  pageUrl: string
  criterionId: string
  /** The check's position in its criterion: where the base side saved the same check's captures. */
  index: number
  evidenceDir: string
  /** The check's directory, relative to the evidence directory. */
  checkDir: string
  rules: readonly RedactionRule[]
  context: VisualContext
  defaultTimeoutMs: number
  /**
   * On a target run: record what the captures reached, and answer with the
   * connections to hosts the profile does not declare (#122).
   */
  recordOutbound?: (attempts: readonly EgressAttempt[]) => Promise<string[]>
}

export interface VisualCheckJobOutcome {
  status: 'passed' | 'failed' | 'unverified'
  reason?: string
  evidence: string[]
  /**
   * The outcome says nothing lasting about the check: the base side had no
   * screenshots this time. A cache must not serve it to the next run.
   */
  transient?: true
}

/** What the base side saved for the same check, or why there is nothing to compare with. */
type Baseline =
  | { available: true; dir: string; missed: Map<string, string> }
  | { available: false; reason: string; transient: boolean }

const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
  const left = new Set(a)
  const right = new Set(b)
  return left.size === right.size && [...left].every((entry) => right.has(entry))
}

async function baselineOf(input: VisualCheckJobInput, comparison: Extract<VisualComparison, { with: 'base' }>): Promise<Baseline> {
  const dir = join(comparison.evidenceDir, 'checks', input.criterionId, String(input.index))
  let record: { masks?: unknown; screenshots?: unknown }
  try {
    record = JSON.parse(await readFile(join(dir, VISUAL_RECORD), 'utf8')) as { masks?: unknown; screenshots?: unknown }
  } catch {
    return { available: false, reason: `no base screenshots to compare with: ${comparison.why(input.criterionId)}`, transient: true }
  }
  // The same masks at both sides, or nothing is compared (#119): a region
  // blacked out on one side only would show as a difference the change did
  // not make.
  const baseMasks = Array.isArray(record.masks) ? record.masks.filter((mask): mask is string => typeof mask === 'string') : []
  if (!sameSet(baseMasks, input.context.masks))
    return {
      available: false,
      reason: `the base screenshots were masked with ${JSON.stringify(baseMasks)} and the head's with ${JSON.stringify(input.context.masks)}, so the two cannot be compared: a region masked on one side only would show as a difference`,
      transient: false,
    }
  // Why the base side could not take a screenshot, in its own words, for the
  // pairs the head then cannot compare.
  const missed = new Map<string, string>()
  for (const entry of Array.isArray(record.screenshots) ? (record.screenshots as Array<Record<string, unknown>>) : [])
    if (entry?.outcome === 'unverified' && typeof entry.reason === 'string') missed.set(`${String(entry.width)}x${String(entry.theme)}`, entry.reason)
  return { available: true, dir, missed }
}

/**
 * Execute one visual check (#143): capture the page at each width and theme
 * through `runVisualCheck`, compare with the base side's captures when the
 * run has two sides, and decide the outcome in code from what was captured
 * and diffed. Every screenshot and diff image is evidence, and `visual.json`
 * names the page, each capture with the masks in force, and each diff.
 *
 * A screenshot that cannot be taken, a backend that will not start, and a
 * pair that cannot be compared are unverified, never failed: none of them
 * says anything about the change. A difference between base and head is
 * failed, with the diff image as its evidence. Which differences a change
 * intended is not decided here (#40).
 */
export async function runVisualCheckJob(input: VisualCheckJobInput): Promise<VisualCheckJobOutcome> {
  const { check, context, checkDir } = input
  const outDir = join(input.evidenceDir, checkDir)
  const widths = check.widths ?? context.defaults.widths
  if (widths.length === 0)
    return {
      status: 'unverified',
      reason: "the visual check names no width and the profile's visual section declares none, so there is no viewport to capture at",
      evidence: [],
    }
  const unusable = widths.find((width) => !Number.isInteger(width) || width < 1 || width > MAX_VISUAL_WIDTH)
  if (unusable !== undefined)
    return { status: 'unverified', reason: `the width ${String(unusable)} is not a whole number of pixels between 1 and ${MAX_VISUAL_WIDTH}, so nothing can be captured at it`, evidence: [] }
  const named = check.themes ?? context.defaults.themes
  const themes = named.length === 0 ? [DEFAULT_THEME] : named

  const comparison = context.comparison
  const baseline: Baseline | undefined = comparison.with === 'base' ? await baselineOf(input, comparison) : undefined
  const own: VisualRevision = comparison.with === 'base-side' ? 'base' : 'head'

  const factory = context.session ?? playwrightVisualSession
  let session: Awaited<ReturnType<VisualSessionFactory>>
  try {
    session = await factory({ masks: context.masks })
  } catch (error) {
    // A backend that will not start says nothing about the change.
    return { status: 'unverified', reason: `the screenshot backend did not start: ${error instanceof Error ? error.message : String(error)}`, evidence: [] }
  }
  if (input.recordOutbound !== undefined && session.outbound === undefined) {
    // Fail closed: a run against a target holds what its browser reached
    // against the declared hosts, and a backend that cannot say is not trusted.
    await session.dispose()
    return {
      status: 'unverified',
      reason: 'the screenshot backend does not report the hosts its browser reached, so a run against a target cannot vouch for them',
      evidence: [],
    }
  }

  const timeoutMs = check.timeoutMs ?? input.defaultTimeoutMs
  const capture: ScreenshotFn = async (url, width, theme, revision) => {
    // The base's captures were taken by the base side, against the app booted
    // from the base revision (#147). The head side reads them; it never
    // captures a base of its own.
    if (revision !== own) {
      if (baseline?.available !== true) throw new Error('the base side saved no screenshot')
      try {
        return await readFile(join(baseline.dir, 'base', `${width}x${theme}.png`))
      } catch {
        const why = baseline.missed.get(`${width}x${theme}`)
        throw new Error(`the base side saved no screenshot at ${width}x${theme}${why === undefined ? '' : ` (${why})`}`)
      }
    }
    let timer: NodeJS.Timeout | undefined
    const work = session.screenshot(url, width, theme, revision)
    // The losing branch of the race is drained, so a capture that settles
    // late does not crash the run with an unhandled rejection.
    void work.catch(() => {})
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`the capture exceeded its ${timeoutMs} ms timeout`)), timeoutMs)
          timer.unref()
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  const evidence: string[] = []
  let undeclared: string[] = []
  let screenshots: VisualScreenshot[]
  let diffs: VisualDiff[]
  try {
    const result = await runVisualCheck({
      baseUrl: input.pageUrl,
      urlAsGiven: true,
      outDir,
      widths,
      themes,
      revisions: baseline?.available === true ? ['base', 'head'] : [own],
      screenshot: capture,
      diffImages: async (basePng, headPng) => diffPngs(basePng, headPng),
      masks: context.masks,
    })
    screenshots = result.screenshots
    // A side that captured alone has no pairs: the module's "not captured"
    // entries are not a comparison anybody asked for.
    diffs = baseline?.available === true ? result.diffs : []
    // Recorded however the captures ended: a capture that timed out has
    // still reached whatever it reached.
    if (input.recordOutbound !== undefined) {
      undeclared = await input.recordOutbound(session.outbound?.() ?? [])
      evidence.push(`${checkDir}/outbound.json`)
    }
  } finally {
    await session.dispose()
  }

  const at = (entry: { width: number; theme: string }): string => `${entry.width}x${entry.theme}`
  const missed = screenshots.filter((screenshot) => screenshot.revision === own && screenshot.outcome === 'unverified')
  const differing = diffs.filter((diff) => diff.status === 'differs')
  const uncompared = diffs.filter((diff) => diff.status === 'unavailable')
  // A pair with no base capture names why the base side had none.
  const baseMissed = (diff: VisualDiff): string | undefined =>
    screenshots.find((screenshot) => screenshot.revision !== own && screenshot.width === diff.width && screenshot.theme === diff.theme && screenshot.outcome === 'unverified')?.reason

  let decided: Pick<VisualCheckJobOutcome, 'status' | 'reason' | 'transient'>
  if (undeclared.length > 0)
    decided = { status: 'unverified', reason: `refused: undeclared host: ${undeclared.join(', ')}; the target profile does not list it in target.hosts` }
  else if (missed.length > 0)
    decided = { status: 'unverified', reason: `the screenshot at ${at(missed[0] as VisualScreenshot)} could not be taken: ${missed[0]?.reason ?? 'no reason given'}` }
  else if (baseline?.available === false)
    decided = { status: 'unverified', reason: baseline.reason, ...(baseline.transient ? { transient: true as const } : {}) }
  else if (differing.length > 0)
    decided = { status: 'failed', reason: `the page differs from the base at ${differing.map(at).join(', ')}` }
  else if (uncompared.length > 0) {
    const first = uncompared[0] as VisualDiff
    const noBase = baseMissed(first)
    decided = {
      status: 'unverified',
      reason: `the screenshots at ${at(first)} could not be compared: ${noBase ?? first.reason ?? 'no reason given'}`,
      // The base side may take the screenshot next time.
      ...(noBase === undefined ? {} : { transient: true as const }),
    }
  } else decided = { status: 'passed' }

  const inCheck = (path: string | undefined): string | undefined => (path === undefined ? undefined : relative(outDir, path))
  const record = {
    screenshot: check.screenshot,
    url: input.pageUrl,
    side: own,
    widths,
    themes,
    masks: context.masks,
    comparison:
      comparison.with === 'nothing'
        ? { with: 'nothing', reason: comparison.reason }
        : comparison.with === 'base-side'
          ? { with: 'nothing', reason: 'this is the base side of the run: the head side compares its captures with these' }
          : baseline?.available === true
            ? { with: 'base' }
            : { with: 'nothing', reason: baseline?.reason ?? 'no base screenshots to compare with' },
    screenshots: screenshots.map((screenshot) => ({
      revision: screenshot.revision,
      width: screenshot.width,
      theme: screenshot.theme,
      outcome: screenshot.outcome,
      ...(screenshot.path === undefined ? {} : { path: inCheck(screenshot.path) }),
      ...(screenshot.reason === undefined ? {} : { reason: screenshot.reason }),
      // The masks in force for this capture (#119); a capture that was not
      // taken was masked by nothing.
      ...(screenshot.outcome === 'captured' ? { masks: context.masks } : {}),
    })),
    diffs: diffs.map((diff) => ({
      width: diff.width,
      theme: diff.theme,
      status: diff.status,
      ...(diff.path === undefined ? {} : { path: inCheck(diff.path) }),
      ...(diff.reason === undefined ? {} : { reason: diff.reason }),
    })),
    outcome: decided.status,
    ...(decided.reason === undefined ? {} : { reason: decided.reason }),
  }
  await mkdir(outDir, { recursive: true })
  // The text of the record is swept like any other evidence (#52): a reason
  // quotes what the browser said, and a URL can carry a credential.
  await writeFile(join(outDir, VISUAL_RECORD), `${JSON.stringify(redactValue(record, input.rules), null, 2)}\n`)
  evidence.unshift(`${checkDir}/${VISUAL_RECORD}`)
  for (const screenshot of screenshots) if (screenshot.path !== undefined) evidence.push(`${checkDir}/${inCheck(screenshot.path)}`)
  for (const diff of diffs) if (diff.path !== undefined) evidence.push(`${checkDir}/${inCheck(diff.path)}`)
  return { ...decided, evidence }
}
