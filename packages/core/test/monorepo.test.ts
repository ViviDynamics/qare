import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  DEFAULT_PROFILE_NAME,
  JobValidationError,
  ProfileValidationError,
  discoverProfiles,
  judgeExecuted,
  loadJobFromText,
  loadResult,
  pathUnderArea,
  profileCovers,
  renderComment,
  runJob,
  selectProfiles,
  touchedPathsFromDiff,
  type JobCriterion,
  type JobProfileGroup,
  type NamedProfile,
  type QaProfile,
  type RunResult,
  type SeveralProfilesJob,
} from '../src/index.js'

const HEALTH_URL = ['http:', '//localhost:3000/up'].join('')

const APP_PROFILE: QaProfile = {
  app: {
    boot: { compose: 'compose.qa.yaml', service: 'admin' },
    health: { http: HEALTH_URL, timeout: '120s' },
    seed: { command: 'true' },
    login: { fixture: 'fixtures/users.yml', role: 'admin' },
  },
  stubs: [],
  visual: { widths: [], themes: [] },
  suites: [],
}

const HEALTHY_BOOT = {
  runCompose: async () => ({ code: 0, stdout: 'up out', stderr: 'up err' }),
  probe: async () => ({ ok: true }),
  pollIntervalMs: 1,
}

const TARGET_CONFIG = [
  'target:',
  ['  url: http:', '//localhost:3000'].join(''),
  '  health:',
  `    http: ${HEALTH_URL}`,
  '    timeout: 30s',
  '  hosts: []',
].join('\n')

const APP_BOOT_CONFIG = [
  'app:',
  '  boot: { compose: compose.qa.yaml, service: admin }',
  `  health: { http: '${HEALTH_URL}', timeout: 120s }`,
  '  seed: { command: "true" }',
  '  login: { fixture: fixtures/users.yml, role: admin }',
  'stubs: []',
  'visual: { widths: [], themes: [] }',
  'suites: []',
].join('\n')

async function writeProfile(dir: string, config: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'QA.md'), 'what this app is', 'utf8')
  await writeFile(join(dir, 'config.yml'), `${config}\n`, 'utf8')
}

test('discovery finds the single root profile as the default', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'qare-mono-'))
  await writeProfile(join(repo, '.qa'), TARGET_CONFIG)
  const found = await discoverProfiles(join(repo, '.qa'))
  expect(found).toHaveLength(1)
  expect(found[0]?.name).toBe(DEFAULT_PROFILE_NAME)
  expect(found[0]?.dir).toBe(join(repo, '.qa'))
})

test('discovery finds named profiles in subdirectories, sorted by name', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'qare-mono-'))
  await writeProfile(join(repo, '.qa', 'storefront'), TARGET_CONFIG)
  await writeProfile(join(repo, '.qa', 'admin'), TARGET_CONFIG)
  const found = await discoverProfiles(join(repo, '.qa'))
  expect(found.map((profile) => profile.name)).toEqual(['admin', 'storefront'])
  expect(found[0]?.profile.target?.url).toBeTruthy()
})

test('a .qa/ holding the root form and named profiles fails closed', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'qare-mono-'))
  await writeProfile(join(repo, '.qa'), TARGET_CONFIG)
  await writeProfile(join(repo, '.qa', 'admin'), TARGET_CONFIG)
  await expect(discoverProfiles(join(repo, '.qa'))).rejects.toThrow(ProfileValidationError)
})

test('subdirectories without a config.yml are shared fixtures, not profiles', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'qare-mono-'))
  await writeProfile(join(repo, '.qa', 'admin'), TARGET_CONFIG)
  await mkdir(join(repo, '.qa', 'fixtures'), { recursive: true })
  const found = await discoverProfiles(join(repo, '.qa'))
  expect(found.map((profile) => profile.name)).toEqual(['admin'])
})

test('a malformed named profile fails discovery instead of being skipped', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'qare-mono-'))
  await writeProfile(join(repo, '.qa', 'admin'), TARGET_CONFIG)
  await writeProfile(join(repo, '.qa', 'broken'), 'app: { boot: {} }')
  await expect(discoverProfiles(join(repo, '.qa'))).rejects.toThrow(ProfileValidationError)
})

