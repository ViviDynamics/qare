import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { bootApp, installCancelCleanup, loadResult, renderComment, runJob, type ClientHealthCheck, type FlowPage, type Job, type JobCriterion, type QaProfile, type RunJobOpts } from '../src/index.js'

const SECRET = 'sk-desktop-fixture-456'

const WITH_DISPLAY = { clientEnv: { env: { DISPLAY: ':99' }, platform: 'linux' as const } }

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

function profileOf(artefact: Record<string, unknown> = {}, extra: Partial<QaProfile> = {}): QaProfile {
  return {
    client: {
      driver: 'electron',
      args: ['--no-sandbox'],
      artefact: { kind: 'archive', executable: 'greeter/greeter', head: { path: 'artefacts/head.tar.gz' }, ...artefact },
    },
    stubs: [],
    visual: { widths: [], themes: [] },
    suites: [],
    redact: { values: [SECRET] },
    ...extra,
  }
}

const GREETS: JobCriterion['checks'] = [
  {
    kind: 'flow',
    actions: [
      { action: 'open', url: '/' },
      { action: 'assertText', text: 'Good evening, Ada.' },
    ],
  },
]

/**
 * A repository whose pipeline already left two builds of the greeter in it:
 * the base build greets, and the head build is whatever `head` says it shows.
 * Each build is an archive holding a script named `greeter/greeter` and the
 * text its window shows, which the fake session reads from the install.
 */
async function workspace(opts: { profile?: QaProfile; head?: string; base?: string | false; corruptHead?: boolean } = {}): Promise<{ job: Job; installRoot: string; repoPath: string }> {
  const repoPath = await mkdtemp(join(tmpdir(), 'qare-client-provision-'))
  const installRoot = await mkdtemp(join(tmpdir(), 'qare-client-installs-'))
  await mkdir(join(repoPath, 'artefacts'))
  const pack = async (side: string, shows: string): Promise<void> => {
    const build = await mkdtemp(join(tmpdir(), 'qare-client-build-'))
    await mkdir(join(build, 'greeter'))
    await writeFile(join(build, 'greeter', 'greeter'), '#!/bin/sh\nexit 0\n')
    await chmod(join(build, 'greeter', 'greeter'), 0o755)
    await writeFile(join(build, 'greeter', 'shows.txt'), shows)
    execFileSync('tar', ['-czf', join(repoPath, 'artefacts', `${side}.tar.gz`), '-C', build, 'greeter'])
  }
  if (opts.corruptHead === true) await writeFile(join(repoPath, 'artefacts', 'head.tar.gz'), `not an archive ${SECRET}\n`)
  else await pack('head', opts.head ?? 'Good evening, Ada.')
  if (opts.base !== false) await pack('base', opts.base ?? 'Good evening, Ada.')
  return {
    repoPath,
    installRoot,
    job: {
      id: 'job-client-provision',
      repoPath,
      baseRef: 'main',
      headRef: 'HEAD',
      profile: { inline: opts.profile ?? profileOf() },
      criteria: [{ id: 'greets', text: 'the application greets', checks: GREETS }],
      evidenceDir: join(repoPath, 'evidence'),
      post: 'none',
    },
  }
}

const UP: ClientHealthCheck = async () => ({ ok: true, lines: ['[window 1 opened] file:///app/index.html'] })

/**
 * A session that drives whichever build the run installed: it reads the text
 * the build shows from beside the executable the run hands the driver.
 */
function installedSession(events: string[], launched: string[]): NonNullable<RunJobOpts['clientSession']> {
  return (executable) => async () => {
    launched.push(executable)
    const shows = await readFile(join(executable, '..', 'shows.txt'), 'utf8')
    const page: FlowPage = {
      open: async (url) => events.push(`open ${url}`),
      click: async () => {},
      type: async () => {},
      choose: async () => {},
      waitFor: async () => {},
      assertText: async (text) => {
        events.push(`assert ${text}`)
        if (!shows.includes(text)) throw new Error(`assert failed: the text ${JSON.stringify(text)} is not visible in any open window`)
      },
      assertElement: async () => {},
      screenshot: async (path) => {
        await writeFile(path, PNG_1X1)
      },
    }
    return { page, dispose: async () => {}, console: () => [`[main stdout] shows ${shows}`] }
  }
}

