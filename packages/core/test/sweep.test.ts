import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { FileLedgerStore, appendChange, LEDGER_FILE } from '../src/ledger.js'
import {
  DEFAULT_STALE_AFTER,
  SweepLedgerError,
  areasOf,
  classifySweep,
  loadHeldResult,
  parseSweepConfig,
  readSweepConfig,
  renderFindingMarkdown,
  renderStatusMarkdown,
  statusDraft,
  statusReportMarker,
  sweepFindingMarker,
  sweepLedger,
} from '../src/sweep.js'
import type { LedgerChange, LedgerEntry } from '../src/ledger.js'

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    criterion: 'spec-up-200',
    status: 'active',
    source: ['src/app.ts'],
    proof: 'command',
    ...overrides,
  }
}

function ledgerWith(entries: LedgerEntry[], changes: LedgerChange[] = []): { entries: LedgerEntry[]; changes: LedgerChange[] } {
  return { entries, changes }
}

function verifyChange(seqTime: string, criteria: string[], previous: LedgerChange[] = []): LedgerChange[] {
  return appendChange(previous, {
    kind: 'verify',
    actor: 'run-1',
    timestamp: seqTime,
    reason: `run run-1: pass on ${criteria.length} criterion(s)`,
    criteria,
  })
}

test('parseSweepConfig reads default and areas strictly', () => {
  const config = parseSweepConfig({ default: { staleAfter: '30d' }, areas: { web: { staleAfter: '1w' } } })
  expect(config.default.staleAfter).toBe('30d')
  expect(config.areas?.web?.staleAfter).toBe('1w')
})

test('parseSweepConfig rejects unknown fields, missing default and bad durations', () => {
  expect(() => parseSweepConfig({ default: { staleAfter: '30d' }, extra: 1 })).toThrow(/unknown field in sweep config/)
  expect(() => parseSweepConfig({})).toThrow(/requires a "default"/)
  expect(() => parseSweepConfig({ default: { staleAfter: '0d' } })).toThrow(/must be positive/)
  expect(() => parseSweepConfig({ default: { staleAfter: '-5d' } })).toThrow(/must be a positive count/)
  expect(() => parseSweepConfig({ default: { staleAfter: '30' } })).toThrow(/must be a positive count/)
  expect(() => parseSweepConfig({ default: { staleAfter: 30 } })).toThrow(/staleAfter must be a string/)
})

test('built-in default threshold is a duration string', () => {
  expect(DEFAULT_STALE_AFTER).toMatch(/^\d+[dwy]$/)
})

test('areasOf names suites and topmost directories', () => {
  expect(areasOf({ source: ['suite:web', 'src/app.ts:42', 'README.md'] })).toEqual(['web', 'src', 'README.md'])
  expect(areasOf({ source: [] })).toEqual([])
})

const CONFIG = parseSweepConfig({ default: { staleAfter: '30d' }, areas: { web: { staleAfter: '1w' } } })

test('a criterion verified within its area threshold is proven, past it is stale', () => {
  const now = new Date(Date.parse('2026-09-29T00:00:00Z'))
  const changes = appendChange(verifyChange('2026-01-01T00:00:00Z', ['old']), {
    kind: 'verify',
    actor: 'run-1',
    timestamp: '2026-09-25T00:00:00Z',
    reason: 'run run-1: pass on 1 criterion(s), already active',
    criteria: ['fresh'],
  })
  const ledger = ledgerWith([entry({ criterion: 'fresh' }), entry({ criterion: 'old' })], changes)
  const classification = classifySweep(ledger.entries, ledger.changes, CONFIG, { now })
  expect(classification.proven).toEqual(['fresh'])
  expect(classification.stale).toEqual(['old'])
  expect(classification.unverified).toEqual([])
})

test('a criterion edited after its verification is stale', () => {
  const now = new Date(Date.parse('2026-09-29T00:00:00Z'))
  const changes = verifyChange('2026-09-25T00:00:00Z', ['edited'])
  const withEdit = appendChange(changes, {
    kind: 'ingest',
    actor: 'someone',
    timestamp: '2026-09-26T00:00:00Z',
    reason: 'wording tightened',
    criteria: ['edited'],
  })
  const classification = classifySweep([entry({ criterion: 'edited' })], withEdit, CONFIG, { now })
  expect(classification.stale).toEqual(['edited'])
  expect(classification.proven).toEqual([])
})

test('a criterion with no verification and a proposed criterion are unverified', () => {
  const now = new Date(Date.parse('2026-09-29T00:00:00Z'))
  const classification = classifySweep(
    [entry({ criterion: 'never-run' }), entry({ criterion: 'new-one', status: 'proposed' })],
    [],
    CONFIG,
    { now },
  )
  expect(classification.unverified).toEqual(['never-run', 'new-one'])
  expect(classification.proven).toEqual([])
  expect(classification.stale).toEqual([])
})

