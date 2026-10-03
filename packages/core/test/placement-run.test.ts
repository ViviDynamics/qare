import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { loadResult, runJob, validateProfileConfig, type HostProbes, type Job, type JobCriterion, type QaProfile, type RunJobOpts } from '../src/index.js'

// Test files carry no network literals (the offline scanner), so URLs are
// joined at runtime and every probe is a fake.
const TARGET_URL = ['https:', '//app.example.test'].join('')
const HEALTH_URL = ['http:', '//localhost:3000/up'].join('')

const made: string[] = []

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const target = (requires?: unknown): QaProfile => validateProfileConfig({ target: { url: TARGET_URL, health: { http: '/health', timeout: '1s' } }, ...(requires === undefined ? {} : { requires }) })

const app = (requires?: unknown): QaProfile =>
  validateProfileConfig({
    app: {
      boot: { compose: 'compose.qa.yaml', service: 'web' },
      health: { http: HEALTH_URL, timeout: '1s' },
      seed: { command: 'true' },
      login: { fixture: 'fixtures/users.yml', role: 'admin' },
    },
    stubs: [],
    visual: { widths: [], themes: [] },
    suites: [],
    ...(requires === undefined ? {} : { requires }),
  })

const ECHO: JobCriterion['checks'] = [{ kind: 'command', run: 'node echo-args.mjs hello', expect: { exit: 0 } }]

async function repo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), 'qare-placement-'))
  made.push(repoPath)
  await writeFile(join(repoPath, 'echo-args.mjs'), 'console.log(process.argv.slice(2).join(" "))\n')
  return repoPath
}

async function jobFor(profile: QaProfile): Promise<Job> {
  const repoPath = await repo()
  return {
    id: 'job-placement',
    repoPath,
    baseRef: 'main',
    headRef: 'HEAD',
    profile: { inline: profile },
    criteria: [
      { id: 'greets', text: 'the application greets', checks: ECHO },
      { id: 'parts', text: 'the application parts', checks: ECHO },
    ],
    evidenceDir: join(repoPath, 'evidence'),
    post: 'none',
  }
}

/** A Linux host with nothing extra: no virtualisation, no device, no runner. */
const LINUX: HostProbes = {
  platform: 'linux',
  arch: 'x64',
  env: {},
  virtualisation: () => '/dev/kvm is not there, so this host offers no hardware virtualisation',
  devices: async () => ({ attached: [], detail: 'no adb answered (adb devices exited 127), so no attached device can be seen' }),
}

/** Every seam that would provision something, each recording that it was asked. */
function provisioning(touched: string[]): RunJobOpts {
  return {
    probe: async () => {
      touched.push('health probe')
      return { ok: true }
    },
    pollIntervalMs: 1,
    runCompose: async (args) => {
      touched.push(`compose ${args.join(' ')}`)
      return { code: 0, stdout: '', stderr: '' }
    },
    provision: {
      runCommand: async (command) => {
        touched.push(`build ${command}`)
        return { code: 0, output: '' }
      },
      health: async () => {
        touched.push('client health')
        return { ok: true }
      },
    },
  }
}

/** The same, for a run that was asked for its base side too. */
function provisioningBothSides(touched: string[]): RunJobOpts {
  return {
    ...provisioning(touched),
    base: {
      checkout: async () => {
        touched.push('base checkout')
        return { ok: false as const, reason: 'no checkout in this test' }
      },
    },
  }
}

