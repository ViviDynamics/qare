import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test, vi } from 'vitest'
import {
  criterionCacheKey,
  profileFingerprint,
  renderComment,
  resolveRefSha,
  runJob,
  stableStringify,
  type CacheKeyParts,
  type Job,
  type QaProfile,
  type SeveralProfilesJob,
} from '../src/index.js'

const localUrl = (rest: string): string => ['http:', rest].join('')

// A target profile: the run boots nothing and probes the health URL once, so
// the cache, not the boot, is the only thing these tests have to set up.
const PROFILE = {
  target: { url: localUrl('//target-host:3000'), health: { http: localUrl('//target-host:3000/up'), timeout: '1s' } },
}

const BOOT = { probe: async () => ({ ok: true }) }

// A several-app run boots each group's app for real (through the compose
// seam), so this profile carries the app shape the validator demands and the
// boot stub answers the compose up and the health probe.
const APP_PROFILE = {
  app: {
    boot: { compose: 'compose.qa.yaml', service: 'admin' },
    health: { http: localUrl('//app-host:3000/up'), timeout: '5s' },
    seed: { command: 'bin/rails' },
    login: { fixture: 'fixtures/users.yml', role: 'admin' },
  },
  stubs: [],
  visual: { widths: [1440], themes: ['light'] },
  suites: [],
}
const SEVERAL_BOOT = { ...BOOT, runCompose: async () => ({ code: 0, stdout: 'up out', stderr: 'up err' }) }

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function gitRepo(): Promise<{ repo: string; base: string; head: string }> {
  const repo = await mkdtemp(join(tmpdir(), 'qare-cache-'))
  dirs.push(repo)
  execSync('git init -q', { cwd: repo })
  execSync('git config user.email t@e.st', { cwd: repo })
  execSync('git config user.name t', { cwd: repo })
  await writeFile(join(repo, 'marker.txt'), 'present\n')
  execSync('git add marker.txt', { cwd: repo })
  execSync('git commit -q -m base', { cwd: repo })
  const base = execSync('git rev-parse HEAD', { cwd: repo }).toString().trim()
  execSync('git commit -q --allow-empty -m head', { cwd: repo })
  const head = execSync('git rev-parse HEAD', { cwd: repo }).toString().trim()
  return { repo, base, head }
}

function makeJob(fields: { repo: string; base: string; head: string; runs: string[]; evidence: string; profile?: unknown }): Job {
  return {
    id: 'job-cache',
    repoPath: fields.repo,
    baseRef: fields.base,
    headRef: fields.head,
    profile: { inline: fields.profile ?? PROFILE },
    criteria: fields.runs.map((run, index) => ({
      id: `criterion-${index + 1}`,
      text: `criterion ${index + 1}`,
      checks: [{ kind: 'command' as const, run }],
    })),
    evidenceDir: join(fields.repo, fields.evidence),
    post: 'none',
  }
}

function parts(fields: Partial<CacheKeyParts>): CacheKeyParts {
  return {
    criterionId: 'criterion-1',
    checks: [{ kind: 'command', run: 'echo ok' }],
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    planHash: 'p1',
    profileHash: 'r1',
    ...fields,
  }
}

test('a second run over the same revisions replays the cached result instead of re-running', async () => {
  const { repo, base, head } = await gitRepo()
  const cache = join(repo, 'cache')
  const first = await runJob(
    makeJob({ repo, base, head, runs: ['cp marker.txt copied.txt'], evidence: 'evidence-1' }),
    { ...BOOT, cacheDir: cache },
  )
  expect(first.result.verdict).toBe('passed')
  expect(first.result.criteria[0]).not.toHaveProperty('cached')
  // The first run stores, it does not serve: no summary until there is a hit.
  expect(existsSync(join(repo, 'evidence-1', 'cache.json'))).toBe(false)

  // The marker is gone, so a re-run of the check would fail; only a replay
  // of the stored result can still prove the criterion.
  await rm(join(repo, 'marker.txt'))
  const second = await runJob(
    makeJob({ repo, base, head, runs: ['cp marker.txt copied.txt'], evidence: 'evidence-2' }),
    { ...BOOT, cacheDir: cache },
  )
  expect(second.result.verdict).toBe('passed')
  expect(second.result.criteria[0]).toMatchObject({ id: 'criterion-1', outcome: 'proven', cached: true })
  // The replayed evidence is what the original run wrote.
  expect(existsSync(join(repo, 'evidence-2', 'checks', 'criterion-1', '0', 'stdout.txt'))).toBe(true)
  expect(existsSync(join(repo, 'evidence-2', 'checks', 'criterion-1', '0', 'command.json'))).toBe(true)
  // The summary names the criterion the cache served, and the comment marks it.
  const summary = JSON.parse(await readFile(join(repo, 'evidence-2', 'cache.json'), 'utf8'))
  expect(summary.version).toBe(1)
  expect(summary.hits).toHaveLength(1)
  expect(summary.hits[0].criterion).toBe('criterion-1')
  expect(renderComment(second.result)).toContain('(cached)')
})