test('a criterion nothing has verified for the threshold period is stale even with a history', () => {
  const now = new Date(Date.parse('2026-09-29T00:00:00Z'))
  const changes = verifyChange('2026-06-01T00:00:00Z', ['old-timer'])
  const classification = classifySweep([entry({ criterion: 'old-timer' })], changes, CONFIG, { now })
  expect(classification.stale).toEqual(['old-timer'])
})

test('per-area thresholds choose the strictest area a criterion touches', () => {
  const now = new Date(Date.parse('2026-09-29T00:00:00Z'))
  const changes = verifyChange('2026-09-20T00:00:00Z', ['web-one', 'repo-one'])
  const classification = classifySweep(
    [entry({ criterion: 'web-one', source: ['suite:web'] }), entry({ criterion: 'repo-one', source: ['src/app.ts'] })],
    changes,
    CONFIG,
    { now },
  )
  expect(classification.stale).toEqual(['web-one'])
  expect(classification.proven).toEqual(['repo-one'])
})

test('quarantined and refused come from the held result and win over the buckets', () => {
  const now = new Date(Date.parse('2026-09-29T00:00:00Z'))
  const changes = verifyChange('2026-09-25T00:00:00Z', ['held-one', 'refused-one', 'plain'])
  const classification = classifySweep(
    [entry({ criterion: 'held-one' }), entry({ criterion: 'refused-one' }), entry({ criterion: 'plain' })],
    changes,
    CONFIG,
    { now, quarantined: ['held-one'], refused: ['refused-one'] },
  )
  expect(classification.quarantined).toEqual(['held-one'])
  expect(classification.refused).toEqual(['refused-one'])
  expect(classification.proven).toEqual(['plain'])
})

test('superseded and retired entries appear in no bucket', () => {
  const now = new Date(Date.parse('2026-09-29T00:00:00Z'))
  const classification = classifySweep(
    [entry({ criterion: 'gone', status: 'superseded' }), entry({ criterion: 'retired', status: 'retired' })],
    [],
    CONFIG,
    { now },
  )
  expect(classification.proven).toEqual([])
  expect(classification.stale).toEqual([])
  expect(classification.unverified).toEqual([])
  expect(classification.quarantined).toEqual([])
  expect(classification.refused).toEqual([])
})