test('bootApp provisions a client artefact and says what to launch; the install is the outcome\'s to tear down (#75)', async () => {
  const { job, installRoot, repoPath } = await workspace()
  const boot = await bootApp(profileOf(), { ...WITH_DISPLAY, root: repoPath, provision: { installRoot, health: UP } })
  expect(boot.kind).toBe('up')
  expect(boot.client?.executable.startsWith(installRoot)).toBe(true)
  expect(boot.client?.artefact).toMatchObject({ side: 'head', path: 'artefacts/head.tar.gz', source: 'prebuilt' })
  expect(boot.logs).toContain('provisioning the head side from artefacts/head.tar.gz (archive)')
  expect(readdirSync(installRoot)).toHaveLength(1)
  expect(await boot.client?.teardown()).toEqual({ ok: true })
  expect(readdirSync(installRoot)).toEqual([])
  expect(boot.client?.log()).toContain('[teardown] removed')
  void job
})

test('bootApp provisions the side it is asked for, and blocks with the log when it cannot (#75)', async () => {
  const { installRoot, repoPath } = await workspace({ base: false })
  const two = profileOf({ base: { path: 'artefacts/base.tar.gz' } })
  const base = await bootApp(two, { ...WITH_DISPLAY, root: repoPath, side: 'base', provision: { installRoot, health: UP } })
  expect(base.kind).toBe('blocked')
  expect(base.reason).toMatch(/^the base artefact artefacts\/base\.tar\.gz is not there to install/)
  expect(base.logs).toContain('[blocked] the base artefact artefacts/base.tar.gz is not there to install')
  expect(base.client).toBeUndefined()
  expect(readdirSync(installRoot)).toEqual([])
})

test('a profile that names an executable in the checkout is launched in place, and is health checked only when it asks (#72, #75)', async () => {
  const repoPath = await mkdtemp(join(tmpdir(), 'qare-client-legacy-'))
  await mkdir(join(repoPath, 'dist', 'app'), { recursive: true })
  await writeFile(join(repoPath, 'dist', 'app', 'app'), '#!/bin/sh\nexit 0\n')
  await chmod(join(repoPath, 'dist', 'app', 'app'), 0o755)
  const legacy: QaProfile = { client: { driver: 'electron', executable: 'dist/app/app', args: [] }, stubs: [], visual: { widths: [], themes: [] }, suites: [] }
  let asked = 0
  const health: ClientHealthCheck = async () => {
    asked += 1
    return { ok: false, reason: 'the application opened no window within 5000 ms', lines: ['[main stderr] no window'] }
  }
  const plain = await bootApp(legacy, { ...WITH_DISPLAY, root: repoPath, provision: { health } })
  // Nothing was installed, so there is nothing to tear down: the outcome is the #72 one.
  expect(plain).toEqual({ kind: 'up', logs: '' })
  expect(asked).toBe(0)
  expect(existsSync(join(repoPath, 'dist', 'app', 'app'))).toBe(true)

  const checked = await bootApp({ ...legacy, client: { ...legacy.client!, health: { timeout: '5s' } } }, { ...WITH_DISPLAY, root: repoPath, provision: { health } })
  expect(asked).toBe(1)
  expect(checked.kind).toBe('blocked')
  expect(checked.reason).toBe('the client build dist/app/app is there, but it did not come up within 5s: the application opened no window within 5000 ms')
  expect(checked.logs).toContain('[health] [main stderr] no window')
})

