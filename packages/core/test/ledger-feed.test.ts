import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { FileLedgerStore, parseLedgerEntries, serializeLedger, type LedgerEntry } from '../src/ledger.js'
import { parseVerificationRecord } from '../src/ledger-proposal.js'
import { feedJobProposals, feedRunLedger } from '../src/ledger-feed.js'
import { runJob, type Job, type JobCriterion, type QaProfile } from '../src/index.js'
import { existsSync } from 'node:fs'

const SHA = 'a'.repeat(40)

const HEALTH_URL = ['http:', '//localhost:3000/up'].join('')

const INLINE_PROFILE: QaProfile = {
  app: {
    boot: { compose: 'compose.qa.yaml', service: 'admin' },
    health: { http: HEALTH_URL, timeout: '120s' },
    seed: { command: 'bin/rails db:seed:qa' },
    login: { fixture: 'fixtures/users.yml', role: 'admin' },
  },
  stubs: [],
  visual: { widths: [1440], themes: ['light'] },
  suites: [{ name: 'static', command: 'echo ok', kind: 'flow' }],
}

const HEALTHY_BOOT = {
  runCompose: async () => ({ code: 0, stdout: 'up out', stderr: 'up err' }),
  probe: async () => ({ ok: true }),
  pollIntervalMs: 1,
}

function feedInput(overrides: Partial<Parameters<typeof feedJobProposals>[0]> = {}) {
  return {
    runId: 'run-42',
    sha: SHA,
    timestamp: '2026-09-21T00:00:00.000Z',
    outcome: 'pass' as const,
    criteria: [
      { criterionId: 'spec-up-200', outcome: 'proven' as const },
      { criterionId: 'extra-0', outcome: 'failed' as const },
    ],
    ...overrides,
  }
}

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    criterion: 'spec-up-200',
    status: 'active',
    source: ['https:' + '//example.test/pr/1'],
    proof: 'command',
    ...overrides,
  }
}

describe('feedJobProposals', () => {
  test('namespaces job criteria with the job: prefix and maps outcomes', () => {
    const record = feedJobProposals(feedInput())
    expect(record.criteria).toEqual([
      { criterionId: 'job:spec-up-200', outcome: 'pass' },
      { criterionId: 'job:extra-0', outcome: 'fail' },
    ])
  })

  test('unverified job criteria are skipped; all-unverified is a named failure', () => {
    const mixed = feedJobProposals(
      feedInput({
        criteria: [
          { criterionId: 'a', outcome: 'unverified' },
          { criterionId: 'b', outcome: 'proven' },
        ],
      }),
      [],
    )
    expect(mixed.criteria).toEqual([{ criterionId: 'job:b', outcome: 'pass' }])
    expect(() =>
      feedJobProposals(feedInput({ criteria: [{ criterionId: 'a', outcome: 'unverified' }] })),
    ).toThrow(/no verifiable job criteria to feed/)
  })

  test('duplicate job criteria fail closed', () => {
    expect(() =>
      feedJobProposals(
        feedInput({
          criteria: [
            { criterionId: 'spec-up-200', outcome: 'proven' },
            { criterionId: 'spec-up-200', outcome: 'failed' },
          ],
        }),
      ),
    ).toThrow(/duplicate job criterion "spec-up-200"/)
  })

  test('the emitted record round-trips through the strict loader', () => {
    const record = feedJobProposals(feedInput())
    expect(parseVerificationRecord(JSON.parse(JSON.stringify(record)))).toEqual(record)
  })

  test('hostile raw job criterion ids fail closed before namespacing', () => {
    expect(() => feedJobProposals(feedInput({ criteria: [{ criterionId: 'a:b', outcome: 'proven' }] }))).toThrow(
      /must not contain ":"; namespaces are applied by the feed/,
    )
    expect(() => feedJobProposals(feedInput({ criteria: [{ criterionId: '../escape', outcome: 'proven' }] }))).toThrow(
      /path separators/,
    )
    expect(() => feedJobProposals(feedInput({ criteria: [{ criterionId: 'job:x:y', outcome: 'proven' }] }))).toThrow(
      /must not contain ":"/,
    )
  })

  test('run verdict blocked or refused refuses the feed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qare-ledger-feed-'))
    try {
      await expect(feedRunLedger(dir, { id: 'job-x', headRef: SHA }, 'blocked', [
        { criterionId: 'c1', outcome: 'unverified' },
      ])).rejects.toThrow(/is not a verification outcome/)
      expect(existsSync(join(dir, 'ledger-proposal-job-x.json'))).toBe(false)
    } finally {
      await rm(dir, { recursive: true })
    }
  })
})

