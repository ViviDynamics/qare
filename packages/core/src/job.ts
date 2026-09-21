import { readFile } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'
import type { QaProfile } from './profile.js'

export type JobProfileRef = { path: string } | { inline: QaProfile }

export interface JobCommandCheck {
  kind: 'command'
  run: string
  cwd?: string
  timeoutMs?: number
}

export interface JobCriterion {
  id: string
  text: string
  checks?: JobCommandCheck[]
}

export type JobPostTarget = 'none' | string

export interface Job {
  id: string
  repoPath: string
  baseRef: string
  headRef: string
  profile: JobProfileRef
  criteria: JobCriterion[]
  evidenceDir: string
  post: JobPostTarget
}

export class JobValidationError extends Error {
  readonly field: string

  constructor(field: string, message: string) {
    super(`${field}: ${message}`)
    this.name = 'JobValidationError'
    this.field = field
  }
}

function fail(field: string, message: string): never {
  throw new JobValidationError(field, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown, field: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    fail(field, `${label} must be a non-empty string`)
  return value
}

export async function loadJobFromFile(path: string): Promise<Job> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw new JobValidationError(
      'file',
      `job file is required but unreadable at ${path} (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  return loadJobFromText(text)
}

export function loadJobFromText(text: string): Job {
  let input: unknown
  try {
    input = parseYaml(text)
  } catch (error) {
    throw new JobValidationError(
      'yaml',
      `job file is not valid YAML (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  return parseJob(input)
}

export function parseJob(input: unknown): Job {
  if (!isRecord(input))
    fail('job', 'job must be a YAML object with id, repoPath, baseRef, headRef, profile, criteria, evidenceDir and post')
  return {
    id: nonEmptyString(input.id, 'id', 'id'),
    repoPath: nonEmptyString(input.repoPath, 'repoPath', 'repo path'),
    baseRef: nonEmptyString(input.baseRef, 'baseRef', 'base ref'),
    headRef: nonEmptyString(input.headRef, 'headRef', 'head ref'),
    profile: parseProfileRef(input.profile),
    criteria: parseCriteria(input.criteria),
    evidenceDir: nonEmptyString(input.evidenceDir, 'evidenceDir', 'evidence output directory'),
    post: parsePost(input.post),
  }
}

function parseProfileRef(value: unknown): JobProfileRef {
  if (!isRecord(value)) fail('profile', 'profile must be a YAML object carrying either a path or an inline profile')
  const hasPath = value.path !== undefined
  const hasInline = value.inline !== undefined
  if (hasPath && hasInline)
    fail('profile', 'profile carries both path and inline; a job profile is one or the other')
  if (hasPath) return { path: nonEmptyString(value.path, 'profile.path', 'profile path') }
  if (hasInline) {
    if (!isRecord(value.inline))
      fail('profile.inline', 'inline profile must be a YAML object shaped like a .qa/ profile')
    return { inline: value.inline as unknown as QaProfile }
  }
  fail('profile', 'profile must carry either a path (a .qa/ profile directory) or an inline profile object')
}

function parseCriteria(value: unknown): JobCriterion[] {
  if (!Array.isArray(value)) fail('criteria', 'criteria must be an array of criterion entries')
  if (value.length === 0)
    fail('criteria', 'criteria is empty: a job with no criteria verifies nothing, so it fails closed')
  const criteria = value.map((entry, index) => parseCriterion(entry, index))
  const seen = new Set<string>()
  for (const criterion of criteria) {
    if (seen.has(criterion.id))
      fail('criteria', `duplicate criterion id "${criterion.id}"; criterion ids must be unique within a job`)
    seen.add(criterion.id)
  }
  return criteria
}

function parseCriterion(value: unknown, index: number): JobCriterion {
  const base = `criteria[${index}]`
  if (!isRecord(value)) fail(base, 'criterion must be a YAML object with id and text')
  const id = nonEmptyString(value.id, `${base}.id`, 'id')
  if (id.includes(':'))
    fail(`${base}.id`, `criterion id "${id}" contains ":"; ":" is reserved for namespace prefixes, so it cannot appear in a criterion id`)
  if (/[/\\]|\.\./.test(id) || /[\x00-\x1f\x7f]/.test(id))
    fail(
      `${base}.id`,
      `criterion id ${JSON.stringify(id)} must not contain path separators, ".." or control characters; criterion ids become evidence directory names`,
    )
  const text = nonEmptyString(value.text, `${base}.text`, 'text')
  const checks = value.checks === undefined ? undefined : parseChecks(value.checks, base)
  return checks === undefined ? { id, text } : { id, text, checks }
}

function parseChecks(value: unknown, base: string): JobCommandCheck[] {
  if (!Array.isArray(value)) fail(`${base}.checks`, 'checks must be an array of command checks')
  return value.map((check, checkIndex) => parseCheck(check, `${base}.checks[${checkIndex}]`))
}

function parseCheck(value: unknown, base: string): JobCommandCheck {
  if (!isRecord(value)) fail(base, 'check must be a YAML object with kind and run')
  if (value.kind !== 'command')
    fail(`${base}.kind`, `unknown check kind ${JSON.stringify(value.kind)} (job checks are command checks, expected "command")`)
  const run = nonEmptyString(value.run, `${base}.run`, 'run command')
  const cwd = value.cwd === undefined ? undefined : nonEmptyString(value.cwd, `${base}.cwd`, 'working directory')
  const timeoutMs = parseTimeoutMs(value.timeoutMs, `${base}.timeoutMs`)
  return {
    kind: 'command',
    run,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  }
}

function parseTimeoutMs(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value))
    fail(field, 'timeoutMs must be a number of milliseconds')
  if (value <= 0) fail(field, 'timeoutMs must be a positive number of milliseconds')
  return value
}

function parsePost(value: unknown): JobPostTarget {
  const target = nonEmptyString(value, 'post', 'post target')
  if (target !== 'none')
    fail('post', `unknown post target ${JSON.stringify(target)} (only "none" is understood for now)`)
  return target
}