test('loadHeldResult reads held and refused criteria and refuses a malformed file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-sweep-'))
  try {
    expect(await loadHeldResult(dir)).toEqual({ held: [], refused: [] })
    await writeFile(
      join(dir, 'held-result.json'),
      JSON.stringify({
        criteria: [
          { id: 'c1', outcome: 'unverified', reason: 'held for an open question: is 200 enough' },
          { id: 'c2', outcome: 'refused', reason: 'refused: missing stub: host:443 (https)' },
          { id: 'c3', outcome: 'unverified', reason: 'could not verify (environment): no app' },
        ],
      }),
      'utf8',
    )
    const result = await loadHeldResult(dir)
    expect(result.held).toEqual(['c1'])
    expect(result.refused).toEqual(['c2'])
    await writeFile(join(dir, 'held-result.json'), '{"criteria": "no"}', 'utf8')
    await expect(loadHeldResult(dir)).rejects.toThrow(SweepLedgerError)
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('readSweepConfig reads sweep.json, tolerates its absence, and rejects a bad one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-sweep-'))
  try {
    expect(await readSweepConfig(dir)).toBeUndefined()
    await writeFile(join(dir, 'sweep.json'), JSON.stringify({ default: { staleAfter: '2w' } }), 'utf8')
    expect((await readSweepConfig(dir))?.default?.staleAfter).toBe('2w')
    await writeFile(join(dir, 'sweep.json'), '{"default": {"staleAfter": "nope"}}', 'utf8')
    const failure = await readSweepConfig(dir).catch((error) => error)
    expect(failure).toBeInstanceOf(SweepLedgerError)
    expect(failure.fingerprint).toBe('sweep:config-invalid')
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('renderStatusMarkdown carries the marker, the counts and every bucket', () => {
  const text = renderStatusMarkdown({
    at: '2026-09-29T00:00:00Z',
    classification: {
      proven: ['a'],
      stale: ['b'],
      unverified: [],
      quarantined: ['c'],
      refused: ['d'],
    },
  })
  expect(text).toContain(statusReportMarker())
  expect(text).toContain('proven: 1 stale: 1 unverified: 0 quarantined: 1 refused: 1')
  expect(text).toContain('## Proven')
  expect(text).toContain('## Quarantined')
  expect(text).toContain('- a')
  expect(statusDraft({ at: '2026-09-29T00:00:00Z', classification: { proven: [], stale: [], unverified: [], quarantined: [], refused: [] } }).title).toBe(
    'QARE standing report',
  )
})

test('findings render with a fingerprint marker and mention the actor', () => {
  const body = renderFindingMarkdown({ fingerprint: 'sweep:config-invalid', reason: 'sweep.json is invalid: default: bad', actor: 'jason' })
  expect(body).toContain(sweepFindingMarker('sweep:config-invalid'))
  expect(body).toContain('@jason')
  expect(renderFindingMarkdown({ fingerprint: 'f', reason: 'r', actor: 'unknown' })).not.toContain('@unknown')
})

test('sweepLedger classifies a ledger directory and reports a corrupt ledger as a finding', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-sweep-'))
  try {
    const store = new FileLedgerStore(dir)
    const changes = verifyChange('2026-09-25T00:00:00Z', ['spec-up-200'])
    await store.saveDocument([entry({ criterion: 'spec-up-200' })], changes)
    await writeFile(join(dir, 'sweep.json'), JSON.stringify({ default: { staleAfter: '30d' } }), 'utf8')
    const payload = await sweepLedger(dir, new Date(Date.parse('2026-09-29T00:00:00Z')))
    expect(payload.findings).toEqual([])
    expect(payload.classification.proven).toEqual(['spec-up-200'])
    expect(payload.lastActor).toBe('run-1')
    await writeFile(join(dir, LEDGER_FILE), '{"entries":', 'utf8')
    const broken = await sweepLedger(dir, new Date(Date.parse('2026-09-29T00:00:00Z')))
    expect(broken.findings).toHaveLength(1)
    expect(broken.findings[0]?.fingerprint).toBe('sweep:ledger-unreadable')
    expect(broken.findings[0]?.actor).toBe('unknown')
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('sweepLedger blames the last ledger actor when the configuration is unreadable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-sweep-'))
  try {
    const store = new FileLedgerStore(dir)
    const changes = verifyChange('2026-09-25T00:00:00Z', ['spec-up-200'])
    await store.saveDocument([entry({ criterion: 'spec-up-200' })], changes)
    await writeFile(join(dir, 'sweep.json'), '{"default": {"staleAfter": "nope"}}', 'utf8')
    const payload = await sweepLedger(dir, new Date(Date.parse('2026-09-29T00:00:00Z')))
    expect(payload.findings).toHaveLength(1)
    expect(payload.findings[0]?.fingerprint).toBe('sweep:config-invalid')
    expect(payload.findings[0]?.actor).toBe('run-1')
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('the sweep reads what the runs recorded beside the ledger and says it in the standing report (#51)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-sweep-'))
  try {
    const store = new FileLedgerStore(dir)
    await store.saveDocument([entry({ criterion: 'spec-up-200' })], verifyChange('2026-09-25T00:00:00Z', ['spec-up-200']))
    await mkdir(join(dir, 'metrics'), { recursive: true })
    await writeFile(
      join(dir, 'metrics', 'runs.jsonl'),
      `${JSON.stringify({ schemaVersion: 'qare.metrics.v1', runId: 'j1', recordedAt: '2026-09-29T00:00:00.000Z', startedAt: '2026-09-29T00:00:00.000Z', finishedAt: '2026-09-29T00:01:00.000Z', wallMs: 60_000, verdict: 'failed', criteria: { selected: [{ id: 'c1', outcome: 'failed' }], counts: { failed: 1 } }, model: { judge: { inputTokens: 5, outputTokens: 1 } } })}\n`,
      'utf8',
    )
    await writeFile(
      join(dir, 'metrics', 'notes.jsonl'),
      `${JSON.stringify({ schemaVersion: 'qare.metrics.v1', recordedAt: '2026-09-29T00:02:00.000Z', kind: 'escape', text: 'shipped broken' })}\nnot json at all\n`,
      'utf8',
    )
    const payload = await sweepLedger(dir, new Date(Date.parse('2026-09-29T00:00:00Z')))
    expect(payload.metrics?.lines).toEqual(expect.arrayContaining(['runs recorded: 1', 'escapes found later: 1']))
    expect(payload.metrics?.malformed).toBe(1)

    const report = { at: payload.at, classification: payload.classification, metrics: payload.metrics }
    const rendered = renderStatusMarkdown(report)
    expect(rendered).toContain('Whether QARE is working')
    expect(rendered).toContain('- runs recorded: 1')
    expect(rendered).toContain('- 1 metrics line(s) in the store were not valid JSON and were skipped')

    // A ledger with no metrics store says so by the section's absence.
    const bare = await mkdtemp(join(tmpdir(), 'qare-sweep-bare-'))
    try {
      const bareStore = new FileLedgerStore(bare)
      await bareStore.saveDocument([entry({ criterion: 'spec-up-200' })], verifyChange('2026-09-25T00:00:00Z', ['spec-up-200']))
      const barePayload = await sweepLedger(bare, new Date(Date.parse('2026-09-29T00:00:00Z')))
      expect(barePayload.metrics).toBeUndefined()
      expect(renderStatusMarkdown({ at: barePayload.at, classification: barePayload.classification })).not.toContain('Whether QARE is working')
    } finally {
      await rm(bare, { recursive: true })
    }
  } finally {
    await rm(dir, { recursive: true })
  }
})