test('a changed check runs for real even with the cache directory of the unchanged run', async () => {
  const { repo, base, head } = await gitRepo()
  const cache = join(repo, 'cache')
  const first = await runJob(
    makeJob({ repo, base, head, runs: ['echo first'], evidence: 'evidence-1' }),
    { ...BOOT, cacheDir: cache },
  )
  expect(first.result.verdict).toBe('passed')
  const second = await runJob(
    makeJob({ repo, base, head, runs: ['echo second'], evidence: 'evidence-2' }),
    { ...BOOT, cacheDir: cache },
  )
  expect(second.result.verdict).toBe('passed')
  expect(second.result.criteria[0]).not.toHaveProperty('cached')
  const stdout = await readFile(join(repo, 'evidence-2', 'checks', 'criterion-1', '0', 'stdout.txt'), 'utf8')
  expect(stdout).toBe('second\n')
})

test('a changed profile invalidates the cached result', async () => {
  const { repo, base, head } = await gitRepo()
  const cache = join(repo, 'cache')
  const first = await runJob(
    makeJob({ repo, base, head, runs: ['echo ok'], evidence: 'evidence-1' }),
    { ...BOOT, cacheDir: cache },
  )
  expect(first.result.verdict).toBe('passed')
  const second = await runJob(
    makeJob({
      repo,
      base,
      head,
      runs: ['echo ok'],
      evidence: 'evidence-2',
      profile: { ...PROFILE, suites: [{ name: 'added', command: 'echo never', kind: 'flow' }] },
    }),
    { ...BOOT, cacheDir: cache },
  )
  expect(second.result.verdict).toBe('passed')
  expect(second.result.criteria[0]).not.toHaveProperty('cached')
})

test('a cached failure replays the failure instead of re-running', async () => {
  const { repo, base, head } = await gitRepo()
  const cache = join(repo, 'cache')
  const first = await runJob(
    makeJob({ repo, base, head, runs: ['cp no-such-source.txt copied.txt'], evidence: 'evidence-1' }),
    { ...BOOT, cacheDir: cache },
  )
  expect(first.result.verdict).toBe('failed')
  const second = await runJob(
    makeJob({ repo, base, head, runs: ['cp no-such-source.txt copied.txt'], evidence: 'evidence-2' }),
    { ...BOOT, cacheDir: cache },
  )
  expect(second.result.verdict).toBe('failed')
  expect(second.result.criteria[0]).toMatchObject({ outcome: 'failed', cached: true })
})

test('a corrupt cache entry is a miss, so the criterion runs again', async () => {
  const { repo, base, head } = await gitRepo()
  const cache = join(repo, 'cache')
  const first = await runJob(
    makeJob({ repo, base, head, runs: ['echo ok'], evidence: 'evidence-1' }),
    { ...BOOT, cacheDir: cache },
  )
  expect(first.result.verdict).toBe('passed')
  const [entry] = await readdir(cache)
  await writeFile(join(cache, entry), 'not json')
  const second = await runJob(
    makeJob({ repo, base, head, runs: ['echo ok'], evidence: 'evidence-2' }),
    { ...BOOT, cacheDir: cache },
  )
  expect(second.result.verdict).toBe('passed')
  expect(second.result.criteria[0]).not.toHaveProperty('cached')
  expect(second.result.criteria[0].outcome).toBe('proven')
})

