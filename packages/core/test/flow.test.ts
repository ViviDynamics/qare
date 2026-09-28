import { join } from 'node:path'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { expect, test } from 'vitest'
import {
  runFlowCheck,
  runSuiteCheck,
  totpCode,
  normaliseAriaSnapshot,
  findCandidates,
  type FlowAction,
  type FlowElement,
  type FlowPage,
  type FlowTrace,
} from '../src/index.js'

const APP_URL = ['http:', '//localhost:3000/up'].join('')

type PageFails = Partial<Record<'open' | 'click' | 'type' | 'choose' | 'waitFor' | 'assertText' | 'assertElement' | 'screenshot', Error>>

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
    choose: async (what, value) => step('choose', `${element(what)}=${value}`, fails.choose),
    waitFor: async (what) => step('waitFor', element(what), fails.waitFor),
    assertText: async (text) => step('assert', text, fails.assertText),
    assertElement: async (what) => step('assertElement', element(what), fails.assertElement),
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
      { action: 'assertText', text: 'Welcome' },
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
      { action: 'assertText', text: 'Welcome' },
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

test('the action log names the masks that applied to each screenshot (#119)', async () => {
  const { page } = fakePage()
  const dir = await outDir()

  const result = await runFlowCheck({
    outDir: dir,
    page,
    actions: [{ action: 'open', url: APP_URL }],
    masks: ['css=.fixture-banner', '//img[@alt="fixture"]'],
  })

  expect(result.outcome).toBe('passed')
  expect(result.evidence).toEqual(['actions.log', 'final.png'])
  const log = await actionsLog(dir)
  expect(log).toContain(
    `screenshot final.png masks: css=.fixture-banner, //img[@alt="fixture"]`,
  )
})

test('without profile masks the action log says nothing about masks (#119)', async () => {
  const { page } = fakePage()
  const dir = await outDir()

  await runFlowCheck({ outDir: dir, page, actions: [{ action: 'open', url: APP_URL }] })

  const log = await actionsLog(dir)
  expect(log).not.toContain('masks:')
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
  expect(result.reason).toContain('the planned command cannot run')
})

const TOTP_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const TOTP_CONFIG = { secret: TOTP_SECRET, digits: 6, period: 30, algorithm: 'SHA1' as const }

test('a totp action types the code the seeded secret generates, and the log names the window, never the code (#64)', async () => {
  const { page, calls } = fakePage()
  const dir = await outDir()
  const generatedCodes: string[] = []

  const result = await runFlowCheck({
    outDir: dir,
    page,
    actions: [
      { action: 'open', url: APP_URL },
      { action: 'totp', element: { role: 'textbox', name: 'Verification code' } },
      { action: 'click', element: { testId: 'sign-in' } },
    ],
    totp: { ...TOTP_CONFIG },
    generatedCodes,
    now: () => 100_000,
  })

  const expected = totpCode(TOTP_SECRET, TOTP_CONFIG, 100_000)
  expect(result.outcome).toBe('passed')
  expect(generatedCodes).toEqual([expected])
  expect(calls).toContain(`type textbox:Verification code=${expected}`)
  // The code itself never reaches the action log; the window does.
  const log = await actionsLog(dir)
  expect(log).toContain('totp code generated for window 3')
  expect(log).not.toContain(expected)
})

test('a totp action without a seeded secret is unverified before anything runs (#64)', async () => {
  const { page, calls } = fakePage()
  const result = await runFlowCheck({
    outDir: await outDir(),
    page,
    actions: [{ action: 'totp', element: { role: 'textbox', name: 'Verification code' } }],
  })
  expect(result.outcome).toBe('unverified')
  expect(result.reason).toContain('the profile declares no login.totp')
  expect(calls).toEqual([])
})

