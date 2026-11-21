import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

test('a line that parses but is not the promised shape is skipped and named, never read as a run (#51)', async () => {
  const dir = await metricsDir()
  try {
    await appendRunMetrics(dir, BASE_RECORD)
    // A `null` line, an array line and a run-shaped object without the
    // required fields each must count as malformed, not crash the reader:
    // JSON.parse accepts them all.
    const runs = await readFile(join(dir, 'runs.jsonl'), 'utf8')
    await import('node:fs/promises').then((fs) =>
      fs.writeFile(join(dir, 'runs.jsonl'), `${runs}null\n[1, 2]\n{"runId": "no schema version"}\n`, 'utf8'),
    )
    const store = await readMetricsStore(dir)
    expect(store.runs).toHaveLength(1)
    expect(store.malformed).toBe(3)
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('a store file that exists but cannot be read is an error the caller names, not an empty store (#51)', async () => {
  const dir = await metricsDir()
  try {
    // A directory where runs.jsonl should be: reading it fails with EISDIR,
    // and the reader must surface that rather than report a silent zero.
    await import('node:fs/promises').then((fs) => fs.mkdir(join(dir, 'runs.jsonl'), { recursive: true }))
    await expect(readMetricsStore(dir)).rejects.toThrow()
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('the summary states the proven-or-failed rate of every recorded criterion outcome (#373)', () => {
  const lines = metricsSummaryLines(
    summarizeMetrics({
      runs: [
        { ...BASE_RECORD, criteria: { selected: [{ id: 'a', outcome: 'proven' }, { id: 'b', outcome: 'failed' }, { id: 'c', outcome: 'unverified' }], counts: {} } },
        { ...BASE_RECORD, runId: 'r2', criteria: { selected: [{ id: 'a', outcome: 'unverified' }, { id: 'b', outcome: 'unverified' }, { id: 'c', outcome: 'unverified' }, { id: 'd', outcome: 'proven' }], counts: {} } },
      ].map((run) => ({ schemaVersion: METRICS_SCHEMA_VERSION, recordedAt: '2026-11-20T00:00:00.000Z', ...run })),
      notes: [],
      malformed: 0,
    }),
  )
  expect(lines).toContain('proven or failed: 3 of 7 criterion outcomes (42.9%)')
})

test('with no criterion outcome recorded the rate is not stated as zero (#373)', () => {
  const lines = metricsSummaryLines(summarizeMetrics({ runs: [], notes: [], malformed: 0 }))
  expect(lines).toContain('proven or failed: no criterion outcomes recorded')
})

function timedRun(index: number, jobs: Array<{ name: string; wallMs: number }> | undefined) {
  const started = new Date(Date.parse('2026-11-01T00:00:00.000Z') + index * 3_600_000).toISOString()
  return {
    ...BASE_RECORD,
    schemaVersion: METRICS_SCHEMA_VERSION,
    recordedAt: started,
    runId: `r${index}`,
    startedAt: started,
    ...(jobs === undefined ? {} : { jobs: jobs.map((job) => ({ ...job, startedAt: started, completedAt: started })) }),
  }
}

test('the summary gives each job its median wall clock, the latest ten runs beside the ten before (#381)', () => {
  // Twenty runs, oldest first: execute took 60s in the earlier ten and 30s in
  // the latest ten, and collect took 20s throughout. Stored newest first, to
  // show the order is read from startedAt, not from the store's lines.
  const runs = Array.from({ length: 20 }, (_, index) =>
    timedRun(index, [
      { name: 'collect (GitHub token only)', wallMs: 20_000 },
      { name: 'execute (no secrets)', wallMs: index < 10 ? 60_000 + index : 30_000 + index },
    ]),
  ).reverse()
  const summary = summarizeMetrics({ runs, notes: [], malformed: 0 })
  expect(summary.jobs['execute (no secrets)']).toHaveLength(20)
  const lines = metricsSummaryLines(summary)
  expect(lines).toContain('job wall clock, collect (GitHub token only): median 20s over the latest 10 runs, 20s over the 10 before')
  expect(lines).toContain('job wall clock, execute (no secrets): median 30s over the latest 10 runs, 1m 0s over the 10 before')
})

test('with ten runs or fewer a job has one median, and a run that recorded no jobs counts for none (#381)', () => {
  const runs = [timedRun(0, [{ name: 'plan (model key only)', wallMs: 40_000 }]), timedRun(1, undefined), timedRun(2, [{ name: 'plan (model key only)', wallMs: 50_000 }]), timedRun(3, [{ name: 'plan (model key only)', wallMs: 90_000 }])]
  const lines = metricsSummaryLines(summarizeMetrics({ runs, notes: [], malformed: 0 }))
  expect(lines).toContain('job wall clock, plan (model key only): median 50s over 3 runs')
  expect(lines.filter((line) => line.startsWith('job wall clock'))).toHaveLength(1)
})

test('with no run that recorded its jobs the report says so, once (#381)', () => {
  const lines = metricsSummaryLines(summarizeMetrics({ runs: [timedRun(0, undefined)], notes: [], malformed: 0 }))
  expect(lines).toContain('job wall clock: no run recorded its jobs')
})

test('a record whose jobs are not the promised shape is still a run, and its jobs count for nothing (#381)', async () => {
  const dir = await metricsDir()
  try {
    const good = { ...timedRun(0, [{ name: 'judge (model key only)', wallMs: 41_000 }]) }
    const bad = { ...timedRun(1, undefined), jobs: [{ name: 7, wallMs: 'slow' }, null] }
    await writeFile(join(dir, 'runs.jsonl'), `${JSON.stringify(good)}\n${JSON.stringify(bad)}\n`)
    const store = await readMetricsStore(dir)
    expect(store.runs).toHaveLength(2)
    expect(store.malformed).toBe(0)
    expect(summarizeMetrics(store).jobs).toEqual({ 'judge (model key only)': [41_000] })
  } finally {
    await rm(dir, { recursive: true })
  }
})
