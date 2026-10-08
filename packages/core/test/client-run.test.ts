import { execSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { bootApp, loadResult, profileFingerprint, renderComment, runJob, stableStringify, trackLiveCell, type CellRecord, type ClientCell, type FlowPage, type Job, type JobCriterion, type QaProfile } from '../src/index.js'

const SECRET = 'sk-desktop-fixture-123'

const CLIENT_PROFILE: QaProfile = {
  client: { driver: 'electron', executable: 'dist/app/app', args: ['--no-sandbox'] },
  stubs: [],
  visual: { widths: [], themes: [] },
  suites: [],
  redact: { values: [SECRET] },
}

/** The same build, opted out of containment (#223): launched beside the run, as every build was before. */
const UNCONTAINED_PROFILE: QaProfile = { ...CLIENT_PROFILE, client: { driver: 'electron', executable: 'dist/app/app', args: ['--no-sandbox'], egress: 'uncontained' } }

const WITH_DISPLAY = { clientEnv: { env: { DISPLAY: ':99' }, platform: 'linux' as const } }
/** A host that can make a cell (#223): the run's own check of it is stood in. */
const WITH_CELL = { ...WITH_DISPLAY, clientCell: { problem: async () => undefined } }

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

async function clientJob(opts: { checks?: JobCriterion['checks']; build?: boolean; script?: string; profile?: QaProfile } = {}): Promise<Job> {
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
    profile: { inline: opts.profile ?? CLIENT_PROFILE },
    criteria: [{ id: 'greets', text: 'the application greets', checks: opts.checks ?? GREETS }],
    evidenceDir: join(repoPath, 'evidence'),
    post: 'none',
  }
}

function desktopSession(events: string[], reached?: () => CellRecord) {
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
      ...(reached === undefined ? {} : { reached }),
    }
  }
}

test('a client profile runs its flows against the build, one side only, and publishes the application\'s console output swept (#72)', async () => {
  const events: string[] = []
  const job = await clientJob()
  const { result } = await runJob(job, {
    ...WITH_CELL,
    runCompose: async () => {
      events.push('compose')
      return { code: 0, stdout: '', stderr: '' }
    },
    flowSession: desktopSession(events, () => ({ reached: [] })),
  })

  expect(result.verdict).toBe('passed')
  expect(result.criteria).toEqual([
    {
      id: 'greets',
      outcome: 'proven',
      evidence: ['checks/greets/0/actions.log', 'checks/greets/0/final.png', 'checks/greets/0/console.log', 'checks/greets/0/outbound.json'],
    },
  ])
  // The path is the application's own: nothing stands in for a target URL.
  expect(events).toEqual(['open /', 'assert Greeter', 'screenshot', 'dispose', 'console read'])
  const console = await readFile(join(job.evidenceDir, 'checks', 'greets', '0', 'console.log'), 'utf8')
  expect(console).toBe('[main stdout] main: ready\n[main stdout] token [redacted]\n[window 1 opened] file:///app/index.html\n[main exited] code 0\n')
  // Nothing ran at a base revision, and the result says what was driven.
  expect(result.client).toEqual({ driver: 'electron', executable: 'dist/app/app', comparison: 'none', egress: 'contained' })
  expect(result.base).toBeUndefined()
  const loaded = loadResult(await readFile(join(job.evidenceDir, 'result.json'), 'utf8'))
  expect(loaded.client).toEqual(result.client)
  expect(renderComment(loaded)).toContain(
    'Checked against the electron build `dist/app/app`, launched by the run. Nothing ran at a base revision, so there is no base comparison and no regression was looked for.',
  )
})

