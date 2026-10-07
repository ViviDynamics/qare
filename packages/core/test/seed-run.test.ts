import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { loadProfile, runJob, type BootOpts, type Job, type JobCriterion, type QaProfile } from '../src/index.js'

// Test files carry no network literals (the offline scanner), so the URL is joined at runtime.
const HEALTH_URL = ['http:', '//localhost:3000/up'].join('')

function profileSeededBy(command: string, timeout?: string): QaProfile {
  return {
    app: {
      boot: { compose: 'compose.qa.yaml', service: 'web' },
      health: { http: HEALTH_URL, timeout: '120s' },
      seed: { command, ...(timeout === undefined ? {} : { timeout }) },
      login: { fixture: 'fixtures/users.yml', role: 'admin' },
    },
    stubs: [],
    suites: [],
    visual: { widths: [], themes: [] },
  }
}

/** A boot seam whose app comes up, recording every compose call it was asked for. */
function bootSeam(): BootOpts & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    runCompose: async (args) => {
      calls.push(args)
      return { code: 0, stdout: '', stderr: '' }
    },
    probe: async () => ({ ok: true }),
    pollIntervalMs: 1,
  }
}

async function makeRepo(scripts: Record<string, string>): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), 'qare-seed-'))
  for (const [name, body] of Object.entries(scripts)) await writeFile(join(repoPath, name), body, 'utf8')
  return repoPath
}

function jobIn(repoPath: string, profile: QaProfile, criteria: JobCriterion[]): Job {
  return { id: 'job-seed', repoPath, baseRef: 'main', headRef: 'HEAD', profile: { inline: profile }, criteria, evidenceDir: join(repoPath, 'evidence'), post: 'none' }
}

// The seed writes what the app would hold; the check reads it. A check that
// ran before the seed would find nothing and fail.
const SEED_SCRIPT = [
  "import { writeFileSync } from 'node:fs'",
  "writeFileSync('seeded.txt', `run ${process.argv[2]} port ${process.env.QARE_APP_PORT} id ${process.env.QARE_RUN_ID}\\n`)",
  "console.log('seeded the admin fixture')",
].join('\n')

test("a run against a booted app executes the profile's seed command before its first check (#240)", async () => {
  const repoPath = await makeRepo({ 'seed.mjs': SEED_SCRIPT })
  const boot = bootSeam()
  const job = jobIn(repoPath, profileSeededBy('node seed.mjs {{run.id}}'), [
    { id: 'reads-the-seed', text: 'the check finds what the seed planted', checks: [{ kind: 'command', run: 'test -f seeded.txt' }] },
  ])

  const { result, isolation } = await runJob(job, boot)

  expect(result.verdict).toBe('passed')
  // Run values were substituted, and the seed saw the run's compose environment.
  const planted = await readFile(join(repoPath, 'seeded.txt'), 'utf8')
  expect(planted).toBe(`run ${isolation?.runId} port ${isolation?.port} id ${isolation?.runId}\n`)
  // What the seed did is evidence the harness wrote, on a run that passed too.
  const log = await readFile(join(job.evidenceDir, 'seed.log'), 'utf8')
  expect(log).toContain(`$ node seed.mjs ${isolation?.runId}`)
  expect(log).toContain('seeded the admin fixture')
  expect(log).toContain('[exit 0]')
  // Once per booted app: one up, one seed.
  expect(boot.calls.filter((args) => args.includes('up'))).toHaveLength(1)
})

