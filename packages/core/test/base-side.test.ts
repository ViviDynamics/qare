import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
  FileLedgerStore,
  loadResult,
  runJob,
  toBaseSideResults,
  type BootOpts,
  type Job,
  type JobCriterion,
  type QaProfile,
  type RunResult,
} from '../src/index.js'

const HEALTH_URL = ['http:', '//localhost:3000/up'].join('')
// Assembled, like HEALTH_URL: no network marker sits as a literal in a test.
const TARGET_URL = ['https:', '//app.example.test'].join('')

const APP_PROFILE: QaProfile = {
  app: {
    boot: { compose: 'compose.qa.yaml', service: 'admin' },
    health: { http: HEALTH_URL, timeout: '120s' },
    seed: { command: 'bin/seed' },
    login: { fixture: 'fixtures/users.yml', role: 'admin' },
  },
  stubs: [],
  visual: { widths: [], themes: [] },
  suites: [],
}

const TARGET_PROFILE: QaProfile = {
  target: { url: TARGET_URL, health: { http: `${TARGET_URL}/up`, timeout: '1s' }, hosts: [] },
  stubs: [],
  visual: { widths: [], themes: [] },
  suites: [],
}

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

const fileCheck = (id: string, file: string): JobCriterion => ({ id, text: `${file} is there`, checks: [{ kind: 'command', run: `test -f ${file}` }] })

/** A head checkout and a base checkout, each a plain directory holding the files named. */
async function twoTrees(files: { base: string[]; head: string[] }): Promise<{ head: string; base: string }> {
  const head = await mkdtemp(join(tmpdir(), 'qare-head-'))
  const base = await mkdtemp(join(tmpdir(), 'qare-base-'))
  for (const file of files.head) await writeFile(join(head, file), 'head\n')
  for (const file of files.base) await writeFile(join(base, file), 'base\n')
  return { head, base }
}

function jobFor(repoPath: string, criteria: JobCriterion[], profile: QaProfile = APP_PROFILE): Job {
  return { id: 'job-two-sided', repoPath, baseRef: 'origin/main', headRef: 'HEAD', profile: { inline: profile }, criteria, evidenceDir: join(repoPath, 'evidence'), post: 'none' }
}

const criterionOf = (result: RunResult, id: string) => {
  const criterion = result.criteria.find((entry) => entry.id === id)
  if (criterion === undefined) throw new Error(`no criterion ${id}`)
  return criterion
}

test('a criterion that passed at the base and fails at the head is a regression, with evidence from both sides (#147)', async () => {
  const trees = await twoTrees({ base: ['old.txt'], head: ['feature.txt'] })
  const job = jobFor(trees.head, [fileCheck('old-behaviour', 'old.txt'), fileCheck('new-behaviour', 'feature.txt'), fileCheck('not-built-yet', 'later.txt')])
  const { result } = await runJob(job, { ...recordingBoot(), base: { repoPath: trees.base } })

  expect(result.verdict).toBe('failed')
  expect(result.base).toEqual({ ref: 'origin/main', status: 'executed' })

  // Worked at the base, fails at the head: a regression.
  const regressed = criterionOf(result, 'old-behaviour')
  expect(regressed).toMatchObject({ outcome: 'failed', regression: true, base: { outcome: 'proven' } })
  expect(regressed.evidence).toContain('head/checks/old-behaviour/0/command.json')
  expect(regressed.base?.evidence).toContain('base/checks/old-behaviour/0/command.json')
  for (const path of [...(regressed.evidence ?? []), ...(regressed.base?.evidence ?? [])]) expect(existsSync(join(job.evidenceDir, path))).toBe(true)
  expect(JSON.parse(await readFile(join(job.evidenceDir, 'base/checks/old-behaviour/0/command.json'), 'utf8'))).toMatchObject({ outcome: 'passed' })
  expect(JSON.parse(await readFile(join(job.evidenceDir, 'head/checks/old-behaviour/0/command.json'), 'utf8'))).toMatchObject({ outcome: 'failed' })

  // New behaviour that works: it failed at the base, and nothing regressed.
  const added = criterionOf(result, 'new-behaviour')
  expect(added).toMatchObject({ outcome: 'proven', base: { outcome: 'failed' } })
  expect('regression' in added).toBe(false)

  // New behaviour that does not work yet: failed, and not a regression.
  expect(criterionOf(result, 'not-built-yet')).toMatchObject({ outcome: 'failed', regression: false, base: { outcome: 'failed' } })

  // What is on disk is what was returned, and the judge reads a base out of it.
  const written = loadResult(await readFile(join(job.evidenceDir, 'result.json'), 'utf8'))
  expect(written).toEqual(result)
  expect(toBaseSideResults(written)).toEqual([
    { criterionId: 'old-behaviour', outcome: 'proven' },
    { criterionId: 'new-behaviour', outcome: 'failed' },
    { criterionId: 'not-built-yet', outcome: 'failed' },
  ])
  // Each side keeps its own raw result beside its evidence.
  expect(loadResult(await readFile(join(job.evidenceDir, 'base/result.json'), 'utf8')).verdict).toBe('failed')
  expect(loadResult(await readFile(join(job.evidenceDir, 'head/result.json'), 'utf8')).verdict).toBe('failed')
})

