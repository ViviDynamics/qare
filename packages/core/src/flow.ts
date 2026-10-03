import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { A11yAuditRequest, A11yFlowAudit, A11yFlowAudits, A11yPageAudit } from './a11y.js'
import type { ExecutionKind } from './environment.js'
import {
  REPAIRS_SCHEMA_VERSION,
  decideRepair,
  describeReference,
  findCandidates,
  identityOfPath,
  identityText,
  type FlowRepairRecord,
} from './locator.js'
import { DEFAULT_CHECK_TIMEOUT_MS, runCommandCheck } from './run.js'
import { SNAPSHOT_SCHEMA_VERSION, nameFindings, trimToSubtree, type SnapshotNode } from './snapshot.js'
import { totpCode, totpWindow, windowRemaining } from './totp.js'

/**
 * The fixed flow vocabulary a plan may ask for (#70, #121). Actions are named
 * for intent rather than for a library, so the same check runs against any
 * driver that declares the same set; the driver resolves element references
 * against the page, and nothing here names a selector.
 */
export type FlowElement = { role: string; name: string; at?: string } | { testId: string }

export type FlowAction =
  | { action: 'open'; url: string }
  | { action: 'type'; element: FlowElement; value: string }
  | { action: 'click'; element: FlowElement }
  /** Chooses the option whose accessible name is `value` in the element (#70). */
  | { action: 'choose'; element: FlowElement; value: string }
  /** Waits until the element is visible, without asserting anything about it (#70). */
  | { action: 'waitFor'; element: FlowElement }
  /** Asserts the text is visible. A failed assert is a failed check (#70). */
  | { action: 'assertText'; text: string }
  /** Asserts the element is visible. A failed assert is a failed check (#70). */
  | { action: 'assertElement'; element: FlowElement }
  /** Takes a screenshot of the page as it stands, as evidence (#70). */
  | { action: 'capture' }
  /** Types the code the harness generates from the profile's seeded secret (#64). */
  | { action: 'totp'; element: FlowElement }
  /** Types the profile's seeded backup code, where the app accepts one (#64). */
  | { action: 'backupCode'; element: FlowElement }

/**
 * What one driver supports (#70): a plan naming an action the driver lacks is
 * rejected before anything runs, with the action and the driver named. Evidence
 * kinds are what the driver can produce for the harness to publish.
 */
export interface FlowDriverCapabilities {
  name: string
  actions: readonly string[]
  evidence: readonly string[]
  /**
   * The check kinds beyond a flow that need a seam of the driver's own and
   * that it serves (#72): a `visual` capture, an `a11y` audit. A plan naming
   * one the driver leaves out is refused before anything runs, naming the
   * kind and the driver. Absent, the driver does not say, and such a check
   * finds out when it runs.
   */
  checks?: readonly string[]
}

/** The check kinds a driver has to serve with a seam of its own (#72). */
export const DRIVER_CHECK_KINDS = ['visual', 'a11y'] as const

/** The driver-served check kinds this driver declares it cannot run; none when it does not say. */
export function undeclaredCheckKinds(driver: FlowDriverCapabilities | undefined): string[] {
  const checks = driver?.checks
  return checks === undefined ? [] : DRIVER_CHECK_KINDS.filter((kind) => !checks.includes(kind))
}

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
  choose(element: FlowElement, value: string): Promise<void>
  waitFor(element: FlowElement): Promise<void>
  assertText(text: string): Promise<void>
  assertElement(element: FlowElement): Promise<void>
  screenshot(path: string): Promise<void>
  /**
   * The page's accessibility snapshot in the normalised schema (#82), mapped
   * from the driver's own tree. Optional: a driver without a snapshot seam
   * keeps working; its flow checks carry no snapshot evidence.
   */
  snapshot?: () => Promise<SnapshotNode>
  /**
   * Audit the page as it stands against the accessibility rule set (#149),
   * at the width and theme asked for, and put the viewport back. Optional:
   * a driver without the seam leaves an `a11y` check unverified.
   */
  audit?: (request: A11yAuditRequest) => Promise<A11yPageAudit>
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
  /**
   * Audit the pages the flow visits (#149): the rule set's tags, and the
   * widths and themes each settled page is audited at. No width audits once,
   * at the viewport the flow ran in.
   */
  a11y?: { tags: readonly string[]; widths: readonly number[]; themes: readonly string[] }
}

export interface FlowCheckResult {
  outcome: 'passed' | 'failed' | 'unverified'
  reason?: string
  evidence: string[]
  /** Every repair proposed this check, applied or refused (#83). */
  repairs?: FlowRepairRecord[]
  /** The audits the flow made, when it was asked to audit (#149). What they come to is the caller's to decide. */
  a11y?: A11yFlowAudits
}