test('a seed command that fails ends the run with every criterion unverified, naming the command and its exit code (#240)', async () => {
  const repoPath = await makeRepo({ 'seed.mjs': "console.log('connecting'); console.error('PG::ConnectionBad: no such database'); process.exit(3)" })
  const job = jobIn(repoPath, profileSeededBy('node seed.mjs'), [
    // The first check would leave a mark if it ran.
    { id: 'first', text: 'first', checks: [{ kind: 'command', run: 'touch ran.txt' }] },
    { id: 'second', text: 'second', checks: [{ kind: 'command', run: 'true' }] },
  ])

  const { result } = await runJob(job, bootSeam())

  expect(result.verdict).toBe('blocked')
  expect(result.criteria.map((criterion) => criterion.outcome)).toEqual(['unverified', 'unverified'])
  for (const criterion of result.criteria) {
    if (criterion.outcome !== 'unverified') throw new Error('every criterion is unverified')
    expect(criterion.reason).toContain('the seed command exited 3')
    expect(criterion.reason).toContain('node seed.mjs')
    expect(criterion.evidence).toEqual(['seed.log'])
  }
  const log = await readFile(join(job.evidenceDir, 'seed.log'), 'utf8')
  expect(log).toContain('connecting')
  expect(log).toContain('PG::ConnectionBad: no such database')
  expect(log).toContain('[exited 3]')
  // No check ran against the app that was not seeded.
  expect(existsSync(join(repoPath, 'ran.txt'))).toBe(false)
})

test('a seed that outlives its bound blocks the run naming the bound (#240)', async () => {
  const repoPath = await makeRepo({ 'seed.mjs': 'setTimeout(() => {}, 60000)' })
  const job = jobIn(repoPath, profileSeededBy('node seed.mjs', '200ms'), [{ id: 'only', text: 'only', checks: [{ kind: 'command', run: 'true' }] }])

  const { result } = await runJob(job, bootSeam())

  expect(result.verdict).toBe('blocked')
  const [criterion] = result.criteria
  if (criterion?.outcome !== 'unverified') throw new Error('the criterion is unverified')
  expect(criterion.reason).toContain('the seed command did not finish within 200ms (app.seed.timeout)')
})

test('a seed whose program is not there blocks the run, and no criterion is failed (#240)', async () => {
  const repoPath = await makeRepo({})
  const job = jobIn(repoPath, profileSeededBy('bin/no-such-seed'), [{ id: 'only', text: 'only', checks: [{ kind: 'command', run: 'true' }] }])

  const { result } = await runJob(job, bootSeam())

  expect(result.verdict).toBe('blocked')
  const [criterion] = result.criteria
  if (criterion?.outcome !== 'unverified') throw new Error('the criterion is unverified')
  expect(criterion.reason).toContain('the seed command could not run')
  expect(criterion.reason).toContain('bin/no-such-seed')
})

test('a seed that needs a shell refuses the run before anything boots (#240)', async () => {
  const repoPath = await makeRepo({})
  const boot = bootSeam()
  const job = jobIn(repoPath, profileSeededBy('bin/migrate && bin/seed'), [{ id: 'only', text: 'only', checks: [{ kind: 'command', run: 'true' }] }])

  const { result } = await runJob(job, boot)

  expect(result.verdict).toBe('refused')
  const [criterion] = result.criteria
  if (criterion?.outcome !== 'unverified') throw new Error('the criterion is unverified')
  expect(criterion.reason).toContain('app.seed.command')
  expect(criterion.reason).toContain('spawned without a shell')
  expect(boot.calls).toEqual([])
})

test('an app that does not come up is never seeded (#240)', async () => {
  const repoPath = await makeRepo({ 'seed.mjs': SEED_SCRIPT })
  const job = jobIn(repoPath, profileSeededBy('node seed.mjs x'), [{ id: 'only', text: 'only', checks: [{ kind: 'command', run: 'true' }] }])

  const { result } = await runJob(job, { runCompose: async () => ({ code: 1, stdout: '', stderr: 'no such service' }), probe: async () => ({ ok: true }), pollIntervalMs: 1 })

  expect(result.verdict).toBe('blocked')
  expect(existsSync(join(repoPath, 'seeded.txt'))).toBe(false)
  expect(existsSync(join(job.evidenceDir, 'seed.log'))).toBe(false)
})