test('a run installs the head artefact, drives the installed build, publishes the provisioning log swept, and leaves nothing installed (#75)', async () => {
  const { job, installRoot } = await workspace()
  const events: string[] = []
  const launched: string[] = []
  const { result } = await runJob(job, {
    ...WITH_DISPLAY,
    provision: { installRoot, health: async () => ({ ok: true, lines: [`[main stdout] token ${SECRET}`, '[window 1 opened] file:///app/index.html'] }) },
    clientSession: installedSession(events, launched),
  })

  expect(result.verdict).toBe('passed')
  expect(result.criteria[0]).toMatchObject({ id: 'greets', outcome: 'proven' })
  // The build the flows drove is the one the run installed, not a path in the checkout.
  expect(launched).toHaveLength(1)
  expect(launched[0]?.startsWith(installRoot)).toBe(true)
  expect(events).toEqual(['open /', 'assert Good evening, Ada.'])
  // One side, and the result names what was provisioned.
  expect(result.client).toMatchObject({
    driver: 'electron',
    executable: 'greeter/greeter',
    comparison: 'none',
    artefact: { path: 'artefacts/head.tar.gz', kind: 'archive', source: 'prebuilt' },
  })
  expect(result.client?.artefact?.sha256).toMatch(/^[0-9a-f]{64}$/)
  expect(result.base).toBeUndefined()
  const loaded = loadResult(await readFile(join(job.evidenceDir, 'result.json'), 'utf8'))
  expect(loaded.client).toEqual(result.client)
  expect(renderComment(loaded)).toContain('Checked against the electron build `greeter/greeter`, installed by the run from `artefacts/head.tar.gz`')

  const log = await readFile(join(job.evidenceDir, 'provision.log'), 'utf8')
  expect(log).toContain('provisioning the head side from artefacts/head.tar.gz (archive)')
  expect(log).toContain('[health] [main stdout] token [redacted]')
  expect(log).not.toContain(SECRET)
  expect(log).toMatch(/\[teardown\] removed .*; nothing is left/)
  expect(readdirSync(installRoot)).toEqual([])
})

test('a failed install is blocked naming the artefact, with the log attached, and no criterion is failed (#75)', async () => {
  const { job, installRoot } = await workspace({ corruptHead: true })
  const launched: string[] = []
  const { result } = await runJob(job, { ...WITH_DISPLAY, provision: { installRoot, health: UP }, clientSession: installedSession([], launched) })

  expect(result.verdict).toBe('blocked')
  expect(result.criteria).toHaveLength(1)
  const criterion = result.criteria[0]!
  expect(criterion.outcome).toBe('unverified')
  expect(criterion.outcome === 'unverified' && criterion.reason).toMatch(/^the head artefact artefacts\/head\.tar\.gz could not be installed: tar exited \d+/)
  expect(criterion.evidence).toEqual(['provision.log'])
  expect(result.criteria.some((entry) => entry.outcome === 'failed')).toBe(false)
  // What the run got as far as obtaining is still named.
  expect(result.client).toMatchObject({ artefact: { path: 'artefacts/head.tar.gz', source: 'prebuilt' } })
  const log = await readFile(join(job.evidenceDir, 'provision.log'), 'utf8')
  expect(log).toMatch(/\[install\] tar: /)
  expect(log).toContain('[blocked] the head artefact artefacts/head.tar.gz could not be installed')
  expect(launched).toEqual([])
  expect(readdirSync(installRoot)).toEqual([])
  // The comment names the log beside the reason, and does not say a build
  // that was never installed was checked.
  const comment = renderComment(loadResult(await readFile(join(job.evidenceDir, 'result.json'), 'utf8')))
  expect(comment).toContain('provision.log')
  expect(comment).not.toContain('Checked against')
  expect(comment).toContain('The electron build `greeter/greeter` was to be installed from `artefacts/head.tar.gz`')
  expect(comment).toContain('provisioning stopped before any check ran')
})

const TWO_SIDES = profileOf({ base: { path: 'artefacts/base.tar.gz' } })

/** A base checkout nobody should need: a prebuilt base artefact is installed, never rebuilt. */
const NO_CHECKOUT = {
  checkout: async () => {
    throw new Error('a prebuilt base artefact needs no checkout of the base')
  },
}