describe('ledger namespacing boundary', () => {
  test('ledger entry ids still reject every colon, including the job namespace', () => {
    const doc = JSON.parse(serializeLedger([entry()]))
    doc.entries[0].criterion = 'job:spec-up-200'
    expect(() => parseLedgerEntries(doc)).toThrow(/contains ":"/)
  })

  test('verification records accept job: ids but reject other namespaces', () => {
    expect(() => parseVerificationRecord(recordWith([{ criterionId: 'foo:x', outcome: 'pass' }]))).toThrow(
      /unknown namespace in criterion id "foo:x"/,
    )
    expect(() => parseVerificationRecord(recordWith([{ criterionId: 'a:b:c', outcome: 'pass' }]))).toThrow(
      /unknown namespace in criterion id "a:b:c"/,
    )
    expect(() => parseVerificationRecord(recordWith([{ criterionId: 'job:', outcome: 'pass' }]))).toThrow(
      /at most one namespace component/,
    )
  })

  function recordWith(criteria: Array<{ criterionId: string; outcome: 'pass' }>) {
    return {
      runId: 'run-42',
      sha: SHA,
      outcome: 'pass',
      evidence: ['evidence/comment-1.json'],
      timestamp: '2026-09-21T00:00:00.000Z',
      criteria,
    }
  }
})

describe('runJob ledger boundary', () => {
  async function makeJob(repoPath: string, criteria: JobCriterion[]): Promise<Job> {
    return {
      id: 'job-run-feed',
      repoPath,
      baseRef: 'main',
      headRef: SHA,
      profile: { inline: INLINE_PROFILE },
      criteria,
      evidenceDir: join(repoPath, 'evidence'),
      post: 'none',
    }
  }

  test('a default run leaves a present ledger byte-identical', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'qare-ledger-feed-'))
    const ledgerDir = join(repoPath, '.qa')
    const store = new FileLedgerStore(ledgerDir)
    await store.save([entry()])
    const before = await readFile(join(ledgerDir, 'ledger.json'), 'utf8')
    const { result } = await runJob(await makeJob(repoPath, [{ id: 'c1', text: 'c1', checks: [{ kind: 'command', run: 'echo ok' }] }]), HEALTHY_BOOT)
    expect(result.verdict).toBe('passed')
    expect(await readFile(join(ledgerDir, 'ledger.json'), 'utf8')).toBe(before)
    expect(existsSync(join(ledgerDir, 'ledger-proposal-job-run-feed.json'))).toBe(false)
    await rm(repoPath, { recursive: true })
  })

  test('opt-in writes a proposal artifact and still leaves the ledger byte-identical', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'qare-ledger-feed-'))
    const ledgerDir = join(repoPath, '.qa')
    const store = new FileLedgerStore(ledgerDir)
    await store.save([entry()])
    const before = await readFile(join(ledgerDir, 'ledger.json'), 'utf8')
    const { result } = await runJob(
      await makeJob(repoPath, [{ id: 'c1', text: 'c1', checks: [{ kind: 'command', run: 'echo ok' }] }]),
      { ...HEALTHY_BOOT, ledgerFeed: { dir: ledgerDir } },
    )
    expect(result.verdict).toBe('passed')
    expect(await readFile(join(ledgerDir, 'ledger.json'), 'utf8')).toBe(before)
    const payload = JSON.parse(await readFile(join(ledgerDir, 'ledger-proposal-job-run-feed.json'), 'utf8'))
    expect(payload.runId).toBe('job-run-feed')
    expect(payload.baseSha).toBe(SHA)
    expect(payload.body.changes).toEqual([])
    expect(payload.ledgerText).toBe(before)
    await rm(repoPath, { recursive: true })
  })
})
