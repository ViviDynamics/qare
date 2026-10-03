import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { bootApp, loadResult, renderComment, runJob, type ClientHealthCheck, type FlowPage, type Job, type JobCriterion, type QaProfile, type RunJobOpts } from '../src/index.js'

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
