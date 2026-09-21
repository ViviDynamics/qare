import { join } from 'node:path'

export type FlowAction =
  | { action: 'navigate'; url: string }
  | { action: 'click'; selector: string }
  | { action: 'fill'; selector: string; value: string }
  | { action: 'assert'; selector: string; text: string }

export interface FlowPage {
  navigate(url: string): Promise<void>
  click(selector: string): Promise<void>
  fill(selector: string, value: string): Promise<void>
  assertText(selector: string, text: string): Promise<void>
}

export interface FlowTrace {
  start(): Promise<string>
  stop(path: string): Promise<void>
}

export interface FlowCheckOpts {
  actions: FlowAction[]
  page: FlowPage
  trace?: FlowTrace
  outDir: string
}

export interface FlowCheckResult {
  outcome: 'passed' | 'failed' | 'unverified'
  reason?: string
  evidence: string[]
}

const KNOWN_KINDS: readonly string[] = ['navigate', 'click', 'fill', 'assert']

function unknownKind(action: FlowAction): string | undefined {
  const kind = (action as { action?: unknown }).action
  return KNOWN_KINDS.includes(String(kind)) ? undefined : String(kind)
}

function describeAction(action: FlowAction, index: number): string {
  switch (action.action) {
    case 'navigate':
      return `action ${index}: navigate ${action.url}`
    case 'click':
      return `action ${index}: click ${action.selector}`
    case 'fill':
      return `action ${index}: fill ${action.selector}=${action.value}`
    case 'assert':
      return `action ${index}: assert ${action.selector}=${action.text}`
  }
}

export async function runFlowCheck(opts: FlowCheckOpts): Promise<FlowCheckResult> {
  const { actions, page, trace, outDir } = opts

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

  const evidence: string[] = []

  if (trace) {
    try {
      await trace.start()
    } catch (error) {
      return { outcome: 'unverified', reason: `trace start failed: ${String(error)}`, evidence }
    }
  }

  let outcome: FlowCheckResult['outcome'] = 'passed'
  let reason: string | undefined

  for (const [index, action] of actions.entries()) {
    try {
      switch (action.action) {
        case 'navigate':
          await page.navigate(action.url)
          break
        case 'click':
          await page.click(action.selector)
          break
        case 'fill':
          await page.fill(action.selector, action.value)
          break
        case 'assert':
          await page.assertText(action.selector, action.text)
          break
      }
    } catch (error) {
      if (action.action === 'assert') {
        outcome = 'failed'
        reason = `assert failed: ${action.selector} does not contain "${action.text}"`
        break
      }
      outcome = 'unverified'
      reason = `action ${index} failed: ${String(error)}`
      break
    }
    evidence.push(describeAction(action, index))
  }

  if (trace) {
    const tracePath = join(outDir, 'trace.zip')
    try {
      await trace.stop(tracePath)
      evidence.push(`trace: ${tracePath}`)
    } catch (error) {
      evidence.push(`trace stop failed: ${String(error)}`)
    }
  }

  return outcome === 'passed' ? { outcome, evidence } : { outcome, reason, evidence }
}
