import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The numbers that say whether QARE is working (#51): what one run cost and
 * decided, and what a repository's runs amount to over time.
 *
 * The data lives in the repository, not only in logs: one JSON line per run
 * in `metrics/runs.jsonl` under the ledger directory, and one JSON line per
 * human note in `metrics/notes.jsonl`. A reader that finds the store missing
 * reads an empty one; a line it cannot parse, or one that is not the shape
 * the store promises, is skipped and named, never fatal: metrics describe
 * runs, they do not gate them. A store file that exists but cannot be read
 * is an error the caller names.
 */

export const METRICS_SCHEMA_VERSION = 'qare.metrics.v1'

export interface ModelUsage {
  inputTokens: number
  outputTokens: number
}

/** Add two model usages, either of which may be missing. */
export function sumUsage(a: ModelUsage | undefined, b: ModelUsage | undefined): ModelUsage | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens }
}

export interface RunMetricsRecord {
  schemaVersion: string
  /** The run this record describes; the job id the pipeline gave the run. */
  runId: string
  /** When the record was written. */
  recordedAt: string
  /** The run's wall clock, from result.json's timestamps. */
  startedAt: string
  finishedAt: string
  wallMs: number
  verdict: string
  /** What the run checked: the criterion ids it selected and how each came out. */
  criteria: {
    selected: Array<{ id: string; outcome: string }>
    counts: Record<string, number>
  }
  /** What the model steps spent; absent when a step ran without a model. */
  model?: { plan?: ModelUsage; judge?: ModelUsage }
  /** Where the run happened, when the caller says. */
  context?: { pr?: number; base?: string; head?: string }
  /**
   * Each job of the run that had completed when the record was written, and
   * its wall clock (#381), as the Actions API reports it. Absent in a record
   * written before jobs were recorded, or by a caller outside the pipeline.
   */
  jobs?: RunJobTiming[]
}

/** One job of a run, by the name its workflow gives it, and how long it took. */
export interface RunJobTiming {
  name: string
  startedAt: string
  completedAt: string
  wallMs: number
}

export type MetricsNoteKind = 'escape' | 'false-block' | 'qa-minutes'

export interface MetricsNote {
  schemaVersion: string
  /** When the note was recorded. */
  recordedAt: string
  kind: MetricsNoteKind
  /** What the note says; for qa-minutes, how many minutes the QA work took. */
  text?: string
  minutes?: number
  /** The criterion or run the note belongs to, when it names one. */
  criterion?: string
  runId?: string
}

export interface MetricsStore {
  runs: RunMetricsRecord[]
  notes: MetricsNote[]
  /** Lines skipped because they were not valid JSON of the expected shape. */
  malformed: number
}

const NOTE_KINDS: MetricsNoteKind[] = ['escape', 'false-block', 'qa-minutes']

export const RUNS_FILE = 'runs.jsonl'
export const NOTES_FILE = 'notes.jsonl'

/** Read a metrics store at `dir` (the directory itself, not its parent). A missing directory reads as empty; a present but unreadable one is an error the caller names. */
export async function readMetricsStore(dir: string): Promise<MetricsStore> {
  const [runs, notes] = await Promise.all([
    readLines<RunMetricsRecord>(join(dir, RUNS_FILE), isRunRecord),
    readLines<MetricsNote>(join(dir, NOTES_FILE), isNoteRecord),
  ])
  return { runs: runs.values, notes: notes.values, malformed: runs.malformed + notes.malformed }
}

async function readLines<T>(file: string, isShape: (value: unknown) => boolean): Promise<{ values: T[]; malformed: number }> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { values: [], malformed: 0 }
    throw error
  }
  const values: T[] = []
  let malformed = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      malformed += 1
      continue
    }
    // A line that parses but is not the shape the store promises is counted
    // and named like an unparseable one: a `null` line must not reach the
    // summary as a run and break the report it was meant to inform.
    if (isShape(parsed)) values.push(parsed as T)
    else malformed += 1
  }
  return { values, malformed }
}

/** Whether a value is a run's metrics record, as the store and every reader of one hold it to. */
export function isRunMetricsRecord(value: unknown): value is RunMetricsRecord {
  return isRunRecord(value)
}

