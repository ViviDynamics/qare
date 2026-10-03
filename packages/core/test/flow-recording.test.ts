import { existsSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { decodePng, encodePng, runFlowCheck, splitApng, type FlowAction, type FlowCaptureOpts, type FlowElement, type FlowPage } from '../src/index.js'

const SECRET = 'hunter2-fixture'
const PASSWORD: FlowElement = { role: 'textbox', name: 'Passphrase' }
const NAME: FlowElement = { role: 'textbox', name: 'Name' }

const describe = (element: FlowElement): string => ('testId' in element ? element.testId : `${element.role}:${element.name}`)
const concealed = (opts: FlowCaptureOpts | undefined): string => `[${(opts?.conceal ?? []).map(describe).join(', ')}]`

/** A frame no other frame equals: its one pixel carries the number of the frame. */
function numbered(index: number): Buffer {
  return encodePng({ width: 1, height: 1, pixels: Buffer.from([index, 0, 0, 255]) })
}

/**
 * A page that can be recorded: every frame it hands back is numbered, and
 * what each capture was asked to conceal is written down beside the actions.
 */
function recordedPage(
  opts: { missing?: string; clickFails?: boolean; frameMs?: number; frame?: (index: number) => Buffer; frameFails?: Error; conceals?: boolean } = {},
): { page: FlowPage; calls: string[] } {
  const calls: string[] = []
  let frames = 0
  const page: FlowPage = {
    ...(opts.conceals === false ? {} : { conceals: true as const }),
    open: async (url) => void calls.push(`open ${url}`),
    click: async (element) => {
      calls.push(`click ${describe(element)}`)
      if (opts.clickFails) throw new Error('the button is not there')
    },
    type: async (element, value) => void calls.push(`type ${describe(element)}=${value}`),
    choose: async () => {},
    waitFor: async () => {},
    assertText: async (text) => {
      calls.push(`assert ${text}`)
      if (text === opts.missing) throw new Error('assert failed')
    },
    assertElement: async () => {},
    screenshot: async (path, capture) => void calls.push(`screenshot ${path.split('/').pop()} ${concealed(capture)}`),
    frame: async (capture) => {
      const index = frames
      frames += 1
      calls.push(`frame ${index} starts ${concealed(capture)}`)
      if (opts.frameMs !== undefined) await new Promise((resolve) => setTimeout(resolve, opts.frameMs))
      if (opts.frameFails) throw opts.frameFails
      calls.push(`frame ${index} ends`)
      return (opts.frame ?? numbered)(index)
    },
  }
  return { page, calls }
}

const outDir = (): Promise<string> => mkdtemp(join(tmpdir(), 'qare-recording-'))
const redactLog = (text: string): string => text.split(SECRET).join('[redacted]')
/** Frames at the action boundaries only, so a test counts them. */
const BOUNDARIES = { intervalMs: 0 }

const FAILING: FlowAction[] = [
  { action: 'open', url: '/' },
  { action: 'click', element: { role: 'button', name: 'Save' } },
  { action: 'assertText', text: 'Saved' },
]

async function framesOf(dir: string): Promise<number[]> {
  return splitApng(await readFile(join(dir, 'recording.png'))).map((frame) => decodePng(frame.png).pixels[0] as number)
}

test('a failed assert leaves a recording of the flow: a frame after every action and one where it failed (#78)', async () => {
  const { page } = recordedPage({ missing: 'Saved' })
  const dir = await outDir()

  const result = await runFlowCheck({ outDir: dir, page, actions: FAILING, recording: BOUNDARIES })

  expect(result.outcome).toBe('failed')
  expect(result.evidence).toEqual(['actions.log', 'failure.png', 'recording.png'])
  expect(result.failedAt).toEqual(expect.any(Number))
  // After the open, after the click, and at the failed assert.
  expect(await framesOf(dir)).toEqual([0, 1, 2])
  expect(await readFile(join(dir, 'actions.log'), 'utf8')).toMatch(/^recording recording\.png: 3 frames over \d+\.\d s, \d+ bytes$/m)
})

test('an action that could not run leaves a recording too: unverified is as much in need of one as failed (#78)', async () => {
  const { page } = recordedPage({ clickFails: true })
  const dir = await outDir()

  const result = await runFlowCheck({ outDir: dir, page, actions: FAILING, recording: BOUNDARIES })

  expect(result.outcome).toBe('unverified')
  expect(result.evidence).toContain('recording.png')
  expect(await framesOf(dir)).toEqual([0, 1])
})

test('a flow that passed keeps no recording, and its log says frames were taken and dropped (#78)', async () => {
  const { page, calls } = recordedPage()
  const dir = await outDir()

  const result = await runFlowCheck({ outDir: dir, page, actions: FAILING, recording: BOUNDARIES })

  expect(result.outcome).toBe('passed')
  expect(result.evidence).toEqual(['actions.log', 'final.png'])
  expect(result.failedAt).toBeUndefined()
  expect(existsSync(join(dir, 'recording.png'))).toBe(false)
  expect(calls.filter((call) => /^frame \d+ ends/.test(call))).toHaveLength(3)
  expect(await readFile(join(dir, 'actions.log'), 'utf8')).toContain('recording not kept: the flow passed (3 frames taken)')
})

test('a flow is sampled while an action is in flight, not only between actions (#78)', async () => {
  const { page } = recordedPage({ missing: 'Saved' })
  page.click = async () => new Promise((resolve) => setTimeout(resolve, 120))
  const dir = await outDir()

  await runFlowCheck({ outDir: dir, page, actions: FAILING, recording: { intervalMs: 20 } })

  // Three boundaries, and at least two frames while the click was in flight.
  expect((await framesOf(dir)).length).toBeGreaterThanOrEqual(5)
})

test('a typed secret is never rendered: its element is concealed before the value is typed, and in every capture after (#78)', async () => {
  // A frame takes a while, and the sampler keeps one in flight, so a frame is under way when the type comes up.
  const { page, calls } = recordedPage({ missing: 'Saved', frameMs: 15 })
  const dir = await outDir()

  const result = await runFlowCheck({
    outDir: dir,
    page,
    redactLog,
    recording: { intervalMs: 1 },
    actions: [
      { action: 'open', url: '/' },
      { action: 'type', element: NAME, value: 'Ada' },
      { action: 'type', element: PASSWORD, value: SECRET },
      { action: 'assertText', text: 'Saved' },
    ],
  })

  expect(result.outcome).toBe('failed')
  const typed = calls.indexOf(`type textbox:Passphrase=${SECRET}`)
  expect(typed).toBeGreaterThan(-1)
  // Every frame that began without the element concealed had ended before the secret was typed.
  const open = new Set<string>()
  for (const call of calls.slice(0, typed)) {
    const started = /^frame (\d+) starts \[\]$/.exec(call)
    const ended = /^frame (\d+) ends$/.exec(call)
    if (started !== null) open.add(started[1] as string)
    if (ended !== null) open.delete(ended[1] as string)
  }
  expect([...open]).toEqual([])
  // From then on every frame, and the failure screenshot, conceals it. A value redaction leaves alone conceals nothing.
  const after = calls.slice(typed + 1)
  expect(after.filter((call) => /^frame \d+ starts/.test(call)).length).toBeGreaterThan(0)
  for (const call of after.filter((entry) => /^frame \d+ starts/.test(entry))) expect(call).toMatch(/starts \[textbox:Passphrase\]$/)
  expect(after).toContain('screenshot failure.png [textbox:Passphrase]')
  const log = await readFile(join(dir, 'actions.log'), 'utf8')
  expect(log).toContain('role=textbox name=Passphrase is concealed in every capture from here on: the value typed into it is one redaction sweeps')
  expect(log).not.toContain(SECRET)
  expect(log).toMatch(/^recording recording\.png: .* bytes, concealed: role=textbox name=Passphrase$/m)
})

test('a driver that cannot conceal an element is not trusted with one: the recording stops before the secret is typed, and nothing claims it was concealed (#78)', async () => {
  const { page, calls } = recordedPage({ missing: 'Saved', conceals: false })
  const dir = await outDir()

  const result = await runFlowCheck({
    outDir: dir,
    page,
    redactLog,
    recording: BOUNDARIES,
    actions: [
      { action: 'open', url: '/' },
      { action: 'type', element: NAME, value: 'Ada' },
      { action: 'type', element: PASSWORD, value: SECRET },
      { action: 'assertText', text: 'Saved' },
    ],
  })

  expect(result.outcome).toBe('failed')
  const typed = calls.indexOf(`type textbox:Passphrase=${SECRET}`)
  expect(calls.slice(typed).filter((call) => call.startsWith('frame'))).toEqual([])
  // What was recorded before the secret is kept. No screenshot is taken after it: nothing would hide the field.
  expect(await framesOf(dir)).toEqual([0, 1])
  expect(calls.filter((call) => call.startsWith('screenshot'))).toEqual([])
  expect(result.evidence).toEqual(['actions.log', 'recording.png'])
  const log = await readFile(join(dir, 'actions.log'), 'utf8')
  expect(log).toContain('failure.png withheld: a secret was typed into the page, and the driver cannot conceal the element it went into')
  expect(log).toContain('recording stopped before action 2: a secret is about to be typed, and the driver cannot conceal the element it goes into')
  expect(log).not.toContain('is concealed')
  expect(log).not.toContain('concealed:')
})

test('a second factor stops the recording before the code is typed, and what was recorded until then is kept (#78)', async () => {
  const { page, calls } = recordedPage({ missing: 'Saved' })
  const dir = await outDir()

  const result = await runFlowCheck({
    outDir: dir,
    page,
    recording: BOUNDARIES,
    totp: { secret: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30, algorithm: 'SHA1' },
    now: () => 100_000,
    actions: [
      { action: 'open', url: '/' },
      { action: 'click', element: { role: 'button', name: 'Sign in' } },
      { action: 'totp', element: { role: 'textbox', name: 'Code' } },
      { action: 'assertText', text: 'Saved' },
    ],
  })

  expect(result.outcome).toBe('failed')
  const typed = calls.findIndex((call) => call.startsWith('type textbox:Code='))
  expect(calls.slice(typed).filter((call) => call.startsWith('frame'))).toEqual([])
  expect(await framesOf(dir)).toEqual([0, 1])
  expect(result.evidence).toEqual(['actions.log', 'recording.png'])
  expect(await readFile(join(dir, 'actions.log'), 'utf8')).toContain(
    'recording stopped before action 2: a second-factor code is about to be on the page, and redaction cannot read pixels',
  )
})

test('a flow that starts with a one-time code on the page is not recorded at all (#78)', async () => {
  const { page, calls } = recordedPage({ missing: 'Saved' })
  const dir = await outDir()

  const result = await runFlowCheck({ outDir: dir, page, actions: FAILING, recording: BOUNDARIES, codesOnPage: true })

  expect(result.evidence).toEqual(['actions.log'])
  expect(calls.filter((call) => call.startsWith('frame'))).toEqual([])
  expect(await readFile(join(dir, 'actions.log'), 'utf8')).toContain('recording not made: a one-time code is on the page, and redaction cannot read pixels')
})

test('a recording is bounded: past its frames or its bytes the oldest go, because the end is where the failure is (#78)', async () => {
  const byFrames = recordedPage({ missing: 'Saved' })
  const framesDir = await outDir()
  await runFlowCheck({ outDir: framesDir, page: byFrames.page, actions: FAILING, recording: { intervalMs: 0, maxFrames: 2 } })
  expect(await framesOf(framesDir)).toEqual([1, 2])
  expect(await readFile(join(framesDir, 'actions.log'), 'utf8')).toMatch(/^recording recording\.png: 2 frames .* bytes, 1 earlier frame dropped to keep it within 2 frames and \d+ bytes$/m)

  const byBytes = recordedPage({ missing: 'Saved' })
  const bytesDir = await outDir()
  await runFlowCheck({ outDir: bytesDir, page: byBytes.page, actions: FAILING, recording: { intervalMs: 0, maxBytes: numbered(0).length + 1 } })
  expect(await framesOf(bytesDir)).toEqual([2])
})

test('a screen that did not change is one frame shown longer, not a frame per sample (#78)', async () => {
  const { page } = recordedPage({ missing: 'Saved', frame: (index) => numbered(index === 1 ? 0 : index) })
  const dir = await outDir()

  await runFlowCheck({ outDir: dir, page, actions: FAILING, recording: BOUNDARIES })

  expect(await framesOf(dir)).toEqual([0, 2])
})

test('a driver whose frames cannot be taken costs the flow nothing but the recording, and the log says why (#78)', async () => {
  const { page } = recordedPage({ missing: 'Saved', frameFails: new Error('the window is gone') })
  const dir = await outDir()

  const result = await runFlowCheck({ outDir: dir, page, actions: FAILING, recording: BOUNDARIES })

  expect(result.outcome).toBe('failed')
  expect(result.reason).toBe('assert failed: the text "Saved" is not visible')
  expect(result.evidence).toEqual(['actions.log', 'failure.png'])
  expect(await readFile(join(dir, 'actions.log'), 'utf8')).toContain('recording not kept: no frame could be taken (3 failed, the first with Error: the window is gone)')
})

test('a driver with no frame seam is not recorded, and a caller can turn recording off (#78)', async () => {
  const none = recordedPage({ missing: 'Saved' })
  delete none.page.frame
  const noneDir = await outDir()
  expect((await runFlowCheck({ outDir: noneDir, page: none.page, actions: FAILING })).evidence).toEqual(['actions.log', 'failure.png'])
  expect(await readFile(join(noneDir, 'actions.log'), 'utf8')).not.toContain('recording')

  const off = recordedPage({ missing: 'Saved' })
  const offDir = await outDir()
  expect((await runFlowCheck({ outDir: offDir, page: off.page, actions: FAILING, recording: false })).evidence).toEqual(['actions.log', 'failure.png'])
  expect(off.calls.filter((call) => call.startsWith('frame'))).toEqual([])
})

test('two fields of one role and name at different places are two fields: each is concealed (#78)', async () => {
  const { page, calls } = recordedPage({ missing: 'Saved' })
  const dir = await outDir()
  const first: FlowElement = { role: 'textbox', name: 'Passphrase', at: 'document/main/form[1]/textbox "Passphrase"' }
  const second: FlowElement = { role: 'textbox', name: 'Passphrase', at: 'document/main/form[2]/textbox "Passphrase"' }

  await runFlowCheck({
    outDir: dir,
    page,
    redactLog,
    recording: BOUNDARIES,
    actions: [
      { action: 'type', element: first, value: SECRET },
      { action: 'type', element: second, value: SECRET },
      { action: 'assertText', text: 'Saved' },
    ],
  })

  expect(calls).toContain('screenshot failure.png [textbox:Passphrase, textbox:Passphrase]')
})

test('a frame larger than the whole bound is not kept: no recording is better than one past its bound (#78)', async () => {
  const { page } = recordedPage({ missing: 'Saved' })
  const dir = await outDir()

  const result = await runFlowCheck({ outDir: dir, page, actions: FAILING, recording: { intervalMs: 0, maxBytes: numbered(0).length - 1 } })

  expect(result.evidence).toEqual(['actions.log', 'failure.png'])
  expect(existsSync(join(dir, 'recording.png'))).toBe(false)
  expect(await readFile(join(dir, 'actions.log'), 'utf8')).toMatch(/^recording not kept: every frame was larger than the \d+ bytes a recording may hold \(3 dropped\)$/m)
})

test('a flow that is stopped takes no more frames and writes nothing more, however its last action ends (#78)', async () => {
  const { page, calls } = recordedPage({ missing: 'Saved' })
  page.click = async () => new Promise((resolve) => setTimeout(resolve, 80))
  const dir = await outDir()
  const stop = new AbortController()

  const flow = runFlowCheck({ outDir: dir, page, actions: FAILING, recording: { intervalMs: 5 }, signal: stop.signal })
  await new Promise((resolve) => setTimeout(resolve, 30))
  stop.abort()
  const framesAtStop = calls.filter((call) => /^frame \d+ starts/.test(call)).length
  const result = await flow

  expect(result).toEqual({ outcome: 'unverified', reason: 'the flow was stopped before it ended', evidence: [] })
  // At most the frame that was in flight; the assertion after the click never ran.
  expect(calls.filter((call) => /^frame \d+ starts/.test(call)).length).toBeLessThanOrEqual(framesAtStop + 1)
  expect(calls.filter((call) => call.startsWith('assert') || call.startsWith('screenshot'))).toEqual([])
  expect(existsSync(join(dir, 'recording.png'))).toBe(false)
  expect(existsSync(join(dir, 'actions.log'))).toBe(false)
})
