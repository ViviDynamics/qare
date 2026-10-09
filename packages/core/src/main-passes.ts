import { createHash } from 'node:crypto'
import type { LedgerDocument, LedgerEntry } from './ledger.js'
import type { RunResult } from './result.js'

/**
 * The record of what a run on the default branch proved (#295): for each
 * criterion, the revision it last passed on. It is what lets a later failure
 * be called a regression and traced to the changes since (#154).
 *
 * It is kept beside the ledger, never in it. The ledger holds criteria, and
 * criteria change only through review (rule 5); that a criterion passed on a
 * revision is a fact about a run, like its metrics, and is recorded the way
 * they are: as a file on the orphan `qa-assets` branch, written by the
 * judge-side step that holds the identity and runs no repository code
 * (rule 7). A pass can only be read as far as this record can be trusted,
 * so it is small, strict and decided in code:
 *
 * - What is recorded is the judged result's `proven` criteria and nothing
 *   else (rule 3). The verifier can only take a pass away, so no model
 *   output can add one.
 * - A pass is of one wording. Each record carries a digest of the ledger
 *   entry it proved, and a criterion whose text, proof or checks have changed
 *   since has no pass until a run proves it again.
 * - A record that cannot be read is an error by name, never "no record" and
 *   never a guess (rule 6).
 */

export const MAIN_PASSES_SCHEMA_VERSION = '1'
/** Where the record sits on the `qa-assets` branch, for the usual profile. */
export const MAIN_PASSES_PATH = 'passes/main.json'

/** The last pass of one criterion on the default branch. */
export interface MainPass {
  /** The revision the passing run checked. */
  sha: string
  /** When that revision was committed: the moment the changes since are counted from. */
  at: string
  /** The run that proved it, as its caller names it: a link or an id. */
  run: string
  /** When the pass was recorded. */
  recordedAt: string
  /** The digest of the ledger entry that was proven: its id, text, proof and checks. */
  entry: string
}

export interface MainPasses {
  /** The last pass of each criterion, by criterion id. */
  passes: Record<string, MainPass>
}

export class MainPassesError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MainPassesError'
  }
}

function fail(field: string, message: string): never {
  throw new MainPassesError(`main passes: ${field}: ${message}`)
}

/**
 * Where a profile's record sits on the `qa-assets` branch. A repository may
 * carry several profiles, each with a ledger of its own, and a run drops
 * the passes its ledger no longer carries: so each profile has a record of
 * its own, and one profile's run never reads or drops another's passes. The
 * usual profile (`.qa`, or none named) keeps `passes/main.json`. Any other
 * is named by its directory, under `passes/profiles/`: nothing in it may
 * climb out or hide.
 */
