import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const LEDGER_SCHEMA_VERSION = '1'
export const LEDGER_FILE = 'ledger.json'

export const LEDGER_STATUSES = ['proposed', 'active', 'superseded', 'retired'] as const
export type LedgerStatus = (typeof LEDGER_STATUSES)[number]

/** The kinds of change the ledger records; every ledger-writing path names its own. */
export const LEDGER_CHANGE_KINDS = ['ingest', 'verify', 'supersede', 'regression', 'retire', 'import'] as const
export type LedgerChangeKind = (typeof LEDGER_CHANGE_KINDS)[number]

/**
 * One recorded change to the ledger (#58): who made it, when, and why. The
 * records form a hash chain — each carries the digest of the record before
 * it — so editing, deleting or reordering history is detectable on load:
 * history is never rewritten.
 */
export interface LedgerChange {
  seq: number
  kind: LedgerChangeKind
  actor: string
  timestamp: string
  reason: string
  criteria: string[]
  digest: string
}

export function appendChange(
  changes: LedgerChange[],
  record: {
    kind: LedgerChangeKind
    actor: string
    timestamp: string
    reason: string
    criteria?: string[]
  },
): LedgerChange[] {
  if (typeof record.actor !== 'string' || record.actor.trim() === '')
    throw new Error('ledger change: actor must be a non-empty string')
  if (/[\r\n]/.test(record.actor)) throw new Error('ledger change: actor must not contain newlines')
  if (typeof record.reason !== 'string' || record.reason.trim() === '')
    throw new Error('ledger change: reason must be a non-empty string')
  if (/[\r\n]/.test(record.reason)) throw new Error('ledger change: reason must not contain newlines')
  if (!LEDGER_CHANGE_KINDS.includes(record.kind))
    throw new Error(`ledger change: unknown kind ${JSON.stringify(record.kind)}`)
  if (/[\r\n]/.test(record.timestamp)) throw new Error('ledger change: timestamp must not contain newlines')
  const criteria = record.criteria ?? []
  const seen = new Set<string>()
  for (const criterion of criteria) {
    if (seen.has(criterion)) throw new Error(`ledger change: criterion ${JSON.stringify(criterion)} repeated`)
    seen.add(criterion)
    validateCriterionId(criterion, 'ledger change.criteria')
  }
  const previous = changes.length === 0 ? '' : changes[changes.length - 1]?.digest ?? ''
  const seq = changes.length + 1
  return [
    ...changes,
    {
      seq,
      kind: record.kind,
      actor: record.actor,
      timestamp: record.timestamp,
      reason: record.reason,
      criteria: [...criteria],
      digest: changeDigestOf(previous, { seq, kind: record.kind, actor: record.actor, timestamp: record.timestamp, reason: record.reason, criteria }),
    },
  ]
}

function changeDigestOf(
  previous: string,
  record: { seq: number; kind: string; actor: string; timestamp: string; reason: string; criteria: string[] },
): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify([previous, record.seq, record.kind, record.actor, record.timestamp, record.reason, record.criteria]), 'utf8')
    .digest('hex')}`
}

/** A conflict's classification, as #40 named it and as an answer may record it. */
export type ResolutionClassification = 'supersede' | 'regression'

/**
 * An answer to a conflict question, recorded in the ledger with who decided
 * and why (#41). `question` is the content-addressed question id the answer
 * settles, so the resolution order can find it again: the next conflict over
 * the same pair settles from this history and asks nothing.
 */
export interface LedgerResolution {
  question: string
  classification: ResolutionClassification
  by: string
  why: string
  at: string
}

export interface LedgerEntry {
  criterion: string
  status: LedgerStatus
  source: string[]
  proof: string
  note?: string
  /** The criteria this entry replaced, when it came in over one (#40). */
  supersedes?: string[]
  /** The criterion in plain words, as the ledger's own sketch carries it. */
  text?: string
  /**
   * The checks the criterion is verified by, each a reference selection maps:
   * `suite:<name>` for the screens a suite drives, or a repository path the
   * check exercises with an optional `:fragment` after it.
   */
  checks?: string[]
  /** The answer to a conflict question this entry carries (#41). */
  resolution?: LedgerResolution
}

function fail(field: string, message: string): never {
  throw new Error(`ledger: ${field}: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown, field: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    fail(field, `${label} must be a non-empty string`)
  return value
}

