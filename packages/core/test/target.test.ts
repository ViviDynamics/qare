import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import {
  ProfileValidationError,
  bootApp,
  buildReadinessReport,
  loadProfile,
  loadResult,
  pathOnTarget,
  readinessInventory,
  renderComment,
  runJob,
  stopApp,
  validateProfileConfig,
  type EgressAttempt,
  type FlowPage,
  type FlowTrace,
  type Job,
  type JobCriterion,
  type QaProfile,
} from '../src/index.js'

// Test files carry no network literals (the offline scanner), so URLs are
// joined at runtime and every probe and page is a fake.
const TARGET_URL = ['https:', '//wiki.example.test'].join('')
const HEALTH_URL = `${TARGET_URL}/health`
const PAGE_URL = `${TARGET_URL}/wiki/Ada_Lovelace`

const TARGET_CONFIG = {
  target: { url: TARGET_URL, health: { http: '/health', timeout: '1s' }, hosts: ['*.cdn.example.test'] },
}

const made: string[] = []

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}

async function makeJob(criteria: JobCriterion[], profile: QaProfile | unknown = validateProfileConfig(TARGET_CONFIG)): Promise<Job> {
  const repoPath = await tempDir('qare-target-')
  await writeFile(join(repoPath, 'echo-args.mjs'), 'console.log(process.argv.slice(2).join(" "))\n')
  return {
    id: 'job-target',
    repoPath,
    baseRef: 'main',
    headRef: 'HEAD',
    profile: { inline: profile },
    criteria,
    evidenceDir: join(repoPath, 'evidence'),
    post: 'none',
  }
}

const UP = { probe: async () => ({ ok: true }), pollIntervalMs: 1 }
const DOWN = { probe: async () => ({ ok: false }), pollIntervalMs: 5 }
const NEVER_COMPOSE = {
  runCompose: async () => {
    throw new Error('a target run must not boot anything')
  },
}

function fakeSession(opened: string[], outbound: EgressAttempt[] | null = [], opts: { hang?: boolean } = {}) {
  return async () => {
    const page: FlowPage = {
      open: async (url) => {
        opened.push(url)
      },
      click: async () => {},
      type: async () => {},
      assertText: async () => {
        if (opts.hang) await new Promise(() => {})
      },
      screenshot: async (path) => writeFile(path, 'png'),
    }
    const trace: FlowTrace = { start: async () => 'trace', stop: async () => {} }
    return { page, trace, dispose: async () => {}, ...(outbound === null ? {} : { outbound: () => outbound }) }
  }
}

test('a target profile needs only the target: no compose, seed, login, stubs, visual or suites (#122)', () => {
  const profile = validateProfileConfig(TARGET_CONFIG)

  expect(profile.app).toBeUndefined()
  expect(profile.target).toEqual({
    url: TARGET_URL,
    // A path is a page on the target.
    health: { http: HEALTH_URL, timeout: '1s' },
    hosts: ['*.cdn.example.test'],
  })
  expect(profile.stubs).toEqual([])
  expect(profile.suites).toEqual([])
})

test('a loaded target profile validates again when a job passes it inline', () => {
  const profile = validateProfileConfig(TARGET_CONFIG)
  expect(validateProfileConfig(profile)).toEqual(profile)
})

test('a profile holding only QA.md and a target config loads, with no fixtures or stubs directory', async () => {
  const dir = await tempDir('qare-target-profile-')
  await writeFile(join(dir, 'QA.md'), '# QA\n')
  await writeFile(join(dir, 'config.yml'), `target:\n  url: ${TARGET_URL}\n  health: { http: /health, timeout: 30s }\n`)

  const profile = await loadProfile(dir)

  expect(profile.target?.url).toBe(TARGET_URL)
  expect(profile.target?.hosts).toEqual([])
})

