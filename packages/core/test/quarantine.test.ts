import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import {
  checkFingerprint,
  renderComment,
  runJob,
  type Job,
  type JobCriterion,
  type QaProfile,
  type RunResult,
} from '../src/index.js'

const HEALTH_URL = ['http:', '//localhost:3000/up'].join('')

const INLINE_PROFILE: QaProfile = {
  app: {
    boot: { compose: 'compose.qa.yaml', service: 'admin' },
    health: { http: HEALTH_URL, timeout: '120s' },
    seed: { command: 'true' },
    login: { fixture: 'fixtures/users.yml', role: 'admin' },
  },
  stubs: [
    {
      service: 'billing',
      hosts: ['api.billing-vendor.example'],
      provided_by: { compose_service: 'billing-stub' },
    },
    {
      service: 'mail',
      hosts: ['api.mailgun.net'],
      provided_by: { compose_service: 'mailpit' },
    },
  ],
  visual: { widths: [1440, 390], themes: ['light', 'dark'] },
  suites: [{ name: 'browser-e2e', command: 'npm --prefix e2e test', kind: 'flow' }],
}

const HEALTHY_BOOT = {
  runCompose: async () => ({ code: 0, stdout: 'up out', stderr: 'up err' }),
  probe: async () => ({ ok: true }),
  pollIntervalMs: 1,
}

// The check the flake tests share: it fails its first attempt and passes its
// second, marking that it ran so the tests can count attempts.
const FLIP_SCRIPT = [
  "import { existsSync, writeFileSync } from 'node:fs'",
  "if (existsSync('flipped')) process.exit(0)",
  "writeFileSync('flipped', 'now')",
  'process.exit(1)',
].join('\n')

async function makeJob(criteria: JobCriterion[]): Promise<Job> {
  const repoPath = await mkdtemp(join(tmpdir(), 'qare-quarantine-'))
  return {
    id: 'job-quarantine',
    repoPath,
    baseRef: 'main',
    headRef: 'HEAD~1',
    profile: { inline: INLINE_PROFILE },
    criteria,
    evidenceDir: join(repoPath, 'evidence'),
    post: 'none',
  }
}

async function commandJob(run: string): Promise<Job> {
  const job = await makeJob([{ id: 'criterion-1', text: 'criterion 1', checks: [{ kind: 'command', run }] }])
  await writeFile(join(job.repoPath, 'flip.mjs'), FLIP_SCRIPT, 'utf8')
  return job
}

test('a check that fails and then passes is quarantined and reports unverified', async () => {
  const job = await commandJob('node flip.mjs')
  const quarantineDir = join(job.repoPath, 'quarantine')
  try {
    const { result } = await runJob(job, { ...HEALTHY_BOOT, execution: 'native', flakeAttempts: 2, quarantineDir })
    expect(result.verdict).toBe('blocked')
    expect(result.criteria[0].outcome).toBe('unverified')
    expect(result.criteria[0].reason).toMatch(/^quarantined \(/)
    expect(result.criteria[0].reason).toContain('unstable: the check failed and passed across 2 attempts of this run')
    const store = JSON.parse(await readFile(join(quarantineDir, 'quarantine.json'), 'utf8'))
    expect(store.schemaVersion).toBe('1')
    expect(store.records).toHaveLength(1)
    expect(store.records[0].criterion).toBe('criterion-1')
    expect(store.records[0].check).toBe('command check 0 of criterion criterion-1')
    expect(store.records[0].fingerprint).toBe(checkFingerprint('criterion-1', { kind: 'command', run: 'node flip.mjs' }))
    expect(new Date(store.records[0].quarantinedAt).toISOString()).toBe(store.records[0].quarantinedAt)
    // Both attempts are evidence: the run shows the failure and the pass it judged from.
    await readFile(join(job.evidenceDir, 'checks', 'criterion-1', '0', 'command.json'), 'utf8')
    await readFile(join(job.evidenceDir, 'checks', 'criterion-1', '0-attempt2', 'command.json'), 'utf8')
  } finally {
    await rm(job.repoPath, { recursive: true, force: true })
  }
})

test('a check that fails every attempt is a failure and quarantines nothing', async () => {
  const job = await commandJob('node nope.mjs')
  await writeFile(join(job.repoPath, 'nope.mjs'), 'process.exit(1)\n', 'utf8')
  const quarantineDir = join(job.repoPath, 'quarantine')
  try {
    const { result } = await runJob(job, { ...HEALTHY_BOOT, execution: 'native', flakeAttempts: 2, quarantineDir })
    expect(result.verdict).toBe('failed')
    expect(result.criteria[0].outcome).toBe('failed')
    const store = JSON.parse(await readFile(join(quarantineDir, 'quarantine.json'), 'utf8'))
    expect(store.records).toEqual([])
  } finally {
    await rm(job.repoPath, { recursive: true, force: true })
  }
})

test('a check that passes its first attempt is proven and never repeated', async () => {
  const job = await commandJob('node count.mjs')
  await writeFile(
    join(job.repoPath, 'count.mjs'),
    "import { appendFileSync } from 'node:fs'\nappendFileSync('runs.log', 'x')\n",
    'utf8',
  )
  const quarantineDir = join(job.repoPath, 'quarantine')
  try {
    const { result } = await runJob(job, { ...HEALTHY_BOOT, execution: 'native', flakeAttempts: 3, quarantineDir })
    expect(result.verdict).toBe('passed')
    expect(result.criteria[0].outcome).toBe('proven')
    const runs = await readFile(join(job.repoPath, 'runs.log'), 'utf8')
    expect(runs).toBe('x')
  } finally {
    await rm(job.repoPath, { recursive: true, force: true })
  }
})

test('a quarantined check is skipped and its criterion reports the record', async () => {
  const job = await commandJob('node flip.mjs')
  const quarantineDir = join(job.repoPath, 'quarantine')
  const fingerprint = checkFingerprint('criterion-1', { kind: 'command', run: 'node flip.mjs' })
  await mkdir(quarantineDir, { recursive: true })
  await writeFile(
    join(quarantineDir, 'quarantine.json'),
    `${JSON.stringify({
      schemaVersion: '1',
      records: [{ check: 'flip', fingerprint, criterion: 'criterion-1', reason: 'unstable: seeded for the test', quarantinedAt: '2026-09-28T00:00:00.000Z' }],
    }, null, 2)}\n`,
    'utf8',
  )
  try {
    const { result } = await runJob(job, { ...HEALTHY_BOOT, execution: 'native', quarantineDir })
    expect(result.verdict).toBe('blocked')
    expect(result.criteria[0]).toEqual({
      id: 'criterion-1',
      outcome: 'unverified',
      reason: 'quarantined (2026-09-28T00:00:00.000Z): unstable: seeded for the test',
      evidence: ['checks/criterion-1/0/quarantined.json'],
    })
    // The check never ran: no attempt evidence, only the record.
    expect(existsSync(join(job.evidenceDir, 'checks', 'criterion-1', '0', 'stdout.txt'))).toBe(false)
    const record = JSON.parse(await readFile(join(job.evidenceDir, 'checks', 'criterion-1', '0', 'quarantined.json'), 'utf8'))
    expect(record.fingerprint).toBe(fingerprint)
  } finally {
    await rm(job.repoPath, { recursive: true, force: true })
  }
})

test('a store that cannot be read is a miss and is never written over', async () => {
  const job = await commandJob('node flip.mjs')
  const quarantineDir = join(job.repoPath, 'quarantine')
  await mkdir(quarantineDir, { recursive: true })
  await writeFile(join(quarantineDir, 'quarantine.json'), 'not json at all', 'utf8')
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const { result } = await runJob(job, { ...HEALTHY_BOOT, execution: 'native', flakeAttempts: 2, quarantineDir })
    // The malformed store applied nothing, so the check ran for real, failed
    // and then passed, and the criterion is unverified either way.
    expect(result.verdict).toBe('blocked')
    expect(result.criteria[0].outcome).toBe('unverified')
    expect(errors.mock.calls.some((call) => String(call[0]).startsWith('quarantine skipped:'))).toBe(true)
    expect(await readFile(join(quarantineDir, 'quarantine.json'), 'utf8')).toBe('not json at all')
  } finally {
    errors.mockRestore()
    await rm(job.repoPath, { recursive: true, force: true })
  }
})