test('a run whose refs do not resolve executes uncached and says so', async () => {
  const { repo, head } = await gitRepo()
  const cache = join(repo, 'cache')
  const errors: string[] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((message: string) => errors.push(message))
  try {
    const run = await runJob(
      makeJob({ repo, base: 'no-such-ref', head, runs: ['echo ok'], evidence: 'evidence-1' }),
      { ...BOOT, cacheDir: cache },
    )
    expect(run.result.verdict).toBe('passed')
    expect(run.result.criteria[0]).not.toHaveProperty('cached')
    expect(errors.some((message) => message.includes('caching skipped'))).toBe(true)
    // Nothing was stored: an uncached run writes no cache entries.
    expect(existsSync(cache)).toBe(false)
  } finally {
    spy.mockRestore()
  }
})

test('a several-app run merges every cache hit into one summary', async () => {
  const { repo, base, head } = await gitRepo()
  const job: SeveralProfilesJob = {
    id: 'job-cache-several',
    repoPath: repo,
    baseRef: base,
    headRef: head,
    profiles: [
      {
        name: 'one',
        profile: { inline: APP_PROFILE },
        criteria: [{ id: 'criterion-1', text: 'criterion 1', checks: [{ kind: 'command' as const, run: 'echo ok' }] }],
      },
      {
        name: 'two',
        profile: { inline: APP_PROFILE },
        criteria: [{ id: 'criterion-2', text: 'criterion 2', checks: [{ kind: 'command' as const, run: 'echo ok' }] }],
      },
    ],
    evidenceDir: join(repo, 'evidence-1'),
    post: 'none',
  }
  const first = await runJob(job, { ...SEVERAL_BOOT, cacheDir: join(repo, 'cache') })
  expect(first.result.verdict).toBe('passed')
  const second = await runJob({ ...job, evidenceDir: join(repo, 'evidence-2') }, { ...SEVERAL_BOOT, cacheDir: join(repo, 'cache') })
  expect(second.result.criteria.map((criterion) => criterion.cached)).toEqual([true, true])
  const summary = JSON.parse(await readFile(join(repo, 'evidence-2', 'cache.json'), 'utf8'))
  expect(summary.hits.map((hit: { criterion: string }) => hit.criterion)).toEqual(['criterion-1', 'criterion-2'])
})

test('resolveRefSha resolves a commit name and leaves what it cannot resolve undefined', async () => {
  const { repo, head } = await gitRepo()
  expect(await resolveRefSha(repo, 'HEAD')).toBe(head)
  expect(await resolveRefSha(repo, 'no-such-ref')).toBeUndefined()
  const notARepo = await mkdtemp(join(tmpdir(), 'qare-cache-norepo-'))
  dirs.push(notARepo)
  expect(await resolveRefSha(notARepo, 'HEAD')).toBeUndefined()
})
test('the cache key moves with every part it is over', () => {
  const baseline = criterionCacheKey(parts({}))
  expect(criterionCacheKey(parts({}))).toBe(baseline)
  expect(criterionCacheKey(parts({ criterionId: 'criterion-2' }))).not.toBe(baseline)
  expect(criterionCacheKey(parts({ checks: [{ kind: 'command', run: 'echo changed' }] }))).not.toBe(baseline)
  expect(criterionCacheKey(parts({ baseSha: 'c'.repeat(40) }))).not.toBe(baseline)
  expect(criterionCacheKey(parts({ headSha: 'd'.repeat(40) }))).not.toBe(baseline)
  expect(criterionCacheKey(parts({ planHash: 'p2' }))).not.toBe(baseline)
  expect(criterionCacheKey(parts({ profileHash: 'r2' }))).not.toBe(baseline)
})

test('stableStringify hashes meaning, not key order', () => {
  expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }))
  expect(stableStringify({ a: undefined, b: 1 })).toBe(stableStringify({ b: 1 }))
  expect(stableStringify({ a: [1, { c: 3, b: 2 }] })).toBe(stableStringify({ a: [1, { b: 2, c: 3 }] }))
})

test('the profile hash moves with the profile the run loaded', () => {
  const profile: QaProfile = { suites: [] }
  const changed: QaProfile = { suites: [{ name: 'added', command: 'echo never', kind: 'flow' }] }
  expect(profileFingerprint(profile)).not.toBe(profileFingerprint(changed))
  expect(profileFingerprint(profile)).toBe(profileFingerprint({ suites: [] }))
})
