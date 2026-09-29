import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  METRICS_SCHEMA_VERSION,
  appendMetricsNote,
  appendRunMetrics,
  metricsSummaryLines,
  readMetricsStore,
  summarizeMetrics,
  sumUsage,
} from '../src/metrics.js'

const BASE_RECORD = {
  runId: 'job-1',
  startedAt: '2026-09-29T10:00:00.000Z',
  finishedAt: '2026-09-29T10:01:30.000Z',
  wallMs: 90_000,
  verdict: 'passed',
  criteria: { selected: [{ id: 'c1', outcome: 'proven' }], counts: { proven: 1 } },
}

function metricsDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'qare-metrics-'))
}

test('a record appended is a record read back, one JSON line per run', async () => {
  const dir = await metricsDir()
  try {
    await appendRunMetrics(dir, { ...BASE_RECORD, model: { plan: { inputTokens: 10, outputTokens: 5 } } }, () => new Date('2026-09-29T10:01:31.000Z'))
    const store = await readMetricsStore(dir)
    expect(store.runs).toHaveLength(1)
    expect(store.runs[0]).toMatchObject({ ...BASE_RECORD, model: { plan: { inputTokens: 10, outputTokens: 5 } }, schemaVersion: METRICS_SCHEMA_VERSION, recordedAt: '2026-09-29T10:01:31.000Z' })
    const text = await readFile(join(dir, 'runs.jsonl'), 'utf8')
    expect(text.split('\n')).toHaveLength(2)
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('a missing store reads as empty, and a line that is not JSON is skipped and named', async () => {
  const dir = await metricsDir()
  try {
    expect(await readMetricsStore(dir)).toMatchObject({ runs: [], notes: [], malformed: 0 })
    await appendRunMetrics(dir, BASE_RECORD)
    await appendMetricsNote(dir, { kind: 'escape', text: 'it shipped broken' })
    const store = await readMetricsStore(dir)
    expect(store.runs).toHaveLength(1)
    expect(store.notes).toHaveLength(1)
    expect(store.malformed).toBe(0)
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('a note must name a known kind, and only qa-minutes carries minutes', async () => {
  const dir = await metricsDir()
  try {
    await expect(appendMetricsNote(dir, { kind: 'qare-best' as never })).rejects.toThrow(/kind must be one of/)
    await expect(appendMetricsNote(dir, { kind: 'escape', minutes: 5 })).rejects.toThrow(/minutes must be a positive number, and only a qa-minutes note carries minutes/)
    await expect(appendMetricsNote(dir, { kind: 'qa-minutes', minutes: 0 })).rejects.toThrow(/minutes must be a positive number/)
    await expect(appendMetricsNote(dir, { kind: 'qa-minutes', minutes: 12.5 })).resolves.toBeUndefined()
    expect((await readMetricsStore(dir)).notes[0]).toMatchObject({ kind: 'qa-minutes', minutes: 12.5, schemaVersion: METRICS_SCHEMA_VERSION })
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('the summary adds wall clock, model spend, outcomes, defects and the human notes', async () => {
  const dir = await metricsDir()
  try {
    await appendRunMetrics(dir, { ...BASE_RECORD, verdict: 'failed', wallMs: 60_000, criteria: { selected: [{ id: 'c1', outcome: 'failed' }], counts: { failed: 1 } }, model: { plan: { inputTokens: 100, outputTokens: 10 }, judge: { inputTokens: 20, outputTokens: 2 } } })
    await appendRunMetrics(dir, { ...BASE_RECORD, wallMs: 30_000, criteria: { selected: [{ id: 'c1', outcome: 'proven' }], counts: { proven: 1 } }, model: { plan: { inputTokens: 1, outputTokens: 1 }, judge: { inputTokens: 1, outputTokens: 1 } } })
    await appendMetricsNote(dir, { kind: 'escape', text: 'the viewer crashed for CSV' })
    await appendMetricsNote(dir, { kind: 'false-block', criterion: 'c1' })
    await appendMetricsNote(dir, { kind: 'qa-minutes', minutes: 45 })
    await appendMetricsNote(dir, { kind: 'qa-minutes', minutes: 15 })

    const summary = summarizeMetrics(await readMetricsStore(dir))
    expect(summary.runs).toBe(2)
    expect(summary.wallMs).toBe(90_000)
    expect(summary.model).toEqual({ plan: { inputTokens: 101, outputTokens: 11 }, judge: { inputTokens: 21, outputTokens: 3 } })
    expect(summary.outcomes).toEqual({ failed: 1, proven: 1 })
    expect(summary.defectsCaughtBeforeMerge).toBe(1)
    expect(summary.notes).toEqual({ escape: 1, 'false-block': 1, 'qa-minutes': 2 })
    expect(summary.qaMinutes).toBe(60)

    const lines = metricsSummaryLines(summary)
    expect(lines).toContain('runs recorded: 2')
    expect(lines).toContain('defects caught before merge: 1')
    expect(lines).toContain('escapes found later: 1')
    expect(lines).toContain('false blocks: 1')
    expect(lines).toContain('human QA minutes: 60')
    expect(lines.join('\n')).toMatch(/wall clock: 1m 30s/)
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('the summary reads a store with malformed lines by skipping them, never failing', async () => {
  const dir = await metricsDir()
  try {
    await appendRunMetrics(dir, BASE_RECORD)
    await appendMetricsNote(dir, { kind: 'escape', text: 'escaped' })
    // Someone (or something) wrote a line that is not JSON.
    const runs = await readFile(join(dir, 'runs.jsonl'), 'utf8')
    await import('node:fs/promises').then((fs) => fs.writeFile(join(dir, 'runs.jsonl'), `${runs}not json at all\n`, 'utf8'))
    const summary = summarizeMetrics(await readMetricsStore(dir))
    expect(summary.runs).toBe(1)
    expect((await readMetricsStore(dir)).malformed).toBe(1)
    const lines = metricsSummaryLines(summary)
    expect(lines).toContain('runs recorded: 1')
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('sumUsage adds either side, and says nothing when both are absent', () => {
  expect(sumUsage(undefined, undefined)).toBeUndefined()
  expect(sumUsage({ inputTokens: 1, outputTokens: 2 }, undefined)).toEqual({ inputTokens: 1, outputTokens: 2 })
  expect(sumUsage(undefined, { inputTokens: 3, outputTokens: 4 })).toEqual({ inputTokens: 3, outputTokens: 4 })
  expect(sumUsage({ inputTokens: 1, outputTokens: 1 }, { inputTokens: 2, outputTokens: 2 })).toEqual({ inputTokens: 3, outputTokens: 3 })
})