test('a run consumes prebuilt artefacts for base and head and provisions both, with no checkout of the base (#75)', async () => {
  const { job, installRoot } = await workspace({ profile: TWO_SIDES })
  const launched: string[] = []
  const { result } = await runJob(job, {
    ...WITH_DISPLAY,
    provision: { installRoot, health: UP },
    clientSession: installedSession([], launched),
    base: NO_CHECKOUT,
  })

  expect(result.verdict).toBe('passed')
  expect(result.base).toEqual({ ref: 'main', status: 'executed' })
  expect(result.criteria[0]).toMatchObject({ id: 'greets', outcome: 'proven', base: { outcome: 'proven' } })
  // Two installs, the base first, each in a directory of its own, both gone.
  expect(launched).toHaveLength(2)
  expect(launched[0]).toContain('qare-install-base-')
  expect(launched[1]).toContain('qare-install-head-')
  expect(readdirSync(installRoot)).toEqual([])
  // The result names what each side was provisioned from.
  expect(result.client).toMatchObject({
    comparison: 'base',
    artefact: { path: 'artefacts/head.tar.gz', source: 'prebuilt' },
    base: { path: 'artefacts/base.tar.gz', source: 'prebuilt' },
  })
  expect(result.client?.base?.sha256).toMatch(/^[0-9a-f]{64}$/)
  // Each side keeps its own evidence and its own provisioning log.
  const baseLog = await readFile(join(job.evidenceDir, 'base', 'provision.log'), 'utf8')
  const headLog = await readFile(join(job.evidenceDir, 'head', 'provision.log'), 'utf8')
  expect(baseLog).toContain('provisioning the base side from artefacts/base.tar.gz (archive)')
  expect(baseLog).toMatch(/\[teardown\] removed/)
  expect(headLog).toContain('provisioning the head side from artefacts/head.tar.gz (archive)')
  expect(result.criteria[0]?.evidence?.[0]).toBe('head/checks/greets/0/actions.log')
  const loaded = loadResult(await readFile(join(job.evidenceDir, 'result.json'), 'utf8'))
  expect(loaded.client).toEqual(result.client)
  const comment = renderComment(loaded)
  expect(comment).toContain('The plan ran on both sides')
  expect(comment).toContain('The base side is the build installed from `artefacts/base.tar.gz`')
  expect(comment).not.toContain('Nothing ran at a base revision')
})

test('a criterion the base build proves and the head build fails is a regression (#75)', async () => {
  const { job, installRoot } = await workspace({ profile: TWO_SIDES, head: 'Good morning, Ada.' })
  const { result } = await runJob(job, { ...WITH_DISPLAY, provision: { installRoot, health: UP }, clientSession: installedSession([], []), base: NO_CHECKOUT })
  expect(result.verdict).toBe('failed')
  expect(result.criteria[0]).toMatchObject({ id: 'greets', outcome: 'failed', regression: true, base: { outcome: 'proven' } })
  // A criterion that fails on both builds is behaviour that does not work yet, not a regression.
  const both = await workspace({ profile: TWO_SIDES, head: 'Good morning, Ada.', base: 'Good morning, Ada.' })
  const never = await runJob(both.job, { ...WITH_DISPLAY, provision: { installRoot: both.installRoot, health: UP }, clientSession: installedSession([], []), base: NO_CHECKOUT })
  expect(never.result.criteria[0]).toMatchObject({ outcome: 'failed', regression: false, base: { outcome: 'failed' } })
})

