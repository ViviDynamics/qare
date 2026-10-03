import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { bootApp, loadResult, renderComment, runJob, type FlowPage, type Job, type JobCriterion, type QaProfile } from '../src/index.js'

const SECRET = 'sk-desktop-fixture-123'

const CLIENT_PROFILE: QaProfile = {
  client: { driver: 'electron', executable: 'dist/app/app', args: ['--no-sandbox'] },
  stubs: [],
  visual: { widths: [], themes: [] },
  suites: [],
  redact: { values: [SECRET] },
}

const WITH_DISPLAY = { clientEnv: { env: { DISPLAY: ':99' }, platform: 'linux' as const } }

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

const GREETS: JobCriterion['checks'] = [
  {
    kind: 'flow',
    actions: [
      { action: 'open', url: '/' },
      { action: 'assertText', text: 'Greeter' },
    ],
  },
]

async function clientJob(opts: { checks?: JobCriterion['checks']; build?: boolean; script?: string } = {}): Promise<Job> {
  const repoPath = await mkdtemp(join(tmpdir(), 'qare-client-run-'))
  if (opts.build !== false) {
    await mkdir(join(repoPath, 'dist', 'app'), { recursive: true })
    await writeFile(join(repoPath, 'dist', 'app', 'app'), opts.script ?? '#!/bin/sh\nexit 0\n')
    await chmod(join(repoPath, 'dist', 'app', 'app'), 0o755)
  }
  return {
    id: 'job-client-run',
    repoPath,
    baseRef: 'main',
    headRef: 'HEAD',
    profile: { inline: CLIENT_PROFILE },
    criteria: [{ id: 'greets', text: 'the application greets', checks: opts.checks ?? GREETS }],
    evidenceDir: join(repoPath, 'evidence'),
    post: 'none',
  }
}

function desktopSession(events: string[]) {
  const lines = ['[main stdout] main: ready', `[main stdout] token ${SECRET}`, '[window 1 opened] file:///app/index.html']
  return async () => {
    const page: FlowPage = {
      open: async (url) => events.push(`open ${url}`),
      click: async () => events.push('click'),
      type: async () => events.push('type'),
      choose: async () => events.push('choose'),
      waitFor: async () => events.push('waitFor'),
      assertText: async (text) => events.push(`assert ${text}`),
      assertElement: async () => events.push('assertElement'),
      screenshot: async (path) => {
        await writeFile(path, PNG_1X1)
        events.push('screenshot')
      },
    }
    return {
      page,
      dispose: async () => {
        events.push('dispose')
        // What the application writes on its way out is part of its output.
        lines.push('[main exited] code 0')
      },
      console: () => {
        events.push('console read')
        return [...lines]
      },
    }
  }
}

test('a client profile runs its flows against the build, one side only, and publishes the application\'s console output swept (#72)', async () => {
  const events: string[] = []
  const job = await clientJob()
  const { result } = await runJob(job, {
    ...WITH_DISPLAY,
    runCompose: async () => {
      events.push('compose')
      return { code: 0, stdout: '', stderr: '' }
    },
    flowSession: desktopSession(events),
  })

  expect(result.verdict).toBe('passed')
  expect(result.criteria).toEqual([
    {
      id: 'greets',
      outcome: 'proven',
      evidence: ['checks/greets/0/actions.log', 'checks/greets/0/final.png', 'checks/greets/0/console.log'],
    },
  ])
  // The path is the application's own: nothing stands in for a target URL.
  expect(events).toEqual(['open /', 'assert Greeter', 'screenshot', 'dispose', 'console read'])
  const console = await readFile(join(job.evidenceDir, 'checks', 'greets', '0', 'console.log'), 'utf8')
  expect(console).toBe('[main stdout] main: ready\n[main stdout] token [redacted]\n[window 1 opened] file:///app/index.html\n[main exited] code 0\n')
  // Nothing ran at a base revision, and the result says what was driven.
  expect(result.client).toEqual({ driver: 'electron', executable: 'dist/app/app', comparison: 'none' })
  expect(result.base).toBeUndefined()
  const loaded = loadResult(await readFile(join(job.evidenceDir, 'result.json'), 'utf8'))
  expect(loaded.client).toEqual(result.client)
  expect(renderComment(loaded)).toContain(
    'Checked against the electron build `dist/app/app`, launched by the run. Nothing ran at a base revision, so there is no base comparison and no regression was looked for.',
  )
})

