import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { JobCheck, JobCriterion } from './job.js'
import type { QaProfile } from './profile.js'
import { parseResult, RESULT_SCHEMA_VERSION } from './result.js'

/**
 * Canonical JSON: object keys sorted, no whitespace, undefined flattened away.
 * A hash over this form is a hash over meaning, so two inputs that mean the
 * same thing always hash the same (the shape plan-lock fingerprints use).
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(entry => stableStringify(entry)).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).filter(key => record[key] !== undefined).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
  }
  if (value === undefined) return 'null'
  return JSON.stringify(value)
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * The cache key's inputs (#47): the criterion it is filed under, its checks
 * as the plan authored them, both revisions the run resolved to, and the
 * hashes of the plan and the profile. Any part that moves changes the key, so
 * a cached result is only ever served back for the inputs it was produced
 * from, and a changed check or profile can never read its old result.
 */
export interface CacheKeyParts {
  criterionId: string
  checks: JobCheck[]
  baseSha: string
  headSha: string
  planHash: string
  profileHash: string
}

export function criterionCacheKey(parts: CacheKeyParts): string {
  return sha256(
    stableStringify({
      criterionId: parts.criterionId,
      checks: parts.checks,
      baseSha: parts.baseSha,
      headSha: parts.headSha,
      planHash: parts.planHash,
      profileHash: parts.profileHash,
    }),
  )
}

/** The plan hash: a fingerprint over the criteria the run executes. */
export function planFingerprint(criteria: JobCriterion[]): string {
  return sha256(stableStringify(criteria))
}

/** The profile hash: a fingerprint over the profile configuration the run loaded. */
/**
 * What a client profile's results were proven under (#223): a build that ran
 * in a cell, with the gate's record in each flow check's evidence. It is part
 * of the fingerprint, so a result cached before builds were contained, which
 * holds no such record, is never replayed as one that does.
 */
const CLIENT_CONTAINMENT = 'client-egress-cell-v1'

/**
 * What a profile's named commands were proven under (#224): a command runs
 * in a cell by default, with the gate's record in the check's evidence. It
 * is part of the fingerprint, so a result cached before commands were
 * contained, which holds no such record, is never replayed as one that does.
 */
const COMMAND_CONTAINMENT = 'command-egress-cell-v1'

export function profileFingerprint(profile: QaProfile, digest: (text: string) => string = sha256): string {
  const text = stableStringify(profile)
  const marked = [
    ...(profile.client === undefined ? [] : [CLIENT_CONTAINMENT]),
    ...(profile.commands === undefined || Object.keys(profile.commands).length === 0 ? [] : [COMMAND_CONTAINMENT]),
  ]
  return digest(marked.length === 0 ? text : `${marked.join(':')}:${text}`)
}

/**
 * The cached result of one criterion: the criterion result exactly as it was
 * published (outcome, evidence paths, reason, repairs), and every evidence
 * file the criterion wrote, as content, so a replay writes into a fresh
 * evidence directory exactly what the original run wrote.
 */
export interface CachedCriterion {
  version: 1
  criterion: string
  result: Record<string, unknown>
  files: CachedFile[]
  /** The flake bound the result was proven under (#50); absent in entries written before it was recorded. */
  flakeAttempts?: number
}

export interface CachedFile {
  path: string
  encoding: 'utf8' | 'base64'
  content: string
}

export interface CheckCache {
  get(key: string): Promise<CachedCriterion | undefined>
  put(key: string, value: CachedCriterion): Promise<void>
}

const CACHE_FILE_VERSION = 1

export class FileCheckCache implements CheckCache {
  private readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  async get(key: string): Promise<CachedCriterion | undefined> {
    let text: string
    try {
      text = await readFile(this.entry(key), 'utf8')
    } catch {
      // A missing or unreadable entry is a miss: nothing is claimed from
      // what the store does not carry.
      return undefined
    }
    return parseCacheEntry(text)
  }

  async put(key: string, value: CachedCriterion): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.entry(key), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  }

  private entry(key: string): string {
    return join(this.dir, `${key}.json`)
  }
}

/**
 * Fail closed on anything the store did not write: an entry that does not
 * parse, carries another version, names another criterion, or whose result
 * and files are malformed reads as a miss, so a broken cache costs re-runs
 * and never serves a result the original run did not publish. The stored
 * result is validated by the result loader itself, the same loader result.json
 * goes through.
 */
function parseCacheEntry(text: string): CachedCriterion | undefined {
  let input: unknown
  try {
    input = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof input !== 'object' || input === null) return undefined
  const record = input as Record<string, unknown>
  if (record.version !== CACHE_FILE_VERSION) return undefined
  if (record.criterion === undefined || typeof record.criterion !== 'string') return undefined
  if (!Array.isArray(record.files)) return undefined
  if (record.result === undefined) return undefined
  try {
    parseResult({ schemaVersion: RESULT_SCHEMA_VERSION, verdict: 'passed', criteria: [record.result] })
  } catch {
    return undefined
  }
  const files: CachedFile[] = []
  for (const entry of record.files) {
    const file = parseFile(entry)
    if (file === undefined) return undefined
    files.push(file)
  }
  return {
    version: 1,
    criterion: record.criterion,
    result: record.result as Record<string, unknown>,
    files,
    ...(typeof record.flakeAttempts === 'number' ? { flakeAttempts: record.flakeAttempts } : {}),
  }
}

function parseFile(value: unknown): CachedFile | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.path !== 'string' || record.path === '') return undefined
  if (record.encoding !== 'utf8' && record.encoding !== 'base64') return undefined
  if (typeof record.content !== 'string') return undefined
  return { path: record.path, encoding: record.encoding, content: record.content }
}

/**
 * The refs a job names are resolved to the revisions they name now, so the
 * key speaks in revisions and not in names a later run could reuse for
 * different content. An unresolvable ref means no cache: a run that cannot
 * name what it checked out executes uncached rather than risking a false hit.
 */
export function resolveRefSha(repoPath: string, ref: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: repoPath }, (error, stdout) => {
      if (error) {
        resolve(undefined)
        return
      }
      resolve(stdout.trim())
    })
  })
}

/**
 * Every evidence file one criterion wrote, read back from the evidence
 * directory with paths kept relative to it, so a replay writes the same files
 * under the same names. Binary evidence (a masked screenshot) rides as base64
 * and is copied back byte for byte; everything else as utf8.
 */
export async function collectCriterionFiles(evidenceDir: string, criterionId: string): Promise<CachedFile[]> {
  const root = join(evidenceDir, 'checks', criterionId)
  const names: string[] = []
  try {
    await walkFiles(root, '', names)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  names.sort()
  const files: CachedFile[] = []
  for (const name of names) {
    const buffer = await readFile(join(root, name))
    // A text file never carries a NUL byte in its first bytes; a screenshot
    // and the other binaries do.
    const isText = !buffer.subarray(0, 2048).includes(0)
    files.push({
      path: join('checks', criterionId, name),
      encoding: isText ? 'utf8' : 'base64',
      content: isText ? buffer.toString('utf8') : buffer.toString('base64'),
    })
  }
  return files
}

/** The files under dir, as paths relative to it, directories walked into. */
async function walkFiles(dir: string, prefix: string, out: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await walkFiles(join(dir, entry.name), `${prefix}${entry.name}/`, out)
    else out.push(`${prefix}${entry.name}`)
  }
}