test('the two sides boot under isolations of their own, and the base is torn down before the head boots (#147)', async () => {
  const trees = await twoTrees({ base: ['old.txt'], head: ['old.txt'] })
  const boot = recordingBoot()
  const job = jobFor(trees.head, [fileCheck('kept', 'old.txt')])
  const { result, isolation } = await runJob(job, { ...boot, base: { repoPath: trees.base } })

  expect(result.verdict).toBe('passed')
  expect(criterionOf(result, 'kept')).toMatchObject({ outcome: 'proven', base: { outcome: 'proven' } })

  const verbs = boot.calls.map((args) => ({ project: args[1], file: args[3], verb: args.find((arg) => arg === 'up' || arg === 'down') }))
  expect(verbs.map((call) => call.verb)).toEqual(['up', 'down', 'up'])
  const [baseUp, baseDown, headUp] = verbs
  expect(baseUp?.project).toMatch(/^qare-/)
  expect(baseDown?.project).toBe(baseUp?.project)
  expect(headUp?.project).toMatch(/^qare-/)
  expect(headUp?.project).not.toBe(baseUp?.project)
  // The base boots from the base tree's own recipe; the head's is untouched.
  expect(baseUp?.file).toBe(join(trees.base, 'compose.qa.yaml'))
  expect(headUp?.file).toBe('compose.qa.yaml')
  // The head's app stays up for the caller, as it does on a one-sided run.
  expect(isolation?.project).toBe(headUp?.project)
  // Each side names the project it booted under.
  expect(JSON.parse(await readFile(join(job.evidenceDir, 'base/isolation.json'), 'utf8')).project).toBe(baseUp?.project)
  expect(JSON.parse(await readFile(join(job.evidenceDir, 'head/isolation.json'), 'utf8')).project).toBe(headUp?.project)
})

test('a base that will not boot is reported as such, and nothing becomes a regression (#147)', async () => {
  const trees = await twoTrees({ base: ['old.txt'], head: [] })
  const job = jobFor(trees.head, [fileCheck('old-behaviour', 'old.txt')])
  // The first `up` is the base's.
  const { result } = await runJob(job, { ...recordingBoot((call) => call === 1), base: { repoPath: trees.base } })

  expect(result.verdict).toBe('failed')
  expect(result.base).toMatchObject({ ref: 'origin/main', status: 'not-executed' })
  expect(result.base?.reason).toContain('compose up exited 1')
  const criterion = criterionOf(result, 'old-behaviour')
  expect(criterion).toMatchObject({ outcome: 'failed', base: { outcome: 'not-compared' } })
  expect(criterion.base?.reason).toContain('the base side did not run')
  expect('regression' in criterion).toBe(false)
  expect(toBaseSideResults(result)).toEqual([])
})

test('a criterion that cannot run at the base is not compared, and never a regression (#147)', async () => {
  const trees = await twoTrees({ base: [], head: [] })
  // The directory the check runs in exists only at the head: new behaviour.
  await mkdir(join(trees.head, 'feature'))
  const job = jobFor(trees.head, [{ id: 'in-new-dir', text: 'the feature ships its file', checks: [{ kind: 'command', run: 'test -f shipped.txt', cwd: 'feature' }] }])
  const { result } = await runJob(job, { ...recordingBoot(), base: { repoPath: trees.base } })

  expect(result.base).toEqual({ ref: 'origin/main', status: 'executed' })
  const criterion = criterionOf(result, 'in-new-dir')
  expect(criterion).toMatchObject({ outcome: 'failed', base: { outcome: 'not-compared' } })
  expect(criterion.base?.reason).toMatch(/^unverified at the base: /)
  expect('regression' in criterion).toBe(false)
})