test('each app of a several-app run is seeded by its own command, and one that fails blocks only its own criteria (#240)', async () => {
  const repoPath = await makeRepo({
    'seed-a.mjs': "import { writeFileSync } from 'node:fs'\nwriteFileSync('a.txt', '')",
    'seed-b.mjs': "console.error('b has no database'); process.exit(7)",
  })
  const job: Job = {
    id: 'job-seed-several',
    repoPath,
    baseRef: 'main',
    headRef: 'HEAD',
    profiles: [
      { name: 'a', profile: { inline: profileSeededBy('node seed-a.mjs') }, criteria: [{ id: 'a-reads', text: 'a', checks: [{ kind: 'command', run: 'test -f a.txt' }] }] },
      { name: 'b', profile: { inline: profileSeededBy('node seed-b.mjs') }, criteria: [{ id: 'b-reads', text: 'b', checks: [{ kind: 'command', run: 'true' }] }] },
    ],
    evidenceDir: join(repoPath, 'evidence'),
    post: 'none',
  }

  const { result } = await runJob(job, bootSeam())

  const byId = new Map(result.criteria.map((criterion) => [criterion.id, criterion]))
  expect(byId.get('a-reads')?.outcome).toBe('proven')
  const b = byId.get('b-reads')
  if (b?.outcome !== 'unverified') throw new Error('b is unverified')
  expect(b.reason).toContain('the seed command exited 7')
  expect(b.evidence).toEqual(['seed-b.log'])
  expect(await readFile(join(job.evidenceDir, 'seed-b.log'), 'utf8')).toContain('b has no database')
  expect(await readFile(join(job.evidenceDir, 'seed-a.log'), 'utf8')).toContain('[exit 0]')
})

test('a criterion that boots an app of its own has that app seeded too (#240)', async () => {
  const repoPath = await makeRepo({
    'seed.mjs': "import { appendFileSync } from 'node:fs'\nappendFileSync('seeds.txt', `${process.env.QARE_RUN_ID}\\n`)",
  })
  const boot = bootSeam()
  const job = jobIn(repoPath, profileSeededBy('node seed.mjs'), [
    { id: 'shared', text: 'shared', checks: [{ kind: 'command', run: 'test -f seeds.txt' }] },
    { id: 'own', text: 'own', isolated: true, checks: [{ kind: 'command', run: 'test -f seeds.txt' }] },
  ])

  const { result, isolation } = await runJob(job, boot)

  expect(result.criteria.map((criterion) => criterion.outcome)).toEqual(['proven', 'proven'])
  // Two apps came up, and each was seeded once, under its own run id.
  const seeded = (await readFile(join(repoPath, 'seeds.txt'), 'utf8')).trim().split('\n')
  expect(seeded).toHaveLength(2)
  expect(new Set(seeded).size).toBe(2)
  expect(seeded).toContain(isolation?.runId)
  expect(await readFile(join(job.evidenceDir, 'checks', 'own', 'seed.log'), 'utf8')).toContain('[exit 0]')
})

test('the base side is seeded too, from its own checkout and under its own run id (#240)', async () => {
  const script = "import { writeFileSync } from 'node:fs'\nwriteFileSync('seeded.txt', process.env.QARE_RUN_ID ?? '')"
  const head = await makeRepo({ 'seed.mjs': script })
  const base = await makeRepo({ 'seed.mjs': script })
  const boot = bootSeam()
  const job = jobIn(head, profileSeededBy('node seed.mjs'), [{ id: 'reads-the-seed', text: 'seeded', checks: [{ kind: 'command', run: 'test -f seeded.txt' }] }])

  const { result, isolation } = await runJob(job, { ...boot, base: { repoPath: base } })

  expect(result.base?.status).toBe('executed')
  expect(result.criteria[0]).toMatchObject({ outcome: 'proven', base: { outcome: 'proven' } })
  const atHead = await readFile(join(head, 'seeded.txt'), 'utf8')
  const atBase = await readFile(join(base, 'seeded.txt'), 'utf8')
  expect(atHead).toBe(isolation?.runId)
  expect(atBase).not.toBe('')
  expect(atBase).not.toBe(atHead)
  // Each side's seed log is in that side's evidence.
  expect(await readFile(join(job.evidenceDir, 'head', 'seed.log'), 'utf8')).toContain('[exit 0]')
  expect(await readFile(join(job.evidenceDir, 'base', 'seed.log'), 'utf8')).toContain('[exit 0]')
})