function isRunRecord(value: unknown): value is RunMetricsRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const criteria = record.criteria
  return (
    record.schemaVersion === METRICS_SCHEMA_VERSION &&
    typeof record.runId === 'string' &&
    typeof record.recordedAt === 'string' &&
    typeof record.startedAt === 'string' &&
    typeof record.finishedAt === 'string' &&
    typeof record.wallMs === 'number' &&
    Number.isFinite(record.wallMs) &&
    typeof record.verdict === 'string' &&
    typeof criteria === 'object' &&
    criteria !== null &&
    Array.isArray((criteria as Record<string, unknown>).selected)
  )
}

function isNoteRecord(value: unknown): value is MetricsNote {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const note = value as Record<string, unknown>
  return (
    note.schemaVersion === METRICS_SCHEMA_VERSION &&
    typeof note.recordedAt === 'string' &&
    typeof note.kind === 'string' &&
    NOTE_KINDS.includes(note.kind as MetricsNoteKind) &&
    (note.minutes === undefined || (typeof note.minutes === 'number' && Number.isFinite(note.minutes)))
  )
}

/** Append one run record as a line. Creates the store directory when missing. A record that already carries recordedAt keeps it, so a caller writing the same record to two destinations writes the same timestamp. */
export async function appendRunMetrics(dir: string, record: Omit<RunMetricsRecord, 'schemaVersion' | 'recordedAt'> & { recordedAt?: string }, now: () => Date = defaultNow): Promise<void> {
  const full: RunMetricsRecord = { schemaVersion: METRICS_SCHEMA_VERSION, recordedAt: now().toISOString(), ...record }
  await appendLine(join(dir, RUNS_FILE), full)
}

/** Append one human note as a line. Creates the store directory when missing. */
export async function appendMetricsNote(dir: string, note: Omit<MetricsNote, 'schemaVersion' | 'recordedAt'>, now: () => Date = defaultNow): Promise<void> {
  const kind = note.kind
  if (!NOTE_KINDS.includes(kind)) throw new Error(`metrics note kind must be one of ${NOTE_KINDS.join(', ')}, not ${JSON.stringify(kind)}`)
  if ((note.minutes ?? undefined) !== undefined && (note.kind !== 'qa-minutes' || !Number.isFinite(note.minutes) || (note.minutes as number) <= 0))
    throw new Error('metrics note minutes must be a positive number, and only a qa-minutes note carries minutes')
  const full: MetricsNote = { schemaVersion: METRICS_SCHEMA_VERSION, recordedAt: now().toISOString(), ...note }
  await appendLine(join(dir, NOTES_FILE), full)
}

async function appendLine(file: string, value: unknown): Promise<void> {
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, `${JSON.stringify(value)}\n`, { flag: 'a' })
}

export interface MetricsSummary {
  /** How many runs the store records, and their wall clock together. */
  runs: number
  wallMs: number
  /** The model steps' spend across every run, each side summed separately. */
  model: { plan?: ModelUsage; judge?: ModelUsage }
  /** Every criterion outcome the runs decided, counted. */
  outcomes: Record<string, number>
  /** Runs whose verdict was failed: defects caught before merge. */
  defectsCaughtBeforeMerge: number
  /** Human notes, by kind: escapes found later, false blocks, QA minutes. */
  notes: Record<MetricsNoteKind, number>
  qaMinutes: number
  /**
   * Each job's wall clock (#381), one entry per run that recorded the job,
   * oldest run first by its startedAt.
   */
  jobs: Record<string, number[]>
}

/** How many runs each window of a job's wall clock line covers (#381). */
export const JOB_WINDOW = 10

function isJobTiming(value: unknown): value is RunJobTiming {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const job = value as Record<string, unknown>
  return typeof job.name === 'string' && job.name !== '' && typeof job.wallMs === 'number' && Number.isFinite(job.wallMs) && job.wallMs >= 0
}

/**
 * Each job's wall clock across the runs (#381): the runs in the order they
 * started, whatever order the store holds them in. A record's `jobs` is
 * optional, and one that is not the promised shape counts for nothing: the
 * record is still a run.
 */
function jobWallClocks(runs: RunMetricsRecord[]): Record<string, number[]> {
  const ordered = [...runs].sort((a, b) => (Date.parse(a.startedAt) || 0) - (Date.parse(b.startedAt) || 0))
  const jobs: Record<string, number[]> = {}
  for (const run of ordered) {
    if (!Array.isArray(run.jobs)) continue
    for (const job of run.jobs) if (isJobTiming(job)) (jobs[job.name] ??= []).push(job.wallMs)
  }
  return jobs
}