test('a build that is not there blocks the run, and a host with no display refuses it, by name before any check runs (#72, #76)', async () => {
  const events: string[] = []
  const missing = await clientJob({ build: false })
  const blocked = await runJob(missing, { ...WITH_CELL, flowSession: desktopSession(events) })
  expect(blocked.result.verdict).toBe('blocked')
  expect(blocked.result.criteria[0]).toMatchObject({ outcome: 'unverified' })
  expect(blocked.result.criteria[0]?.reason).toBe(
    `the client build is not there to launch: client.executable dist/app/app resolves to ${join(missing.repoPath, 'dist', 'app', 'app')}, which is not a file; building it is the project's own step, before the run`,
  )

  // The display is this host's to have only when the build runs on it: a contained build's is its cell's.
  // A display is a requirement like any other (#76): a host without one is refused, not found out by a launch.
  const headless = await clientJob({ profile: UNCONTAINED_PROFILE })
  const dark = await runJob(headless, { clientEnv: { env: {}, platform: 'linux', xvfb: () => undefined }, flowSession: desktopSession(events) })
  expect(dark.result.verdict).toBe('refused')
  expect(dark.result.criteria[0]?.reason).toBe(
    'refused: unmet requirement: the electron driver needs a display: neither DISPLAY nor WAYLAND_DISPLAY is set, and no Xvfb is on PATH to start a virtual one (the web image ships it). Nothing was provisioned.',
  )
  expect(dark.result.requirements).toEqual({ display: true })
  expect(events).toEqual([])

  // A path inside the repository that is a link out of it is not the repository's build.
  const linked = await clientJob({ build: false })
  await mkdir(join(linked.repoPath, 'dist', 'app'), { recursive: true })
  await symlink('/bin/sh', join(linked.repoPath, 'dist', 'app', 'app'))
  const escaped = await runJob(linked, { ...WITH_CELL, flowSession: desktopSession(events) })
  expect(escaped.result.verdict).toBe('blocked')
  expect(escaped.result.criteria[0]?.reason).toMatch(/client\.executable dist\/app\/app resolves outside the repository the run checks/)
  expect(events).toEqual([])

  // The boot seam answers the same way for a caller that boots without running.
  expect(await bootApp(CLIENT_PROFILE, { ...WITH_CELL, root: headless.repoPath })).toEqual({ kind: 'up', logs: '' })
  expect((await bootApp(CLIENT_PROFILE, { ...WITH_CELL, root: missing.repoPath })).kind).toBe('blocked')
})

test('what the electron driver cannot do refuses the run before anything is launched (#72)', async () => {
  const events: string[] = []
  const full = ['https:', '//example.test/'].join('')
  const url = await clientJob({ checks: [{ kind: 'flow', actions: [{ action: 'open', url: full }] }] })
  const refused = await runJob(url, { ...WITH_CELL, flowSession: desktopSession(events) })
  expect(refused.result.verdict).toBe('refused')
  expect(refused.result.criteria[0]?.reason).toContain('criteria[0].checks[0].actions[0].url')
  expect(refused.result.criteria[0]?.reason).toContain(`the electron driver opens a path inside the application, not ${JSON.stringify(full)}`)

  const visual = await clientJob({ checks: [{ kind: 'visual', screenshot: 'home', url: '/' }] })
  const unserved = await runJob(visual, { ...WITH_CELL, flowSession: desktopSession(events) })
  expect(unserved.result.verdict).toBe('refused')
  expect(unserved.result.criteria[0]?.reason).toContain('a visual check is not one the electron driver declares, so the plan cannot run against it')

  const a11y = await clientJob({ checks: [{ kind: 'a11y', actions: [{ action: 'open', url: '/' }] }] })
  const unaudited = await runJob(a11y, { ...WITH_CELL, flowSession: desktopSession(events) })
  expect(unaudited.result.criteria[0]?.reason).toContain('a a11y check is not one the electron driver declares')
  expect(events).toEqual([])
})

test('without an injected session the run launches the build itself, and a build that dies at once is unverified with its output (#72)', async () => {
  const job = await clientJob({ profile: UNCONTAINED_PROFILE, script: '#!/bin/sh\necho "main: cannot start" >&2\nexit 3\n' })
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
    const native = await runJob(await clientJob({ script, profile: UNCONTAINED_PROFILE }), { ...WITH_DISPLAY, execution: 'native' })
    const contained = await runJob(await clientJob({ script, profile: UNCONTAINED_PROFILE }), { ...WITH_DISPLAY, execution: 'containerised' })
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
  const { result } = await runJob(job, { ...WITH_CELL, flowSession: desktopSession(events) })
  expect(result.criteria[0]?.outcome).toBe('unverified')
  expect(result.criteria[0]?.reason).toContain('the profile names a client build, which a run launches for one side only; check this app in its own single run')
  expect(events).toEqual([])
})