test('a named profile directory whose name cannot be published fails discovery closed', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'qare-mono-'))
  await writeProfile(join(repo, '.qa', 'bad:name'), TARGET_CONFIG)
  await expect(discoverProfiles(join(repo, '.qa'))).rejects.toThrow(/must not contain path separators, "\.\." or control characters/)

  const newlineRepo = await mkdtemp(join(tmpdir(), 'qare-mono-'))
  await writeProfile(join(newlineRepo, '.qa', 'admin\n## injected'), TARGET_CONFIG)
  await expect(discoverProfiles(join(newlineRepo, '.qa'))).rejects.toThrow(ProfileValidationError)
})

test('a root config.yml that exists but is not a file fails discovery closed', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'qare-mono-'))
  await writeProfile(join(repo, '.qa', 'storefront'), TARGET_CONFIG)
  await mkdir(join(repo, '.qa', 'config.yml'), { recursive: true })
  await expect(discoverProfiles(join(repo, '.qa'))).rejects.toThrow(ProfileValidationError)
})

test('a named profile directory called default fails closed whatever the config entry is', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'qare-mono-'))
  await writeProfile(join(repo, '.qa', 'admin'), TARGET_CONFIG)
  await mkdir(join(repo, '.qa', 'default', 'config.yml'), { recursive: true })
  await expect(discoverProfiles(join(repo, '.qa'))).rejects.toThrow(/reserved for the single root profile/)
})

test('a named directory that carries a config.yml but no QA.md fails discovery closed', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'qare-mono-'))
  await mkdir(join(repo, '.qa', 'admin'), { recursive: true })
  await writeFile(join(repo, '.qa', 'admin', 'config.yml'), `${TARGET_CONFIG}\n`, 'utf8')
  await expect(discoverProfiles(join(repo, '.qa'))).rejects.toThrow(/QA\.md/)
})

test('a profile whose area path carries a dot segment fails when it loads, because no git diff path matches it', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'qare-mono-'))
  await writeProfile(join(repo, '.qa', 'admin'), `${TARGET_CONFIG}\npaths:\n  - ./apps/admin\n`)
  await expect(discoverProfiles(join(repo, '.qa'))).rejects.toThrow(/carries a "\." segment/)
})

test('a repository without .qa/ discovers nothing', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'qare-mono-'))
  expect(await discoverProfiles(join(repo, '.qa'))).toEqual([])
})

const ADMIN: NamedProfile = { name: 'admin', dir: '/r/.qa/admin', profile: { paths: ['apps/admin'] } }
const WHOLE_REPO: NamedProfile = { name: 'all', dir: '/r/.qa/all', profile: { paths: ['.'] } }
const WEB: NamedProfile = { name: 'web', dir: '/r/.qa/web', profile: {} }
const WEB_AREA: NamedProfile = { name: 'web', dir: '/r/.qa/web', profile: { paths: ['apps/web'] } }
const ROOT: NamedProfile = { name: DEFAULT_PROFILE_NAME, dir: '/r/.qa', profile: {} }

test('the root profile is selected on every change', () => {
  expect(selectProfiles([ROOT], ['docs/notes.md'])).toEqual([ROOT])
  expect(selectProfiles([ROOT], [])).toEqual([ROOT])
})

test('a named profile is selected when a touched path falls under its areas', () => {
  expect(selectProfiles([ADMIN, WEB_AREA], ['apps/admin/src/main.ts'])).toEqual([ADMIN])
  expect(selectProfiles([ADMIN, WEB_AREA], ['apps/web/main.ts'])).toEqual([WEB_AREA])
  // A profile that declares no areas has none to be selected by.
  expect(selectProfiles([ADMIN, WEB], ['apps/web/main.ts'])).toEqual([])
})

test('areas match at a segment boundary, so apps/admin never covers apps/admin-ui', () => {
  expect(selectProfiles([ADMIN, WEB], ['apps/admin-ui/main.ts'])).toEqual([])
})

test('the area . covers the whole repository', () => {
  expect(selectProfiles([WHOLE_REPO, WEB], ['docs/notes.md'])).toEqual([WHOLE_REPO])
})