function validateCriterionId(id: string, field: string): string {
  if (id.includes(':'))
    fail(field, `criterion id "${id}" contains ":"; ":" is reserved for namespace prefixes`)
  if (/[/\\]|\.\./.test(id) || /[\x00-\x1f\x7f]/.test(id))
    fail(
      field,
      `criterion id ${JSON.stringify(id)} must not contain path separators, ".." or control characters`,
    )
  return id
}

function sourceLinks(value: unknown, field: string): string[] {
  if (value === undefined) fail(field, 'source is required')
  if (!Array.isArray(value)) fail(field, 'source must be an array of links')
  return value.map((entry, index) => {
    const link = nonEmptyString(entry, `${field}[${index}]`, 'source link')
    if (/[\r\n]/.test(link)) fail(`${field}[${index}]`, 'source link must not contain newlines')
    return link
  })
}

function parseEntry(entry: unknown, field: string): LedgerEntry {
  if (!isRecord(entry)) fail(field, 'ledger entry must be a JSON object')
  const allowed = new Set(['criterion', 'status', 'source', 'proof', 'note', 'supersedes', 'text', 'checks', 'resolution'])
  for (const key of Object.keys(entry)) {
    if (!allowed.has(key)) fail(`${field}.${key}`, 'unknown field in ledger entry')
  }
  const criterion = validateCriterionId(
    nonEmptyString(entry.criterion, `${field}.criterion`, 'criterion id'),
    `${field}.criterion`,
  )
  const status = entry.status
  if (typeof status !== 'string' || !LEDGER_STATUSES.includes(status as LedgerStatus))
    fail(
      `${field}.status`,
      `unknown status ${JSON.stringify(status)} (expected "proposed", "active", "superseded" or "retired")`,
    )
  const proof = nonEmptyString(entry.proof, `${field}.proof`, 'proof type')
  if (/[\r\n]/.test(proof)) fail(`${field}.proof`, 'proof must not contain newlines')
  const parsed: LedgerEntry = {
    criterion,
    status: status as LedgerStatus,
    source: sourceLinks(entry.source, `${field}.source`),
    proof,
  }
  if (entry.note !== undefined) {
    const note = nonEmptyString(entry.note, `${field}.note`, 'note')
    if (/[\r\n]/.test(note)) fail(`${field}.note`, 'note must not contain newlines')
    parsed.note = note
  }
  if (entry.supersedes !== undefined) {
    if (!Array.isArray(entry.supersedes)) fail(`${field}.supersedes`, 'supersedes must be an array of criterion ids')
    const supersedes = entry.supersedes.map((id, index) =>
      validateCriterionId(
        nonEmptyString(id, `${field}.supersedes[${index}]`, 'criterion id'),
        `${field}.supersedes[${index}]`,
      ),
    )
    if (new Set(supersedes).size !== supersedes.length)
      fail(`${field}.supersedes`, 'supersedes must not repeat a criterion id')
    parsed.supersedes = supersedes
  }
  if (entry.text !== undefined) {
    const text = nonEmptyString(entry.text, `${field}.text`, 'criterion text')
    if (/[\r\n]/.test(text)) fail(`${field}.text`, 'criterion text must not contain newlines')
    parsed.text = text
  }
  if (entry.checks !== undefined) {
    if (!Array.isArray(entry.checks)) fail(`${field}.checks`, 'checks must be an array of check references')
    parsed.checks = entry.checks.map((check, index) => {
      const reference = nonEmptyString(check, `${field}.checks[${index}]`, 'check reference')
      if (/[\r\n]/.test(reference)) fail(`${field}.checks[${index}]`, 'check reference must not contain newlines')
      return reference
    })
  }
  if (entry.resolution !== undefined) {
    parsed.resolution = parseResolution(entry.resolution, `${field}.resolution`)
  }
  return parsed
}