test('a backupCode action without a seeded backup code is unverified (#64)', async () => {
  const result = await runFlowCheck({
    outDir: await outDir(),
    page: fakePage().page,
    actions: [{ action: 'backupCode', element: { role: 'textbox', name: 'Recovery code' } }],
    totp: { ...TOTP_CONFIG },
  })
  expect(result.outcome).toBe('unverified')
  expect(result.reason).toContain('no login.backupCode')
})

test('a backupCode action types the seeded value, and it is swept like a code (#64)', async () => {
  const { page, calls } = fakePage()
  const dir = await outDir()
  const generatedCodes: string[] = []
  const result = await runFlowCheck({
    outDir: dir,
    page,
    actions: [{ action: 'backupCode', element: { role: 'textbox', name: 'Recovery code' } }],
    totp: { ...TOTP_CONFIG, backupCode: '4321-9876' },
    generatedCodes,
    now: () => 100_000,
  })
  expect(result.outcome).toBe('passed')
  expect(generatedCodes).toEqual(['4321-9876'])
  expect(calls).toContain('type textbox:Recovery code=4321-9876')
  expect(await actionsLog(dir)).not.toContain('4321-9876')
})

test('a product assertion that fails after the factor was typed is failed, with the capture still withheld (#64)', async () => {
  const { page } = fakePage({ assertText: new Error('no') })
  const dir = await outDir()
  const result = await runFlowCheck({
    outDir: dir,
    page,
    actions: [
      { action: 'open', url: APP_URL },
      { action: 'totp', element: { role: 'textbox', name: 'Verification code' } },
      { action: 'assertText', text: 'Welcome' },
    ],
    totp: { ...TOTP_CONFIG },
    generatedCodes: [],
    now: () => 100_000,
  })
  // The factor was accepted and typed: a later assertion that fails is a
  // signal about the product, not about the factor, so the outcome is the
  // failure the assert observed. Page visibility alone is not a rejection
  // signal (#64).
  expect(result.outcome).toBe('failed')
  expect(result.reason).toContain('assert failed')
  expect(result.reason).not.toContain('942')
  // The failure screenshot is withheld while the code sits on the page.
  expect(result.evidence).toEqual(['actions.log'])
  const log = await actionsLog(dir)
  expect(log).toContain('failure.png withheld')
})

test('a factor type that throws after the seam saw the code is unverified with the value swept (#64)', async () => {
  const { page } = fakePage()
  const generatedCodes: string[] = []
  page.type = async (_what, value) => {
    // The seam saw the value before it threw: the failure reason quotes it.
    throw new Error(`the seam rejected ${value}`)
  }
  const result = await runFlowCheck({
    outDir: await outDir(),
    page,
    actions: [{ action: 'totp', element: { role: 'textbox', name: 'Verification code' } }],
    totp: { ...TOTP_CONFIG },
    generatedCodes,
    // The sweep a real runner hands the flow: it sees every value the flow
    // registered at the moment it runs, so the reason is swept only if the
    // value was registered before the type was attempted (#64).
    redactLog: (text) => generatedCodes.reduce((out, code) => out.split(code).join('[redacted]'), text),
    now: () => 100_000,
  })
  expect(result.outcome).toBe('unverified')
  expect(result.reason).not.toContain(generatedCodes[0])
  expect(result.reason).toContain('[redacted]')
})

test('a code generated against a closing window is retried once in the next window (#64)', async () => {
  const { page, calls } = fakePage()
  const generatedCodes: string[] = []
  // The clock reads 29900ms into window 0 for the first calls and 30100ms by
  // the straddle check, so the boundary crossed while the flow was typing.
  const times = [29_900, 29_900, 29_900, 30_100, 30_100]
  const result = await runFlowCheck({
    outDir: await outDir(),
    page,
    actions: [{ action: 'totp', element: { role: 'textbox', name: 'Verification code' } }],
    totp: { ...TOTP_CONFIG },
    generatedCodes,
    now: () => times.shift() ?? 30_100,
  })
  expect(result.outcome).toBe('passed')
  expect(generatedCodes).toEqual([
    totpCode(TOTP_SECRET, TOTP_CONFIG, 29_900),
    totpCode(TOTP_SECRET, TOTP_CONFIG, 30_100),
  ])
  expect(calls.filter((call) => call.startsWith('type '))).toHaveLength(2)
})