test('a profile without paths is selected only by its own directory', () => {
  expect(selectProfiles([WEB], ['.qa/web/config.yml'])).toEqual([WEB])
  expect(selectProfiles([WEB], ['.qa/web'])).toEqual([WEB])
  expect(profileCovers(WEB, '.qa/webx')).toBe(false)
  expect(profileCovers(WEB, 'apps/web/main.ts')).toBe(false)
})

test('paths are matched at a segment boundary', () => {
  expect(pathUnderArea('apps/admin/src', 'apps/admin')).toBe(true)
  expect(pathUnderArea('apps/admin', 'apps/admin')).toBe(true)
  expect(pathUnderArea('apps/admin-ui', 'apps/admin')).toBe(false)
  expect(pathUnderArea('anything at all', '.')).toBe(true)
})

test('touched paths come from the diff file headers, both sides of a rename', () => {
  const diff = [
    'diff --git a/apps/admin/src/a.ts b/apps/admin/src/a.ts',
    'index 111..222 100644',
    '--- a/apps/admin/src/a.ts',
    '+++ b/apps/admin/src/a.ts',
    'diff --git a/apps/web/b.ts b/apps/web/renamed.ts',
    '--- a/apps/web/b.ts',
    '+++ b/apps/web/renamed.ts',
  ].join('\n')
  expect(touchedPathsFromDiff(diff)).toEqual(['apps/admin/src/a.ts', 'apps/web/b.ts', 'apps/web/renamed.ts'])
})

test('diff headers git quotes for exotic paths still select the app whose area declares them', () => {
  // Git quotes a path that carries spaces, quotes, tabs or non-ASCII bytes in
  // C style; the quoted header is unquoted before the path is read, so such a
  // change under a declared area selects the app instead of reporting it
  // unmatched (#55).
  const diff = [
    'diff --git "a/apps/web/my app.ts" "b/apps/web/my app.ts"',
    '--- "a/apps/web/my app.ts"',
    '+++ "b/apps/web/my app.ts"',
    'diff --git "a/apps/web/d\\303\\251cor.ts" "b/apps/web/d\\303\\251cor.ts"',
  ].join('\n')
  expect(touchedPathsFromDiff(diff)).toEqual(['apps/web/d\u00e9cor.ts', 'apps/web/my app.ts'])
})

function severalJob(groups: JobProfileGroup[]): SeveralProfilesJob {
  return {
    id: 'job-monorepo-smoke',
    repoPath: '/r',
    baseRef: 'main',
    headRef: 'HEAD~1',
    profiles: groups,
    evidenceDir: '/e',
    post: 'none',
  }
}

function commandCriterion(id: string): JobCriterion {
  return { id, text: `criterion ${id}`, checks: [{ kind: 'command', run: 'echo ok' }] }
}

async function makeSeveralJob(groups: JobProfileGroup[]): Promise<SeveralProfilesJob> {
  const job = severalJob(groups)
  const repoPath = await mkdtemp(join(tmpdir(), 'qare-mono-run-'))
  job.repoPath = repoPath
  job.evidenceDir = join(repoPath, 'evidence')
  return job
}

test('one run checks two apps under two isolations and reports a verdict per app', async () => {
  const job = await makeSeveralJob([
    { name: 'admin', profile: { inline: APP_PROFILE }, criteria: [commandCriterion('admin-c1')] },
    { name: 'storefront', profile: { inline: APP_PROFILE }, criteria: [commandCriterion('storefront-c1')] },
  ])

  const { result, isolations } = await runJob(job, HEALTHY_BOOT)

  expect(result.verdict).toBe('passed')
  expect(result.profiles).toEqual([
    { name: 'admin', verdict: 'passed', criteria: ['admin-c1'], profile: { inline: APP_PROFILE } },
    { name: 'storefront', verdict: 'passed', criteria: ['storefront-c1'], profile: { inline: APP_PROFILE } },
  ])
  expect(result.target).toBeUndefined()
  expect(result.criteria.map((criterion) => criterion.id)).toEqual(['admin-c1', 'storefront-c1'])
  const adminIsolation = JSON.parse(await readFile(join(job.evidenceDir, 'isolation-admin.json'), 'utf8'))
  const storefrontIsolation = JSON.parse(await readFile(join(job.evidenceDir, 'isolation-storefront.json'), 'utf8'))
  expect(adminIsolation.project).not.toBe(storefrontIsolation.project)
  expect(await readFile(join(job.evidenceDir, 'values-admin.json'), 'utf8')).toBeTruthy()
  const written = loadResult(await readFile(join(job.evidenceDir, 'result.json'), 'utf8'))
  expect(written.profiles).toEqual(result.profiles)
  // The run hands back every app's isolation, so a caller can stop each stack
  // the run booted (#55).
  expect(isolations).toEqual([
    { name: 'admin', isolation: expect.objectContaining({ project: adminIsolation.project }) },
    { name: 'storefront', isolation: expect.objectContaining({ project: storefrontIsolation.project }) },
  ])
})

