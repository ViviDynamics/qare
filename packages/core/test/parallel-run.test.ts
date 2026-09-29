import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { runJob, shardCriteria, type BootOpts, type Job, type JobCriterion, type JobProfileRef, type QaProfile } from '../src/index.js'

const HEALTH_URL = ['http:', '//localhost:3000/up'].join('')

const INLINE_PROFILE: QaProfile = {
  app: {
    boot: { compose: 'compose.qa.yaml', service: 'admin' },
    health: { http: HEALTH_URL, timeout: '120s' },
    seed: { command: 'bin/rails db:seed:qa' },
    login: { fixture: 'fixtures/users.yml', role: 'admin' },
  },
  stubs: [],
  suites: [],
  visual: { widths: [1440, 390], themes: ['light', 'dark'] },
}

const TARGET_PROFILE: QaProfile = {
  target: { url: HEALTH_URL, health: { http: '/up', timeout: '1s' } },
  stubs: [],
  suites: [],
  visual: { widths: [390], themes: ['light'] },
}

function commandCriteria(...runs: string[]): JobCriterion[] {
  return runs.map((run, index) => ({
    id: `criterion-${index + 1}`,
    text: `criterion ${index + 1}`,
    checks: [{ kind: 'command', run }],
  }))
}

const SUIT = { runCompose: async () => ({ code: 0, stdout: 'up out', stderr: 'up err' }), probe: async () => ({ ok: true }), pollIntervalMs: 1 }

async function makeJob(fields: { criteria: JobCriterion[]; profile: JobProfileRef }): Promise<Job> {
  const repoPath = await mkdtemp(join(tmpdir(), 'qare-parallel-'))
  return {
    id: 'job-parallel-smoke',
    repoPath,
    baseRef: 'main',
    headRef: 'HEAD~1',
    profile: fields.profile,
    criteria: fields.criteria,
    evidenceDir: join(repoPath, 'evidence'),
    post: 'none',
  }
}

test('independent criteria are dealt round-robin over the workers in plan order', () => {
  const criteria = commandCriteria('echo one', 'echo two', 'echo three', 'echo four', 'echo five', 'echo six')
  const lanes = shardCriteria(criteria, 3, new Set())
  expect(lanes.sequential).toEqual([])
  expect(lanes.shared.map((slice) => slice.map((index) => criteria[index]?.id ?? 'gone'))).toEqual([
    ['criterion-1', 'criterion-4'],
    ['criterion-2', 'criterion-5'],
    ['criterion-3', 'criterion-6'],
  ])
})

test('one worker is the serial run: every criterion in plan order on the one worker', () => {
  const criteria = commandCriteria('echo one', 'echo two')
  const lanes = shardCriteria(criteria, 1, new Set())
  expect(lanes.shared).toEqual([[0, 1]])
  expect(lanes.sequential).toEqual([])
})

test('criteria that hand values through mail artefacts keep plan order in the sequential lane', () => {
  const mail: JobCriterion = {
    id: 'mail-1',
    text: 'the reset link arrives',
    checks: [{ kind: 'mail', address: 'qare-run@localhost', subject: 'reset' }],
  }
  const consumer: JobCriterion = {
    id: 'flow-1',
    text: 'the flow opens the link',
    checks: [{ kind: 'flow', suite: 'browser-e2e', actions: [{ action: 'open', url: '{{mail.reset.link}}' }] }],
  }
  const secondConsumer: JobCriterion = {
    id: 'flow-2',
    text: 'the flow opens the second link',
    checks: [{ kind: 'flow', suite: 'browser-e2e', actions: [{ action: 'open', url: '{{mail.reset.code}}' }] }],
  }
  const shared = commandCriteria('echo shared')
  const lanes = shardCriteria([consumer, shared, mail, secondConsumer], 4, new Set())
  expect(lanes.shared).toEqual([[], [1], [], []])
  expect(lanes.sequential.map((entry) => ({ index: entry.index, ownBoot: entry.ownBoot }))).toEqual([
    { index: 0, ownBoot: false },
    { index: 2, ownBoot: false },
    { index: 3, ownBoot: false },
  ])
})

test('a criterion the job declares isolated runs against an app of its own', () => {
  const criteria = [...commandCriteria('echo shared'), { id: 'mutator-1', text: 'it mutates', checks: [{ kind: 'command', run: 'echo mutate' }], isolated: true }]
  const lanes = shardCriteria(criteria, 2, new Set())
  expect(lanes.shared).toEqual([[0], []])
  expect(lanes.sequential).toEqual([{ index: 1, ownBoot: true }])
})

test('a criterion checked by an isolated suite runs against an app of its own', () => {
  const criteria: JobCriterion[] = [
    { id: 'suite-run', text: 'the suite passes', checks: [{ kind: 'flow', suite: 'heavy-e2e' }] },
    ...commandCriteria('echo shared'),
  ]
  const lanes = shardCriteria(criteria, 2, new Set(['heavy-e2e']))
  expect(lanes.shared).toEqual([[], [1]])
  expect(lanes.sequential).toEqual([{ index: 0, ownBoot: true }])
})