const DECLARING: QaProfile = { ...CLIENT_PROFILE, client: { driver: 'electron', executable: 'dist/app/app', args: ['--no-sandbox'], hosts: ['api.example.test'] } }

const outboundOf = async (job: Job): Promise<unknown> => JSON.parse(await readFile(join(job.evidenceDir, 'checks', 'greets', '0', 'outbound.json'), 'utf8'))

test('the evidence of a contained client run lists the hosts the build reached (#223)', async () => {
  const job = await clientJob({ profile: DECLARING })
  const reached = [{ host: 'api.example.test', port: 443, protocol: 'https', declared: true, count: 3 }]
  const { result } = await runJob(job, { ...WITH_CELL, flowSession: desktopSession([], () => ({ reached })) })
  expect(result.verdict).toBe('passed')
  expect(result.criteria[0]?.evidence).toContain('checks/greets/0/outbound.json')
  expect(await outboundOf(job)).toEqual({ client: 'dist/app/app', containment: 'cell', declared: ['api.example.test'], reached })
  expect(result.client).toEqual({ driver: 'electron', executable: 'dist/app/app', comparison: 'none', egress: 'contained' })
  expect(renderComment(loadResult(await readFile(join(job.evidenceDir, 'result.json'), 'utf8')))).toContain(
    'The build ran contained, with no network of its own: the hosts it reached through the gate are in each flow check\'s `outbound.json`.',
  )
})

test('a build that reaches for a host its profile does not declare refuses the run, naming the host (#223)', async () => {
  const job = await clientJob({ profile: DECLARING })
  const reached = [
    { host: 'api.example.test', port: 443, protocol: 'https', declared: true, count: 1 },
    { host: 'telemetry.example.test', port: 53, protocol: 'dns', declared: false, count: 2 },
    // What the gate refused is undeclared, whatever the name: a declared host on a port it does not carry.
    { host: 'api.example.test', port: 22, protocol: 'tcp', declared: false, count: 1 },
  ]
  const { result } = await runJob(job, { ...WITH_CELL, flowSession: desktopSession([], () => ({ reached })) })
  // The flow itself passed; the run is refused all the same, as a missing stub refuses one.
  expect(result.verdict).toBe('refused')
  expect(result.criteria[0]?.outcome).toBe('unverified')
  expect(result.criteria[0]?.reason).toBe(
    'refused: undeclared host: telemetry.example.test:53 (dns), api.example.test:22 (tcp); the client profile does not list it in client.hosts',
  )
  // The record is in the check's evidence however the check ended; an unverified
  // criterion lists no files, as on a target run, so the file is read where it lies.
  expect(await outboundOf(job)).toMatchObject({ containment: 'cell', reached })
})

test('what a build reached is recorded however its flow ended, a timeout included (#223)', async () => {
  const job = await clientJob({ profile: DECLARING, checks: [{ kind: 'flow', timeoutMs: 50, actions: [{ action: 'open', url: '/' }, { action: 'waitFor', element: { testId: 'never' } }] }] })
  const session = desktopSession([], () => ({ reached: [{ host: 'telemetry.example.test', port: 443, protocol: 'https', declared: false, count: 1 }] }))
  const hanging: typeof session = async () => {
    const started = await session()
    return { ...started, page: { ...started.page, waitFor: () => new Promise(() => {}) } }
  }
  const { result } = await runJob(job, { ...WITH_CELL, flowSession: hanging })
  expect(result.verdict).toBe('refused')
  expect(result.criteria[0]?.reason).toMatch(/^refused: undeclared host: telemetry\.example\.test:443 \(https\)/)
  expect(await outboundOf(job)).toMatchObject({ containment: 'cell' })
})

