import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_CHECK_TIMEOUT_MS, runCommandCheck } from './run.js'
import { totpCode, totpWindow, windowRemaining } from './totp.js'

/**
 * The fixed flow vocabulary a plan may ask for (#70, #121). The driver resolves
 * element references against the page; nothing here names a selector.
 */
export type FlowElement = { role: string; name: string } | { testId: string }

export type FlowAction =
  | { action: 'open'; url: string }
  | { action: 'type'; element: FlowElement; value: string }
  | { action: 'click'; element: FlowElement }
  | { action: 'assert'; text: string }
  /** Types the code the harness generates from the profile's seeded secret (#64). */
  | { action: 'totp'; element: FlowElement }
  /** Types the profile's seeded backup code, where the app accepts one (#64). */
  | { action: 'backupCode'; element: FlowElement }

/** The profile's `login.totp` section, carried to the flow that types its codes. */
export interface FlowTotpConfig {
  secret: string
  digits: number
  period: number
  algorithm: 'SHA1' | 'SHA256' | 'SHA512'
  backupCode?: string
}

export interface FlowPage {
  open(url: string): Promise<void>
  click(element: FlowElement): Promise<void>
  type(element: FlowElement, value: string): Promise<void>
  assertText(text: string): Promise<void>
  screenshot(path: string): Promise<void>
}

export interface FlowTrace {
  start(): Promise<string>
  stop(path: string): Promise<void>
}

export interface FlowCheckOpts {
  actions: FlowAction[]
  page: FlowPage
  trace?: FlowTrace
  /** The check's own directory inside the evidence: the action log and screenshots land here. */
  outDir: string
  /**
   * Where the trace is written: a Playwright trace is a zip, which evidence
   * redaction cannot read (#52), so it is kept out of the published evidence
   * and its location is noted in the action log instead.
   */
  tracesDir?: string
  /**
   * Applied to the action log before it is written: the log carries user-
   * authored strings, so it goes through the same sweep as the rest of the
   * published evidence.
   */
  redactLog?: (text: string) => string
  /**
   * Profile masks (#119): page regions the browser blacks out while it takes
   * every screenshot of this check, so fixture data never reaches the pixels.
   * The action log names them beside each screenshot they applied to.
   */
  masks?: string[]
  /**
   * The profile's seeded second factor (#64). A `totp` or `backupCode` action
   * without it is unverified before anything runs: the code path cannot run
   * without the secret the profile seeds.
   */
  totp?: FlowTotpConfig
  /** Every code the harness generated, so the caller can sweep them from the evidence (#64). */
  generatedCodes?: string[]
  /** Whether a code the flow did not generate itself — a mail-borne one — is already on the page (#64). */
  codesOnPage?: boolean
  /** Injectable clock, so window arithmetic is pinned in tests. */
  now?: () => number
}

export interface FlowCheckResult {
  outcome: 'passed' | 'failed' | 'unverified'
  reason?: string
  evidence: string[]
}

const KNOWN_KINDS: readonly string[] = ['open', 'type', 'click', 'assert', 'totp', 'backupCode']

/**
 * A code typed this close to a window boundary is generated for the next
 * window instead: the app validating it across the boundary would reject it
 * (RFC 6238 §5.2), and the retry below only covers a boundary that crosses
 * while the flow is moving (#64).
 */
const BOUNDARY_GUARD_MS = 1000

const FAILURE_SCREENSHOT = 'failure.png'
const FINAL_SCREENSHOT = 'final.png'
const ACTION_LOG = 'actions.log'

function unknownKind(action: FlowAction): string | undefined {
  const kind = (action as { action?: unknown }).action
  return KNOWN_KINDS.includes(String(kind)) ? undefined : String(kind)
}

function describeElement(element: FlowElement): string {
  return 'testId' in element ? `testId=${element.testId}` : `role=${element.role} name=${element.name}`
}