test('a sharded run boots the shared app once and returns the verdicts in plan order', async () => {
  const ups: Array<{ args: string[]; env: Record<string, string> | undefined }> = []
  const captured: BootOpts = {
    ...SUIT,
    runCompose: async (args, _timeoutMs, env) => {
      ups.push({ args, env })
      return { code: 0, stdout: 'up out', stderr: '' }
    },
  }
  const job = await makeJob({
    criteria: commandCriteria('echo one', 'echo two', 'echo three', 'echo four'),
    profile: { inline: INLINE_PROFILE },
  })

  const { result } = await runJob(job, { ...captured, workers: 3 })

  expect(result.verdict).toBe('passed')
  expect(result.criteria.map((criterion) => criterion.id)).toEqual(['criterion-1', 'criterion-2', 'criterion-3', 'criterion-4'])
  expect(result.criteria.every((criterion) => criterion.outcome === 'proven')).toBe(true)
  // The app boots once for the whole run: the workers reuse it, and every
  // criterion that shares no state with its neighbours runs against it.
  expect(ups.length).toBe(1)
})

test('a run with one worker behaves exactly as the serial run does', async () => {
  const ups: unknown[] = []
  const captured: BootOpts = {
    ...SUIT,
    runCompose: async (args) => {
      ups.push(args)
      return { code: 0, stdout: 'up out', stderr: '' }
    },
  }
  const job = await makeJob({ criteria: commandCriteria('echo one', 'echo two'), profile: { inline: INLINE_PROFILE } })

  const { result } = await runJob(job, { ...captured, workers: 1 })

  expect(result.verdict).toBe('passed')
  expect(result.criteria.map((criterion) => criterion.outcome)).toEqual(['proven', 'proven'])
  expect(ups.length).toBe(1)
})

test('an isolated criterion boots an app of its own, records it, and tears it down', async () => {
  const ups: Array<{ args: string[]; env: Record<string, string> | undefined }> = []
  const downs: Array<string | undefined> = []
  const captured: BootOpts = {
    ...SUIT,
    runCompose: async (args, _timeoutMs, env) => {
      if (args.includes('down')) downs.push(env?.QARE_RUN_ID)
      else ups.push({ args, env })
      return { code: 0, stdout: 'up out', stderr: '' }
    },
  }
  const criteria: JobCriterion[] = [
    ...commandCriteria('echo shared'),
    { id: 'mutator-1', text: 'it mutates', checks: [{ kind: 'command', run: 'echo mutate' }], isolated: true },
  ]
  const job = await makeJob({ criteria, profile: { inline: INLINE_PROFILE } })

  const { result } = await runJob(job, { ...captured, workers: 2 })

  expect(result.verdict).toBe('passed')
  // One app for the run, one app for the criterion that mutates.
  expect(ups.length).toBe(2)
  const runIsolation = JSON.parse(await readFile(join(job.evidenceDir, 'isolation.json'), 'utf8')) as Record<string, string>
  const shardIsolation = JSON.parse(await readFile(join(job.evidenceDir, 'isolation-mutator-1.json'), 'utf8')) as Record<string, string>
  expect(shardIsolation.run_id).not.toBe(runIsolation.run_id)
  expect(shardIsolation.project).toBe(`qare-${shardIsolation.run_id}`)
  // The criterion's own app goes down with the criterion, so a sharded run
  // leaves no stack of its own holding a port or a volume (#48).
  expect(downs).toEqual([shardIsolation.run_id])
  expect(result.criteria.map((criterion) => criterion.outcome)).toEqual(['proven', 'proven'])
})

test('an isolated suite routes the criteria that name it through an app of their own', async () => {
  const ups: Array<{ args: string[]; env: Record<string, string> | undefined }> = []
  const captured: BootOpts = {
    ...SUIT,
    runCompose: async (args, _timeoutMs, env) => {
      if (!args.includes('down')) ups.push({ args, env })
      return { code: 0, stdout: 'up out', stderr: '' }
    },
  }
  const profile: QaProfile = { ...INLINE_PROFILE, suites: [{ name: 'heavy-e2e', command: 'echo suite ran', kind: 'flow', isolated: true }] }
  const criteria: JobCriterion[] = [
    ...commandCriteria('echo shared'),
    { id: 'suite-run', text: 'the suite passes', checks: [{ kind: 'flow', suite: 'heavy-e2e' }] },
  ]
  const job = await makeJob({ criteria, profile: { inline: profile } })

  const { result } = await runJob(job, { ...captured, workers: 2 })

  expect(result.verdict).toBe('passed')
  expect(ups.length).toBe(2)
  expect(result.criteria.map((criterion) => criterion.outcome)).toEqual(['proven', 'proven'])
})

test('a target run runs its isolated criterion against the declared target, booting nothing extra', async () => {
  const ups: unknown[] = []
  const captured: BootOpts = {
    ...SUIT,
    runCompose: async (args) => {
      if (!args.includes('down')) ups.push(args)
      return { code: 0, stdout: 'up out', stderr: '' }
    },
  }
  const criteria: JobCriterion[] = [
    ...commandCriteria('echo shared'),
    { id: 'mutator-1', text: 'it mutates', checks: [{ kind: 'command', run: 'echo mutate' }], isolated: true },
  ]
  const job = await makeJob({ criteria, profile: { inline: TARGET_PROFILE } })

  const { result } = await runJob(job, { ...captured, workers: 2 })

  expect(result.verdict).toBe('passed')
  // A target run has no app of its own to boot, and an isolated declaration
  // cannot conjure one: nothing boots, and the criterion is checked against
  // the target like its neighbours are.
  expect(ups.length).toBe(0)
  expect(result.criteria.map((criterion) => criterion.outcome)).toEqual(['proven', 'proven'])
})