test('a several-profile run refuses a caller-carried isolation instead of sharing it', async () => {
  const job = await makeSeveralJob([
    { name: 'admin', profile: { inline: APP_PROFILE }, criteria: [commandCriterion('admin-c1')] },
    { name: 'storefront', profile: { inline: APP_PROFILE }, criteria: [commandCriterion('storefront-c1')] },
  ])
  const isolation = { runId: 'r1', project: 'qare-r1', startedAt: '2026-01-01T00:00:00Z', port: 3000 }

  const { result } = await runJob(job, { ...HEALTHY_BOOT, isolation })

  expect(result.verdict).toBe('refused')
  expect(result.profiles?.map((profile) => profile.verdict)).toEqual(['refused', 'refused'])
  expect(result.criteria.every((criterion) => criterion.outcome === 'unverified' && criterion.reason.includes('an isolation of its own'))).toBe(true)
})

test('a several-profile run fails closed on a malformed profile even when the caller carries an isolation', async () => {
  // The isolation refusal is decided after every profile is resolved, so a
  // profile that cannot validate fails the run wherever it appears: no run
  // mode serializes a profile that was never validated (#55).
  const job = await makeSeveralJob([
    { name: 'admin', profile: { inline: {} as unknown as QaProfile }, criteria: [commandCriterion('admin-c1')] },
  ])
  const isolation = { runId: 'r1', project: 'qare-r1', startedAt: '2026-01-01T00:00:00Z', port: 3000 }

  await expect(runJob(job, { ...HEALTHY_BOOT, isolation })).rejects.toThrow()
})

test('an app that declares a hosted target is refused in a several-app run, and the other app still runs', async () => {
  // The result's target metadata says a run against a target has one side
  // only, so a several-app run cannot name what a target app was checked
  // against: it is refused instead of silently dropping the metadata (#55).
  const targetedProfile: QaProfile = {
    target: { url: ['http:', '//targeted.example'].join(''), health: { http: HEALTH_URL, timeout: '30s' }, hosts: [] },
    stubs: [],
    visual: { widths: [], themes: [] },
    suites: [],
  }
  const job = await makeSeveralJob([
    { name: 'targeted', profile: { inline: targetedProfile }, criteria: [commandCriterion('targeted-c1')] },
    { name: 'admin', profile: { inline: APP_PROFILE }, criteria: [commandCriterion('admin-c1')] },
  ])

  const { result } = await runJob(job, HEALTHY_BOOT)
  expect(result.profiles).toEqual([
    { name: 'targeted', verdict: 'refused', criteria: ['targeted-c1'], profile: { inline: targetedProfile } },
    { name: 'admin', verdict: 'passed', criteria: ['admin-c1'], profile: { inline: APP_PROFILE } },
  ])
  expect(result.verdict).toBe('blocked')
  expect(result.target).toBeUndefined()
  expect(result.criteria[0].reason).toContain('hosted target')
})

test('an app whose boot blocks attaches its own provisioning log, named for the app (#75)', async () => {
  const job = await makeSeveralJob([
    { name: 'web', profile: { inline: APP_PROFILE }, criteria: [commandCriterion('web-c1')] },
    { name: 'admin', profile: { inline: APP_PROFILE }, criteria: [commandCriterion('admin-c1')] },
  ])
  let boots = 0
  const { result } = await runJob(job, {
    ...HEALTHY_BOOT,
    runCompose: async (args) => {
      if (!args.includes('up')) return { code: 0, stdout: '', stderr: '' }
      boots += 1
      return boots === 1 ? { code: 1, stdout: '', stderr: 'web: port is already allocated' } : { code: 0, stdout: '', stderr: '' }
    },
  })
  expect(result.criteria[0]).toEqual({ id: 'web-c1', outcome: 'unverified', reason: 'compose up exited 1', evidence: ['provision-web.log'] })
  expect(await readFile(join(job.evidenceDir, 'provision-web.log'), 'utf8')).toBe('web: port is already allocated\n')
  expect(result.criteria[1]?.outcome).toBe('proven')
})