test('the intent actions run in order through the seam (#70)', async () => {
  const { page, calls } = fakePage()
  const dir = await outDir()

  const result = await runFlowCheck({
    outDir: dir,
    page,
    actions: [
      { action: 'open', url: APP_URL },
      { action: 'waitFor', element: { role: 'combobox', name: 'Country' } },
      { action: 'choose', element: { role: 'combobox', name: 'Country' }, value: 'Ireland' },
      { action: 'assertElement', element: { testId: 'address-form' } },
      { action: 'capture' },
    ],
  })

  expect(result.outcome).toBe('passed')
  expect(result.reason).toBeUndefined()
  expect(calls).toEqual([
    `open ${APP_URL}`,
    'waitFor combobox:Country',
    'choose combobox:Country=Ireland',
    'assertElement address-form',
    'screenshot ' + join(dir, 'capture-4.png'),
    `screenshot ${join(dir, 'final.png')}`,
  ])
  // The capture lands in the evidence beside the action log, ahead of the named final screenshot.
  expect(result.evidence).toEqual(['actions.log', 'capture-4.png', 'final.png'])
  const log = await actionsLog(dir)
  expect(log).toContain('action 1: wait for role=combobox name=Country')
  expect(log).toContain('action 2: choose role=combobox name=Country=Ireland')
  expect(log).toContain('action 3: assert the element testId=address-form is visible')
  expect(log).toContain('action 4: capture a screenshot')
})

test('a failed element assert fails the check and names the element (#70)', async () => {
  const { page, calls } = fakePage({ assertElement: new Error('element absent') })
  const dir = await outDir()

  const result = await runFlowCheck({
    outDir: dir,
    page,
    actions: [
      { action: 'open', url: APP_URL },
      { action: 'assertElement', element: { role: 'button', name: 'Save' } },
    ],
  })

  expect(result.outcome).toBe('failed')
  expect(result.reason).toBe('assert failed: the element role=button name=Save is not visible')
  expect(calls).toEqual([`open ${APP_URL}`, 'assertElement button:Save', `screenshot ${join(dir, 'failure.png')}`])
  expect(result.evidence).toEqual(['actions.log', 'failure.png'])
})

test('a capture is withheld while a second-factor code may sit on the page (#64, #70)', async () => {
  const { page } = fakePage()
  const dir = await outDir()

  const result = await runFlowCheck({
    outDir: dir,
    page,
    actions: [{ action: 'capture' }],
    codesOnPage: true,
  })

  expect(result.outcome).toBe('passed')
  expect(result.evidence).toEqual(['actions.log'])
  const log = await actionsLog(dir)
  expect(log).toContain('capture-0.png withheld')
})

test('a capture whose screenshot fails leaves the check unverified, not passed (#70)', async () => {
  const { page } = fakePage({ screenshot: new Error('the disk filled') })
  const dir = await outDir()

  const result = await runFlowCheck({
    outDir: dir,
    page,
    actions: [{ action: 'open', url: APP_URL }, { action: 'capture' }],
  })

  expect(result.outcome).toBe('unverified')
  expect(result.reason).toContain('action 1 failed')
  expect(result.reason).toContain('the disk filled')
  // The failure screenshot cannot be written either, so only the log survives.
  expect(result.evidence).toEqual(['actions.log'])
  const log = await actionsLog(dir)
  expect(log).toContain('screenshot capture-1.png failed')
})

const SNAPSHOT_YAML = [
  '- main:',
  '  - group "Welcome panel":',
  '    - button',
].join('\n')

function pageWithSnapshot(snapshotYaml: string, fails: PageFails = {}): FlowPage {
  const snapshot = normaliseAriaSnapshot(snapshotYaml)
  return { ...fakePage(fails).page, snapshot: async () => snapshot }
}

