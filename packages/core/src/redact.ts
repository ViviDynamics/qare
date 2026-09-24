import { lstat, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { loadResult, type RunResult } from './result.js'

/**
 * Evidence is published on pull requests, so qare redacts it before it leaves
 * the machine that produced it (#52).
 *
 * The first four built-in rules are nare's event redaction (nare/events.py at
 * the pinned 2026.9.10), so what nare keeps out of its own events stays out of
 * qare's evidence too. nare applies them in-process to its events and offers
 * callers no way to run them over their own text, so qare applies the same
 * rules here rather than a second, different set. The rest cover token shapes
 * nare's list does not.
 */
export const REDACTED = '[redacted]'

export interface RedactionRule {
  name: string
  /** Global; a rule that keeps part of its match does so through `replacement`. */
  pattern: RegExp
  replacement: string
}

// Bounded repeats where nare's are open: evidence is up to a megabyte of
// output from pull request code, and an open `[\w.\-]*` before a fixed word
// backtracks quadratically over a long run of word characters. The key's
// leading affix (AUTH_ in AUTH_TOKEN) stays outside the match, because the
// key is kept and only its value replaced.
const KEY_VALUE = new RegExp(
  '((?:api[_-]?key|auth|token|secret|password|passwd|credential)[\\w.\\-]{0,64}["\']?\\s{0,16}[=:]\\s{0,16}["\']?)' +
    '(?:(?:bearer|basic|token)\\s{1,16})?\\S+',
  'gi',
)

export const BUILTIN_REDACTION_RULES: readonly RedactionRule[] = [
  { name: 'anthropic key', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g, replacement: REDACTED },
  { name: 'sk- key', pattern: /sk-[A-Za-z0-9_-]{20,}/g, replacement: REDACTED },
  { name: 'github token', pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g, replacement: REDACTED },
  { name: 'key or password assignment', pattern: KEY_VALUE, replacement: `$1${REDACTED}` },
  { name: 'github fine-grained token', pattern: /github_pat_[A-Za-z0-9_]{20,}/g, replacement: REDACTED },
  { name: 'aws access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: REDACTED },
  { name: 'slack token', pattern: /xox[abposr]-[A-Za-z0-9-]{10,}/g, replacement: REDACTED },
  {
    name: 'json web token',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
    replacement: REDACTED,
  },
  // An unterminated block (output cut at the capture limit) is redacted to the
  // end rather than left half-published.
  {
    name: 'private key',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    replacement: REDACTED,
  },
  {
    name: 'password in a url',
    pattern: /(\b[a-z][a-z0-9+.-]{0,32}:\/\/[^\s:@/]{1,256}:)[^\s@/]{1,256}@/gi,
    replacement: `$1${REDACTED}@`,
  },
]

/** A `.qa/` profile's `redact` section: fixture data that must not be published. */
export interface ProfileRedaction {
  /** Literal strings, redacted wherever they appear. */
  values?: string[]
  /** Regular expressions (JavaScript syntax, no flags), redacted wherever they match. */
  patterns?: string[]
}

export class RedactionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RedactionError'
  }
}

/**
 * The rules for a run: the profile's own first, then the built-in ones.
 *
 * Throws RedactionError for a pattern that does not compile or that matches
 * the empty string, which would redact between every character.
 */
export function redactionRules(profile?: ProfileRedaction): RedactionRule[] {
  const own: RedactionRule[] = []
  for (const value of profile?.values ?? []) {
    if (value === '') throw new RedactionError('a redact value must not be empty')
    own.push({ name: 'profile value', pattern: new RegExp(escapeRegExp(value), 'g'), replacement: REDACTED })
  }
  for (const source of profile?.patterns ?? []) own.push(profilePattern(source))
  return [...own, ...BUILTIN_REDACTION_RULES]
}

