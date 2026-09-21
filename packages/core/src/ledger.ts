import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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

export function parseLedgerEntries(input: unknown): LedgerEntry[] {
  if (!Array.isArray(input)) fail('entries', 'ledger must be a JSON array')
  return input.map((entry, index) => {
    const field = `entries[${index}]`
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
  })
}

export function serializeLedger(entries: LedgerEntry[]): string {
  const canonical = [...entries]
    .sort((a, b) => (a.criterion < b.criterion ? -1 : a.criterion > b.criterion ? 1 : 0))
    .map((entry) => {
      const sorted: Record<string, unknown> = {}
      for (const key of ['criterion', 'status', 'source', 'proof', 'note'].sort()) {
        if (entry[key as keyof LedgerEntry] !== undefined) sorted[key] = entry[key as keyof LedgerEntry]
      }
      return sorted
    })
  return `${JSON.stringify(canonical, null, 2)}\n`
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
    } catch {
      return []
    }
    return parseLedgerEntries(JSON.parse(text))
  }

  async save(entries: LedgerEntry[]): Promise<void> {
    await mkdir(join(this.file, '..'), { recursive: true })
    await writeFile(this.file, serializeLedger(entries))
  }
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
    let text: string
    try {
      text = (await this.run(['show', `${this.branch}:${LEDGER_FILE}`])).stdout
    } catch {
      return []
    }
    return parseLedgerEntries(JSON.parse(text))
  }

  async save(entries: LedgerEntry[]): Promise<void> {
    const blob = (
      await this.run(['hash-object', '-w', '--stdin'], serializeLedger(entries))
    ).stdout.trim()
    const tree = (
      await this.run(['mktree'], `100644 blob ${blob}\t${LEDGER_FILE}`)
    ).stdout.trim()
    let commit: string
    try {
      const parent = (await this.run(['rev-parse', '--verify', `refs/heads/${this.branch}`])).stdout.trim()
      commit = (await this.run(['commit-tree', tree, '-p', parent, '-m', 'criteria ledger update'])).stdout.trim()
    } catch {
      commit = (await this.run(['commit-tree', tree, '-m', 'criteria ledger update'])).stdout.trim()
    }
    await this.run(['update-ref', `refs/heads/${this.branch}`, commit])
  }
}