test('a build that is not there, or a host with no display, blocks the run by name before any check runs (#72)', async () => {
  const events: string[] = []
  const missing = await clientJob({ build: false })
  const blocked = await runJob(missing, { ...WITH_DISPLAY, flowSession: desktopSession(events) })
  expect(blocked.result.verdict).toBe('blocked')
  expect(blocked.result.criteria[0]).toMatchObject({ outcome: 'unverified' })
  expect(blocked.result.criteria[0]?.reason).toBe(
    `the client build is not there to launch: client.executable dist/app/app resolves to ${join(missing.repoPath, 'dist', 'app', 'app')}, which is not a file; building it is the project's own step, before the run`,
  )

  const headless = await clientJob()
  const dark = await runJob(headless, { clientEnv: { env: {}, platform: 'linux', xvfb: () => undefined }, flowSession: desktopSession(events) })
  expect(dark.result.verdict).toBe('blocked')
  expect(dark.result.criteria[0]?.reason).toMatch(/the electron driver needs a display/)
  expect(events).toEqual([])

  // The boot seam answers the same way for a caller that boots without running.
  expect(await bootApp(CLIENT_PROFILE, { ...WITH_DISPLAY, root: headless.repoPath })).toEqual({ kind: 'up', logs: '' })
  expect((await bootApp(CLIENT_PROFILE, { ...WITH_DISPLAY, root: missing.repoPath })).kind).toBe('blocked')
})

test('what the electron driver cannot do refuses the run before anything is launched (#72)', async () => {
  const events: string[] = []
  const full = ['https:', '//example.test/'].join('')
  const url = await clientJob({ checks: [{ kind: 'flow', actions: [{ action: 'open', url: full }] }] })
  const refused = await runJob(url, { ...WITH_DISPLAY, flowSession: desktopSession(events) })
  expect(refused.result.verdict).toBe('refused')
  expect(refused.result.criteria[0]?.reason).toContain('criteria[0].checks[0].actions[0].url')
  expect(refused.result.criteria[0]?.reason).toContain(`the electron driver opens a path inside the application, not ${JSON.stringify(full)}`)

  const visual = await clientJob({ checks: [{ kind: 'visual', screenshot: 'home', url: '/' }] })
  const unserved = await runJob(visual, { ...WITH_DISPLAY, flowSession: desktopSession(events) })
  expect(unserved.result.verdict).toBe('refused')
  expect(unserved.result.criteria[0]?.reason).toContain('a visual check is not one the electron driver declares, so the plan cannot run against it')

  const a11y = await clientJob({ checks: [{ kind: 'a11y', actions: [{ action: 'open', url: '/' }] }] })
  const unaudited = await runJob(a11y, { ...WITH_DISPLAY, flowSession: desktopSession(events) })
  expect(unaudited.result.criteria[0]?.reason).toContain('a a11y check is not one the electron driver declares')
  expect(events).toEqual([])
})

test('without an injected session the run launches the build itself, and a build that dies at once is unverified with its output (#72)', async () => {
  const job = await clientJob({ script: '#!/bin/sh\necho "main: cannot start" >&2\nexit 3\n' })
  const { result } = await runJob(job, WITH_DISPLAY)
  expect(result.verdict).not.toBe('failed')
  expect(result.criteria[0]?.outcome).toBe('unverified')
  expect(result.criteria[0]?.reason).toMatch(
    /the flow backend did not start: (the application exited with code 3 before the driver could attach; its output: \[main stderr\] main: cannot start|playwright-core is not installed)/,
  )
  expect(existsSync(join(job.evidenceDir, 'result.json'))).toBe(true)
})

test('a run on a host launches the build without the host\'s environment; a run in an image inherits the image\'s (#72, #91)', async () => {
  // The build reports whether it can see a variable the harness holds.
  const script = '#!/bin/sh\nif [ -n "$QARE_TEST_HOST_TOKEN" ]; then echo "sees the token" >&2; else echo "sees no token" >&2; fi\nexit 3\n'
  process.env.QARE_TEST_HOST_TOKEN = 'held-by-the-harness'
  try {
    const native = await runJob(await clientJob({ script }), { ...WITH_DISPLAY, execution: 'native' })
    const contained = await runJob(await clientJob({ script }), { ...WITH_DISPLAY, execution: 'containerised' })
    const reason = (result: typeof native): string => result.result.criteria[0]?.reason ?? ''
    if (!reason(native).includes('playwright-core is not installed')) {
      expect(reason(native)).toContain('[main stderr] sees no token')
      expect(reason(contained)).toContain('[main stderr] sees the token')
    }
  } finally {
    delete process.env.QARE_TEST_HOST_TOKEN
  }
})

test('a run over several apps refuses a client profile, which has one side and one build (#72)', async () => {
  const events: string[] = []
  const single = await clientJob()
  const { profile: _profile, criteria, ...rest } = single
  void _profile
  const job = { ...rest, profiles: [{ name: 'desktop', profile: { inline: CLIENT_PROFILE }, criteria }] } as unknown as Job
  const { result } = await runJob(job, { ...WITH_DISPLAY, flowSession: desktopSession(events) })
  expect(result.criteria[0]?.outcome).toBe('unverified')
  expect(result.criteria[0]?.reason).toContain('the profile names a client build, which a run launches for one side only; check this app in its own single run')
  expect(events).toEqual([])
})