test('a run needing macOS on a host without it is refused with a named reason, before any provisioning (#76)', async () => {
  const touched: string[] = []
  const job = await jobFor(target({ os: 'macos' }))
  const { result } = await runJob(job, { ...provisioningBothSides(touched), host: LINUX })

  expect(result.verdict).toBe('refused')
  const reason = 'refused: unmet requirement: a macos host (requires.os): this host is linux. Nothing was provisioned.'
  expect(result.criteria).toEqual([
    { id: 'greets', outcome: 'unverified', reason },
    { id: 'parts', outcome: 'unverified', reason },
  ])
  // Not the health probe, not a boot, not a base checkout: nothing at all.
  expect(touched).toEqual([])
  // The evidence holds the refusal and nothing a provisioning would have left.
  expect(readdirSync(job.evidenceDir)).toEqual(['result.json'])
  // And it says what was required, and of which host.
  expect(result.requirements).toEqual({ os: 'macos' })
  expect(result.environment?.host).toEqual({ os: 'linux', arch: 'x64', virtualisation: false })
  expect(result.target).toEqual({ url: TARGET_URL, comparison: 'none' })
})

test('everything that is missing is named at once, and a profile that boots an app boots nothing (#76)', async () => {
  const touched: string[] = []
  const job = await jobFor(app({ os: 'windows', virtualisation: true, devices: ['android'] }))
  const { result, isolation } = await runJob(job, { ...provisioningBothSides(touched), host: LINUX })

  expect(result.verdict).toBe('refused')
  expect(result.criteria[0]?.reason).toBe(
    'refused: unmet requirement: a windows host (requires.os): this host is linux; hardware virtualisation (requires.virtualisation): /dev/kvm is not there, so this host offers no hardware virtualisation; an attached android device (requires.devices): no adb answered (adb devices exited 127), so no attached device can be seen. Nothing was provisioned.',
  )
  // No base checkout, no compose project, no isolation to tear down.
  expect(touched).toEqual([])
  expect(isolation).toBeUndefined()
  expect(readdirSync(job.evidenceDir)).toEqual(['result.json'])
  expect(result.base).toBeUndefined()
  expect(result.requirements).toEqual({ os: 'windows', virtualisation: true, devices: ['android'] })
})

test('a client build that is to be built and installed is refused before its build command runs (#76)', async () => {
  const touched: string[] = []
  const profile = validateProfileConfig({
    client: {
      driver: 'electron',
      egress: 'uncontained',
      artefact: {
        kind: 'directory',
        executable: 'my-app',
        head: { path: 'out/head', build: 'make head' },
        base: { path: 'out/base', build: 'make base' },
      },
    },
    requires: { os: 'macos' },
  })
  const job = await jobFor(profile)
  const { result } = await runJob(job, { ...provisioningBothSides(touched), host: LINUX, clientEnv: { env: { DISPLAY: ':99' }, platform: 'linux' } })

  expect(result.verdict).toBe('refused')
  expect(result.criteria[0]?.reason).toBe('refused: unmet requirement: a macos host (requires.os): this host is linux. Nothing was provisioned.')
  expect(touched).toEqual([])
  expect(existsSync(join(job.evidenceDir, 'provision.log'))).toBe(false)
  expect(existsSync(join(job.evidenceDir, 'base'))).toBe(false)
  // What the profile declares and what its shape implies are one record.
  expect(result.requirements).toEqual({ os: 'macos', display: true })
  expect(result.client).toMatchObject({ driver: 'electron', executable: 'my-app', egress: 'uncontained' })
})

test('a host that meets what the profile requires runs it, and the evidence names the host and the requirement (#76)', async () => {
  const touched: string[] = []
  const job = await jobFor(target({ os: 'linux', virtualisation: true, devices: ['android'] }))
  const host: HostProbes = {
    platform: 'linux',
    arch: 'arm64',
    env: { QARE_RUNNER_ENVIRONMENT: 'github-hosted', QARE_REPOSITORY_VISIBILITY: 'public' },
    virtualisation: () => undefined,
    devices: async () => ({ attached: ['R58M12ABCDE'] }),
  }
  const { result } = await runJob(job, { ...provisioning(touched), host })

  expect(result.verdict).toBe('passed')
  expect(touched).toEqual(['health probe'])
  expect(result.requirements).toEqual({ os: 'linux', virtualisation: true, devices: ['android'] })
  expect(result.environment?.host).toEqual({ os: 'linux', arch: 'arm64', virtualisation: true, runner: 'github-hosted' })
  // What was written is what loads back.
  const loaded = loadResult(await readFile(join(job.evidenceDir, 'result.json'), 'utf8'))
  expect(loaded.requirements).toEqual(result.requirements)
  expect(loaded.environment?.host).toEqual(result.environment?.host)
})