test('a host that cannot contain a client build refuses the run by name, and launches nothing (#223, #76)', async () => {
  const events: string[] = []
  const job = await clientJob()
  const reason = 'a contained build or command runs in a cell the docker daemon makes, and no daemon answered (docker exited 127)'
  const { result } = await runJob(job, { ...WITH_DISPLAY, clientCell: { problem: async () => reason }, flowSession: desktopSession(events, () => ({ reached: [] })) })
  // The cell is a requirement of the host like any other (#76): unmet, the run is refused before anything is provisioned.
  expect(result.verdict).toBe('refused')
  expect(result.criteria[0]).toMatchObject({ outcome: 'unverified', reason: `refused: unmet requirement: ${reason}. Nothing was provisioned.` })
  expect(result.requirements).toEqual({ cell: true })
  expect(events).toEqual([])
  // With nothing stood in, the run asks the host itself: this one names no image to make a cell from.
  const saved = process.env.QARE_IMAGE_REF
  delete process.env.QARE_IMAGE_REF
  try {
    const asked = await runJob(await clientJob(), { ...WITH_DISPLAY, flowSession: desktopSession(events, () => ({ reached: [] })) })
    expect(asked.result.verdict).toBe('refused')
    expect(asked.result.criteria[0]?.reason).toMatch(/^refused: unmet requirement: .*QARE_IMAGE_REF names none.*client\.egress: uncontained/)
  } finally {
    if (saved !== undefined) process.env.QARE_IMAGE_REF = saved
  }
})

test('a contained run that cannot say what its build reached is unverified, never passed (#223)', async () => {
  // A backend with no record to give.
  const silent = await runJob(await clientJob(), { ...WITH_CELL, flowSession: desktopSession([]) })
  expect(silent.result.verdict).toBe('blocked')
  expect(silent.result.criteria[0]?.reason).toBe('the flow backend does not report what the build reached, so a contained client run cannot vouch for it')

  // A record that never came back from the gate.
  const lostJob = await clientJob()
  const lost = await runJob(lostJob, {
    ...WITH_CELL,
    flowSession: desktopSession([], () => {
      throw new Error('the gate stopped (code 137) without writing its record, so what the build reached is not known')
    }),
  })
  expect(lost.result.verdict).toBe('blocked')
  expect(lost.result.criteria[0]?.reason).toBe('the gate stopped (code 137) without writing its record, so what the build reached is not known')
  expect(existsSync(join(lostJob.evidenceDir, 'checks', 'greets', '0', 'outbound.json'))).toBe(false)

  // A record that was cut.
  const cutJob = await clientJob()
  const incomplete = 'the build reached for more distinct destinations than the gate records, so the record was cut'
  const cut = await runJob(cutJob, { ...WITH_CELL, flowSession: desktopSession([], () => ({ reached: [], incomplete })) })
  expect(cut.result.verdict).toBe('blocked')
  expect(cut.result.criteria[0]?.reason).toBe(incomplete)
  expect(await outboundOf(cutJob)).toMatchObject({ containment: 'cell', incomplete })
})

test('a profile that opts out runs its build uncontained, and the evidence says so (#223)', async () => {
  const events: string[] = []
  const job = await clientJob({ profile: UNCONTAINED_PROFILE })
  const { result } = await runJob(job, {
    ...WITH_DISPLAY,
    clientCell: {
      problem: async () => {
        throw new Error('an uncontained run asked whether a cell can be made')
      },
    },
    flowSession: desktopSession(events),
  })
  expect(result.verdict).toBe('passed')
  expect(result.client).toEqual({ driver: 'electron', executable: 'dist/app/app', comparison: 'none', egress: 'uncontained' })
  expect(result.criteria[0]?.evidence).toContain('checks/greets/0/outbound.json')
  expect(await outboundOf(job)).toEqual({
    client: 'dist/app/app',
    containment: 'none',
    reason: 'the profile opts out with client.egress: uncontained, so the build ran with the network its step has and what it reached was not recorded',
  })
  expect(renderComment(loadResult(await readFile(join(job.evidenceDir, 'result.json'), 'utf8')))).toContain(
    'The build was not contained (`client.egress: uncontained`): it ran with the network its step had, and what it reached was not recorded.',
  )
})

