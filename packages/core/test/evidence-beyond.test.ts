import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  decodePng,
  encodePng,
  normaliseAriaSnapshot,
  redactEvidenceDir,
  redactionRules,
  runJob,
  splitApng,
  type FlowCaptureOpts,
  type FlowPage,
  type Job,
  type JobCriterion,
  type PlatformLogEntry,
  type QaProfile,
} from '../src/index.js'

/** The planted secret: the profile names it, the flow types it, the application logs it, and the page shows it. */
const SECRET = 'planted-secret-4f9a17c2'

const PROFILE: QaProfile = {
  client: { driver: 'electron', executable: 'dist/app/app', args: ['--no-sandbox'] },
  stubs: [],
  visual: { widths: [], themes: [] },
  suites: [],
  redact: { values: [SECRET] },
}

const HOST = { clientEnv: { env: { DISPLAY: ':99' }, platform: 'linux' as const }, clientCell: { problem: async () => undefined } }

const FAILING: JobCriterion['checks'] = [
  {
    kind: 'flow',
    actions: [
      { action: 'open', url: '/' },
      { action: 'type', element: { role: 'textbox', name: 'Access code' }, value: SECRET },
      { action: 'click', element: { role: 'button', name: 'Greet' } },
      { action: 'assertText', text: 'A greeting nobody wrote' },
    ],
  },
]

const PASSING: JobCriterion['checks'] = [{ kind: 'flow', actions: [{ action: 'open', url: '/' }, { action: 'assertText', text: 'Greeter' }] }]

async function clientJob(checks: JobCriterion['checks']): Promise<Job> {
  const repoPath = await mkdtemp(join(tmpdir(), 'qare-evidence-beyond-'))
  await mkdir(join(repoPath, 'dist', 'app'), { recursive: true })
  await writeFile(join(repoPath, 'dist', 'app', 'app'), '#!/bin/sh\nexit 0\n')
  await chmod(join(repoPath, 'dist', 'app', 'app'), 0o755)
  return {
    id: 'job-evidence-beyond',
    repoPath,
    baseRef: 'main',
    headRef: 'HEAD',
    profile: { inline: PROFILE },
    criteria: [{ id: 'greets', text: 'the application greets', checks }],
    evidenceDir: join(repoPath, 'evidence'),
    post: 'none',
  }
}

/**
 * An application that does everything a secret can do to evidence: it logs
 * the value typed into it, and its tree holds the value as the field's own.
 * Its frames are numbered, and what each capture was asked to conceal is
 * written down.
 */
function leakySession(captures: string[], opts: { hangs?: boolean } = {}) {
  return async () => {
    const entries: PlatformLogEntry[] = [{ at: Date.now(), line: '[main stdout] main: ready' }]
    const record = (line: string): void => void entries.push({ at: Date.now(), line })
    let typed = ''
    let frames = 0
    const asked = (kind: string, capture: FlowCaptureOpts | undefined): void =>
      void captures.push(`${kind} conceals [${(capture?.conceal ?? []).map((element) => ('name' in element ? element.name : element.testId)).join(', ')}]`)
    const page: FlowPage = {
      conceals: true,
      open: async () => {
        if (opts.hangs) await new Promise((resolve) => setTimeout(resolve, 300))
        record('[window 1 opened] file:///app/index.html')
      },
      click: async () => record(`[window 1 console.log] renderer: greeted with access code ${typed}`),
      type: async (_element, value) => {
        typed = value
      },
      choose: async () => {},
      waitFor: async () => {},
      assertText: async (text) => {
        if (text !== 'Greeter') throw new Error('assert failed')
      },
      assertElement: async () => {},
      screenshot: async (path, capture) => {
        asked('screenshot', capture)
        await writeFile(path, encodePng({ width: 1, height: 1, pixels: Buffer.from([0, 0, 0, 255]) }))
      },
      frame: async (capture) => {
        asked('frame', capture)
        frames += 1
        return encodePng({ width: 1, height: 1, pixels: Buffer.from([frames, 0, 0, 255]) })
      },
      snapshot: async () => normaliseAriaSnapshot(`- heading "Greeter" [level=1]\n- textbox "Access code": ${typed}\n- status "A greeting nobody wrote is not here"`),
    }
    return {
      page,
      // An application takes a moment to close, and says so when it has.
      dispose: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        record('[main exited] code 0')
      },
      console: () => entries.map((entry) => entry.line),
      platformLog: () => [...entries],
      reached: () => ({ reached: [] }),
    }
  }
}

async function filesUnder(dir: string, prefix = ''): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) found.push(...(await filesUnder(join(dir, entry.name), `${prefix}${entry.name}/`)))
    else found.push(`${prefix}${entry.name}`)
  }
  return found.sort()
}