test('flow masks are the union of every app, so one app screenshot carries every app mask', async () => {
  const received: string[][] = []
  const maskedProfile = (mask: string): QaProfile => ({ ...APP_PROFILE, redact: { masks: [mask] } })
  const job = await makeSeveralJob([
    {
      name: 'admin',
      profile: { inline: maskedProfile('css=.admin-secret') },
      criteria: [{ id: 'admin-c1', text: 'flow', checks: [{ kind: 'flow', name: 'walk', actions: [{ action: 'open', url: HEALTH_URL }] }] }],
    },
    { name: 'storefront', profile: { inline: maskedProfile('css=.storefront-secret') }, criteria: [commandCriterion('storefront-c1')] },
  ])

  await runJob(job, {
    ...HEALTHY_BOOT,
    flowSession: async (opts) => {
      received.push(opts.masks)
      throw new Error('the test stops at the factory, having captured the masks')
    },
  })

  expect(received).toEqual([['css=.admin-secret', 'css=.storefront-secret']])
})

test('a path-referenced profile shares the fixtures and stubs the .qa root keeps', async () => {
  const job = await makeSeveralJob([
    { name: 'admin', profile: { path: '.qa/admin' }, criteria: [commandCriterion('admin-c1')] },
  ])
  await writeProfile(join(job.repoPath, '.qa', 'admin'), APP_BOOT_CONFIG)
  await mkdir(join(job.repoPath, '.qa', 'fixtures'), { recursive: true })
  await mkdir(join(job.repoPath, '.qa', 'stubs'), { recursive: true })

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.verdict).toBe('passed')
  expect(result.profiles?.map((profile) => profile.verdict)).toEqual(['passed'])
})

test("a plan validation refusal still writes the app's isolation evidence", async () => {
  const job = await makeSeveralJob([
    {
      name: 'admin',
      profile: { inline: APP_PROFILE },
      criteria: [{
        id: 'admin-c1',
        text: 'criterion admin-c1',
        checks: [{ kind: 'flow', actions: [{ action: 'open', url: `{{mail.c1.link}}${'/x'}` }] }],
      }],
    },
  ])

  const { result, isolations } = await runJob(job, HEALTHY_BOOT)

  expect(result.verdict).toBe('blocked')
  expect(result.profiles?.map((profile) => profile.verdict)).toEqual(['refused'])
  const isolation = JSON.parse(await readFile(join(job.evidenceDir, 'isolation-admin.json'), 'utf8'))
  expect(isolation.project).toBeTruthy()
  expect(isolations).toEqual([expect.objectContaining({ name: 'admin' })])
})

test("every app's evidence is swept with every app's redaction rules", async () => {
  const secret = 's3cr3t-token'
  const job = await makeSeveralJob([
    {
      name: 'storefront',
      profile: { inline: APP_PROFILE },
      criteria: [{ id: 'storefront-c1', text: 'c', checks: [{ kind: 'command', run: `echo ${secret}` }] }],
    },
    { name: 'admin', profile: { inline: { ...APP_PROFILE, redact: { values: [secret] } } }, criteria: [commandCriterion('admin-c1')] },
  ])

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.verdict).toBe('passed')
  const stdout = await readFile(join(job.evidenceDir, 'checks', 'storefront-c1', '0', 'stdout.txt'), 'utf8')
  expect(stdout).not.toContain(secret)
  expect(stdout).toContain('[redacted]')
})

test('the per-app report survives judging and replay', async () => {
  const { result } = await judgeExecuted(severalResult(), { texts: {}, diff: '' })
  expect(result.profiles).toEqual(severalResult().profiles)
})

