import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  FileLedgerStore,
  decodePng,
  encodePng,
  redactEvidenceDir,
  redactionRules,
  runJob,
  runVisualCheckJob,
  visualPageUrl,
  type BootOpts,
  type EgressAttempt,
  type Job,
  type JobCriterion,
  type JobVisualCheck,
  type QaProfile,
  type RunResult,
  type VisualRevision,
  type VisualSessionFactory,
} from '../src/index.js'

// Assembled, never literal: no network marker sits as a literal in a test.
const HEALTH_URL = ['http:', '//localhost:3000/up'].join('')
const TARGET_URL = ['https:', '//wiki.example.test'].join('')
const APP_ORIGIN = new RegExp(`^${['http:', '//localhost:'].join('')}\\d+`)

const APP_PROFILE: QaProfile = {
  app: {
    boot: { compose: 'compose.qa.yaml', service: 'admin' },
    health: { http: HEALTH_URL, timeout: '120s' },
    seed: { command: 'bin/seed' },
    login: { fixture: 'fixtures/users.yml', role: 'admin' },
  },
  stubs: [],
  visual: { widths: [1440, 390], themes: ['light', 'dark'] },
  suites: [],
}

const TARGET_PROFILE: QaProfile = {
  target: { url: TARGET_URL, health: { http: `${TARGET_URL}/up`, timeout: '1s' }, hosts: ['*.cdn.example.test'] },
  stubs: [],
  visual: { widths: [], themes: [] },
  suites: [],
}

const UP = { probe: async () => ({ ok: true }), pollIntervalMs: 1 }