export function summarizeMetrics(store: MetricsStore): MetricsSummary {
  const outcomes: Record<string, number> = {}
  let wallMs = 0
  let defectsCaughtBeforeMerge = 0
  let model: { plan?: ModelUsage; judge?: ModelUsage } = {}
  for (const run of store.runs) {
    wallMs += typeof run.wallMs === 'number' && Number.isFinite(run.wallMs) ? run.wallMs : 0
    for (const criterion of run.criteria?.selected ?? []) outcomes[criterion.outcome] = (outcomes[criterion.outcome] ?? 0) + 1
    if (run.verdict === 'failed') defectsCaughtBeforeMerge += 1
    model = {
      plan: sumUsage(model.plan, run.model?.plan),
      judge: sumUsage(model.judge, run.model?.judge),
    }
  }
  const notes: Record<MetricsNoteKind, number> = { escape: 0, 'false-block': 0, 'qa-minutes': 0 }
  let qaMinutes = 0
  for (const note of store.notes) {
    if (!(note.kind in notes)) continue
    notes[note.kind] += 1
    if (note.kind === 'qa-minutes' && typeof note.minutes === 'number' && Number.isFinite(note.minutes)) qaMinutes += note.minutes
  }
  return { runs: store.runs.length, wallMs, model, outcomes, defectsCaughtBeforeMerge, notes, qaMinutes, jobs: jobWallClocks(store.runs) }
}

/** The summary as human-readable lines, for `qare ledger status` and the sweep issue. */
export function metricsSummaryLines(summary: MetricsSummary): string[] {
  const lines = [
    `runs recorded: ${summary.runs}`,
    `wall clock: ${formatDuration(summary.wallMs)}`,
  ]
  if (summary.model.plan !== undefined) lines.push(`model cost, plan: ${usageLine(summary.model.plan)}`)
  if (summary.model.judge !== undefined) lines.push(`model cost, judge: ${usageLine(summary.model.judge)}`)
  const outcomes = Object.entries(summary.outcomes)
  if (outcomes.length > 0) lines.push(`criteria by outcome: ${outcomes.sort().map(([k, v]) => `${k} ${v}`).join(', ')}`)
  lines.push(decidedRateLine(summary.outcomes))
  lines.push(`defects caught before merge: ${summary.defectsCaughtBeforeMerge}`)
  lines.push(`escapes found later: ${summary.notes.escape}`)
  lines.push(`false blocks: ${summary.notes['false-block']}`)
  lines.push(`human QA minutes: ${summary.qaMinutes}`)
  if (summary.notes['qa-minutes'] > 0) lines.push(`human QA notes: ${summary.notes['qa-minutes']}`)
  lines.push(...jobLines(summary.jobs))
  return lines
}

/**
 * Each job's wall clock (#381), so a change in run time is measurable: the
 * median over the latest ten runs that recorded the job, beside the median
 * over the ten before them. Ten runs or fewer have one median.
 */
function jobLines(jobs: Record<string, number[]>): string[] {
  const names = Object.keys(jobs).sort()
  if (names.length === 0) return ['job wall clock: no run recorded its jobs']
  return names.map((name) => {
    const times = jobs[name] ?? []
    if (times.length <= JOB_WINDOW) return `job wall clock, ${name}: median ${formatDuration(median(times))} over ${times.length} run${times.length === 1 ? '' : 's'}`
    const latest = times.slice(-JOB_WINDOW)
    const before = times.slice(-2 * JOB_WINDOW, -JOB_WINDOW)
    return `job wall clock, ${name}: median ${formatDuration(median(latest))} over the latest ${JOB_WINDOW} runs, ${formatDuration(median(before))} over the ${before.length} before`
  })
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length === 0) return 0
  return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
}

/**
 * How much of what the runs checked was decided (#373): the share of every
 * recorded criterion outcome that was proven or failed rather than left
 * unverified. With nothing recorded there is no rate, and it is not zero.
 */
function decidedRateLine(outcomes: Record<string, number>): string {
  const total = Object.values(outcomes).reduce((sum, count) => sum + count, 0)
  if (total === 0) return 'proven or failed: no criterion outcomes recorded'
  const decided = (outcomes.proven ?? 0) + (outcomes.failed ?? 0)
  return `proven or failed: ${decided} of ${total} criterion outcomes (${((decided / total) * 100).toFixed(1)}%)`
}

function usageLine(usage: ModelUsage): string {
  return `${usage.inputTokens} input tokens, ${usage.outputTokens} output tokens`
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return `${minutes}m ${rest}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function defaultNow(): Date {
  return new Date()
}