test('a failing check leaves a recording, a log excerpt and a tree snapshot, and a planted secret is in none of the evidence (#78)', async () => {
  const captures: string[] = []
  const job = await clientJob(FAILING)

  const { result } = await runJob(job, { ...HOST, flowSession: leakySession(captures) })

  const check = 'checks/greets/0'
  expect(result.criteria).toEqual([
    {
      id: 'greets',
      outcome: 'failed',
      evidence: [
        `${check}/actions.log`,
        `${check}/assert-3.json`,
        `${check}/failure.png`,
        `${check}/recording.png`,
        `${check}/console.log`,
        `${check}/failure.log`,
        `${check}/outbound.json`,
      ],
      reason: 'assert failed: the text "A greeting nobody wrote" is not visible',
    },
  ])
  const dir = join(job.evidenceDir, check)

  // The recording: a frame after each action and one at the failure.
  const frames = splitApng(await readFile(join(dir, 'recording.png')))
  expect(frames.map((frame) => decodePng(frame.png).pixels[0])).toEqual([1, 2, 3, 4])
  // The secret's field was concealed before the value was typed, and stayed concealed.
  expect(captures).toEqual(['frame conceals []', 'frame conceals [Access code]', 'frame conceals [Access code]', 'frame conceals [Access code]', 'screenshot conceals [Access code]'])

  // The log excerpt: what the platform wrote up to the failure, the mark, and what it wrote on its way out.
  const excerpt = (await readFile(join(dir, 'failure.log'), 'utf8')).split('\n')
  expect(excerpt[0]).toBe('the platform log from 30 s before the check stopped to its end')
  expect(excerpt.slice(1).map((line) => line.replace(/^\[[-+]\d+\.\d{3}s\] /, ''))).toEqual([
    '[main stdout] main: ready',
    '[window 1 opened] file:///app/index.html',
    '[window 1 console.log] renderer: greeted with access code [redacted]',
    '--- the check stopped here ---',
    '[main exited] code 0',
    '',
  ])

  // The tree snapshot at the assertion: what the harness saw, with the field's value swept.
  const snapshot = JSON.parse(await readFile(join(dir, 'assert-3.json'), 'utf8')) as { assertedText: string; snapshot: unknown }
  expect(snapshot.assertedText).toBe('A greeting nobody wrote')
  expect(JSON.stringify(snapshot.snapshot)).toContain('A greeting nobody wrote is not here')

  // The sweep: no byte of the secret anywhere in the evidence, read as bytes so an image is searched too.
  const files = await filesUnder(job.evidenceDir)
  expect(files).toEqual(expect.arrayContaining([`${check}/recording.png`, `${check}/failure.log`, `${check}/console.log`, `${check}/assert-3.json`, `${check}/actions.log`, 'result.json']))
  for (const file of files) expect((await readFile(join(job.evidenceDir, file))).includes(SECRET), `${file} holds the planted secret`).toBe(false)
  expect(await readFile(join(dir, 'console.log'), 'utf8')).toContain('renderer: greeted with access code [redacted]')
  // And the pipeline's own sweep finds nothing left to redact, and vouches for the recording as an image.
  const swept = await redactEvidenceDir(job.evidenceDir, redactionRules(PROFILE.redact))
  expect(swept.changed).toEqual([])
  expect(swept.images).toEqual([`${check}/failure.png`, `${check}/recording.png`])
})

test('a check that passed has its console output and nothing of a failure: no recording, no excerpt (#78)', async () => {
  const job = await clientJob(PASSING)

  const { result } = await runJob(job, { ...HOST, flowSession: leakySession([]) })

  const check = 'checks/greets/0'
  expect(result.criteria).toEqual([
    { id: 'greets', outcome: 'proven', evidence: [`${check}/actions.log`, `${check}/assert-1.json`, `${check}/final.png`, `${check}/console.log`, `${check}/outbound.json`] },
  ])
  expect(await filesUnder(join(job.evidenceDir, check))).toEqual(['actions.log', 'assert-1.json', 'console.log', 'final.png', 'outbound.json'])
})

test('a flow that outlived its timeout still gets its log excerpt, cut around the moment it was stopped (#78)', async () => {
  const job = await clientJob([{ kind: 'flow', timeoutMs: 40, actions: [{ action: 'open', url: '/' }, { action: 'assertText', text: 'Greeter' }] }])

  const { result } = await runJob(job, { ...HOST, flowSession: leakySession([], { hangs: true }) })

  const check = 'checks/greets/0'
  expect(result.criteria[0]).toMatchObject({ outcome: 'unverified', reason: 'flow exceeded its 40 ms timeout' })
  expect(await filesUnder(join(job.evidenceDir, check))).toEqual(['console.log', 'failure.log', 'outbound.json'])
  // The flow it gave up on ends later, and adds nothing to evidence the run has already vouched for.
  await new Promise((resolve) => setTimeout(resolve, 400))
  expect(await filesUnder(join(job.evidenceDir, check))).toEqual(['console.log', 'failure.log', 'outbound.json'])
  const excerpt = await readFile(join(job.evidenceDir, check, 'failure.log'), 'utf8')
  expect(excerpt).toMatch(/^\[-\d+\.\d{3}s\] \[main stdout\] main: ready\n--- the check stopped here ---\n\[\+\d+\.\d{3}s\] \[main exited\] code 0$/m)
})
