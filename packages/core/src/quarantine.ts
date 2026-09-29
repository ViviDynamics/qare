import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stableStringify } from './cache.js'
import type { JobCheck } from './job.js'

export const QUARANTINE_SCHEMA_VERSION = '1'
export const QUARANTINE_FILE = 'quarantine.json'

/**
 * One quarantined check (#50): the check as the plan authored it, named for
 * the human, addressed by a fingerprint over the authored form, with the
 * reason it was quarantined and the date that happened. A quarantined check
 * runs no more, and the criterion it belongs to reports unverified, never
 * proven: quarantine is a bounded pause, not a pass.
 */
export interface QuarantineRecord {
  /** The check's authored name, or a kind and position description when unnamed. */
  check: string
  /** A sha256 over the criterion id and the check as authored. */
  fingerprint: string
  /** The criterion the check belonged to when it was quarantined. */
  criterion: string
  /** Why the check was quarantined. */
  reason: string
  /** When the check was quarantined, as an ISO 8601 timestamp. */
  quarantinedAt: string
}

/** The run's quarantine store: the file in `dir`, or an empty store. */
export interface QuarantineContext {
  dir: string
  records: QuarantineRecord[]
  /** Set when the store is there but cannot be read; nothing is applied and nothing is written over it. */
  unreadable?: string
}

/**
 * A stable fingerprint over the criterion and the check as the plan authored
 * it, before any run value is substituted, so a minted port or run id can
 * never move a check's address: the same authored check is the same check,
 * whatever the run minted around it.
 */
export function checkFingerprint(criterionId: string, check: JobCheck): string {
  return `sha256:${createHash('sha256').update(stableStringify([criterionId, check]), 'utf8').digest('hex')}`
}

/** The name a quarantine record carries for a check: authored when there is one. */
export function quarantineCheckName(check: JobCheck, criterionId: string, index: number): string {
  if ('name' in check && check.name !== undefined) return check.name
  return `${check.kind} check ${index} of criterion ${criterionId}`
}

/**
 * Read a quarantine store from `dir`. A directory with no store yet is an
 * empty store. A store that is there but malformed is not an error and not
 * a claim: it reads as unreadable, no record is applied, and nothing the
 * caller writes may land over it, so the run quarantines nothing it cannot
 * read and the checks run for real.
 */
export async function readQuarantine(dir: string): Promise<QuarantineContext> {
  const context: QuarantineContext = { dir, records: [] }
  let text: string
  try {
    text = await readFile(join(dir, QUARANTINE_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      context.unreadable = error instanceof Error ? error.message : String(error)
    return context
  }
  try {
    context.records = recordsFrom(JSON.parse(text))
  } catch (error) {
    context.unreadable = error instanceof Error ? error.message : String(error)
  }
  return context
}

/** The run's view of the store: none when no directory was given. */
export async function openQuarantine(dir: string | undefined): Promise<QuarantineContext | undefined> {
  return dir === undefined ? undefined : readQuarantine(dir)
}

function recordsFrom(parsed: unknown): QuarantineRecord[] {
  if (typeof parsed !== 'object' || parsed === null) return []
  const document = parsed as Record<string, unknown>
  // A store a future schema wrote is not one this version reads: no record
  // is applied, and the checks run for real.
  if (document.schemaVersion !== QUARANTINE_SCHEMA_VERSION) return []
  if (!Array.isArray(document.records)) return []
  const records: QuarantineRecord[] = []
  for (const entry of document.records) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (
      typeof record.check !== 'string' ||
      record.check === '' ||
      typeof record.fingerprint !== 'string' ||
      record.fingerprint === '' ||
      typeof record.criterion !== 'string' ||
      record.criterion === '' ||
      typeof record.reason !== 'string' ||
      record.reason === '' ||
      typeof record.quarantinedAt !== 'string' ||
      record.quarantinedAt === ''
    )
      continue
    records.push({
      check: record.check,
      fingerprint: record.fingerprint,
      criterion: record.criterion,
      reason: record.reason,
      quarantinedAt: record.quarantinedAt,
    })
  }
  return records
}

/** The record a fingerprint was quarantined under, when there is one. */
export function quarantinedRecord(
  context: QuarantineContext | undefined,
  fingerprint: string,
): QuarantineRecord | undefined {
  return context?.records.find((record) => record.fingerprint === fingerprint)
}

/**
 * Record a quarantined check: one record per fingerprint, so quarantining
 * the same check again updates the reason and the date rather than piling up.
 */
export function addQuarantineRecord(context: QuarantineContext, record: QuarantineRecord): void {
  context.records = [...context.records.filter((entry) => entry.fingerprint !== record.fingerprint), record]
}

/**
 * Persist the store. An unreadable store is left exactly as it was read: the
 * run has already named it on its own error stream, and a quarantining that
 * could not read the store does not get to blind the next run with a half
 * file of its own.
 */
export async function saveQuarantine(context: QuarantineContext | undefined): Promise<void> {
  if (context === undefined || context.unreadable !== undefined) return
  await mkdir(context.dir, { recursive: true })
  await writeFile(
    join(context.dir, QUARANTINE_FILE),
    `${JSON.stringify({ schemaVersion: QUARANTINE_SCHEMA_VERSION, records: context.records }, null, 2)}\n`,
  )
}
