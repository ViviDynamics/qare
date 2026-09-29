import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The numbers that say whether QARE is working (#51): what one run cost and
 * decided, and what a repository's runs amount to over time.
 *
 * The data lives in the repository, not only in logs: one JSON line per run
 * in `metrics/runs.jsonl` under the ledger directory, and one JSON line per
 * human note in `metrics/notes.jsonl`. A reader that finds a store missing
 * reads an empty one, and a line it cannot parse is skipped and named, never
 * fatal: metrics describe runs, they do not gate them.
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

/** Read a metrics store at `dir` (the directory itself, not its parent). A missing directory reads as empty. */
export async function readMetricsStore(dir: string): Promise<MetricsStore> {
  const [runs, notes] = await Promise.all([readLines<RunMetricsRecord>(join(dir, RUNS_FILE)), readLines<MetricsNote>(join(dir, NOTES_FILE))])
  return { runs: runs.values, notes: notes.values, malformed: runs.malformed + notes.malformed }
}

async function readLines<T>(file: string): Promise<{ values: T[]; malformed: number }> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return { values: [], malformed: 0 }
  }
  const values: T[] = []
  let malformed = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      values.push(JSON.parse(line) as T)
    } catch {
      malformed += 1
    }
  }
  return { values, malformed }
}

/** Append one run record as a line. Creates the store directory when missing. */
export async function appendRunMetrics(dir: string, record: Omit<RunMetricsRecord, 'schemaVersion' | 'recordedAt'>, now: () => Date = defaultNow): Promise<void> {
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
  return { runs: store.runs.length, wallMs, model, outcomes, defectsCaughtBeforeMerge, notes, qaMinutes }
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
  lines.push(`defects caught before merge: ${summary.defectsCaughtBeforeMerge}`)
  lines.push(`escapes found later: ${summary.notes.escape}`)
  lines.push(`false blocks: ${summary.notes['false-block']}`)
  lines.push(`human QA minutes: ${summary.qaMinutes}`)
  if (summary.notes['qa-minutes'] > 0) lines.push(`human QA notes: ${summary.notes['qa-minutes']}`)
  return lines
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