test('a base artefact that cannot be provisioned never blocks the head: the base is not executed, naming the artefact, with its log kept (#75)', async () => {
  const { job, installRoot } = await workspace({ profile: TWO_SIDES, base: false })
  const { result } = await runJob(job, { ...WITH_DISPLAY, provision: { installRoot, health: UP }, clientSession: installedSession([], []), base: NO_CHECKOUT })
  expect(result.verdict).toBe('passed')
  expect(result.base?.status).toBe('not-executed')
  expect(result.base?.reason).toMatch(/^the base artefact artefacts\/base\.tar\.gz is not there to install/)
  expect(result.criteria[0]).toMatchObject({ outcome: 'proven', base: { outcome: 'not-compared', evidence: ['base/provision.log'] } })
  expect(result.criteria[0]?.base?.reason).toMatch(/^the base side did not run: the base artefact artefacts\/base\.tar\.gz is not there to install/)
  // One side ran, and the result does not claim a comparison.
  expect(result.client?.comparison).toBe('none')
  expect(result.client?.base).toBeUndefined()
  expect(await readFile(join(job.evidenceDir, 'base', 'provision.log'), 'utf8')).toContain('[blocked] the base artefact artefacts/base.tar.gz is not there to install')
  expect(readdirSync(installRoot)).toEqual([])
})

test('a base artefact that is not there is built in a checkout of the base, by the command the profile declares (#75)', async () => {
  const profile = profileOf({ base: { path: 'artefacts/base.tar.gz', build: 'node scripts/package.mjs' } })
  const { job, installRoot, repoPath } = await workspace({ profile, base: false })
  const baseTree = await mkdtemp(join(tmpdir(), 'qare-client-base-tree-'))
  const built: Array<{ cwd: string; artefact?: string }> = []
  let disposed = false
  const { result } = await runJob(job, {
    ...WITH_DISPLAY,
    provision: {
      installRoot,
      health: UP,
      runCommand: async (command, args, run) => {
        if (command === 'tar') {
          execFileSync('tar', args)
          return { code: 0, output: '' }
        }
        built.push({ cwd: run.cwd, artefact: run.env.QARE_ARTEFACT })
        execFileSync('cp', [join(repoPath, 'artefacts', 'head.tar.gz'), join(repoPath, 'artefacts', 'base.tar.gz')])
        return { code: 0, output: 'packaged the base\n' }
      },
    },
    clientSession: installedSession([], []),
    base: {
      checkout: async () => ({
        ok: true,
        checkout: {
          path: baseTree,
          dispose: async () => {
            disposed = true
          },
        },
      }),
    },
  })
  expect(built).toEqual([{ cwd: baseTree, artefact: join(repoPath, 'artefacts', 'base.tar.gz') }])
  expect(result.base).toEqual({ ref: 'main', status: 'executed' })
  expect(result.client?.base).toMatchObject({ path: 'artefacts/base.tar.gz', source: 'built' })
  expect(disposed).toBe(true)
})

test('a client profile has one side when nobody asks for the base, or when it names no base artefact (#75)', async () => {
  const unasked = await workspace({ profile: TWO_SIDES })
  const one = await runJob(unasked.job, { ...WITH_DISPLAY, provision: { installRoot: unasked.installRoot, health: UP }, clientSession: installedSession([], []) })
  expect(one.result.base).toBeUndefined()
  expect(one.result.client?.comparison).toBe('none')
  expect(existsSync(join(unasked.job.evidenceDir, 'provision.log'))).toBe(true)

  const headOnly = await workspace()
  const asked = await runJob(headOnly.job, { ...WITH_DISPLAY, provision: { installRoot: headOnly.installRoot, health: UP }, clientSession: installedSession([], []), base: NO_CHECKOUT })
  expect(asked.result.base).toBeUndefined()
  expect(asked.result.client?.comparison).toBe('none')
})

test('a profile that runs nothing at the base installs nothing there (#75)', async () => {
  const { job, installRoot } = await workspace({ profile: { ...TWO_SIDES, base: { criteria: 'none' } } })
  const launched: string[] = []
  const { result } = await runJob(job, { ...WITH_DISPLAY, provision: { installRoot, health: UP }, clientSession: installedSession([], launched), base: NO_CHECKOUT })
  expect(result.base).toMatchObject({ status: 'not-executed', reason: 'the profile runs no criteria at the base (base.criteria: none)' })
  expect(launched).toHaveLength(1)
  expect(existsSync(join(job.evidenceDir, 'base', 'provision.log'))).toBe(false)
})