test('a profile that requires nothing records no requirement, and still names the host that produced the result (#76)', async () => {
  const job = await jobFor(target())
  const { result } = await runJob(job, { ...provisioning([]), host: { ...LINUX, env: { RUNNER_ENVIRONMENT: 'self-hosted' } } })
  expect(result.verdict).toBe('passed')
  expect(result.requirements).toBeUndefined()
  expect(result.environment?.host).toEqual({ os: 'linux', arch: 'x64', virtualisation: false, runner: 'self-hosted' })
})

test('each side of a two-sided run names the host that produced it (#76)', async () => {
  const touched: string[] = []
  const job = await jobFor(app())
  const baseRepo = await repo()
  const { result } = await runJob(job, {
    ...provisioning(touched),
    host: { ...LINUX, env: { QARE_RUNNER_ENVIRONMENT: 'github-hosted' } },
    base: { repoPath: baseRepo },
  })
  expect(result.base?.status).toBe('executed')
  const host = { os: 'linux', arch: 'x64', virtualisation: false, runner: 'github-hosted' }
  expect(result.environment?.host).toEqual(host)
  for (const side of ['base', 'head'])
    expect(loadResult(await readFile(join(job.evidenceDir, side, 'result.json'), 'utf8')).environment?.host, side).toEqual(host)
})

test('in a run over several apps, the app whose requirements are unmet is refused alone, and boots nothing (#76)', async () => {
  const touched: string[] = []
  const repoPath = await repo()
  const job: Job = {
    id: 'job-placement-several',
    repoPath,
    baseRef: 'main',
    headRef: 'HEAD',
    profiles: [
      { name: 'phone', profile: { inline: app({ devices: ['android'] }) }, criteria: [{ id: 'phone-greets', text: 'the phone app greets', checks: ECHO }] },
      { name: 'web', profile: { inline: app() }, criteria: [{ id: 'web-greets', text: 'the web app greets', checks: ECHO }] },
    ],
    evidenceDir: join(repoPath, 'evidence'),
    post: 'none',
  }
  const { result } = await runJob(job, { ...provisioning(touched), host: LINUX })

  expect(result.criteria).toEqual([
    {
      id: 'phone-greets',
      outcome: 'unverified',
      reason:
        'refused: unmet requirement: an attached android device (requires.devices): no adb answered (adb devices exited 127), so no attached device can be seen. Nothing was provisioned.',
    },
    expect.objectContaining({ id: 'web-greets', outcome: 'proven' }),
  ])
  expect(result.profiles?.map((entry) => [entry.name, entry.verdict, entry.requirements])).toEqual([
    ['phone', 'refused', { devices: ['android'] }],
    ['web', 'passed', undefined],
  ])
  // Only the web app was booted.
  expect(touched.filter((entry) => entry.includes(' up ')).length).toBe(1)
  expect(result.environment?.host).toEqual({ os: 'linux', arch: 'x64', virtualisation: false })
})