function profilePattern(source: string): RedactionRule {
  let pattern: RegExp
  try {
    pattern = new RegExp(source, 'g')
  } catch (error) {
    throw new RedactionError(
      `redact pattern ${JSON.stringify(source)} is not a valid regular expression (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  if (new RegExp(source).test(''))
    throw new RedactionError(`redact pattern ${JSON.stringify(source)} matches the empty string`)
  return { name: 'profile pattern', pattern, replacement: REDACTED }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function redactText(text: string, rules: readonly RedactionRule[] = BUILTIN_REDACTION_RULES): string {
  let redacted = text
  for (const rule of rules) redacted = redacted.replace(rule.pattern, rule.replacement)
  return redacted
}

const SECRET_KEY = /api[_-]?key|auth|token|secret|password|passwd|credential/i

/**
 * Every string in a JSON value, redacted, and the whole value of any key that
 * names a secret: `{"password": "hunter2"}` has nothing for a text rule to
 * match, since the value alone does not look like one.
 */
export function redactValue<T>(value: T, rules: readonly RedactionRule[] = BUILTIN_REDACTION_RULES): T {
  return redactNode(value, rules) as T
}

function redactNode(value: unknown, rules: readonly RedactionRule[]): unknown {
  if (typeof value === 'string') return redactText(value, rules)
  if (Array.isArray(value)) return value.map((entry) => redactNode(entry, rules))
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        typeof entry === 'string' && SECRET_KEY.test(key) ? REDACTED : redactNode(entry, rules),
      ]),
    )
  return value
}

/**
 * A result with its reasons redacted, the only free text in it. Ids and
 * evidence paths are identities: a criterion id may legally read `token:1`,
 * and redacting it would detach the result from its plan and its files.
 */
export function redactResult(result: RunResult, rules: readonly RedactionRule[] = BUILTIN_REDACTION_RULES): RunResult {
  return {
    ...result,
    criteria: result.criteria.map((criterion) =>
      'reason' in criterion && typeof criterion.reason === 'string'
        ? { ...criterion, reason: redactText(criterion.reason, rules) }
        : criterion,
    ),
  }
}

export interface EvidenceRedaction {
  /** Files looked at, relative to the evidence directory. */
  files: string[]
  /** Files that had something redacted. */
  changed: string[]
  /** Images, published as captured: text rules cannot read pixels. */
  images: string[]
}

/**
 * Redact every file under an evidence directory in place, before it is
 * uploaded.
 *
 * Fails closed: a file it cannot vouch for (a binary that is not an image, a
 * symlink, anything not a regular file) throws RedactionError naming it, and
 * the caller must not upload the directory.
 */
export async function redactEvidenceDir(
  dir: string,
  rules: readonly RedactionRule[] = BUILTIN_REDACTION_RULES,
): Promise<EvidenceRedaction> {
  const info = await lstat(dir).catch(() => undefined)
  if (info === undefined || !info.isDirectory())
    throw new RedactionError(`evidence directory ${dir} does not exist or is not a directory`)
  const report: EvidenceRedaction = { files: [], changed: [], images: [] }
  await walk(dir, dir, rules, report)
  return report
}

async function walk(
  root: string,
  dir: string,
  rules: readonly RedactionRule[],
  report: EvidenceRedaction,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const path = join(dir, entry.name)
    const name = relative(root, path)
    if (entry.isDirectory()) await walk(root, path, rules, report)
    else if (entry.isFile()) await redactFile(path, name, rules, report)
    else throw new RedactionError(`${name} is not a regular file, so redaction cannot vouch for it`)
  }
}

async function redactFile(
  path: string,
  name: string,
  rules: readonly RedactionRule[],
  report: EvidenceRedaction,
): Promise<void> {
  report.files.push(name)
  const bytes = await readFile(path)
  if (isImage(bytes)) {
    report.images.push(name)
    return
  }
  const text = decodeText(bytes)
  if (text === undefined)
    throw new RedactionError(`${name} is neither text nor an image, so redaction cannot read it`)
  const redacted =
    name === 'result.json'
      ? redactResultText(text, name, rules)
      : name.endsWith('.json')
        ? redactJsonText(text, rules)
        : redactText(text, rules)
  if (redacted === text) return
  await writeFile(path, redacted)
  report.changed.push(name)
}

function redactResultText(text: string, name: string, rules: readonly RedactionRule[]): string {
  let result: RunResult
  try {
    result = loadResult(text)
  } catch (error) {
    throw new RedactionError(
      `${name} is not a valid result, so its reasons cannot be told from its ids (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  const redacted = redactResult(result, rules)
  return JSON.stringify(redacted) === JSON.stringify(result) ? text : `${JSON.stringify(redacted, null, 2)}\n`
}

function redactJsonText(text: string, rules: readonly RedactionRule[]): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return redactText(text, rules)
  }
  const redacted = redactValue(parsed, rules)
  // Rewritten only when something changed, so an untouched file keeps its bytes.
  return JSON.stringify(redacted) === JSON.stringify(parsed) ? text : `${JSON.stringify(redacted, null, 2)}\n`
}

const IMAGE_SIGNATURES: Array<{ at: number; bytes: number[] }> = [
  { at: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }, // PNG
  { at: 0, bytes: [0xff, 0xd8, 0xff] }, // JPEG
  { at: 0, bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF8
  { at: 8, bytes: [0x57, 0x45, 0x42, 0x50] }, // WEBP (after RIFF....)
]

function isImage(bytes: Buffer): boolean {
  return IMAGE_SIGNATURES.some(
    ({ at, bytes: signature }) =>
      bytes.length >= at + signature.length && signature.every((byte, index) => bytes[at + index] === byte),
  )
}

function decodeText(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}