const QUESTION_ID_PATTERN = /^q-[0-9a-f]{16}$/

function parseResolution(value: unknown, field: string): LedgerResolution {
  if (!isRecord(value)) fail(field, 'resolution must be a JSON object')
  const allowed = new Set(['question', 'classification', 'by', 'why', 'at'])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${field}.${key}`, 'unknown field in ledger resolution')
  }
  const question = nonEmptyString(value.question, `${field}.question`, 'question id')
  if (!QUESTION_ID_PATTERN.test(question))
    fail(`${field}.question`, `question id ${JSON.stringify(question)} must match q- followed by 16 hex characters`)
  const classification = value.classification
  if (classification !== 'supersede' && classification !== 'regression')
    fail(`${field}.classification`, `unknown classification ${JSON.stringify(classification)} (expected "supersede" or "regression")`)
  const by = nonEmptyString(value.by, `${field}.by`, 'decider')
  if (/[\r\n]/.test(by)) fail(`${field}.by`, 'decider must not contain newlines')
  const why = nonEmptyString(value.why, `${field}.why`, 'why')
  if (/[\r\n]/.test(why)) fail(`${field}.why`, 'why must not contain newlines')
  const at = nonEmptyString(value.at, `${field}.at`, 'decided at')
  if (/[\r\n]/.test(at)) fail(`${field}.at`, 'decided at must not contain newlines')
  return { question, classification, by, why, at }
}

function canonicalEntries(entries: LedgerEntry[]): Record<string, unknown>[] {
  return [...entries]
    .sort((a, b) => (a.criterion < b.criterion ? -1 : a.criterion > b.criterion ? 1 : 0))
    .map((entry) => {
      const sorted: Record<string, unknown> = {}
      for (const key of ['criterion', 'status', 'source', 'proof', 'note', 'supersedes', 'text', 'checks', 'resolution'].sort()) {
        if (entry[key as keyof LedgerEntry] !== undefined) sorted[key] = entry[key as keyof LedgerEntry]
      }
      return sorted
    })
}

export function integrityOf(entries: LedgerEntry[]): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalEntries(entries)), 'utf8').digest('hex')}`
}

export function parseLedgerEntries(input: unknown): LedgerEntry[] {
  return parseLedgerDocument(input).entries
}

export interface LedgerDocument {
  entries: LedgerEntry[]
  changes: LedgerChange[]
}

export function parseLedgerDocument(input: unknown): LedgerDocument {
  if (!isRecord(input)) fail('document', 'ledger must be a JSON object with a "entries" array')
  for (const key of Object.keys(input)) {
    if (key !== 'entries' && key !== 'schemaVersion' && key !== 'integrity' && key !== 'changes')
      fail(`document.${key}`, 'unknown field in ledger document')
  }
  if (input.schemaVersion !== LEDGER_SCHEMA_VERSION)
    fail(
      'document.schemaVersion',
      `unsupported ledger schema version ${JSON.stringify(input.schemaVersion)} (expected "${LEDGER_SCHEMA_VERSION}")`,
    )
  if (!Array.isArray(input.entries)) fail('document.entries', 'entries must be a JSON array')
  const entries = input.entries.map((entry, index) => parseEntry(entry, `entries[${index}]`))
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.criterion))
      fail('document.entries', `duplicate criterion "${entry.criterion}" in ledger`)
    seen.add(entry.criterion)
  }
  const expected = integrityOf(entries)
  if (input.integrity !== expected)
    fail(
      'document.integrity',
      `ledger integrity check failed: expected ${expected}, got ${JSON.stringify(input.integrity)}`,
    )
  const changes = input.changes === undefined ? [] : parseChanges(input.changes)
  return { entries, changes }
}

/** The chain is validated record by record: a rewritten history cannot load.
 *
 * An edit, a drop or a reorder of the records a document still carries is
 * detected here. Deleting the last records cannot be detected from the
 * document alone, because the document is the only thing carrying them; an
 * external copy of the chain's head, such as the published history file, is
 * what a rollback is checked against. */