test('a group whose profile is not there is refused for that app alone', async () => {
  const job = await makeSeveralJob([
    { name: 'admin', profile: { inline: APP_PROFILE }, criteria: [commandCriterion('admin-c1')] },
    { name: 'ghost', profile: { path: '.qa/ghost' }, criteria: [commandCriterion('ghost-c1')] },
  ])

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.profiles).toEqual([
    { name: 'admin', verdict: 'passed', criteria: ['admin-c1'], profile: { inline: APP_PROFILE } },
    { name: 'ghost', verdict: 'refused', criteria: ['ghost-c1'], profile: { path: '.qa/ghost' } },
  ])
  expect(result.verdict).toBe('blocked')
  const ghost = result.criteria.find((criterion) => criterion.id === 'ghost-c1')
  expect(ghost?.outcome).toBe('unverified')
  if (ghost?.outcome === 'unverified') expect(ghost.reason).toMatch(/no usable .qa\/ profile for ghost/)
})

const SEVERAL_JOB_TEXT = [
  'id: j',
  'repoPath: /r',
  'baseRef: main',
  'headRef: HEAD',
  'evidenceDir: /e',
  'post: none',
  'profiles:',
  '  - name: admin',
  '    profile: { path: .qa/admin }',
  '    criteria:',
  '      - { id: admin-c1, text: works }',
  '  - name: storefront',
  '    profile: { inline: {} }',
  '    criteria:',
  '      - { id: storefront-c1, text: loads }',
].join('\n')

test('a several-profile job parses with one group per app', () => {
  const job = loadJobFromText(SEVERAL_JOB_TEXT)
  if (!('profiles' in job)) throw new Error('expected the profiles form')
  expect(job.profiles.map((group) => group.name)).toEqual(['admin', 'storefront'])
  expect(job.profiles[0]?.criteria).toEqual([{ id: 'admin-c1', text: 'works' }])
})

test('a job cannot carry both the single form and named profiles', () => {
  expect(() => loadJobFromText(`${SEVERAL_JOB_TEXT}\nprofile: { path: .qa/admin }\n`)).toThrow(JobValidationError)
})

test('a job cannot carry a top-level criteria list alongside named profiles', () => {
  expect(() => loadJobFromText(`${SEVERAL_JOB_TEXT}\ncriteria: [{ id: c1, text: works }]\n`)).toThrow(JobValidationError)
})

test('criterion ids must be unique across every group of a job', () => {
  const duplicate = SEVERAL_JOB_TEXT.replace('storefront-c1', 'admin-c1')
  try {
    loadJobFromText(duplicate)
    throw new Error('expected the loader to refuse duplicate criterion ids')
  } catch (error) {
    expect(error).toBeInstanceOf(JobValidationError)
    expect((error as JobValidationError).message).toMatch(/unique across every profile/)
  }
})

test('profile names must be unique within a job', () => {
  const duplicate = SEVERAL_JOB_TEXT.replace('name: storefront', 'name: admin')
  expect(() => loadJobFromText(duplicate)).toThrow(JobValidationError)
})

test('an empty profiles list fails closed', () => {
  const empty = [
    'id: j',
    'repoPath: /r',
    'baseRef: main',
    'headRef: HEAD',
    'evidenceDir: /e',
    'post: none',
    'profiles: []',
  ].join('\n')
  expect(() => loadJobFromText(empty)).toThrow(JobValidationError)
})

test('a profile name may not carry the namespace separator', () => {
  expect(() => loadJobFromText(SEVERAL_JOB_TEXT.replace('name: admin', 'name: a:admin'))).toThrow(JobValidationError)
})

test('a named group cannot take the name the single root profile reserves', () => {
  expect(() => loadJobFromText(SEVERAL_JOB_TEXT.replace('name: admin', `name: ${DEFAULT_PROFILE_NAME}`))).toThrow(
    JobValidationError,
  )
})

test('a named boot profile shares the fixtures and stubs the root keeps when it has none of its own', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'qare-mono-'))
  await writeProfile(join(repo, '.qa', 'admin'), APP_BOOT_CONFIG)
  await mkdir(join(repo, '.qa', 'fixtures'), { recursive: true })
  await mkdir(join(repo, '.qa', 'stubs'), { recursive: true })
  const found = await discoverProfiles(join(repo, '.qa'))
  expect(found.map((profile) => profile.name)).toEqual(['admin'])
})