test('a seed that fails at the base leaves the base not executed, with its log kept, and the head is checked (#240)', async () => {
  const head = await makeRepo({ 'seed.mjs': "import { writeFileSync } from 'node:fs'\nwriteFileSync('seeded.txt', '')" })
  const base = await makeRepo({ 'seed.mjs': "console.error('the base has no such task'); process.exit(4)" })
  const job = jobIn(head, profileSeededBy('node seed.mjs'), [{ id: 'reads-the-seed', text: 'seeded', checks: [{ kind: 'command', run: 'test -f seeded.txt' }] }])

  const { result } = await runJob(job, { ...bootSeam(), base: { repoPath: base } })

  expect(result.verdict).toBe('passed')
  expect(result.base?.status).toBe('not-executed')
  expect(result.base?.reason).toContain('the seed command exited 4')
  expect(result.criteria[0]).toMatchObject({ outcome: 'proven', base: { outcome: 'not-compared', evidence: ['base/seed.log'] } })
  expect(await readFile(join(job.evidenceDir, 'base', 'seed.log'), 'utf8')).toContain('the base has no such task')
})

test('a criterion named like an app keeps its own seed log apart from the app\'s (#240)', async () => {
  const repoPath = await makeRepo({ 'seed.mjs': "console.log(`seeded ${process.env.QARE_RUN_ID}`)" })
  const job: Job = {
    id: 'job-seed-names',
    repoPath,
    baseRef: 'main',
    headRef: 'HEAD',
    profiles: [
      {
        name: 'admin',
        profile: { inline: profileSeededBy('node seed.mjs') },
        criteria: [{ id: 'admin', text: 'admin', isolated: true, checks: [{ kind: 'command', run: 'true' }] }],
      },
    ],
    evidenceDir: join(repoPath, 'evidence'),
    post: 'none',
  }

  const { result } = await runJob(job, bootSeam())

  expect(result.criteria[0]?.outcome).toBe('proven')
  const app = await readFile(join(job.evidenceDir, 'seed-admin.log'), 'utf8')
  const own = await readFile(join(job.evidenceDir, 'checks', 'admin', 'seed.log'), 'utf8')
  expect(app).toContain('[exit 0]')
  expect(own).toContain('[exit 0]')
  expect(own).not.toBe(app)
})

test('the profile loader reads app.seed.timeout and refuses one that is not a duration (#240)', async () => {
  const write = async (seed: string): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), 'qare-seed-profile-'))
    await mkdir(join(root, '.qa', 'fixtures'), { recursive: true })
    await mkdir(join(root, '.qa', 'stubs'), { recursive: true })
    await writeFile(join(root, '.qa', 'fixtures', 'users.yml'), '', 'utf8')
    await writeFile(join(root, '.qa', 'QA.md'), 'the app', 'utf8')
    await writeFile(
      join(root, '.qa', 'config.yml'),
      [
        'app:',
        '  boot: { compose: compose.qa.yaml, service: web }',
        `  health: { http: "${HEALTH_URL}", timeout: 120s }`,
        `  seed: ${seed}`,
        '  login: { fixture: fixtures/users.yml, role: admin }',
        'stubs: []',
        'visual: { widths: [], themes: [] }',
        'suites: []',
        '',
      ].join('\n'),
      'utf8',
    )
    return join(root, '.qa')
  }
  expect((await loadProfile(await write('{ command: bin/seed, timeout: 10m }'))).app?.seed).toEqual({ command: 'bin/seed', timeout: '10m' })
  expect((await loadProfile(await write('{ command: bin/seed }'))).app?.seed).toEqual({ command: 'bin/seed' })
  await expect(loadProfile(await write('{ command: bin/seed, timeout: soon }'))).rejects.toThrow(/app\.seed\.timeout/)
})