test('a target profile stays head-only, and says so (#147, #122)', async () => {
  const trees = await twoTrees({ base: ['old.txt'], head: ['old.txt'] })
  const job = jobFor(trees.head, [fileCheck('kept', 'old.txt')], TARGET_PROFILE)
  let asked = 0
  const { result } = await runJob(job, {
    probe: async () => ({ ok: true }),
    pollIntervalMs: 1,
    base: {
      checkout: async () => {
        asked += 1
        return { ok: false, reason: 'never asked' }
      },
    },
  })

  expect(asked).toBe(0)
  expect(result.base).toBeUndefined()
  expect(result.target).toEqual({ url: TARGET_URL, comparison: 'none' })
  const criterion = criterionOf(result, 'kept')
  expect(criterion.base).toBeUndefined()
  // One side, so the evidence sits where a one-sided run puts it.
  expect(criterion.evidence).toContain('checks/kept/0/command.json')
  expect(existsSync(join(job.evidenceDir, 'base'))).toBe(false)
})

test('a run that is not asked for a base side runs one side, as before (#147)', async () => {
  const trees = await twoTrees({ base: [], head: ['old.txt'] })
  const job = jobFor(trees.head, [fileCheck('kept', 'old.txt')])
  const { result } = await runJob(job, recordingBoot())
  expect(result.base).toBeUndefined()
  expect(criterionOf(result, 'kept').evidence).toContain('checks/kept/0/command.json')
})

test('without a base checkout the head still runs, and every criterion is not compared (#147)', async () => {
  const trees = await twoTrees({ base: [], head: [] })
  const job = jobFor(trees.head, [fileCheck('missing', 'old.txt')])
  // The head directory is no git repository and no checkout is handed in.
  const { result } = await runJob(job, { ...recordingBoot(), base: {} })

  expect(result.verdict).toBe('failed')
  expect(result.base?.status).toBe('not-executed')
  expect(result.base?.reason).toContain('does not name a commit')
  const criterion = criterionOf(result, 'missing')
  expect(criterion).toMatchObject({ outcome: 'failed', base: { outcome: 'not-compared' } })
  expect(criterion.evidence).toContain('head/checks/missing/0/command.json')
  expect('regression' in criterion).toBe(false)
})

test('a base side that throws stops nothing: the head runs and the reason is named (#147)', async () => {
  const trees = await twoTrees({ base: [], head: ['old.txt'] })
  const job = jobFor(trees.head, [fileCheck('kept', 'old.txt')])
  const { result } = await runJob(job, {
    ...recordingBoot(),
    base: {
      checkout: async () => {
        throw new Error('disk full')
      },
    },
  })
  expect(result.verdict).toBe('passed')
  expect(result.base).toEqual({ ref: 'origin/main', status: 'not-executed', reason: 'the base side stopped before it finished: disk full' })
  expect(criterionOf(result, 'kept')).toMatchObject({ outcome: 'proven', base: { outcome: 'not-compared' } })
})

test('the profile can limit the base side to the criteria the ledger at the base already carries (#147)', async () => {
  const trees = await twoTrees({ base: ['old.txt'], head: [] })
  await new FileLedgerStore(join(trees.base, '.qa')).save([{ criterion: 'LED-1', status: 'active', source: ['#1'], proof: 'command' }])
  const job = jobFor(trees.head, [fileCheck('LED-1', 'old.txt'), fileCheck('issue-9-1', 'old.txt')], { ...APP_PROFILE, base: { criteria: 'ledger' } })
  const { result } = await runJob(job, { ...recordingBoot(), base: { repoPath: trees.base } })

  expect(criterionOf(result, 'LED-1')).toMatchObject({ outcome: 'failed', regression: true, base: { outcome: 'proven' } })
  const fresh = criterionOf(result, 'issue-9-1')
  // It would have been proven at the base, and it was not run there: not
  // compared, never passed, never a regression.
  expect(fresh).toMatchObject({ outcome: 'failed', base: { outcome: 'not-compared' } })
  expect(fresh.base?.reason).toContain('ledger')
  expect('regression' in fresh).toBe(false)
  expect(existsSync(join(job.evidenceDir, 'base/checks/issue-9-1'))).toBe(false)
  expect(existsSync(join(job.evidenceDir, 'base/checks/LED-1'))).toBe(true)
})