test('a store that parses but is not a store reads as unreadable and is never written over', async () => {
  const stores = [
    '[]',
    '5',
    '{"schemaVersion":"9","records":[]}',
    '{"schemaVersion":"1","records":"no"}',
    '{"schemaVersion":"1","records":[{"check":"flip"}]}',
  ]
  for (const store of stores) {
    const job = await commandJob('node flip.mjs')
    const quarantineDir = join(job.repoPath, 'quarantine')
    await mkdir(quarantineDir, { recursive: true })
    await writeFile(join(quarantineDir, 'quarantine.json'), store, 'utf8')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { result } = await runJob(job, { ...HEALTHY_BOOT, execution: 'native', flakeAttempts: 2, quarantineDir })
      expect(result.verdict).toBe('blocked')
      expect(result.criteria[0].outcome).toBe('unverified')
      expect(errors.mock.calls.some((call) => String(call[0]).startsWith('quarantine skipped:'))).toBe(true)
      expect(await readFile(join(quarantineDir, 'quarantine.json'), 'utf8')).toBe(store)
    } finally {
      errors.mockRestore()
      await rm(job.repoPath, { recursive: true, force: true })
    }
  }
})

test('attempts default to one, so today a failing check fails with no retries', async () => {
  const job = await commandJob('node flip.mjs')
  const quarantineDir = join(job.repoPath, 'quarantine')
  try {
    const { result } = await runJob(job, { ...HEALTHY_BOOT, execution: 'native', quarantineDir })
    expect(result.verdict).toBe('failed')
    expect(result.criteria[0].outcome).toBe('failed')
    const store = JSON.parse(await readFile(join(quarantineDir, 'quarantine.json'), 'utf8'))
    expect(store.records).toEqual([])
  } finally {
    await rm(job.repoPath, { recursive: true, force: true })
  }
})

test('the fingerprint moves with the criterion and the authored check', async () => {
  const check = { kind: 'command', run: 'cp marker.txt copied.txt' } as const
  const same = checkFingerprint('criterion-1', check)
  expect(checkFingerprint('criterion-1', check)).toBe(same)
  expect(checkFingerprint('criterion-2', check)).not.toBe(same)
  expect(checkFingerprint('criterion-1', { kind: 'command', run: 'cp other.txt copied.txt' })).not.toBe(same)
})

test('the evidence comment names the quarantine and never dresses it as a pass', async () => {
  const result = {
    schemaVersion: '1',
    id: 'job-quarantine',
    verdict: 'blocked',
    criteria: [
      {
        id: 'criterion-1',
        outcome: 'unverified',
        reason: 'quarantined (2026-09-28T00:00:00.000Z): unstable: the check failed and passed across 2 attempts of this run',
      },
    ],
  } as unknown as RunResult
  const body = renderComment(result)
  expect(body).toContain('quarantined (flake): quarantined (2026-09-28T00:00:00.000Z): unstable')
  expect(body).toContain('Quarantined checks failed and passed across the attempts this run gave them')
  expect(body).toContain('unverified, and the checks are skipped')
})
