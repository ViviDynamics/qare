import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const LEDGER_SCHEMA_VERSION = '1'
export const LEDGER_FILE = 'ledger.json'

export const LEDGER_STATUSES = ['proposed', 'active', 'superseded', 'retired'] as const
export type LedgerStatus = (typeof LEDGER_STATUSES)[number]

export interface LedgerEntry {
  criterion: string
  status: LedgerStatus
  source: string[]
  proof: string
  note?: string
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
  const allowed = new Set(['criterion', 'status', 'source', 'proof', 'note'])
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
  return parsed
}

function canonicalEntries(entries: LedgerEntry[]): Record<string, unknown>[] {
  return [...entries]
    .sort((a, b) => (a.criterion < b.criterion ? -1 : a.criterion > b.criterion ? 1 : 0))
    .map((entry) => {
      const sorted: Record<string, unknown> = {}
      for (const key of ['criterion', 'status', 'source', 'proof', 'note'].sort()) {
        if (entry[key as keyof LedgerEntry] !== undefined) sorted[key] = entry[key as keyof LedgerEntry]
      }
      return sorted
    })
}

export function integrityOf(entries: LedgerEntry[]): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalEntries(entries)), 'utf8').digest('hex')}`
}

export function parseLedgerEntries(input: unknown): LedgerEntry[] {
  if (!isRecord(input)) fail('document', 'ledger must be a JSON object with a "entries" array')
  for (const key of Object.keys(input)) {
    if (key !== 'entries' && key !== 'schemaVersion' && key !== 'integrity')
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
  return entries
}

export function serializeLedger(entries: LedgerEntry[]): string {
  const canonical = canonicalEntries(entries)
  return `${JSON.stringify(
    { entries: canonical, schemaVersion: LEDGER_SCHEMA_VERSION, integrity: integrityOf(entries) },
    null,
    2,
  )}\n`
}

function validated(entries: LedgerEntry[]): LedgerEntry[] {
  return parseLedgerEntries(JSON.parse(serializeLedger(entries)))
}

export interface LedgerStore {
  load(): Promise<LedgerEntry[]>
  save(entries: LedgerEntry[]): Promise<void>
}

export class FileLedgerStore implements LedgerStore {
  private readonly file: string

  constructor(dir: string) {
    this.file = join(dir, LEDGER_FILE)
  }

  async load(): Promise<LedgerEntry[]> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return []
      throw error
    }
    return parseLedgerEntries(JSON.parse(text))
  }

  async save(entries: LedgerEntry[]): Promise<void> {
    const text = serializeLedger(validated(entries))
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
    try {
      await this.run(['rev-parse', '--verify', `refs/heads/${this.branch}`])
    } catch {
      return []
    }
    let text: string
    try {
      text = (await this.run(['show', `${this.branch}:${LEDGER_FILE}`])).stdout
    } catch (error) {
      throw new Error(`ledger: branch exists but ${LEDGER_FILE} is unreadable: ${String(error)}`)
    }
    return parseLedgerEntries(JSON.parse(text))
  }

  async save(entries: LedgerEntry[]): Promise<void> {
    const blob = (
      await this.run(['hash-object', '-w', '--stdin'], serializeLedger(validated(entries)))
    ).stdout.trim()
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