/** A compose seam that records every call, and fails the `up` of the calls it is told to. */
function recordingBoot(failUp: (call: number) => boolean = () => false): BootOpts & { calls: string[][] } {
  const calls: string[][] = []
  let ups = 0
  return {
    calls,
    runCompose: async (args) => {
      calls.push(args)
      if (args.includes('up')) {
        ups += 1
        if (failUp(ups)) return { code: 1, stdout: '', stderr: 'no such service' }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
    probe: async () => ({ ok: true }),
    pollIntervalMs: 1,
  }
}

/** A page: a white canvas as wide as the viewport, with one dark element on it. */
function page(width: number, element: { x: number; y: number } | null = { x: 1, y: 1 }): Buffer {
  const height = 4
  const pixels = Buffer.alloc(width * height * 4, 255)
  if (element !== null) pixels.set([0, 0, 0, 255], (element.y * width + element.x) * 4)
  return encodePng({ width, height, pixels })
}

interface Capture {
  url: string
  width: number
  theme: string
  revision: VisualRevision
}

/** A screenshot backend that paints what it is told to, and records every capture and the masks it was started with. */
function fakeVisual(
  paint: (capture: Capture) => Buffer | Error = ({ width }) => page(width),
  opts: { outbound?: EgressAttempt[] | null } = {},
): { session: VisualSessionFactory; captures: Capture[]; masks: string[][]; disposed: () => number } {
  const captures: Capture[] = []
  const masks: string[][] = []
  let disposed = 0
  return {
    captures,
    masks,
    disposed: () => disposed,
    session: async (started) => {
      masks.push(started.masks)
      return {
        screenshot: async (url, width, theme, revision) => {
          const capture = { url, width, theme, revision }
          captures.push(capture)
          const painted = paint(capture)
          if (painted instanceof Error) throw painted
          return painted
        },
        dispose: async () => {
          disposed += 1
        },
        ...(opts.outbound === null ? {} : { outbound: () => opts.outbound ?? [] }),
      }
    },
  }
}

const visual = (id: string, check: Partial<JobVisualCheck> = {}): JobCriterion => ({
  id,
  text: `${id} looks right`,
  checks: [{ kind: 'visual', name: id, screenshot: id, ...check }],
})

async function tempRepo(prefix = 'qare-visual-run-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

function jobFor(repoPath: string, criteria: JobCriterion[], profile: QaProfile): Job {
  return { id: 'job-visual', repoPath, baseRef: 'origin/main', headRef: 'HEAD', profile: { inline: profile }, criteria, evidenceDir: join(repoPath, 'evidence'), post: 'none' }
}

const criterionOf = (result: RunResult, id: string) => {
  const criterion = result.criteria.find((entry) => entry.id === id)
  if (criterion === undefined) throw new Error(`no criterion ${id}`)
  return criterion
}

const readJson = async (path: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>

// One side: a target.

test('on a target a visual check captures the head at each width, proves the criterion, and says there was nothing to compare with (#143)', async () => {
  const repo = await tempRepo()
  const backend = fakeVisual()
  const job = jobFor(repo, [visual('article', { url: '/wiki/Ada_Lovelace', widths: [390, 1440] })], TARGET_PROFILE)

  const { result } = await runJob(job, { ...UP, visualSession: backend.session })

  expect(result.verdict).toBe('passed')
  const criterion = criterionOf(result, 'article')
  expect(criterion.outcome).toBe('proven')
  expect(criterion.evidence).toEqual([
    'checks/article/0/visual.json',
    'checks/article/0/outbound.json',
    'checks/article/0/head/390xlight.png',
    'checks/article/0/head/1440xlight.png',
  ])
  for (const path of criterion.evidence ?? []) expect(existsSync(join(job.evidenceDir, path))).toBe(true)

  // The page is a path on the target, captured as written: no query is added to it.
  expect(backend.captures).toEqual([
    { url: `${TARGET_URL}/wiki/Ada_Lovelace`, width: 390, theme: 'light', revision: 'head' },
    { url: `${TARGET_URL}/wiki/Ada_Lovelace`, width: 1440, theme: 'light', revision: 'head' },
  ])
  expect(backend.disposed()).toBe(1)

  const record = await readJson(join(job.evidenceDir, 'checks/article/0/visual.json'))
  expect(record).toMatchObject({
    screenshot: 'article',
    url: `${TARGET_URL}/wiki/Ada_Lovelace`,
    side: 'head',
    widths: [390, 1440],
    // Neither the check nor the profile named a theme: the browser's default.
    themes: ['light'],
    comparison: { with: 'nothing', reason: 'the profile names a running target, which has one side only, so there is no base to compare with' },
    screenshots: [
      { revision: 'head', width: 390, theme: 'light', outcome: 'captured', path: 'head/390xlight.png', masks: [] },
      { revision: 'head', width: 1440, theme: 'light', outcome: 'captured', path: 'head/1440xlight.png', masks: [] },
    ],
    diffs: [],
    outcome: 'passed',
  })
  // What was captured is what is on disk.
  expect(decodePng(await readFile(join(job.evidenceDir, 'checks/article/0/head/390xlight.png'))).width).toBe(390)
})

test('a visual check that names no page captures the app itself, and one that names no width takes the profile\'s (#143)', async () => {
  const repo = await tempRepo()
  const backend = fakeVisual()
  const profile = { ...TARGET_PROFILE, visual: { widths: [1280], themes: ['dark'] } }

  const { result } = await runJob(jobFor(repo, [visual('home')], profile), { ...UP, visualSession: backend.session })

  expect(criterionOf(result, 'home').outcome).toBe('proven')
  expect(backend.captures).toEqual([{ url: TARGET_URL, width: 1280, theme: 'dark', revision: 'head' }])
})

test('a visual check with no width anywhere is unverified, and nothing is captured (#143)', async () => {
  const repo = await tempRepo()
  const backend = fakeVisual()

  const { result } = await runJob(jobFor(repo, [visual('home')], TARGET_PROFILE), { ...UP, visualSession: backend.session })

  expect(result.verdict).toBe('blocked')
  expect(criterionOf(result, 'home')).toMatchObject({ outcome: 'unverified' })
  expect(criterionOf(result, 'home').reason).toContain("names no width and the profile's visual section declares none")
  expect(backend.captures).toEqual([])
})

test('a screenshot that cannot be taken is unverified, naming why, never failed (#143)', async () => {
  const repo = await tempRepo()
  const backend = fakeVisual(({ width }) => (width === 1440 ? new Error('net::ERR_CONNECTION_REFUSED') : page(width)))
  const job = jobFor(repo, [visual('article', { widths: [390, 1440] })], TARGET_PROFILE)

  const { result } = await runJob(job, { ...UP, visualSession: backend.session })

  expect(result.verdict).toBe('blocked')
  const criterion = criterionOf(result, 'article')
  expect(criterion.outcome).toBe('unverified')
  expect(criterion.reason).toContain('the screenshot at 1440xlight could not be taken')
  expect(criterion.reason).toContain('net::ERR_CONNECTION_REFUSED')
  // The record keeps what was captured and what was not.
  const record = await readJson(join(job.evidenceDir, 'checks/article/0/visual.json'))
  expect(record).toMatchObject({
    outcome: 'unverified',
    screenshots: [
      { width: 390, outcome: 'captured', path: 'head/390xlight.png' },
      { width: 1440, outcome: 'unverified' },
    ],
  })
})

test('a screenshot backend that will not start leaves the check unverified (#143)', async () => {
  const repo = await tempRepo()
  const session: VisualSessionFactory = async () => {
    throw new Error('playwright-core is not installed')
  }

  const { result } = await runJob(jobFor(repo, [visual('article', { widths: [390] })], TARGET_PROFILE), { ...UP, visualSession: session })

  expect(criterionOf(result, 'article')).toMatchObject({
    outcome: 'unverified',
    reason: 'the screenshot backend did not start: playwright-core is not installed',
  })
})

test('a capture that outlives its timeout is unverified, and the run goes on (#143)', async () => {
  const repo = await tempRepo()
  const session: VisualSessionFactory = async () => ({
    screenshot: () => new Promise<Buffer>(() => {}),
    dispose: async () => {},
    outbound: () => [],
  })

  const { result } = await runJob(jobFor(repo, [visual('article', { widths: [390], timeoutMs: 20 })], TARGET_PROFILE), { ...UP, visualSession: session })

  expect(criterionOf(result, 'article').outcome).toBe('unverified')
  expect(criterionOf(result, 'article').reason).toContain('the capture exceeded its 20 ms timeout')
})

test('on a target the captures are held to the declared hosts, like a flow\'s browser (#122, #143)', async () => {
  const declared = fakeVisual(undefined, { outbound: [{ host: 'wiki.example.test', port: 443, protocol: 'https' }, { host: 'img.cdn.example.test', port: 443, protocol: 'https' }] })
  const declaredJob = jobFor(await tempRepo(), [visual('article', { widths: [390] })], TARGET_PROFILE)
  const allowed = await runJob(declaredJob, { ...UP, visualSession: declared.session })
  expect(allowed.result.verdict).toBe('passed')
  expect(await readJson(join(declaredJob.evidenceDir, 'checks/article/0/outbound.json'))).toMatchObject({
    target: TARGET_URL,
    reached: [
      { host: 'img.cdn.example.test', declared: true },
      { host: 'wiki.example.test', declared: true },
    ],
  })

  const undeclared = fakeVisual(undefined, { outbound: [{ host: 'tracker.example.test', port: 443, protocol: 'https' }] })
  const refused = await runJob(jobFor(await tempRepo(), [visual('article', { widths: [390] })], TARGET_PROFILE), { ...UP, visualSession: undeclared.session })
  expect(refused.result.verdict).toBe('refused')
  expect(criterionOf(refused.result, 'article').outcome).toBe('unverified')
  expect(criterionOf(refused.result, 'article').reason).toContain('refused: undeclared host: tracker.example.test:443 (https)')

  // A backend that cannot say what it reached is not trusted on a target.
  const silent = fakeVisual(undefined, { outbound: null })
  const untrusted = await runJob(jobFor(await tempRepo(), [visual('article', { widths: [390] })], TARGET_PROFILE), { ...UP, visualSession: silent.session })
  expect(criterionOf(untrusted.result, 'article').outcome).toBe('unverified')
  expect(criterionOf(untrusted.result, 'article').reason).toContain('does not report the hosts its browser reached')
  expect(silent.captures).toEqual([])
  expect(silent.disposed()).toBe(1)
})

test('a page that climbs out of the target, or names a value the run does not mint, refuses the run before anything is captured (#143)', async () => {
  for (const url of ['/../../elsewhere', '/wiki/{{run.nonsense}}']) {
    const backend = fakeVisual()
    const { result } = await runJob(jobFor(await tempRepo(), [visual('article', { url, widths: [390] })], { ...TARGET_PROFILE, target: { ...TARGET_PROFILE.target!, url: `${TARGET_URL}/wiki` } }), {
      ...UP,
      visualSession: backend.session,
    })
    expect(result.verdict).toBe('refused')
    expect(criterionOf(result, 'article').reason).toContain('criteria[0].checks[0].url')
    expect(backend.captures).toEqual([])
  }
})

test('the page of a visual check resolves on the app the run booted, on the target, or stands as a URL (#143)', () => {
  const app = { appHealth: [HEALTH_URL.replace('3000', '{{run.app_port}}')].join('') }
  const values = { id: 'r1', mail_address: 'qare-r1@localhost', app_port: '41234' }
  const origin = ['http:', '//localhost:41234'].join('')

  expect(visualPageUrl('/dashboard?tab=1', app, values)).toEqual({ ok: true, url: `${origin}/dashboard?tab=1` })
  expect(visualPageUrl(undefined, app, values)).toEqual({ ok: true, url: `${origin}/` })
  // A profile that pins a port is moved to the port the run published the app on.
  expect(visualPageUrl('/dashboard', { appHealth: HEALTH_URL }, values)).toEqual({ ok: true, url: `${origin}/dashboard` })
  expect(visualPageUrl('/wiki/Ada', { targetUrl: TARGET_URL }, values)).toEqual({ ok: true, url: `${TARGET_URL}/wiki/Ada` })
  expect(visualPageUrl(`${TARGET_URL}/other`, { targetUrl: TARGET_URL }, values)).toEqual({ ok: true, url: `${TARGET_URL}/other` })
  expect(visualPageUrl('dashboard', app, values)).toMatchObject({ ok: false })
  expect(visualPageUrl(['file:', '///etc/passwd'].join(''), app, values)).toMatchObject({ ok: false })
  expect(visualPageUrl('/dashboard', {}, values)).toMatchObject({ ok: false })
})

test('the masks in force are handed to the backend, named for each screenshot, and the evidence passes the redaction sweep (#52, #119, #143)', async () => {
  const repo = await tempRepo()
  const profile: QaProfile = { ...TARGET_PROFILE, redact: { values: ['jane@pilot.example'], masks: ['css=.fixture-banner'] } }
  const backend = fakeVisual(({ width }) => (width === 1440 ? new Error('could not render the banner of jane@pilot.example') : page(width)))
  const job = jobFor(repo, [visual('article', { url: '/wiki/Ada?user=jane@pilot.example', widths: [390, 1440] })], profile)

  const { result } = await runJob(job, { ...UP, visualSession: backend.session })

  expect(backend.masks).toEqual([['css=.fixture-banner']])
  const text = await readFile(join(job.evidenceDir, 'checks/article/0/visual.json'), 'utf8')
  const record = JSON.parse(text) as { masks: string[]; screenshots: Array<{ masks?: string[]; outcome: string }> }
  expect(record.masks).toEqual(['css=.fixture-banner'])
  expect(record.screenshots.map((screenshot) => screenshot.masks)).toEqual([['css=.fixture-banner'], undefined])
  // The fixture value never reaches the record or the result, in the URL or in a reason.
  expect(text).not.toContain('jane@pilot.example')
  expect(JSON.stringify(result)).not.toContain('jane@pilot.example')
  expect(await readFile(join(job.evidenceDir, 'result.json'), 'utf8')).not.toContain('jane@pilot.example')

  // The pipeline's sweep (#52) vouches for every file: the record as text, the screenshots as images.
  const swept = await redactEvidenceDir(job.evidenceDir, redactionRules(profile.redact))
  expect(swept.changed).toEqual([])
  expect(swept.images).toEqual(['checks/article/0/head/390xlight.png'])
})

// One side: an app the run boots, and nobody asked for a base.

test('a run that boots the app and was asked for no base captures the head on the app it booted (#143)', async () => {
  const repo = await tempRepo()
  const backend = fakeVisual()
  const job = jobFor(repo, [visual('dashboard', { url: '/dashboard', widths: [390], themes: ['dark'] })], APP_PROFILE)

  const { result, isolation } = await runJob(job, { ...recordingBoot(), visualSession: backend.session })

  expect(criterionOf(result, 'dashboard').outcome).toBe('proven')
  expect(backend.captures).toHaveLength(1)
  expect(backend.captures[0]?.url).toBe(`${['http:', '//localhost:'].join('')}${isolation?.port}/dashboard`)
  expect(await readJson(join(job.evidenceDir, 'checks/dashboard/0/visual.json'))).toMatchObject({
    comparison: { with: 'nothing', reason: 'nothing ran at a base revision in this run, so there is no base to compare with' },
    outcome: 'passed',
  })
  // An app run records no outbound file: the stub map, not the target hosts, is its boundary.
  expect(existsSync(join(job.evidenceDir, 'checks/dashboard/0/outbound.json'))).toBe(false)
})

// Two sides (#147).

async function twoTrees(): Promise<{ head: string; base: string }> {
  return { head: await tempRepo('qare-head-'), base: await tempRepo('qare-base-') }
}

test('a change that moves an element fails the visual criterion, with base, head and diff images as evidence (#143)', async () => {
  const trees = await twoTrees()
  // The element sits one pixel further right at the head, at the phone width only.
  const backend = fakeVisual(({ width, revision }) => page(width, revision === 'head' && width === 390 ? { x: 2, y: 1 } : { x: 1, y: 1 }))
  const job = jobFor(trees.head, [visual('dashboard', { url: '/dashboard', widths: [390, 1440], themes: ['light'] })], APP_PROFILE)

  const { result } = await runJob(job, { ...recordingBoot(), visualSession: backend.session, base: { repoPath: trees.base } })

  expect(result.verdict).toBe('failed')
  expect(result.base).toEqual({ ref: 'origin/main', status: 'executed' })
  const criterion = criterionOf(result, 'dashboard')
  // Captured at the base, different at the head: the judge names it a regression.
  expect(criterion).toMatchObject({ outcome: 'failed', regression: true, base: { outcome: 'proven' } })
  expect(criterion.evidence).toEqual([
    'head/checks/dashboard/0/visual.json',
    'head/checks/dashboard/0/base/390xlight.png',
    'head/checks/dashboard/0/base/1440xlight.png',
    'head/checks/dashboard/0/head/390xlight.png',
    'head/checks/dashboard/0/head/1440xlight.png',
    'head/checks/dashboard/0/diff/390xlight.png',
  ])
  expect(criterion.base?.evidence).toEqual([
    'base/checks/dashboard/0/visual.json',
    'base/checks/dashboard/0/base/390xlight.png',
    'base/checks/dashboard/0/base/1440xlight.png',
  ])
  for (const path of [...(criterion.evidence ?? []), ...(criterion.base?.evidence ?? [])]) expect(existsSync(join(job.evidenceDir, path))).toBe(true)

  // Each side captured its own app: the base's, torn down before the head's booted.
  expect(backend.captures.map((capture) => capture.revision)).toEqual(['base', 'base', 'head', 'head'])
  const origins = backend.captures.map((capture) => new URL(capture.url).origin)
  expect(origins[0]).toMatch(APP_ORIGIN)
  expect(origins[0]).toBe(origins[1])
  expect(origins[2]).toBe(origins[3])
  expect(origins[2]).not.toBe(origins[0])
  expect(backend.captures.every((capture) => new URL(capture.url).pathname === '/dashboard')).toBe(true)

  const record = await readJson(join(job.evidenceDir, 'head/checks/dashboard/0/visual.json'))
  expect(record).toMatchObject({
    side: 'head',
    comparison: { with: 'base' },
    diffs: [
      { width: 390, theme: 'light', status: 'differs', path: 'diff/390xlight.png' },
      { width: 1440, theme: 'light', status: 'identical' },
    ],
    outcome: 'failed',
    reason: 'the page differs from the base at 390xlight',
  })
  // The diff image marks where the element was and where it went.
  const diff = decodePng(await readFile(join(job.evidenceDir, 'head/checks/dashboard/0/diff/390xlight.png')))
  const marked = (x: number, y: number): boolean => diff.pixels.readUInt32BE((y * diff.width + x) * 4) === 0xff0000ff
  expect([marked(1, 1), marked(2, 1), marked(0, 0)]).toEqual([true, true, false])
  // The base the head compared with is the capture the base side saved, byte for byte.
  expect(
    (await readFile(join(job.evidenceDir, 'head/checks/dashboard/0/base/390xlight.png'))).equals(await readFile(join(job.evidenceDir, 'base/checks/dashboard/0/base/390xlight.png'))),
  ).toBe(true)
  expect(await readJson(join(job.evidenceDir, 'base/checks/dashboard/0/visual.json'))).toMatchObject({ side: 'base', outcome: 'passed', diffs: [] })
})

test('a change that touches nothing visible proves the visual criterion (#143)', async () => {
  const trees = await twoTrees()
  const backend = fakeVisual()
  const job = jobFor(trees.head, [visual('dashboard', { url: '/dashboard' })], APP_PROFILE)

  const { result } = await runJob(job, { ...recordingBoot(), visualSession: backend.session, base: { repoPath: trees.base } })

  expect(result.verdict).toBe('passed')
  const criterion = criterionOf(result, 'dashboard')
  expect(criterion).toMatchObject({ outcome: 'proven', base: { outcome: 'proven' } })
  expect('regression' in criterion).toBe(false)
  // The profile's widths and themes, at both sides.
  expect(backend.captures).toHaveLength(8)
  const record = await readJson(join(job.evidenceDir, 'head/checks/dashboard/0/visual.json'))
  expect((record.diffs as Array<{ status: string }>).map((diff) => diff.status)).toEqual(['identical', 'identical', 'identical', 'identical'])
  expect(criterion.evidence?.some((path) => path.includes('/diff/'))).toBe(false)
})

test('a base that will not boot leaves the visual check unverified, naming why, never failed (#143)', async () => {
  const trees = await twoTrees()
  const backend = fakeVisual()
  const job = jobFor(trees.head, [visual('dashboard', { widths: [390], themes: ['light'] })], APP_PROFILE)

  // The first `up` is the base's.
  const { result } = await runJob(job, { ...recordingBoot((call) => call === 1), visualSession: backend.session, base: { repoPath: trees.base } })

  expect(result.verdict).toBe('blocked')
  expect(result.base).toMatchObject({ status: 'not-executed' })
  const criterion = criterionOf(result, 'dashboard')
  expect(criterion).toMatchObject({ outcome: 'unverified', base: { outcome: 'not-compared' } })
  expect(criterion.reason).toContain('no base screenshots to compare with: the base side did not run')
  expect(criterion.reason).toContain('compose up exited 1')
  expect('regression' in criterion).toBe(false)
  // The head was still captured, so the evidence shows what it looks like.
  expect(backend.captures.map((capture) => capture.revision)).toEqual(['head'])
  expect(await readJson(join(job.evidenceDir, 'head/checks/dashboard/0/visual.json'))).toMatchObject({
    comparison: { with: 'nothing' },
    screenshots: [{ revision: 'head', outcome: 'captured', path: 'head/390xlight.png' }],
    outcome: 'unverified',
  })
})

test('a page that cannot be captured at the base leaves the check unverified, not failed (#143)', async () => {
  const trees = await twoTrees()
  const backend = fakeVisual(({ width, revision }) => (revision === 'base' ? new Error('the page is not there yet') : page(width)))
  const job = jobFor(trees.head, [visual('dashboard', { widths: [390], themes: ['light'] })], APP_PROFILE)

  const { result } = await runJob(job, { ...recordingBoot(), visualSession: backend.session, base: { repoPath: trees.base } })

  const criterion = criterionOf(result, 'dashboard')
  expect(criterion).toMatchObject({ outcome: 'unverified', base: { outcome: 'not-compared' } })
  expect(criterion.reason).toContain('the screenshots at 390xlight could not be compared')
  // The reason is the base side's own: why it could not take the screenshot.
  expect(criterion.reason).toContain('the base side saved no screenshot at 390xlight (Error: the page is not there yet)')
  expect(await readJson(join(job.evidenceDir, 'base/checks/dashboard/0/visual.json'))).toMatchObject({ side: 'base', outcome: 'unverified' })
})

test('a region named in the profile\'s masks is masked at base and head alike (#119, #143)', async () => {
  const trees = await twoTrees()
  const profile: QaProfile = { ...APP_PROFILE, redact: { masks: ['css=.fixture-banner', '[data-testid="clock"]'] } }
  const backend = fakeVisual()
  const job = jobFor(trees.head, [visual('dashboard', { widths: [390], themes: ['light'] })], profile)

  const { result } = await runJob(job, { ...recordingBoot(), visualSession: backend.session, base: { repoPath: trees.base } })

  expect(criterionOf(result, 'dashboard').outcome).toBe('proven')
  // One backend per side, each started with the same masks.
  expect(backend.masks).toEqual([
    ['css=.fixture-banner', '[data-testid="clock"]'],
    ['css=.fixture-banner', '[data-testid="clock"]'],
  ])
  for (const side of ['base', 'head']) {
    const record = await readJson(join(job.evidenceDir, side, 'checks/dashboard/0/visual.json'))
    expect(record.masks).toEqual(['css=.fixture-banner', '[data-testid="clock"]'])
    for (const screenshot of record.screenshots as Array<{ masks: string[] }>) expect(screenshot.masks).toEqual(['css=.fixture-banner', '[data-testid="clock"]'])
  }
})

const PROFILE_YAML = (masks: string[]): string =>
  [
    'app:',
    '  boot: { compose: compose.qa.yaml, service: admin }',
    `  health: { http: "${HEALTH_URL}", timeout: 120s }`,
    '  seed: { command: bin/seed }',
    '  login: { fixture: fixtures/users.yml, role: admin }',
    'stubs: []',
    'visual: { widths: [390], themes: [light] }',
    'suites: []',
    `redact: { masks: ${JSON.stringify(masks)} }`,
    '',
  ].join('\n')

async function writeProfile(repo: string, masks: string[]): Promise<void> {
  await mkdir(join(repo, '.qa', 'fixtures'), { recursive: true })
  await mkdir(join(repo, '.qa', 'stubs'), { recursive: true })
  await writeFile(join(repo, '.qa', 'QA.md'), '# QA\n')
  await writeFile(join(repo, '.qa', 'fixtures', 'users.yml'), 'admin: {}\n')
  await writeFile(join(repo, '.qa', 'config.yml'), PROFILE_YAML(masks))
}

test('the head profile\'s masks are in force at the base too, so a mask the change adds never shows as a difference (#143)', async () => {
  const trees = await twoTrees()
  await writeProfile(trees.base, [])
  await writeProfile(trees.head, ['css=.new-fixture'])
  const backend = fakeVisual()
  const job: Job = { ...jobFor(trees.head, [visual('dashboard')], APP_PROFILE), profile: { path: '.qa' } }

  const { result } = await runJob(job, { ...recordingBoot(), visualSession: backend.session, base: { repoPath: trees.base } })

  expect(criterionOf(result, 'dashboard').outcome).toBe('proven')
  expect(backend.masks).toEqual([['css=.new-fixture'], ['css=.new-fixture']])
})

test('a mask only the base profile names means the two sides were masked differently, so nothing is compared (#143)', async () => {
  const trees = await twoTrees()
  await writeProfile(trees.base, ['css=.old-fixture'])
  await writeProfile(trees.head, [])
  // Even a real difference is not reported as one: the pair is not comparable.
  const backend = fakeVisual(({ width, revision }) => page(width, revision === 'head' ? { x: 2, y: 1 } : { x: 1, y: 1 }))
  const job: Job = { ...jobFor(trees.head, [visual('dashboard')], APP_PROFILE), profile: { path: '.qa' } }

  const { result } = await runJob(job, { ...recordingBoot(), visualSession: backend.session, base: { repoPath: trees.base } })

  const criterion = criterionOf(result, 'dashboard')
  expect(criterion.outcome).toBe('unverified')
  expect(criterion.reason).toContain('a region masked on one side only would show as a difference')
  expect(criterion.reason).toContain('css=.old-fixture')
})

test('a criterion the profile leaves out of the base side has no base screenshots, and says which limit left it out (#143, #147)', async () => {
  const trees = await twoTrees()
  const backend = fakeVisual()
  const profile: QaProfile = { ...APP_PROFILE, base: { criteria: 'ledger' } }
  const job = jobFor(trees.head, [visual('dashboard', { widths: [390], themes: ['light'] }), { id: 'kept', text: 'runs', checks: [{ kind: 'command', run: 'true' }] }], profile)
  await new FileLedgerStore(join(trees.base, '.qa')).save([{ criterion: 'kept', status: 'active', source: ['#1'], proof: 'command' }])

  const { result } = await runJob(job, { ...recordingBoot(), visualSession: backend.session, base: { repoPath: trees.base } })

  const criterion = criterionOf(result, 'dashboard')
  expect(criterion.outcome).toBe('unverified')
  expect(criterion.reason).toContain('no base screenshots to compare with: not run at the base')
})

test('a missing base comparison is this run\'s outcome only, and a difference is not (#143)', async () => {
  const dir = await tempRepo()
  const backend = fakeVisual()
  const input = {
    check: { kind: 'visual' as const, screenshot: 'dashboard', widths: [390], themes: ['light'] },
    pageUrl: `${TARGET_URL}/dashboard`,
    criterionId: 'dashboard',
    index: 0,
    evidenceDir: join(dir, 'head'),
    checkDir: 'checks/dashboard/0',
    rules: [],
    defaultTimeoutMs: 1000,
  }
  const context = { session: backend.session, defaults: { widths: [], themes: [] }, masks: [] }
  const against = { with: 'base' as const, evidenceDir: join(dir, 'base'), why: () => 'the base side did not run: no checkout' }

  // Nothing saved at the base: a cache must not serve this outcome to the next run.
  const missing = await runVisualCheckJob({ ...input, context: { ...context, comparison: against } })
  expect(missing).toMatchObject({ status: 'unverified', transient: true, reason: 'no base screenshots to compare with: the base side did not run: no checkout' })

  // The base side saves its captures; the head side then finds a difference, which is a lasting outcome.
  const base = await runVisualCheckJob({ ...input, evidenceDir: join(dir, 'base'), context: { ...context, comparison: { with: 'base-side' } } })
  expect(base).toMatchObject({ status: 'passed' })
  const moved = fakeVisual(({ width }) => page(width, { x: 3, y: 2 }))
  const differs = await runVisualCheckJob({ ...input, context: { ...context, session: moved.session, comparison: against } })
  expect(differs.status).toBe('failed')
  expect('transient' in differs).toBe(false)
  expect(differs.evidence).toContain('checks/dashboard/0/diff/390xlight.png')
})