test('without an injected session a contained run makes a cell for each launch, from the profile\'s hosts (#223)', async () => {
  const asked: Array<{ repoPath: string; hosts: readonly string[]; install?: string }> = []
  const job = await clientJob({ profile: DECLARING })
  const { result } = await runJob(job, {
    ...WITH_DISPLAY,
    clientCell: {
      problem: async () => undefined,
      start: async (opts): Promise<ClientCell> => {
        asked.push(opts)
        throw new Error('the cell could not be made: the gate was not ready in time')
      },
    },
  })
  expect(result.criteria[0]?.outcome).toBe('unverified')
  expect(result.criteria[0]?.reason).toMatch(/the flow backend did not start: (the cell could not be made: the gate was not ready in time|playwright-core is not installed)/)
  if (!(result.criteria[0]?.reason ?? '').includes('playwright-core')) expect(asked).toEqual([{ repoPath: job.repoPath, hosts: ['api.example.test'], install: join(realpathSync(job.repoPath), 'dist', 'app') }])
})

test('a refusal for an undeclared host is decided by every run: a cached result never stands in for the gate (#223)', async () => {
  const job = await clientJob({ profile: DECLARING })
  execSync('git init -q && git add -A && git -c user.name=t -c user.email=t@example.test commit -q -m build', { cwd: job.repoPath })
  const cached = { ...job, baseRef: 'HEAD', headRef: 'HEAD' }
  let launches = 0
  const session = desktopSession([], () => ({ reached: [{ host: 'telemetry.example.test', port: 53, protocol: 'dns', declared: false, count: 1 }] }))
  const counting: typeof session = async () => {
    launches += 1
    return session()
  }
  const cacheDir = join(job.repoPath, '..', `${job.id}-cache-${Date.now()}`)
  const first = await runJob(cached, { ...WITH_CELL, flowSession: counting, cacheDir })
  const second = await runJob({ ...cached, evidenceDir: join(job.repoPath, 'evidence-2') }, { ...WITH_CELL, flowSession: counting, cacheDir })
  expect(first.result.verdict).toBe('refused')
  // The second run launched the build again and was refused again, by its own gate.
  expect(launches).toBe(2)
  expect(second.result.verdict).toBe('refused')
  expect(second.result.criteria[0]?.reason).toBe(first.result.criteria[0]?.reason)
})

test('a result cached before builds were contained is not one a contained run replays (#223)', () => {
  // The fingerprint of a client profile carries the containment it was run under,
  // so an entry written without a gate's record cannot satisfy a run that needs one.
  const plain = (profile: QaProfile): string => profileFingerprint({ ...profile, client: undefined } as QaProfile)
  expect(profileFingerprint(CLIENT_PROFILE)).not.toBe(profileFingerprint({ stubs: [], visual: { widths: [], themes: [] }, suites: [] }))
  expect(stableStringify(CLIENT_PROFILE)).not.toContain('client-egress-cell')
  // Beside the marker every profile carries for how its command checks are contained (#286).
  expect(profileFingerprint(CLIENT_PROFILE, (text) => text)).toBe(`client-egress-cell-v1:command-egress-cell-v2:${stableStringify(CLIENT_PROFILE)}`)
  // A profile with no client carries no client marker.
  const booted: QaProfile = { stubs: [], visual: { widths: [], themes: [] }, suites: [] }
  expect(profileFingerprint(booted, (text) => text)).toBe(`command-egress-cell-v2:${stableStringify(booted)}`)
  void plain
})

test('a cancelled run takes its cells with it before the process ends (#223)', async () => {
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  const reaped: string[] = []
  let release: () => void = () => {}
  let inFlight: () => void = () => {}
  const started = new Promise<void>((resolve) => (inFlight = resolve))
  const job = await clientJob()
  const running = runJob(job, {
    ...WITH_CELL,
    // The run is held inside its first check, with a cell made.
    flowSession: async () => {
      const untrack = trackLiveCell(() => reaped.push('cell reaped'))
      inFlight()
      await new Promise<void>((resolve) => (release = resolve))
      untrack()
      throw new Error('cancelled')
    },
  })
  try {
    await started
    process.emit('SIGINT')
    expect(reaped).toEqual(['cell reaped'])
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(4))
  } finally {
    release()
    await running.catch(() => {})
    exit.mockRestore()
  }
})