test('an assertion writes the trimmed normalised snapshot to the evidence, with the unnamed controls named (#82)', async () => {
  const page = pageWithSnapshot(SNAPSHOT_YAML)
  const dir = await outDir()

  const result = await runFlowCheck({
    outDir: dir,
    page,
    actions: [
      { action: 'open', url: APP_URL },
      { action: 'assertText', text: 'Welcome panel' },
    ],
  })

  expect(result.outcome).toBe('passed')
  expect(result.evidence).toEqual(['actions.log', 'assert-1.json', 'final.png'])
  const written = JSON.parse(await readFile(join(dir, 'assert-1.json'), 'utf8'))
  expect(written.schemaVersion).toBe(1)
  expect(written.assertedText).toBe('Welcome panel')
  // The subtree the assertion touched is kept whole, so the unnamed button in
  // it is a finding with a path to where it sits, not a silent pass.
  expect(written.snapshot.path).toBe('document')
  expect(written.findings).toEqual([
    'accessibility finding: document/main/group "Welcome panel"/button has no accessible name',
  ])
  const log = await actionsLog(dir)
  expect(log).toContain('snapshot assert-1.json: document')
  expect(log).toContain('accessibility finding: document/main/group "Welcome panel"/button has no accessible name')
})

test('a failed assert still writes the snapshot the page held at that point (#82)', async () => {
  const page = pageWithSnapshot(SNAPSHOT_YAML, { assertText: new Error('text absent') })
  const dir = await outDir()

  const result = await runFlowCheck({
    outDir: dir,
    page,
    actions: [
      { action: 'open', url: APP_URL },
      { action: 'assertText', text: 'Welcome' },
    ],
  })

  expect(result.outcome).toBe('failed')
  expect(result.evidence).toEqual(['actions.log', 'assert-1.json', 'failure.png'])
  const written = JSON.parse(await readFile(join(dir, 'assert-1.json'), 'utf8'))
  expect(written.assertedText).toBe('Welcome')
  // Nothing on the page names the text, so the snapshot is left untrimmed: what
  // the page held instead is the evidence the failure needs.
  expect(written.snapshot).toEqual(normaliseAriaSnapshot(SNAPSHOT_YAML))
})

test('an element assertion writes its snapshot evidence, trimmed by name (#82)', async () => {
  const page = pageWithSnapshot(SNAPSHOT_YAML)
  const dir = await outDir()

  const result = await runFlowCheck({
    outDir: dir,
    page,
    actions: [
      { action: 'open', url: APP_URL },
      { action: 'assertElement', element: { role: 'group', name: 'Welcome panel' } },
    ],
  })

  expect(result.outcome).toBe('passed')
  expect(result.evidence).toEqual(['actions.log', 'assert-1.json', 'final.png'])
  const written = JSON.parse(await readFile(join(dir, 'assert-1.json'), 'utf8'))
  expect(written.assertedText).toBe('Welcome panel')
  // The unnamed button inside the asserted group is a finding, not a silent pass.
  expect(written.findings).toEqual([
    'accessibility finding: document/main/group "Welcome panel"/button has no accessible name',
  ])
})

test('an element assertion by test id keeps the whole tree in its evidence (#82)', async () => {
  const page = pageWithSnapshot(SNAPSHOT_YAML)
  const dir = await outDir()

  const result = await runFlowCheck({
    outDir: dir,
    page,
    actions: [
      { action: 'open', url: APP_URL },
      { action: 'assertElement', element: { testId: 'welcome-panel' } },
    ],
  })

  expect(result.outcome).toBe('passed')
  const written = JSON.parse(await readFile(join(dir, 'assert-1.json'), 'utf8'))
  // A test id is no trim target in the snapshot, so the evidence is untrimmed,
  // and the record names no asserted text.
  expect(written.snapshot).toEqual(normaliseAriaSnapshot(SNAPSHOT_YAML))
  expect(written.findings).toEqual([
    'accessibility finding: document/main/group "Welcome panel"/button has no accessible name',
  ])
  expect(written.assertedText).toBeUndefined()
})

