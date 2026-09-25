import { join } from 'node:path'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { expect, test } from 'vitest'
import {
  runFlowCheck,
  runSuiteCheck,
  type FlowAction,
  type FlowPage,
  type FlowTrace,
} from '../src/index.js'

const APP_URL = ['http:', '//localhost:3000/up'].join('')

type PageFails = Partial<Record<'open' | 'click' | 'type' | 'assertText' | 'screenshot', Error>>

function fakePage(fails: PageFails = {}): { page: FlowPage; calls: string[] } {
  const calls: string[] = []
  const step = (kind: string, detail: string, error: Error | undefined): void => {
    calls.push(`${kind} ${detail}`)
    if (error) throw error
  }
  const element = (what: FlowElement): string => 'testId' in what ? what.testId : `${what.role}:${what.name}`
  const page: FlowPage = {
    open: async (url) => step('open', url, fails.open),
    click: async (what) => step('click', element(what), fails.click),
    type: async (what, value) => step('type', `${element(what)}=${value}`, fails.type),
    assertText: async (text) => step('assert', text, fails.assertText),
    screenshot: async (path) => {
      calls.push(`screenshot ${path}`)
      if (fails.screenshot) throw fails.screenshot
    },
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

async function outDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'qare-flow-'))
}

async function actionsLog(dir: string): Promise<string> {
  return readFile(join(dir, 'actions.log'), 'utf8')
}

test('runs typed actions in order, names the final screenshot, and keeps the trace out of the evidence', async () => {
  const { page, calls } = fakePage()
  const { trace, events } = fakeTrace()
  const dir = await outDir()

  const result = await runFlowCheck({
    outDir: dir,
    tracesDir: join(dir, '..', 'traces'),
    page,
    trace,
    actions: [
      { action: 'open', url: APP_URL },
      { action: 'type', element: { role: 'textbox', name: 'Email' }, value: 'me@example.com' },
      { action: 'click', element: { testId: 'sign-in' } },
      { action: 'assert', text: 'Welcome' },
    ],
  })

  expect(result.outcome).toBe('passed')
  expect(result.reason).toBeUndefined()
  expect(calls).toEqual([
    `open ${APP_URL}`,
    'type textbox:Email=me@example.com',
    'click sign-in',
    'assert Welcome',
    `screenshot ${join(dir, 'final.png')}`,
  ])
  expect(result.evidence).toEqual(['actions.log', 'final.png'])
  // The trace is a zip, and redaction cannot read a zip (#52): it stops into
  // the traces dir, and its location is noted in the action log instead.
  const tracePath = join(dir, '..', 'traces', 'trace.zip')
  expect(events).toEqual(['start', `stop ${tracePath}`])
  expect(result.evidence.some((entry) => entry.includes('trace.zip'))).toBe(false)
  const log = await actionsLog(dir)
  expect(log).toContain(`trace kept out of the published evidence`)
})

test('the action log is redacted with the run rules before it is written', async () => {
  const { page } = fakePage()
  const dir = await outDir()

  const result = await runFlowCheck({
    outDir: dir,
    page,
    actions: [{ action: 'open', url: APP_URL }],
    redactLog: (text) => text.replaceAll(APP_URL, '[redacted]'),
  })

  expect(result.outcome).toBe('passed')
  const log = await actionsLog(dir)
  expect(log).not.toContain(APP_URL)
  expect(log).toContain('open [redacted]')
})

test('reports failed for a mismatched assert, with the failure screenshot', async () => {
  const { page, calls } = fakePage({ assertText: new Error('text absent') })
  const dir = await outDir()

  const result = await runFlowCheck({
    outDir: dir,
    page,
    actions: [
      { action: 'open', url: APP_URL },
      { action: 'assert', text: 'Welcome' },
    ],
  })

  expect(result.outcome).toBe('failed')
  expect(result.reason).toBe('assert failed: the text "Welcome" is not visible')
  expect(calls).toEqual([`open ${APP_URL}`, 'assert Welcome', `screenshot ${join(dir, 'failure.png')}`])
  expect(result.evidence).toEqual(['actions.log', 'failure.png'])
  expect(result.evidence.some((entry) => entry.includes('final.png'))).toBe(false)
})

