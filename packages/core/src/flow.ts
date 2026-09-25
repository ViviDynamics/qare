import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_CHECK_TIMEOUT_MS, runCommandCheck } from './run.js'

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
}

export interface FlowCheckResult {
  outcome: 'passed' | 'failed' | 'unverified'
  reason?: string
  evidence: string[]
}

const KNOWN_KINDS: readonly string[] = ['open', 'type', 'click', 'assert']

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
  const { actions, page, trace, outDir, tracesDir, redactLog } = opts

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

  await mkdir(outDir, { recursive: true })

  const log: string[] = []
  const writeLog = async (): Promise<void> => {
    const text = log.join('\n')
    await writeFile(join(outDir, ACTION_LOG), `${redactLog === undefined ? text : redactLog(text)}\n`)
  }
  const screenshot = async (name: string): Promise<string | undefined> => {
    try {
      await page.screenshot(join(outDir, name))
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
    log.push(describeAction(action, index))
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
