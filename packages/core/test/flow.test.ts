import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  runFlowCheck,
  type FlowAction,
  type FlowCheckOpts,
  type FlowPage,
  type FlowTrace,
} from '../src/index.js'

const OUT_DIR = '/tmp/qare-flow-fake'
const TRACE_PATH = join(OUT_DIR, 'trace.zip')
const APP_URL = ['http:', '//localhost:3000/up'].join('')

type PageFails = Partial<Record<'navigate' | 'click' | 'fill' | 'assertText', Error>>

function fakePage(fails: PageFails = {}): { page: FlowPage; calls: string[] } {
  const calls: string[] = []
  const step = (kind: keyof PageFails, detail: string, error: Error | undefined) => {
    calls.push(`${kind} ${detail}`)
    if (error) throw error
  }
  const page: FlowPage = {
    navigate: async (url) => step('navigate', url, fails.navigate),
    click: async (selector) => step('click', selector, fails.click),
    fill: async (selector, value) => step('fill', `${selector}=${value}`, fails.fill),
    assertText: async (selector, text) => step('assert', `${selector}=${text}`, fails.assertText),
  }
  return { page, calls }
}

function fakeTrace(opts: { startError?: Error } = {}): {
  trace: FlowTrace
  events: string[]
} {
  const events: string[] = []
  return {
    events,
    trace: {
      start: async () => {
        events.push('start')
        if (opts.startError) throw opts.startError
        return 'trace-session-1'
      },
      stop: async (path) => {
        events.push(`stop ${path}`)
      },
    },
  }
}

function optsWith(extra: Omit<Partial<FlowCheckOpts>, 'outDir'>): FlowCheckOpts {
  return { outDir: OUT_DIR, ...extra }
}

test('runs actions in order and references the stopped trace in evidence', async () => {
  const { page, calls } = fakePage()
  const { trace, events } = fakeTrace()

  const result = await runFlowCheck(
    optsWith({
      page,
      trace,
      actions: [
        { action: 'navigate', url: APP_URL },
        { action: 'fill', selector: '#email', value: 'me@example.com' },
        { action: 'click', selector: 'button[type=submit]' },
        { action: 'assert', selector: 'h1', text: 'Welcome' },
      ],
    }),
  )

  expect(result.outcome).toBe('passed')
  expect(result.reason).toBeUndefined()
  expect(calls).toEqual([
    `navigate ${APP_URL}`,
    'fill #email=me@example.com',
    'click button[type=submit]',
    'assert h1=Welcome',
  ])
  expect(events).toEqual(['start', `stop ${TRACE_PATH}`])
  expect(result.evidence.some((entry) => entry.includes(TRACE_PATH))).toBe(true)
})

test('reports failed for a mismatched assert and still writes the trace', async () => {
  const { page, calls } = fakePage({ assertText: new Error('text absent') })
  const { trace, events } = fakeTrace()

  const result = await runFlowCheck(
    optsWith({
      page,
      trace,
      actions: [
        { action: 'navigate', url: APP_URL },
        { action: 'assert', selector: 'h1', text: 'Welcome' },
      ],
    }),
  )

  expect(result.outcome).toBe('failed')
  expect(result.reason).toBe('assert failed: h1 does not contain "Welcome"')
  expect(calls).toEqual([
    `navigate ${APP_URL}`,
    'assert h1=Welcome',
  ])
  expect(events).toEqual(['start', `stop ${TRACE_PATH}`])
  expect(result.evidence.some((entry) => entry.includes(TRACE_PATH))).toBe(true)
})

test('reports unverified with the action index when a step throws', async () => {
  const { page, calls } = fakePage({ click: new Error('element detached') })
  const { trace, events } = fakeTrace()

  const result = await runFlowCheck(
    optsWith({
      page,
      trace,
      actions: [
        { action: 'navigate', url: APP_URL },
        { action: 'click', selector: '#save' },
      ],
    }),
  )

  expect(result.outcome).toBe('unverified')
  expect(result.reason).toContain('action 1')
  expect(result.reason).toContain('element detached')
  expect(calls).toEqual([
    `navigate ${APP_URL}`,
    'click #save',
  ])
  expect(events).toEqual(['start', `stop ${TRACE_PATH}`])
  expect(result.evidence.some((entry) => entry.includes(TRACE_PATH))).toBe(true)
})

test('fails closed naming the kind for an unknown action', async () => {
  const { page, calls } = fakePage()

  const result = await runFlowCheck(
    optsWith({
      page,
      actions: [{ action: 'hover', selector: '#menu' } as unknown as FlowAction],
    }),
  )

  expect(result.outcome).toBe('unverified')
  expect(result.reason).toContain('hover')
  expect(calls).toEqual([])
})

test('reports unverified for an empty action list', async () => {
  const { page, calls } = fakePage()

  const result = await runFlowCheck(optsWith({ page, actions: [] }))

  expect(result.outcome).toBe('unverified')
  expect(result.reason).toBe('flow has no actions')
  expect(calls).toEqual([])
})

test('reports unverified without executing actions when trace start throws', async () => {
  const { page, calls } = fakePage()
  const { trace, events } = fakeTrace({ startError: new Error('recorder unavailable') })

  const result = await runFlowCheck(
    optsWith({
      page,
      trace,
      actions: [{ action: 'navigate', url: APP_URL }],
    }),
  )

  expect(result.outcome).toBe('unverified')
  expect(result.reason).toContain('recorder unavailable')
  expect(calls).toEqual([])
  expect(events).toEqual(['start'])
})