test('a ledger limit that leaves nothing to run boots no base at all (#147)', async () => {
  const trees = await twoTrees({ base: ['old.txt'], head: ['old.txt'] })
  const boot = recordingBoot()
  const job = jobFor(trees.head, [fileCheck('issue-9-1', 'old.txt')], { ...APP_PROFILE, base: { criteria: 'ledger' } })
  const { result } = await runJob(job, { ...boot, base: { repoPath: trees.base } })

  expect(result.base?.status).toBe('not-executed')
  expect(result.base?.reason).toContain('ledger')
  expect(boot.calls.filter((args) => args.includes('up'))).toHaveLength(1)
  expect(criterionOf(result, 'issue-9-1')).toMatchObject({ outcome: 'proven', base: { outcome: 'not-compared' } })
})

test('the profile can bound the base side by a time budget; what did not run is not compared (#147)', async () => {
  const trees = await twoTrees({ base: ['old.txt'], head: [] })
  const job = jobFor(trees.head, [fileCheck('old-behaviour', 'old.txt')], { ...APP_PROFILE, base: { budget: '0s' } })
  const { result } = await runJob(job, { ...recordingBoot(), base: { repoPath: trees.base } })

  const criterion = criterionOf(result, 'old-behaviour')
  expect(criterion).toMatchObject({ outcome: 'failed', base: { outcome: 'not-compared' } })
  expect(criterion.base?.reason).toContain('budget of 0s')
  expect('regression' in criterion).toBe(false)
  expect(existsSync(join(job.evidenceDir, 'base/checks/old-behaviour'))).toBe(false)
})