test('a public repository on a self-hosted runner is refused before anything runs, unless its caller opted in (#76)', async () => {
  const touched: string[] = []
  const selfHosted = (extra: NodeJS.ProcessEnv = {}): HostProbes => ({
    ...LINUX,
    env: { QARE_RUNNER_ENVIRONMENT: 'self-hosted', QARE_REPOSITORY_VISIBILITY: 'public', ...extra },
  })
  const job = await jobFor(target({ os: 'linux' }))
  const { result } = await runJob(job, { ...provisioningBothSides(touched), host: selfHosted() })
  expect(result.verdict).toBe('refused')
  // What the profile required is recorded here too, though it is not why the run was refused.
  expect(result.requirements).toEqual({ os: 'linux' })
  expect(result.target).toEqual({ url: TARGET_URL, comparison: 'none' })
  expect(result.criteria[0]?.reason).toBe(
    'refused: placement: this repository is public and the run landed on a self-hosted runner: a public repository keeps its runs on GitHub-hosted runners, because a runner that outlives its job keeps whatever a pull request left on it; to use your own capacity anyway, opt in with the pipeline input self-hosted: allow',
  )
  expect(touched).toEqual([])
  expect(result.environment?.host).toEqual({ os: 'linux', arch: 'x64', virtualisation: false, runner: 'self-hosted' })

  // Opted in, the same run on the same runner goes ahead, and the evidence still says where.
  const allowed = await runJob(await jobFor(target()), { ...provisioning(touched), host: selfHosted({ QARE_SELF_HOSTED: 'allow' }) })
  expect(allowed.result.verdict).toBe('passed')
  expect(allowed.result.environment?.host?.runner).toBe('self-hosted')

  // A run over several apps is refused whole: no app of it runs there.
  const repoPath = await repo()
  const several: Job = {
    id: 'job-placement-public',
    repoPath,
    baseRef: 'main',
    headRef: 'HEAD',
    profiles: [
      { name: 'admin', profile: { inline: app({ os: 'linux' }) }, criteria: [{ id: 'admin-greets', text: 'the admin greets', checks: ECHO }] },
      { name: 'web', profile: { inline: app() }, criteria: [{ id: 'web-greets', text: 'the web app greets', checks: ECHO }] },
    ],
    evidenceDir: join(repoPath, 'evidence'),
    post: 'none',
  }
  touched.length = 0
  const whole = await runJob(several, { ...provisioningBothSides(touched), host: selfHosted() })
  expect(whole.result.verdict).toBe('refused')
  expect(whole.result.criteria.map((criterion) => criterion.outcome)).toEqual(['unverified', 'unverified'])
  expect(whole.result.criteria[0]).toMatchObject({ reason: expect.stringMatching(/^refused: placement: this repository is public/) })
  // Each app still carries what its own profile required.
  expect(whole.result.profiles?.map((entry) => [entry.name, entry.verdict, entry.requirements])).toEqual([
    ['admin', 'refused', { os: 'linux' }],
    ['web', 'refused', undefined],
  ])
  expect(touched).toEqual([])
})

test('the host is asked about a device once for the whole run: every app, and both sides (#76)', async () => {
  const asked: string[] = []
  const repoPath = await repo()
  const baseRepo = await repo()
  const job: Job = {
    id: 'job-placement-once',
    repoPath,
    baseRef: 'main',
    headRef: 'HEAD',
    profiles: [
      { name: 'phone', profile: { inline: app({ devices: ['android'] }) }, criteria: [{ id: 'phone-greets', text: 'the phone app greets', checks: ECHO }] },
      { name: 'tablet', profile: { inline: app({ devices: ['android'] }) }, criteria: [{ id: 'tablet-greets', text: 'the tablet app greets', checks: ECHO }] },
    ],
    evidenceDir: join(repoPath, 'evidence'),
    post: 'none',
  }
  const { result } = await runJob(job, {
    ...provisioning([]),
    host: {
      ...LINUX,
      devices: async (kind) => {
        asked.push(kind)
        return { attached: [], detail: 'adb devices did not answer within 10 s, so no attached device can be seen' }
      },
    },
    base: { repoPath: baseRepo },
  })
  expect(result.profiles?.map((entry) => entry.verdict)).toEqual(['refused', 'refused'])
  // Two apps on two sides would be four probes of ten seconds each against an adb that hangs.
  expect(asked).toEqual(['android'])
})