test('reports unverified with the action index when a step throws', async () => {
  const { page, calls } = fakePage({ click: new Error('element detached') })
  const dir = await outDir()

  const result = await runFlowCheck({
    outDir: dir,
    page,
    actions: [
      { action: 'open', url: APP_URL },
      { action: 'click', element: { testId: 'save' } },
    ],
  })

  expect(result.outcome).toBe('unverified')
  expect(result.reason).toContain('action 1')
  expect(result.reason).toContain('element detached')
  expect(calls).toEqual([`open ${APP_URL}`, 'click save', `screenshot ${join(dir, 'failure.png')}`])
  expect(result.evidence).toEqual(['actions.log', 'failure.png'])
})

test('fails closed naming the kind for an unknown action', async () => {
  const { page, calls } = fakePage()
  const dir = await outDir()

  const result = await runFlowCheck({
    outDir: dir,
    page,
    actions: [{ action: 'hover', selector: '#menu' } as unknown as FlowAction],
  })

  expect(result.outcome).toBe('unverified')
  expect(result.reason).toContain('hover')
  expect(calls).toEqual([])
  expect(result.evidence).toEqual([])
})

test('reports unverified for an empty action list', async () => {
  const { page, calls } = fakePage()
  const dir = await outDir()

  const result = await runFlowCheck({ outDir: dir, page, actions: [] })

  expect(result.outcome).toBe('unverified')
  expect(result.reason).toBe('flow has no actions')
  expect(calls).toEqual([])
})

test('reports unverified without executing actions when trace start throws', async () => {
  const { page, calls } = fakePage()
  const { trace, events } = fakeTrace({ startError: new Error('recorder unavailable') })
  const dir = await outDir()

  const result = await runFlowCheck({
    outDir: dir,
    page,
    trace,
    actions: [{ action: 'open', url: APP_URL }],
  })

  expect(result.outcome).toBe('unverified')
  expect(result.reason).toContain('recorder unavailable')
  expect(calls).toEqual([])
  expect(events).toEqual(['start'])
})

test('a screenshot that cannot be taken is noted in the log, and the check still finishes', async () => {
  const { page, calls } = fakePage({ screenshot: new Error('no page to capture') })
  const dir = await outDir()

  const result = await runFlowCheck({
    outDir: dir,
    page,
    actions: [{ action: 'open', url: APP_URL }],
  })

  expect(result.outcome).toBe('passed')
  expect(result.evidence).toEqual(['actions.log'])
  expect(calls).toEqual([`open ${APP_URL}`, `screenshot ${join(dir, 'final.png')}`])
  const log = await actionsLog(dir)
  expect(log).toContain('screenshot final.png failed')
})

async function suiteCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'qare-suite-'))
}

test('runSuiteCheck passes when the suite command exits zero', async () => {
  const result = await runSuiteCheck({ name: 'unit', command: 'echo ok' }, { cwd: await suiteCwd() })

  expect(result.outcome).toBe('passed')
  expect(result.reason).toBeUndefined()
})

test('runSuiteCheck fails with the suite name and exit code when the suite fails', async () => {
  const cwd = await suiteCwd()
  await writeFile(join(cwd, 'failing.sh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })

  const result = await runSuiteCheck({ name: 'cucumber', command: './failing.sh' }, { cwd })

  expect(result.outcome).toBe('failed')
  expect(result.reason).toBe('suite cucumber exited 1')
})

test('runSuiteCheck stays unverified when the suite binary is missing', async () => {
  const result = await runSuiteCheck(
    { name: 'cucumber', command: 'definitely-not-a-binary-xyz' },
    { cwd: await suiteCwd() },
  )

  expect(result.outcome).toBe('unverified')
  expect(result.reason).toContain('could not start')
})