test('a failed element assertion still writes the snapshot the page held (#82)', async () => {
  const page = pageWithSnapshot(SNAPSHOT_YAML, { assertElement: new Error('element absent') })
  const dir = await outDir()

  const result = await runFlowCheck({
    outDir: dir,
    page,
    actions: [
      { action: 'open', url: APP_URL },
      { action: 'assertElement', element: { role: 'group', name: 'Welcome panel' } },
    ],
  })

  expect(result.outcome).toBe('failed')
  expect(result.evidence).toEqual(['actions.log', 'assert-1.json', 'failure.png'])
  const written = JSON.parse(await readFile(join(dir, 'assert-1.json'), 'utf8'))
  expect(written.assertedText).toBe('Welcome panel')
  expect(written.snapshot).toEqual(normaliseAriaSnapshot(SNAPSHOT_YAML))
})

test('a driver without a snapshot seam notes the gap and carries no snapshot evidence (#82)', async () => {
  const { page } = fakePage()
  const dir = await outDir()

  const result = await runFlowCheck({
    outDir: dir,
    page,
    actions: [{ action: 'assertText', text: 'Welcome' }],
  })

  expect(result.outcome).toBe('passed')
  expect(result.evidence).toEqual(['actions.log', 'final.png'])
  expect(await actionsLog(dir)).toContain('snapshot not taken: the driver exposes no accessibility snapshot')
})

const REPAIR_YAML = '- main:\n  - form "Sign in":\n    - button "Save"'

/**
 * A page whose click lands only on the element the current tree holds, and
 * misses whenever the reference still names the path the plan authored (#83).
 * With `miss: 'always'` the locator resolves but the click fails anyway, the
 * way an element the page obscures fails whatever path it is driven by.
 */
function repairablePage(opts: { yaml: string; miss: 'stale' | 'always' }): FlowPage {
  const current = findCandidates(normaliseAriaSnapshot(opts.yaml), { role: 'button', name: 'Save' })[0]?.path
  return {
    ...fakePage().page,
    click: async (what) => {
      if (opts.miss === 'always') throw new Error('the element is obscured')
      const path = 'at' in what ? what.at : undefined
      if (path === current) return
      throw new Error(`strict mode violation: element not found at ${path ?? '(no path)'}`)
    },
    snapshot: async () => normaliseAriaSnapshot(opts.yaml),
  }
}

test('a rename of the markup around an element is repaired, recorded and re-driven (#83)', async () => {
  const page = repairablePage({ yaml: REPAIR_YAML, miss: 'stale' })
  const dir = await outDir()

  const result = await runFlowCheck({
    outDir: dir,
    page,
    actions: [
      { action: 'open', url: APP_URL },
      { action: 'click', element: { role: 'button', name: 'Save', at: 'document/main/form "Log in"/button "Save"' } },
    ],
  })

  // The wrapper form was renamed by the change under review: the path moved,
  // the element did not, and the identity rule says so.
  expect(result.outcome).toBe('passed')
  expect(result.repairs).toEqual([
    {
      action: 1,
      reference: 'role=button name=Save at=document/main/form "Log in"/button "Save"',
      repaired: 'role=button name=Save at=document/main/form "Sign in"/button "Save"',
      identity: 'same role, same accessible name, same landmark ancestry (main/form)',
      status: 'applied',
    },
  ])
  expect(result.evidence).toEqual(['actions.log', 'final.png', 'repairs.json'])
  const written = JSON.parse(await readFile(join(dir, 'repairs.json'), 'utf8'))
  expect(written.schemaVersion).toBe(1)
  expect(written.repairs).toEqual(result.repairs)
  const log = await actionsLog(dir)
  expect(log).toContain(
    'locator repair applied: action 1 role=button name=Save at=document/main/form "Log in"/button "Save" -> role=button name=Save at=document/main/form "Sign in"/button "Save": same role, same accessible name, same landmark ancestry (main/form)',
  )
})