function parseChanges(value: unknown): LedgerChange[] {
  if (!Array.isArray(value)) fail('document.changes', 'changes must be a JSON array')
  let previous = ''
  return value.map((entry, index) => {
    const change = parseChange(entry, index)
    if (change.seq !== index + 1)
      fail(
        `document.changes[${index}]`,
        `history must be sequential: record ${index} carries seq ${change.seq}, expected ${index + 1}`,
      )
    const expectedDigest = changeDigestOf(previous, change)
    if (change.digest !== expectedDigest)
      fail(
        `document.changes[${index}]`,
        `history does not match its chain: record ${change.seq} claims ${change.digest} but the chain computes ${expectedDigest}; history has been rewritten`,
      )
    previous = change.digest
    return change
  })
}

function parseChange(entry: unknown, index: number): LedgerChange {
  const field = `document.changes[${index}]`
  if (!isRecord(entry)) fail(field, 'ledger change must be a JSON object')
  const allowed = new Set(['seq', 'kind', 'actor', 'timestamp', 'reason', 'criteria', 'digest'])
  for (const key of Object.keys(entry)) {
    if (!allowed.has(key)) fail(`${field}.${key}`, 'unknown field in ledger change')
  }
  if (typeof entry.seq !== 'number' || !Number.isInteger(entry.seq) || entry.seq < 1)
    fail(`${field}.seq`, 'seq must be a positive whole number')
  const kind = entry.kind
  if (typeof kind !== 'string' || !LEDGER_CHANGE_KINDS.includes(kind as LedgerChangeKind))
    fail(`${field}.kind`, `unknown kind ${JSON.stringify(kind)}`)
  const actor = nonEmptyString(entry.actor, `${field}.actor`, 'actor')
  if (/[\r\n]/.test(actor)) fail(`${field}.actor`, 'actor must not contain newlines')
  const timestamp = nonEmptyString(entry.timestamp, `${field}.timestamp`, 'timestamp')
  if (/[\r\n]/.test(timestamp)) fail(`${field}.timestamp`, 'timestamp must not contain newlines')
  const reason = nonEmptyString(entry.reason, `${field}.reason`, 'reason')
  if (/[\r\n]/.test(reason)) fail(`${field}.reason`, 'reason must not contain newlines')
  if (!Array.isArray(entry.criteria)) fail(`${field}.criteria`, 'criteria must be an array of criterion ids')
  const criteria = entry.criteria.map((id, position) =>
    validateCriterionId(nonEmptyString(id, `${field}.criteria[${position}]`, 'criterion id'), `${field}.criteria[${position}]`),
  )
  const digest = nonEmptyString(entry.digest, `${field}.digest`, 'digest')
  return { seq: entry.seq, kind: kind as LedgerChangeKind, actor, timestamp, reason, criteria, digest }
}

export function serializeLedger(entries: LedgerEntry[]): string {
  const canonical = canonicalEntries(entries)
  return `${JSON.stringify(
    { entries: canonical, schemaVersion: LEDGER_SCHEMA_VERSION, integrity: integrityOf(entries) },
    null,
    2,
  )}\n`
}

export function serializeLedgerDocument(entries: LedgerEntry[], changes: LedgerChange[]): string {
  const document =
    changes.length === 0
      ? { entries: canonicalEntries(entries), schemaVersion: LEDGER_SCHEMA_VERSION, integrity: integrityOf(entries) }
      : {
          entries: canonicalEntries(entries),
          changes,
          schemaVersion: LEDGER_SCHEMA_VERSION,
          integrity: integrityOf(entries),
        }
  return `${JSON.stringify(document, null, 2)}\n`
}

export interface LedgerStore {
  load(): Promise<LedgerEntry[]>
  save(entries: LedgerEntry[], changes?: LedgerChange[]): Promise<void>
}

export class FileLedgerStore implements LedgerStore {
  private readonly file: string

  constructor(dir: string) {
    this.file = join(dir, LEDGER_FILE)
  }

  async load(): Promise<LedgerEntry[]> {
    return (await this.loadDocument()).entries
  }