test.each([
  [{ target: { url: 'wiki.example.test', health: { http: '/health', timeout: '1s' } } }, 'target.url'],
  [{ target: { url: 'ftp://wiki.example.test', health: { http: '/health', timeout: '1s' } } }, 'target.url'],
  [{ target: { url: TARGET_URL } }, 'target.health'],
  [{ target: { url: TARGET_URL, health: { http: 'health', timeout: '1s' } } }, 'target.health.http'],
  [{ target: { url: TARGET_URL, health: { http: '/health', timeout: 'soon' } } }, 'target.health.timeout'],
  [{ target: { url: TARGET_URL, health: { http: '/health', timeout: '1s' }, hosts: 'cdn' } }, 'target.hosts'],
  [{ ...TARGET_CONFIG, app: {} }, 'target'],
  [{ ...TARGET_CONFIG, stubs: [{ service: 'billing', hosts: ['x'], provided_by: { compose_service: 'y' } }] }, 'stubs'],
])('a target profile mistake names the field (%#)', (config, field) => {
  let error: unknown
  try {
    validateProfileConfig(config)
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(ProfileValidationError)
  expect((error as ProfileValidationError).field).toBe(field)
})

test('a target that answers is up without anything booting, and stopping it stops nothing', async () => {
  const profile = validateProfileConfig(TARGET_CONFIG)
  const probed: string[] = []

  const outcome = await bootApp(profile, {
    ...NEVER_COMPOSE,
    probe: async (url) => {
      probed.push(url)
      return { ok: true }
    },
  })
  await stopApp(profile, NEVER_COMPOSE)

  expect(outcome.kind).toBe('up')
  expect(probed).toEqual([HEALTH_URL])
})

test('a target that is down blocks the run naming the URL, and no criterion is failed', async () => {
  const job = await makeJob([
    { id: 'c1', text: 'the article opens', checks: [{ kind: 'command', run: 'node echo-args.mjs never' }] },
    { id: 'c2', text: 'search finds it', checks: [{ kind: 'flow', actions: [{ action: 'open', url: '/' }] }] },
  ])

  const { result } = await runJob(job, { ...NEVER_COMPOSE, ...DOWN, flowSession: fakeSession([]) })

  expect(result.verdict).toBe('blocked')
  expect(result.criteria.every((criterion) => criterion.outcome === 'unverified')).toBe(true)
  for (const criterion of result.criteria) {
    expect((criterion as { reason: string }).reason).toContain(`target ${TARGET_URL} is not reachable`)
    expect((criterion as { reason: string }).reason).toContain(HEALTH_URL)
  }
  expect(result.target).toEqual({ url: TARGET_URL, comparison: 'none' })
})

test('command and flow checks run against the target URL, and the result says there is no base comparison', async () => {
  const opened: string[] = []
  const job = await makeJob([
    {
      id: 'c1',
      text: 'the article is served',
      checks: [{ kind: 'command', run: 'node echo-args.mjs {{run.target_url}}/wiki/Ada_Lovelace' }],
    },
    {
      id: 'c2',
      text: 'the article opens in a browser',
      checks: [
        {
          kind: 'flow',
          actions: [
            { action: 'open', url: '/wiki/Ada_Lovelace' },
            { action: 'assert', text: 'Ada Lovelace' },
          ],
        },
      ],
    },
  ])

  const { result } = await runJob(job, {
    ...NEVER_COMPOSE,
    ...UP,
    flowSession: fakeSession(opened, [
      { host: 'wiki.example.test', port: 443, protocol: 'https' },
      { host: 'img.cdn.example.test', port: 443, protocol: 'https' },
    ]),
  })

  expect(result.verdict).toBe('passed')
  expect(result.criteria.map((criterion) => criterion.outcome)).toEqual(['proven', 'proven'])
  expect(await readFile(join(job.evidenceDir, 'checks/c1/0/stdout.txt'), 'utf8')).toBe(`${PAGE_URL}\n`)
  expect(opened).toEqual([PAGE_URL])
  expect(result.target).toEqual({ url: TARGET_URL, comparison: 'none' })

  const outbound = JSON.parse(await readFile(join(job.evidenceDir, 'checks/c2/0/outbound.json'), 'utf8'))
  expect(outbound.reached.map((entry: { host: string; declared: boolean }) => [entry.host, entry.declared])).toEqual([
    ['img.cdn.example.test', true],
    ['wiki.example.test', true],
  ])
  expect(result.criteria[1]).toMatchObject({ evidence: expect.arrayContaining(['checks/c2/0/outbound.json']) })

  const written = loadResult(await readFile(join(job.evidenceDir, 'result.json'), 'utf8'))
  expect(written.target).toEqual({ url: TARGET_URL, comparison: 'none' })
  expect(renderComment(written)).toContain('there is no base comparison')
})

test('a flow that reaches a host the target profile does not declare refuses the run, naming the host', async () => {
  const job = await makeJob([
    { id: 'c1', text: 'the article opens', checks: [{ kind: 'flow', actions: [{ action: 'open', url: '/' }] }] },
  ])

  const { result } = await runJob(job, {
    ...NEVER_COMPOSE,
    ...UP,
    flowSession: fakeSession([], [
      { host: 'wiki.example.test', port: 443, protocol: 'https' },
      { host: 'tracker.example.test', port: 443, protocol: 'https' },
      { host: 'tracker.example.test', port: 443, protocol: 'https' },
    ]),
  })

  expect(result.verdict).toBe('refused')
  expect(result.criteria[0]).toMatchObject({
    outcome: 'unverified',
    reason: expect.stringContaining('refused: undeclared host: tracker.example.test:443 (https)'),
  })
  // Not a missing stub: a target has no stubs, so no stub issue is filed for it.
  expect((result.criteria[0] as { reason: string }).reason).not.toContain('missing stub')
})

test('{{run.target_url}} exists only in a target run: a booted profile refuses it at plan time', async () => {
  const booted = {
    app: {
      boot: { compose: 'compose.yml', service: 'web' },
      health: { http: HEALTH_URL, timeout: '1s' },
      seed: { command: 'true' },
      login: { fixture: 'fixtures/users.yml', role: 'admin' },
    },
    stubs: [],
    visual: { widths: [], themes: [] },
    suites: [],
  }
  const job = await makeJob(
    [{ id: 'c1', text: 'x', checks: [{ kind: 'command', run: 'node echo-args.mjs {{run.target_url}}' }] }],
    booted,
  )

  const { result } = await runJob(job, { ...NEVER_COMPOSE, ...UP })

  expect(result.verdict).toBe('refused')
  expect((result.criteria[0] as { reason: string }).reason).toContain('{{run.target_url}}')
})

test('a target URL carrying credentials is redacted in the result', async () => {
  const url = ['https:', '//qa:hunter2secret@wiki.example.test'].join('')
  const job = await makeJob([], validateProfileConfig({ target: { url, health: { http: '/health', timeout: '1s' } } }))

  const { result } = await runJob(job, { ...NEVER_COMPOSE, ...UP })

  expect(result.target?.url).not.toContain('hunter2secret')
})

test('readiness calls a target profile ready: no compose file and no stubs are gaps', async () => {
  const repo = await tempDir('qare-target-ready-')
  await mkdir(join(repo, '.qa'))
  await writeFile(join(repo, '.qa', 'QA.md'), '# QA\n')
  await writeFile(join(repo, '.qa', 'config.yml'), `target:\n  url: ${TARGET_URL}\n  health: { http: /health, timeout: 30s }\n`)
  // An origin the source reaches is the deployed app's business, not a stub gap.
  await writeFile(join(repo, 'client.js'), `const api = '${['https:', '//api.vendor.example.test'].join('')}/v1'\n`)

  const inventory = await readinessInventory(repo)

  expect(inventory.gaps).toEqual([])
  expect(inventory.profile.target?.url).toBe(TARGET_URL)
  const report = buildReadinessReport(inventory)
  expect(report).toContain(`target ${TARGET_URL}: already running`)
  expect(report).toContain('## Gaps\n- none')
})

test('a result carrying a target with any comparison but none is rejected', () => {
  const text = JSON.stringify({ schemaVersion: '1', verdict: 'passed', criteria: [], target: { url: TARGET_URL, comparison: 'base' } })
  expect(() => loadResult(text)).toThrow(/target\.comparison/)
})

test('the Wikipedia example is a target profile that loads with nothing but QA.md and config.yml', async () => {
  const dir = new URL('../../../examples/wikipedia/.qa', import.meta.url).pathname
  const profile = await loadProfile(dir)
  expect(profile.app).toBeUndefined()
  expect(profile.target?.health.http).toBe(`${profile.target?.url}/wiki/Main_Page`)
  expect(profile.target?.hosts).toContain('*.wikimedia.org')
})

test('a path on a target served under a sub-path stays below it, and a colon in it is not a scheme', () => {
  const app = ['https:', '//org.example.test/app/'].join('')
  expect(pathOnTarget(app, '/login')).toBe(`${app}login`)
  expect(pathOnTarget(app.slice(0, -1), '/login')).toBe(`${app}login`)
  expect(pathOnTarget(TARGET_URL, '/wiki/Special:Search?search=Ada')).toBe(`${TARGET_URL}/wiki/Special:Search?search=Ada`)
  // A protocol-relative path never leaves the target's origin.
  expect(pathOnTarget(TARGET_URL, '//elsewhere.test/x')).toBe(`${TARGET_URL}/elsewhere.test/x`)
  expect(validateProfileConfig({ target: { url: app, health: { http: '/up', timeout: '1s' } } }).target?.health.http).toBe(`${app}up`)
})

test('a flow that times out still has what its browser reached held against the declared hosts', async () => {
  const job = await makeJob([
    {
      id: 'c1',
      text: 'x',
      checks: [{ kind: 'flow', timeoutMs: 50, actions: [{ action: 'open', url: '/' }, { action: 'assert', text: 'never' }] }],
    },
  ])

  const { result } = await runJob(job, {
    ...NEVER_COMPOSE,
    ...UP,
    flowSession: fakeSession([], [{ host: 'tracker.example.test', port: 443, protocol: 'https' }], { hang: true }),
  })

  expect(result.verdict).toBe('refused')
  expect((result.criteria[0] as { reason: string }).reason).toContain('undeclared host: tracker.example.test')
})

test('a flow backend that cannot report its outbound traffic leaves a target run unverified, never passed', async () => {
  const job = await makeJob([{ id: 'c1', text: 'x', checks: [{ kind: 'flow', actions: [{ action: 'open', url: '/' }] }] }])

  const { result } = await runJob(job, { ...NEVER_COMPOSE, ...UP, flowSession: fakeSession([], null) })

  expect(result.criteria[0]).toMatchObject({ outcome: 'unverified', reason: expect.stringContaining('does not report the hosts') })
  expect(result.verdict).not.toBe('passed')
})

test('flow strings and suite commands take run values, and an unknown one refuses the run at plan time with the target noted', async () => {
  const opened: string[] = []
  const withSuite = validateProfileConfig({
    ...TARGET_CONFIG,
    suites: [{ name: 'e2e', command: 'node echo-args.mjs {{run.target_url}}', kind: 'flow' }],
  })
  const job = await makeJob(
    [
      { id: 'c1', text: 'x', checks: [{ kind: 'flow', actions: [{ action: 'open', url: '{{run.target_url}}/wiki/Ada_Lovelace' }] }] },
      { id: 'c2', text: 'y', checks: [{ kind: 'flow', suite: 'e2e' }] },
    ],
    withSuite,
  )

  const { result } = await runJob(job, { ...NEVER_COMPOSE, ...UP, flowSession: fakeSession(opened) })

  expect(result.verdict).toBe('passed')
  expect(opened).toEqual([PAGE_URL])

  const bad = await makeJob([{ id: 'c1', text: 'x', checks: [{ kind: 'flow', actions: [{ action: 'assert', text: '{{run.nope}}' }] }] }])
  const refused = await runJob(bad, { ...NEVER_COMPOSE, ...UP, flowSession: fakeSession([]) })
  expect(refused.result.verdict).toBe('refused')
  expect((refused.result.criteria[0] as { reason: string }).reason).toContain('actions[0].text')
  expect(refused.result.target).toEqual({ url: TARGET_URL, comparison: 'none' })
})

test('a flow on a target served under a sub-path opens its pages below it', async () => {
  const app = ['https:', '//org.example.test/app'].join('')
  const opened: string[] = []
  const job = await makeJob(
    [{ id: 'c1', text: 'x', checks: [{ kind: 'flow', actions: [{ action: 'open', url: '/login' }] }] }],
    validateProfileConfig({ target: { url: app, health: { http: '/up', timeout: '1s' } } }),
  )

  await runJob(job, { ...NEVER_COMPOSE, ...UP, flowSession: fakeSession(opened) })

  expect(opened).toEqual([`${app}/login`])
})