test('an install that cannot be removed is in the result and the comment, never reported as removed (#75)', async () => {
  const { job, installRoot } = await workspace()
  const { result } = await runJob(job, {
    ...WITH_DISPLAY,
    provision: {
      installRoot,
      health: UP,
      installers: {
        archive: {
          install: async (input) => ({
            ok: true,
            installed: {
              location: 'a place that will not let go',
              executable: join(input.installRoot, 'never-launched'),
              uninstall: async () => {
                throw new Error('device or resource busy')
              },
            },
          }),
        },
      },
    },
    flowSession: async () => {
      const page: FlowPage = {
        open: async () => {},
        click: async () => {},
        type: async () => {},
        choose: async () => {},
        waitFor: async () => {},
        assertText: async () => {},
        assertElement: async () => {},
        screenshot: async (path) => {
          await writeFile(path, PNG_1X1)
        },
      }
      return { page, dispose: async () => {} }
    },
  })
  // The checks decided the criteria; what was left behind is said beside them.
  expect(result.verdict).toBe('passed')
  const leftover = 'the head artefact artefacts/head.tar.gz could not be uninstalled from a place that will not let go: device or resource busy'
  expect(result.client?.artefact?.leftover).toBe(leftover)
  const comment = renderComment(loadResult(await readFile(join(job.evidenceDir, 'result.json'), 'utf8')))
  expect(comment).not.toContain('and removed afterwards')
  expect(comment).toContain('It was not removed afterwards')
  expect(comment).toContain('provision.log')
  expect(await readFile(join(job.evidenceDir, 'provision.log'), 'utf8')).toContain(`[teardown] ${leftover}`)
})

test('a cancel removes the install at once and still waits for a neighbouring run\'s compose down before exiting (#75, #53)', async () => {
  const { job, installRoot } = await workspace()
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  let finishDown: () => void = () => {}
  const downs: string[] = []
  // Another run in the same process, with a stack whose down takes a while.
  const neighbour = installCancelCleanup(
    { app: { boot: { compose: 'compose.qa.yaml', service: 'web' }, health: { http: ['http:', '//localhost:1/'].join(''), timeout: '1s' }, seed: { command: 'true' }, login: { fixture: 'f', role: 'r' } }, stubs: [], visual: { widths: [], themes: [] }, suites: [] },
    {
      runCompose: (args) => {
        downs.push(args.join(' '))
        return new Promise((resolve) => {
          finishDown = () => resolve({ code: 0, stdout: '', stderr: '' })
        })
      },
      isolation: { runId: 'run-n', project: 'qare-run-n', startedAt: '2026-01-01T00:00:00.000Z', port: 4321 },
    },
  )
  let release: () => void = () => {}
  let reached: () => void = () => {}
  const inFlight = new Promise<void>((resolve) => {
    reached = resolve
  })
  const running = runJob(job, {
    ...WITH_DISPLAY,
    provision: { installRoot, health: UP },
    // The run is held inside its first check, with its build installed.
    clientSession: () => async () => {
      reached()
      await new Promise<void>((resolve) => {
        release = resolve
      })
      throw new Error('cancelled')
    },
  })
  try {
    await inFlight
    expect(readdirSync(installRoot)).toHaveLength(1)
    process.emit('SIGINT')
    // The install is gone before anything else happens.
    expect(readdirSync(installRoot)).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(downs).toEqual(['-p qare-run-n -f compose.qa.yaml down'])
    // The neighbour's down has not settled, so the process has not exited.
    expect(exit).not.toHaveBeenCalled()
    finishDown()
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(4))
    expect(exit).toHaveBeenCalledTimes(1)
  } finally {
    release()
    await running.catch(() => {})
    neighbour()
    exit.mockRestore()
  }
})

test('an install is removed even when a check throws out of the run (#75)', async () => {
  const { job, installRoot } = await workspace()
  await expect(
    runJob(job, {
      ...WITH_DISPLAY,
      provision: { installRoot, health: UP },
      clientSession: () => {
        throw new Error('the session seam broke')
      },
    }),
  ).rejects.toThrow('the session seam broke')
  expect(readdirSync(installRoot)).toEqual([])
})