test('a result cached at the base is never served to the head, and the run makes its own base checkout (#147, #47)', async () => {
  // A real repository: the criterion's file is there at the first commit and
  // gone at the second, and the run checks the base out itself.
  const repo = await mkdtemp(join(tmpdir(), 'qare-two-commits-'))
  const git = (...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=qare test', '-c', 'user.email=qare@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' })
  git('init', '--quiet', '--initial-branch=main')
  await writeFile(join(repo, 'old.txt'), 'base\n')
  git('add', '.')
  git('commit', '--quiet', '-m', 'before')
  git('rm', '--quiet', 'old.txt')
  git('commit', '--quiet', '-m', 'after')
  const job: Job = { ...jobFor(repo, [fileCheck('old-behaviour', 'old.txt')]), baseRef: 'HEAD~1', evidenceDir: await mkdtemp(join(tmpdir(), 'qare-evidence-')) }
  const cacheDir = await mkdtemp(join(tmpdir(), 'qare-cache-'))

  const { result } = await runJob(job, { ...recordingBoot(), cacheDir, base: {} })
  // Both sides resolve the same two revisions, so their cache keys are equal:
  // a shared store would hand the head the base's proven result.
  expect(criterionOf(result, 'old-behaviour')).toMatchObject({ outcome: 'failed', regression: true, base: { outcome: 'proven' } })
  // The worktree the run made is gone again.
  expect(git('worktree', 'list').trim().split('\n')).toHaveLength(1)

  // A second run replays each side from its own cache.
  const again = await runJob({ ...job, evidenceDir: await mkdtemp(join(tmpdir(), 'qare-evidence-')) }, { ...recordingBoot(), cacheDir, base: {} })
  expect(criterionOf(again.result, 'old-behaviour')).toMatchObject({ outcome: 'failed', cached: true, regression: true, base: { outcome: 'proven' } })
})

test('a run over several apps compares each app with its own base (#147, #55)', async () => {
  const trees = await twoTrees({ base: ['admin.txt', 'shop.txt'], head: ['shop.txt'] })
  const job: Job = {
    id: 'job-two-sided-apps',
    repoPath: trees.head,
    baseRef: 'origin/main',
    headRef: 'HEAD',
    profiles: [
      { name: 'admin', profile: { inline: APP_PROFILE }, criteria: [fileCheck('admin-page', 'admin.txt')] },
      { name: 'shop', profile: { inline: APP_PROFILE }, criteria: [fileCheck('shop-page', 'shop.txt')] },
    ],
    evidenceDir: join(trees.head, 'evidence'),
    post: 'none',
  }
  const boot = recordingBoot()
  const { result } = await runJob(job, { ...boot, base: { repoPath: trees.base } })

  expect(result.verdict).toBe('failed')
  expect(criterionOf(result, 'admin-page')).toMatchObject({ outcome: 'failed', regression: true, base: { outcome: 'proven' } })
  expect(criterionOf(result, 'shop-page')).toMatchObject({ outcome: 'proven', base: { outcome: 'proven' } })
  expect(result.profiles?.map((profile) => profile.verdict)).toEqual(['failed', 'passed'])
  // Two apps at the base, both torn down, then two at the head.
  expect(boot.calls.map((args) => args.find((arg) => arg === 'up' || arg === 'down'))).toEqual(['up', 'up', 'down', 'down', 'up', 'up'])
})

test('a profile can turn the base side off: no checkout, no boot, and the run says it had one side (#147)', async () => {
  const trees = await twoTrees({ base: ['old.txt'], head: [] })
  const boot = recordingBoot()
  let asked = 0
  const job = jobFor(trees.head, [fileCheck('old-behaviour', 'old.txt')], { ...APP_PROFILE, base: { criteria: 'none' } })
  const { result } = await runJob(job, {
    ...boot,
    base: {
      checkout: async () => {
        asked += 1
        return { ok: false, reason: 'never asked' }
      },
    },
  })

  expect(asked).toBe(0)
  expect(boot.calls.filter((args) => args.includes('up'))).toHaveLength(1)
  expect(result.base).toEqual({ ref: 'origin/main', status: 'not-executed', reason: 'the profile runs no criteria at the base (base.criteria: none)' })
  const criterion = criterionOf(result, 'old-behaviour')
  expect(criterion).toMatchObject({ outcome: 'failed', base: { outcome: 'not-compared' } })
  expect('regression' in criterion).toBe(false)
})

const validProfileDir = fileURLToPath(new URL('../fixtures/qa-valid/.qa', import.meta.url))

test('the base boots from the base tree\'s own profile: a base without one is not compared (#147)', async () => {
  const trees = await twoTrees({ base: ['old.txt'], head: [] })
  // The head carries a profile on disk, named by an absolute path as the CLI
  // names it; the base revision predates it.
  await cp(validProfileDir, join(trees.head, '.qa'), { recursive: true })
  const job: Job = { ...jobFor(trees.head, [fileCheck('old-behaviour', 'old.txt')]), profile: { path: join(trees.head, '.qa') } }
  const boot = recordingBoot()
  const { result } = await runJob(job, { ...boot, base: { repoPath: trees.base } })

  expect(result.base?.status).toBe('not-executed')
  expect(result.base?.reason).toContain('the base revision has no usable .qa/ profile')
  // The reason names the base tree, so the profile was looked for there and not at the head.
  expect(result.base?.reason).toContain(join(trees.base, '.qa'))
  expect(boot.calls.filter((args) => args.includes('up'))).toHaveLength(1)
  expect(criterionOf(result, 'old-behaviour')).toMatchObject({ outcome: 'failed', base: { outcome: 'not-compared' } })
})

test('a base whose profile names a running target boots nothing, so nothing is compared with it (#147)', async () => {
  const trees = await twoTrees({ base: ['old.txt'], head: [] })
  await cp(validProfileDir, join(trees.head, '.qa'), { recursive: true })
  await mkdir(join(trees.base, '.qa'))
  await writeFile(join(trees.base, '.qa', 'QA.md'), 'The deployed site.\n')
  await writeFile(join(trees.base, '.qa', 'config.yml'), `target:\n  url: ${TARGET_URL}\n  health: { http: /up, timeout: 1s }\n`)
  const job: Job = { ...jobFor(trees.head, [fileCheck('old-behaviour', 'old.txt')]), profile: { path: '.qa' } }
  const { result } = await runJob(job, { ...recordingBoot(), base: { repoPath: trees.base } })

  expect(result.base?.status).toBe('not-executed')
  expect(result.base?.reason).toContain('names a running target')
  expect(existsSync(join(job.evidenceDir, 'base/checks'))).toBe(false)
  expect('regression' in criterionOf(result, 'old-behaviour')).toBe(false)
})