function describeAction(action: FlowAction, index: number): string {
  switch (action.action) {
    case 'open':
      return `action ${index}: open ${action.url}`
    case 'type':
      return `action ${index}: type ${describeElement(action.element)}=${action.value}`
    case 'click':
      return `action ${index}: click ${describeElement(action.element)}`
    case 'assert':
      return `action ${index}: assert text "${action.text}" is visible`
    case 'totp':
      return `action ${index}: totp code generated from the profile's seeded secret and typed into ${describeElement(action.element)}`
    case 'backupCode':
      return `action ${index}: backup code from the profile's seeded value typed into ${describeElement(action.element)}`
  }
}

/**
 * Drive one flow check through the page seam, producing the evidence the issue
 * asks for: the action log, a screenshot at the end and at the point of
 * failure, and a trace kept out of the published evidence.
 *
 * A failed assert is a failed check. Anything that is not the page's fault —
 * an unknown action, an action that cannot run, a trace that cannot start —
 * is unverified, never failed: the criterion says nothing about the change.
 */
export async function runFlowCheck(opts: FlowCheckOpts): Promise<FlowCheckResult> {
  const { actions, page, trace, outDir, tracesDir, redactLog, masks, totp, generatedCodes, codesOnPage = false, now = Date.now } = opts

  if (actions.length === 0) {
    return { outcome: 'unverified', reason: 'flow has no actions', evidence: [] }
  }

  for (const action of actions) {
    const kind = unknownKind(action)
    if (kind !== undefined) {
      return {
        outcome: 'unverified',
        reason: `unknown action kind: ${kind}`,
        evidence: [],
      }
    }
  }

  // A second factor the profile does not seed is a gap the flow cannot run
  // past: named before anything runs, like an unknown action (#64).
  const needsTotp = actions.some((action) => action.action === 'totp' || action.action === 'backupCode')
  if (needsTotp && totp === undefined) {
    return {
      outcome: 'unverified',
      reason: 'the flow types a second factor, but the profile declares no login.totp; the code path cannot run without the secret the profile seeds',
      evidence: [],
    }
  }
  if (totp !== undefined && actions.some((action) => action.action === 'backupCode') && totp.backupCode === undefined) {
    return {
      outcome: 'unverified',
      reason: 'the flow types a backup code, but the profile declares no login.backupCode value; the alternative factor cannot run without a seeded code',
      evidence: [],
    }
  }

  await mkdir(outDir, { recursive: true })

  const log: string[] = []
  const writeLog = async (): Promise<void> => {
    const text = log.join('\n')
    await writeFile(join(outDir, ACTION_LOG), `${redactLog === undefined ? text : redactLog(text)}\n`)
  }
  // Evidence says which masks applied to each screenshot (#119): the masks are
  // the profile's own, so the note is the same for every capture, and user-
  // authored strings like the selectors are redacted with the log.
  const masksNote = masks === undefined || masks.length === 0 ? '' : ` masks: ${masks.join(', ')}`
  // The failure screenshot is evidence an image rule cannot read, so it is
  // withheld while a second-factor code may still sit on the page (#64).
  // A second-factor code the page has been handed — generated here or read
  // from mail — may still sit in an input on it, and redaction cannot read
  // pixels: every capture is withheld until the flow can prove otherwise (#64).
  let codeOnPage = codesOnPage
  const screenshot = async (name: string): Promise<string | undefined> => {
    if (codeOnPage) {
      log.push(`${name} withheld: the second-factor code is visible on the page, and redaction cannot read pixels`)
      return undefined
    }
    try {
      await page.screenshot(join(outDir, name))
      log.push(`screenshot ${name}${masksNote}`)
      return name
    } catch (error) {
      log.push(`screenshot ${name} failed: ${String(error)}`)
      return undefined
    }
  }

  if (trace) {
    try {
      await trace.start()
    } catch (error) {
      return { outcome: 'unverified', reason: `trace start failed: ${String(error)}`, evidence: [] }
    }
  }

  let outcome: FlowCheckResult['outcome'] = 'passed'
  let reason: string | undefined
  let failureScreenshot: string | undefined

  for (const [index, action] of actions.entries()) {
    let line = describeAction(action, index)
    try {
      switch (action.action) {
        case 'open':
          await page.open(action.url)
          break
        case 'type':
          await page.type(action.element, action.value)
          break
        case 'click':
          await page.click(action.element)
          break
        case 'assert':
          await page.assertText(action.text)
          break
        case 'totp': {
          const config = totp!
          // A code generated against a window that ends before the app reads
          // it is born stale: wait out the boundary and mint the next
          // window's code instead (#64).
          const remaining = windowRemaining(config.period, now())
          if (remaining < BOUNDARY_GUARD_MS) {
            await new Promise((resolve) => setTimeout(resolve, remaining))
          }
          const window = totpWindow(config.period, now())
          const code = totpCode(config.secret, config, now())
          await page.type(action.element, code)
          generatedCodes?.push(code)
          line = `action ${index}: totp code generated for window ${window} and typed into ${describeElement(action.element)}`
          // A boundary that crosses while the flow is moving can leave the
          // app validating the old window's code; the code is retried once,
          // in the window it now sits in (#64).
          if (totpWindow(config.period, now()) !== window) {
            const retried = totpCode(config.secret, config, now())
            await page.type(action.element, retried)
            generatedCodes?.push(retried)
            line = `action ${index}: the code straddled a window boundary; the next window's code is typed in its place into ${describeElement(action.element)}`
          }
          codeOnPage = true
          break
        }
        case 'backupCode': {
          const value = totp!.backupCode!
          await page.type(action.element, value)
          generatedCodes?.push(value)
          codeOnPage = true
          break
        }
      }
    } catch (error) {
      if (action.action === 'assert') {
        outcome = 'failed'
        reason = `assert failed: the text ${JSON.stringify(action.text)} is not visible`
      } else {
        outcome = 'unverified'
        reason = `action ${index} failed: ${String(error)}`
      }
      failureScreenshot = await screenshot(FAILURE_SCREENSHOT)
      break
    }
    log.push(line)
  }

  // A second factor the app keeps rejecting is not the change failing: the
  // login did not complete, so the criterion is blocked with the reason
  // named, never failed (#64).
  if (outcome === 'failed' && codeOnPage) {
    outcome = 'unverified'
    reason = 'the second factor was rejected: a generated code was typed and the login still did not complete (a clock-skewed container or a persistently stale window)'
  }

  const evidence: string[] = [ACTION_LOG]
  if (outcome === 'passed') {
    const final = await screenshot(FINAL_SCREENSHOT)
    if (final !== undefined) evidence.push(final)
  } else if (failureScreenshot !== undefined) {
    evidence.push(failureScreenshot)
  }
  await writeLog()

  if (trace) {
    const tracePath = join(tracesDir ?? outDir, 'trace.zip')
    try {
      await trace.stop(tracePath)
      log.push(`trace kept out of the published evidence (redaction cannot read a zip): ${tracePath}`)
    } catch (error) {
      log.push(`trace stop failed: ${String(error)}`)
    }
    await writeLog()
  }

  return outcome === 'passed' ? { outcome, evidence } : { outcome, reason, evidence }
}

/**
 * Run an existing suite (e.g. cucumber-js) and map its exit code onto a check
 * outcome: exit 0 → passed, any other exit code → failed, and a suite that
 * cannot start or outlives its timeout → unverified.
 *
 * Limitation carried over from the command executor: the suite's `command`
 * string is split on whitespace and spawned directly without a shell, so
 * quoting, pipes and shell syntax are not interpreted.
 */
export async function runSuiteCheck(
  suite: { name: string; command: string },
  opts: { cwd: string; timeoutMs?: number },
): Promise<{ outcome: 'passed' | 'failed' | 'unverified'; reason?: string }> {
  const outcome = await runCommandCheck(
    { kind: 'command', run: suite.command },
    opts.cwd,
    opts.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
  )
  if (outcome.status === 'passed') return { outcome: 'passed' }
  if (outcome.status === 'failed')
    return { outcome: 'failed', reason: `suite ${suite.name} exited ${outcome.code ?? 'unknown'}` }
  return { outcome: 'unverified', reason: outcome.reason }
}