  async loadDocument(): Promise<LedgerDocument> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return { entries: [], changes: [] }
      throw error
    }
    return parseLedgerDocument(JSON.parse(text))
  }

  async save(entries: LedgerEntry[], changes?: LedgerChange[]): Promise<void> {
    // A write that omits the history must not silently drop it: history is
    // never rewritten, so the changes already recorded are carried through.
    // And once history exists, entries cannot change without a record of who
    // made the change: a mutation a record does not name is refused.
    if (changes === undefined) {
      const current = await this.loadDocument()
      if (
        current.changes.length > 0 &&
        integrityOf(current.entries) !== integrityOf(entries)
      )
        throw new Error(
          'ledger: entries changed without a change record; append the record that names who made this change, when, and why',
        )
      changes = current.changes
    }
    await this.saveDocument(entries, changes)
  }

  async saveDocument(entries: LedgerEntry[], changes: LedgerChange[]): Promise<void> {
    const text = serializeLedgerDocument(entries, changes)
    // The fold is only as good as the ledger it writes: the same strict
    // loader a run reads with judges the document before it is written out.
    parseLedgerDocument(JSON.parse(text))
    await mkdir(join(this.file, '..'), { recursive: true })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, text)
    await rename(tmp, this.file)
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
  )
}

export interface GitRunResult {
  stdout: string
}

export type GitRun = (args: string[], input?: string) => Promise<GitRunResult>

function defaultRun(repoPath: string): GitRun {
  return (args, input) =>
    new Promise((resolve, reject) => {
      const child = execFile('git', args, { cwd: repoPath }, (error, stdout) => {
        if (error !== null) {
          reject(new Error(`git ${args.join(' ')} failed: ${String(error)}`))
          return
        }
        resolve({ stdout })
      })
      if (input !== undefined) child.stdin?.end(input)
    })
}

export class BranchLedgerStore implements LedgerStore {
  private readonly run: GitRun
  private readonly branch: string

  constructor(repoPath: string, branch = 'qare-ledger', opts?: { run?: GitRun }) {
    this.branch = branch
    this.run = opts?.run ?? defaultRun(repoPath)
  }

  async load(): Promise<LedgerEntry[]> {
    return (await this.loadDocument()).entries
  }

  async loadDocument(): Promise<LedgerDocument> {
    try {
      await this.run(['rev-parse', '--verify', `refs/heads/${this.branch}`])
    } catch {
      return { entries: [], changes: [] }
    }
    let text: string
    try {
      text = (await this.run(['show', `${this.branch}:${LEDGER_FILE}`])).stdout
    } catch (error) {
      throw new Error(`ledger: branch exists but ${LEDGER_FILE} is unreadable: ${String(error)}`)
    }
    return parseLedgerDocument(JSON.parse(text))
  }

  async save(entries: LedgerEntry[], changes?: LedgerChange[]): Promise<void> {
    if (changes === undefined) {
      const current = await this.loadDocument()
      if (
        current.changes.length > 0 &&
        integrityOf(current.entries) !== integrityOf(entries)
      )
        throw new Error(
          'ledger: entries changed without a change record; append the record that names who made this change, when, and why',
        )
      changes = current.changes
    }
    // The same strict loader a run reads with judges the document before any
    // of it is written out, so invalid entries or a broken chain never commit.
    const text = serializeLedgerDocument(entries, changes)
    parseLedgerDocument(JSON.parse(text))
    const blob = (await this.run(['hash-object', '-w', '--stdin'], text)).stdout.trim()
    const tree = (await this.run(['mktree'], `100644 blob ${blob}\t${LEDGER_FILE}`)).stdout.trim()
    let parent: string | undefined
    try {
      parent = (await this.run(['rev-parse', '--verify', `refs/heads/${this.branch}`])).stdout.trim()
    } catch {
      parent = undefined
    }
    const commit = (
      await this.run(
        parent === undefined
          ? ['commit-tree', tree, '-m', 'criteria ledger update']
          : ['commit-tree', tree, '-p', parent, '-m', 'criteria ledger update'],
      )
    ).stdout.trim()
    await this.run(['update-ref', `refs/heads/${this.branch}`, commit])
  }
}