const KNOWN_KINDS: readonly string[] = [
  'open',
  'type',
  'click',
  'choose',
  'waitFor',
  'assertText',
  'assertElement',
  'capture',
  'totp',
  'backupCode',
]

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

export function describeElement(element: FlowElement): string {
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
    case 'choose':
      return `action ${index}: choose ${describeElement(action.element)}=${action.value}`
    case 'waitFor':
      return `action ${index}: wait for ${describeElement(action.element)}`
    case 'assertText':
      return `action ${index}: assert text "${action.text}" is visible`
    case 'assertElement':
      return `action ${index}: assert the element ${describeElement(action.element)} is visible`
    case 'capture':
      return `action ${index}: capture a screenshot`
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
  const { actions, page, trace, outDir, tracesDir, redactLog, masks, totp, generatedCodes, codesOnPage = false, now = Date.now, a11y } = opts

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
  const screenshot = async (name: string, opts: { required?: boolean } = {}): Promise<string | undefined> => {
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
      // A capture the plan asked for is the proof it asked for: the flow cannot
      // pass as though the pixels were published when the capture failed (#70).
      if (opts.required) throw error
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
  // A capture is evidence the flow took on the way past, so it is listed in
  // the result whatever happens to the actions that follow it (#70).
  const captures: string[] = []
  const evidence: string[] = [ACTION_LOG]

  // At every assertion the page is snapshotted into the normalised schema and
  // the subtree the assertion touched is written to the evidence (#82), so the
  // same criterion yields comparable snapshots across clients. A control in
  // that subtree with no accessible name is a named finding, not a silent pass.
  const snapshotAt = async (index: number, trim?: string): Promise<void> => {
    if (page.snapshot === undefined) {
      log.push('snapshot not taken: the driver exposes no accessibility snapshot')
      return
    }
    try {
      const full = await page.snapshot()
      const trimmed = trim === undefined ? full : trimToSubtree(full, trim)
      const findings = nameFindings(trimmed)
      const name = `assert-${index}.json`
      const record = {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        ...(trim === undefined ? {} : { assertedText: trim }),
        snapshot: trimmed,
        findings,
      }
      const serialized = `${JSON.stringify(record, null, 2)}\n`
      await writeFile(join(outDir, name), redactLog === undefined ? serialized : redactLog(serialized))
      evidence.push(name)
      log.push(`snapshot ${name}: ${trimmed.path}`)
      for (const finding of findings) log.push(finding)
    } catch (error) {
      log.push(`snapshot failed: ${String(error)}`)
    }
  }

  // The element actions a locator repair may act on (#83): the assertion
  // kinds are absent on purpose. A repair never touches what a check asserts,
  // and an `open` or `capture` names no element at all.
  const REPAIRABLE_ACTIONS: readonly string[] = ['type', 'click', 'choose', 'waitFor', 'totp', 'backupCode']

  // One action, driven through the seam. Both the plan's own drive and a
  // repaired re-drive land here, and everything the switch touches — the
  // captures, the codes the flow puts on the page — is the check's own state,
  // shared by both (#83).
  const drive = async (current: FlowAction, index: number): Promise<string | undefined> => {
    switch (current.action) {
      case 'open':
        await page.open(current.url)
        break
      case 'type':
        await page.type(current.element, current.value)
        break
      case 'click':
        await page.click(current.element)
        break
      case 'choose':
        await page.choose(current.element, current.value)
        break
      case 'waitFor':
        await page.waitFor(current.element)
        break
      case 'assertText':
        await page.assertText(current.text)
        await snapshotAt(index, current.text)
        break
      case 'assertElement':
        await page.assertElement(current.element)
        await snapshotAt(index, 'name' in current.element ? current.element.name : undefined)
        break
      case 'capture': {
        const name = `capture-${index}.png`
        const taken = await screenshot(name, { required: true })
        if (taken !== undefined) captures.push(name)
        break
      }
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
        // The code is on the page from the moment the type is attempted:
        // a type that half-succeeds and then throws must not publish a
        // capture of the input, so the flag is set before the attempt (#64).
        codeOnPage = true
        // The sweep knows the value from the moment the seam may: a type
        // that throws after partially filling the input still has the value
        // swept from the failure reason (#64).
        generatedCodes?.push(code)
        await page.type(current.element, code)
        // A boundary that crosses while the flow is moving can leave the
        // app validating the old window's code; the code is retried once,
        // in the window it now sits in (#64).
        if (totpWindow(config.period, now()) !== window) {
          const retried = totpCode(config.secret, config, now())
          generatedCodes?.push(retried)
          await page.type(current.element, retried)
          return `action ${index}: the code straddled a window boundary; the next window's code is typed in its place into ${describeElement(current.element)}`
        }
        return `action ${index}: totp code generated for window ${window} and typed into ${describeElement(current.element)}`
      }
      case 'backupCode': {
        const value = totp!.backupCode!
        // The recovery value is fail-closed the same way: the capture is
        // withheld from a type that throws, whatever the seam did first (#64).
        codeOnPage = true
        generatedCodes?.push(value)
        await page.type(current.element, value)
        break
      }
    }
    return undefined
  }

  // The locator repair itself (#83): an element action failed, its reference
  // carries the snapshot path it was authored against, and the page holds a
  // snapshot now. The repair is proposed, applied with one re-drive, or
  // refused to review, by the identity rule in locator.ts; whichever way it
  // goes it is recorded, and the check's assertions are never touched.
  const repairLocator = async (
    action: FlowAction,
    index: number,
    log: string[],
    records: FlowRepairRecord[],
  ): Promise<{ line: string } | { refused: string } | undefined> => {
    if (!REPAIRABLE_ACTIONS.includes(action.action)) return undefined
    const element = 'element' in action ? action.element : undefined
    if (element === undefined || 'testId' in element || element.at === undefined || page.snapshot === undefined) return undefined
    const identity = identityText(identityOfPath(element.at).landmarks)
    let root: SnapshotNode
    try {
      root = await page.snapshot()
    } catch (error) {
      log.push(`locator repair skipped: the snapshot the repair needed failed: ${String(error)}`)
      return undefined
    }
    const decision = decideRepair(element.at, findCandidates(root, element))
    if (decision.decision === 'review') {
      records.push({ action: index, reference: describeReference(element), identity, status: 'refused', refusedReason: decision.reason })
      log.push(`locator repair refused: ${decision.reason}`)
      return { refused: decision.reason }
    }
    const repaired: FlowElement = { role: element.role, name: element.name, at: decision.path }
    records.push({ action: index, reference: describeReference(element), repaired: describeReference(repaired), identity, status: 'applied' })
    log.push(`locator repair applied: action ${index} ${describeReference(element)} -> ${describeReference(repaired)}: ${identity}`)
    try {
      const repairedAction = { ...action, element: repaired }
      const driven = await drive(repairedAction, index)
      return { line: driven ?? describeAction(repairedAction, index) }
    } catch (error) {
      log.push(`locator repair re-drove action ${index} and it still failed: ${String(error)}`)
      return undefined
    }
  }

  // Every repair this check proposed, applied or refused (#83), recorded
  // whether it fixed the action or sent it to review.
  const records: FlowRepairRecord[] = []

  // The accessibility audits (#149). The page is audited where the plan
  // itself declared it settled: after an open, after a wait or an assertion
  // that held, and at the end of a flow that passed. A point nothing acted
  // on the page since the last audit is not audited twice. One audit that
  // cannot be made ends the auditing, named: the rest would only repeat it,
  // and a page that was not audited is never read as a clean one.
  const audits: A11yFlowAudit[] = []
  let auditError: string | undefined
  let actedSinceAudit = false
  const ACTS_ON_PAGE: readonly string[] = ['open', 'type', 'click', 'choose', 'totp', 'backupCode']
  const SETTLES_PAGE: readonly string[] = ['open', 'waitFor', 'assertText', 'assertElement']
  const auditAt = async (point: number): Promise<void> => {
    if (a11y === undefined || !actedSinceAudit || auditError !== undefined) return
    actedSinceAudit = false
    if (page.audit === undefined) {
      auditError = 'the driver exposes no accessibility audit'
      log.push(`a11y audit not made: ${auditError}`)
      return
    }
    for (const width of a11y.widths.length === 0 ? [undefined] : a11y.widths) {
      for (const theme of a11y.themes) {
        const at = `${width ?? 'viewport'}x${theme}`
        const shot = `a11y/${point}-${at}.png`
        try {
          // A screenshot is evidence redaction cannot read, so none is taken
          // while a one-time code may sit on the page (#64).
          if (codeOnPage) log.push(`a11y screenshot withheld at ${at}: the second-factor code is visible on the page, and redaction cannot read pixels`)
          else await mkdir(join(outDir, 'a11y'), { recursive: true })
          const audit = await page.audit({ tags: a11y.tags, ...(width === undefined ? {} : { width }), theme, ...(codeOnPage ? {} : { screenshot: join(outDir, shot) }) })
          const taken = audit.screenshot === true && !codeOnPage
          audits.push({ ...audit, point, ...(taken ? { screenshotPath: shot } : {}) })
          const found = audit.violations.reduce((sum, violation) => sum + violation.nodes.length, 0)
          log.push(`a11y audit after action ${point} at ${audit.width}x${theme}: ${found} violation(s)${taken ? `, screenshot ${shot}${masksNote}` : ''}`)
        } catch (error) {
          auditError = `the accessibility audit after action ${point} at ${at} could not be made: ${String(error)}`
          log.push(`a11y audit failed: ${auditError}`)
          return
        }
      }
    }
  }
  const settled = async (action: FlowAction, index: number): Promise<void> => {
    if (ACTS_ON_PAGE.includes(action.action)) actedSinceAudit = true
    if (SETTLES_PAGE.includes(action.action)) await auditAt(index)
  }

  for (const [index, action] of actions.entries()) {
    const line = describeAction(action, index)
    try {
      const driven = await drive(action, index)
      log.push(driven ?? line)
      await settled(action, index)
    } catch (error) {
      if (action.action === 'assertText' || action.action === 'assertElement') {
        outcome = 'failed'
        reason =
          action.action === 'assertText'
            ? `assert failed: the text ${JSON.stringify(action.text)} is not visible`
            : `assert failed: the element ${describeElement(action.element)} is not visible`
        // The snapshot at a failed assert shows what the page held instead,
        // trimmed as far as the assertion would have sat (#82). An element
        // assertion trims to its accessible name when it names one and keeps
        // the whole tree for a test-id reference (#82).
        if (action.action === 'assertText') await snapshotAt(index, action.text)
        else await snapshotAt(index, 'name' in action.element ? action.element.name : undefined)
        failureScreenshot = await screenshot(FAILURE_SCREENSHOT)
        break
      }
      // A locator repair is the one second chance an element action gets (#83):
      // the reference is re-driven in the repaired element's place, and the
      // action's own line stands in the log when the re-drive succeeds.
      const repaired = await repairLocator(action, index, log, records)
      if (repaired !== undefined && 'line' in repaired) {
        log.push(repaired.line)
        await settled(action, index)
        continue
      }
      // The failure reason quotes what the action saw, and the action may
      // have seen a value the flow put on the page: the same sweep that
      // follows the code through the log follows it into the reason (#64).
      outcome = 'unverified'
      reason =
        repaired !== undefined && 'refused' in repaired
          ? `action ${index} failed: ${redactLog === undefined ? String(error) : redactLog(String(error))}; the locator repair was refused: ${repaired.refused}`
          : `action ${index} failed: ${redactLog === undefined ? String(error) : redactLog(String(error))}`
      failureScreenshot = await screenshot(FAILURE_SCREENSHOT)
      break
    }
  }

  evidence.push(...captures)
  // The state a passing flow ended in is a page it visited, like the others.
  if (outcome === 'passed') await auditAt(actions.length)
  for (const audit of audits) if (audit.screenshotPath !== undefined) evidence.push(audit.screenshotPath)
  if (outcome === 'passed') {
    const final = await screenshot(FINAL_SCREENSHOT)
    if (final !== undefined) evidence.push(final)
  } else if (failureScreenshot !== undefined) {
    evidence.push(failureScreenshot)
  }
  // The repairs are evidence like the log is: written through the same
  // redaction sweep, listed in the evidence, and named in the run's comment.
  if (records.length > 0) {
    const serialized = `${JSON.stringify({ schemaVersion: REPAIRS_SCHEMA_VERSION, repairs: records }, null, 2)}\n`
    await writeFile(join(outDir, 'repairs.json'), redactLog === undefined ? serialized : redactLog(serialized))
    evidence.push('repairs.json')
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

  const audited: Pick<FlowCheckResult, 'a11y'> = a11y === undefined ? {} : { a11y: { audits, ...(auditError === undefined ? {} : { error: auditError }) } }
  return outcome === 'passed'
    ? { outcome, evidence, ...(records.length === 0 ? {} : { repairs: records }), ...audited }
    : { outcome, reason, evidence, ...(records.length === 0 ? {} : { repairs: records }), ...audited }
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
  opts: { cwd: string; timeoutMs?: number; execution?: ExecutionKind },
): Promise<{ outcome: 'passed' | 'failed' | 'unverified'; reason?: string }> {
  const outcome = await runCommandCheck(
    { kind: 'command', run: suite.command },
    opts.cwd,
    opts.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
    opts.execution,
  )
  if (outcome.status === 'passed') return { outcome: 'passed' }
  if (outcome.status === 'failed')
    return { outcome: 'failed', reason: `suite ${suite.name} exited ${outcome.code ?? 'unknown'}` }
  return { outcome: 'unverified', reason: outcome.reason }
}