export function mainPassesPath(profile?: string): string {
  const given = profile ?? ''
  const named = given.replace(/^(\.\/)+/, '').replace(/\/+$/, '')
  if (given === '' || named === '.qa') return MAIN_PASSES_PATH
  if (named === '' || named.split('/').some((segment) => segment === '' || segment === '.' || segment === '..') || !/^[A-Za-z0-9._/-]+$/.test(named))
    fail('profile', `${JSON.stringify(profile)} cannot name a record: a profile directory is repository-relative, of letters, digits, ".", "_", "-" and "/", with no "." or ".." segment`)
  // The directory itself, under a prefix of its own: two directories are
  // never one record, and none can sit on the usual record or in another's.
  return `passes/profiles/${named}/main.json`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const SHA = /^[0-9a-f]{40}$/
const DIGEST = /^sha256:[0-9a-f]{64}$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

function instant(value: unknown, field: string): string {
  if (typeof value !== 'string' || !INSTANT.test(value) || Number.isNaN(Date.parse(value)))
    fail(field, `${JSON.stringify(value)} is not an instant like "2026-10-09T04:17:00Z"`)
  return value
}

function criterionId(id: string, field: string): string {
  // `__proto__` is no key a plain object can hold as its own.
  if (id === '' || id === '__proto__' || id.includes(':') || /[/\\]|\.\./.test(id) || /[\x00-\x1f\x7f]/.test(id))
    fail(field, `${JSON.stringify(id)} is not a ledger criterion id`)
  return id
}

function parsePass(value: unknown, field: string): MainPass {
  if (!isRecord(value)) fail(field, 'a pass must be a JSON object')
  const allowed = ['sha', 'at', 'run', 'recordedAt', 'entry']
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${field}.${key}`, 'unknown field in a pass')
  if (typeof value.sha !== 'string' || !SHA.test(value.sha)) fail(`${field}.sha`, `${JSON.stringify(value.sha)} is not a 40 character commit`)
  if (typeof value.run !== 'string' || value.run.trim() === '' || /[\r\n]/.test(value.run)) fail(`${field}.run`, 'the run must be one line that names it')
  if (typeof value.entry !== 'string' || !DIGEST.test(value.entry)) fail(`${field}.entry`, `${JSON.stringify(value.entry)} is not a sha256 digest`)
  return { sha: value.sha, at: instant(value.at, `${field}.at`), run: value.run, recordedAt: instant(value.recordedAt, `${field}.recordedAt`), entry: value.entry }
}

/** Read the record strictly: anything it does not expect is an error by name. */
export function parseMainPasses(text: string): MainPasses {
  let input: unknown
  try {
    input = JSON.parse(text)
  } catch (error) {
    throw new MainPassesError(`main passes: the record is not JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  if (!isRecord(input)) fail('document', 'the record must be a JSON object with schemaVersion and passes')
  for (const key of Object.keys(input)) if (key !== 'schemaVersion' && key !== 'passes') fail(`document.${key}`, 'unknown field in the record')
  if (input.schemaVersion !== MAIN_PASSES_SCHEMA_VERSION)
    fail('document.schemaVersion', `unsupported schema version ${JSON.stringify(input.schemaVersion)} (expected "${MAIN_PASSES_SCHEMA_VERSION}")`)
  if (!isRecord(input.passes)) fail('document.passes', 'passes must be a JSON object keyed by criterion id')
  const passes: Record<string, MainPass> = {}
  for (const [id, value] of Object.entries(input.passes)) passes[criterionId(id, 'document.passes')] = parsePass(value, `passes[${JSON.stringify(id)}]`)
  return { passes }
}

/** The record as it is written: criteria in order, so the same passes are the same bytes. */
export function serializeMainPasses(store: MainPasses): string {
  const passes: Record<string, MainPass> = {}
  for (const id of Object.keys(store.passes).sort()) {
    const pass = store.passes[id]
    if (pass !== undefined) passes[id] = { sha: pass.sha, at: pass.at, run: pass.run, recordedAt: pass.recordedAt, entry: pass.entry }
  }
  const text = `${JSON.stringify({ schemaVersion: MAIN_PASSES_SCHEMA_VERSION, passes }, null, 2)}\n`
  // What is written is what the strict reader takes, or it is not written.
  parseMainPasses(text)
  return text
}

/**
 * What a pass is a pass of: the criterion as the ledger words it and proves
 * it. Its status, note and sources are not part of that, so a review that
 * touches only those leaves a pass standing.
 */
export function mainPassEntryDigest(entry: LedgerEntry): string {
  // The checks as a set: the order they are listed in is no part of what was proven.
  const proven = { criterion: entry.criterion, text: entry.text ?? null, proof: entry.proof, checks: [...new Set(entry.checks ?? [])].sort() }
  return `sha256:${createHash('sha256').update(JSON.stringify(proven), 'utf8').digest('hex')}`
}

/**
 * The criteria a judged result of a run on the default branch records a pass
 * for: the ones it proved that the ledger carries as `active`, in the
 * result's order. A criterion the ledger does not carry, or carries in any
 * other status, is not the ledger's to have passed.
 */
export function mainPassesToRecord(result: RunResult, ledger: LedgerDocument): string[] {
  const active = new Set(ledger.entries.filter((entry) => entry.status === 'active').map((entry) => entry.criterion))
  return result.criteria.filter((criterion) => criterion.outcome === 'proven' && active.has(criterion.id)).map((criterion) => criterion.id)
}

/**
 * The record with a run's passes written over the ones it had. A criterion
 * the run did not prove keeps the pass it had: that is the revision a later
 * issue counts the changes from. So does a criterion whose recorded pass is
 * of a revision that is not behind this run's.
 */
export function recordMainPasses(
  store: MainPasses,
  run: { sha: string; at: string; run: string; recordedAt: string },
  criteria: readonly string[],
  ledger: LedgerDocument,
  /**
   * Whether this run's revision may speak for a recorded one: true unless
   * the recorded revision is ahead of this run's in the history. Runs do not
   * always finish in the order their revisions landed, and a run can be
   * started again days later: such a run reads its own revision's ledger,
   * which may word a criterion differently and may lack criteria added
   * since. A pass of a revision ahead of this run's is therefore left
   * exactly as it is, neither replaced nor dropped. A pass of a revision the
   * history no longer relates to this one (rewritten away) is not ahead, and
   * is replaced like any other. Left out, no recorded revision is taken to
   * be ahead: the caller vouches for the order.
   */
  behind: (sha: string) => boolean = () => true,
): MainPasses {
  const entries = new Map(ledger.entries.map((entry) => [entry.criterion, entry]))
  const mine = (pass: MainPass): boolean => pass.sha === run.sha || behind(pass.sha)
  // A pass of a criterion this run's ledger no longer carries can never
  // stand again (it has no entry to be a pass of), so it is not carried
  // forward: the record holds what the ledger holds, and does not only
  // grow. Only where this run's ledger is the later word.
  const passes = Object.fromEntries(Object.entries(store.passes).filter(([id, pass]) => entries.has(id) || !mine(pass)))
  for (const id of criteria) {
    const entry = entries.get(id)
    if (entry === undefined || entry.status !== 'active') continue
    criterionId(id, 'criteria')
    const had = passes[id]
    if (had !== undefined && !mine(had)) continue
    passes[id] = { sha: run.sha, at: run.at, run: run.run, recordedAt: run.recordedAt, entry: mainPassEntryDigest(entry) }
  }
  return parseMainPasses(serializeMainPasses({ passes }))
}

/**
 * The passes that still stand for the ledger as it is now: of a criterion
 * the ledger carries, in the wording and with the checks it has today. A
 * pass of other words is no pass of these.
 */
export function standingMainPasses(store: MainPasses, ledger: LedgerDocument): Map<string, MainPass> {
  const standing = new Map<string, MainPass>()
  for (const entry of ledger.entries) {
    const pass = store.passes[entry.criterion]
    if (pass !== undefined && pass.entry === mainPassEntryDigest(entry)) standing.set(entry.criterion, pass)
  }
  return standing
}