test('a named boot profile that keeps its own fixtures needs none from the root', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'qare-mono-'))
  await writeProfile(join(repo, '.qa', 'admin'), APP_BOOT_CONFIG)
  await mkdir(join(repo, '.qa', 'admin', 'fixtures'), { recursive: true })
  await mkdir(join(repo, '.qa', 'admin', 'stubs'), { recursive: true })
  const found = await discoverProfiles(join(repo, '.qa'))
  expect(found.map((profile) => profile.name)).toEqual(['admin'])
})

test('a root profile that is there but malformed fails instead of reading as a named layout', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'qare-mono-'))
  await mkdir(join(repo, '.qa'), { recursive: true })
  await writeFile(join(repo, '.qa', 'config.yml'), 'stubs: []\n', 'utf8')
  await writeProfile(join(repo, '.qa', 'admin'), TARGET_CONFIG)
  await expect(discoverProfiles(join(repo, '.qa'))).rejects.toThrow(ProfileValidationError)
})

test('a named profile directory called default fails closed', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'qare-mono-'))
  await writeProfile(join(repo, '.qa', 'default'), TARGET_CONFIG)
  await expect(discoverProfiles(join(repo, '.qa'))).rejects.toThrow(/reserved for the single root profile/)
})

function severalResult(): RunResult {
  return {
    schemaVersion: '1',
    verdict: 'failed',
    job: { id: 'j' },
    criteria: [
      { id: 'admin-c1', outcome: 'proven', evidence: [] },
      { id: 'storefront-c1', outcome: 'failed', reason: 'the command exited 1', evidence: [] },
    ],
    profiles: [
      { name: 'admin', verdict: 'passed', criteria: ['admin-c1'] },
      { name: 'storefront', verdict: 'failed', criteria: ['storefront-c1'] },
    ],
  }
}

test('the comment reports one section per app when a run checked several', () => {
  const comment = renderComment(severalResult())
  expect(comment).toContain('## QARE run: failed')
  expect(comment).toContain('### admin — verdict passed')
  expect(comment).toContain('### storefront — verdict failed')
  const sections = comment.split('### ')
  const adminSection = sections.find((section) => section.startsWith('admin —')) ?? ''
  const storefrontSection = sections.find((section) => section.startsWith('storefront —')) ?? ''
  expect(adminSection).toContain('admin-c1')
  expect(adminSection).not.toContain('storefront-c1')
  expect(storefrontSection).toContain('storefront-c1')
})

test('a profile name that carries Markdown is escaped in the heading, not rendered', () => {
  const result: RunResult = {
    ...severalResult(),
    profiles: [{ name: 'a`d|min<b>*_[x]~', verdict: 'failed', criteria: ['admin-c1'] }],
  }
  const comment = renderComment(result)
  expect(comment).toContain('### a\\`d\\|min\\<b\\>\\*\\_\\[x\\]\\~ — verdict failed')
  expect(comment).not.toContain('<b>')
  expect(comment).not.toContain('[x]')
})

test('a profile name that carries a line break cannot inject a heading below it', () => {
  const result: RunResult = {
    ...severalResult(),
    profiles: [{ name: 'admin\n## injected', verdict: 'failed', criteria: ['admin-c1'] }],
  }
  const comment = renderComment(result)
  expect(comment).toContain('### admin ## injected — verdict failed')
  expect(comment.split('\n').filter((line) => line.startsWith('### '))).toHaveLength(1)
})

test('the comment of a single-profile run has no per-app sections', () => {
  const result: RunResult = {
    schemaVersion: '1',
    verdict: 'passed',
    job: { id: 'j' },
    criteria: [{ id: 'c1', outcome: 'proven', evidence: [] }],
  }
  expect(renderComment(result)).not.toContain('###')
})

test('a named profile cannot be read from a repository whose .qa root also carries the root form', async () => {
  const job = await makeSeveralJob([
    { name: 'admin', profile: { path: '.qa/admin' }, criteria: [commandCriterion('admin-c1')] },
  ])
  await writeProfile(join(job.repoPath, '.qa', 'admin'), APP_BOOT_CONFIG)
  await writeFile(join(job.repoPath, '.qa', 'config.yml'), 'stubs: []\n', 'utf8')

  await expect(runJob(job, HEALTHY_BOOT)).rejects.toThrow(/not both/)
})