test('a repair that would point at a different element is refused and sent to review (#83)', async () => {
  // The button now sits under the navigation: same role, same name, different
  // landmarks, so a different element, and never a repair.
  const page = repairablePage({ yaml: '- main:\n  - navigation:\n    - button "Save"', miss: 'stale' })
  const dir = await outDir()

  const result = await runFlowCheck({
    outDir: dir,
    page,
    actions: [
      { action: 'open', url: APP_URL },
      { action: 'click', element: { role: 'button', name: 'Save', at: 'document/main/form "Sign in"/button "Save"' } },
    ],
  })

  expect(result.outcome).toBe('unverified')
  expect(result.reason).toContain('the locator repair was refused')
  expect(result.reason).toContain('different landmarks')
  expect(result.repairs).toEqual([
    {
      action: 1,
      reference: 'role=button name=Save at=document/main/form "Sign in"/button "Save"',
      identity: 'same role, same accessible name, same landmark ancestry (main/form)',
      status: 'refused',
      refusedReason: expect.stringContaining('different landmarks'),
    },
  ])
  expect(result.evidence).toEqual(['actions.log', 'failure.png', 'repairs.json'])
  const written = JSON.parse(await readFile(join(dir, 'repairs.json'), 'utf8'))
  expect(written.repairs[0].status).toBe('refused')
  expect(await actionsLog(dir)).toContain('locator repair refused:')
})

test('an assertion is never repaired: an element that moved under an assert fails the check (#83)', async () => {
  const page = {
    ...repairablePage({ yaml: '- main:\n  - form "Sign in":\n    - group "Welcome panel"', miss: 'stale' }),
    assertElement: async () => {
      throw new Error('element absent')
    },
  }
  const dir = await outDir()

  const result = await runFlowCheck({
    outDir: dir,
    page,
    actions: [
      { action: 'open', url: APP_URL },
      { action: 'assertElement', element: { role: 'group', name: 'Welcome panel', at: 'document/main/form "Log in"/group "Welcome panel"' } },
    ],
  })

  // The assert failed, a candidate sits in the snapshot, and still no repair
  // may cross an assertion: the check fails as itself.
  expect(result.outcome).toBe('failed')
  expect(result.repairs).toBeUndefined()
  expect(result.evidence).toEqual(['actions.log', 'assert-1.json', 'failure.png'])
  const log = await actionsLog(dir)
  expect(log).not.toContain('locator repair')
})

test('an element action without a snapshot path is never repaired (#83)', async () => {
  const page = repairablePage({ yaml: REPAIR_YAML, miss: 'stale' })
  const dir = await outDir()

  const result = await runFlowCheck({
    outDir: dir,
    page,
    actions: [
      { action: 'open', url: APP_URL },
      { action: 'click', element: { role: 'button', name: 'Save' } },
    ],
  })

  // A reference that carries no path has no identity to compare: the failure
  // stands as it always has, and no repair is proposed.
  expect(result.outcome).toBe('unverified')
  expect(result.reason).toContain('action 1 failed')
  expect(result.repairs).toBeUndefined()
  expect(result.evidence).toEqual(['actions.log', 'failure.png'])
  expect(await actionsLog(dir)).not.toContain('locator repair')
})

test('a repair whose reference still resolves is refused, so a failing action is not papered over (#83)', async () => {
  const page = repairablePage({ yaml: REPAIR_YAML, miss: 'always' })
  const dir = await outDir()

  const result = await runFlowCheck({
    outDir: dir,
    page,
    actions: [
      { action: 'open', url: APP_URL },
      { action: 'click', element: { role: 'button', name: 'Save', at: 'document/main/form "Sign in"/button "Save"' } },
    ],
  })

  expect(result.outcome).toBe('unverified')
  expect(result.reason).toContain('still resolves to the same element')
  expect(result.repairs?.[0]?.status).toBe('refused')
})
