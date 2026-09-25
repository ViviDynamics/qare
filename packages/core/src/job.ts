import { readFile } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'
import type { QaProfile } from './profile.js'
import { PlanValidationError, parseFlowActions, type FlowActionStep } from './plan.js'

export type JobProfileRef = { path: string } | { inline: QaProfile }

export interface JobCommandCheck {
  kind: 'command'
  run: string
  cwd?: string
  timeoutMs?: number
  env?: Record<string, string>
}

export interface JobMailCheck {
  kind: 'mail'
  /** The plan-level check name, so later checks can reference its artefacts as `{{mail.<name>.link}}`. */
  name?: string
  address: string
  from?: string
  subject?: string
  body?: string
  timeoutMs?: number
  singleUse?: boolean
}

export interface JobFlowCheck {
  kind: 'flow'
  name?: string
  suite?: string
  actions?: FlowActionStep[]
  timeoutMs?: number
}

export type JobCheck = JobCommandCheck | JobMailCheck | JobFlowCheck

export interface JobCriterion {
  id: string
  text: string
  checks?: JobCheck[]
  /**
   * Why nothing runs for it, when a plan says: the planner could not plan it,
   * or its checks are kinds the runner does not execute. Reported as its
   * unverified reason (#123), and never alongside checks.
   */
  unrunnable?: string
  /**
   * Checks the plan gave it that the runner does not execute, when it runs
   * others. Half a proof is not a proof: a criterion whose run checks pass is
   * still unverified, with this as the reason.
   */
  skipped?: string
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
  const unrunnable = value.unrunnable === undefined ? undefined : nonEmptyString(value.unrunnable, `${base}.unrunnable`, 'unrunnable reason')
  const skipped = value.skipped === undefined ? undefined : nonEmptyString(value.skipped, `${base}.skipped`, 'skipped reason')
  if (unrunnable !== undefined && checks !== undefined && checks.length > 0)
    fail(`${base}.unrunnable`, 'a criterion with checks has something to run; unrunnable says why one has nothing, so it carries one or the other')
  return {
    id,
    text,
    ...(checks === undefined ? {} : { checks }),
    ...(unrunnable === undefined ? {} : { unrunnable }),
    ...(skipped === undefined ? {} : { skipped }),
  }
}

function parseChecks(value: unknown, base: string): JobCheck[] {
  if (!Array.isArray(value)) fail(`${base}.checks`, 'checks must be an array of check entries')
  return value.map((check, checkIndex) => parseCheck(check, `${base}.checks[${checkIndex}]`))
}

function parseFlowCheck(value: Record<string, unknown>, base: string): JobFlowCheck {
  const name = value.name === undefined ? undefined : nonEmptyString(value.name, `${base}.name`, 'name')
  const timeoutMs = parseTimeoutMs(value.timeoutMs, `${base}.timeoutMs`)
  const hasSuite = value.suite !== undefined
  const hasActions = value.actions !== undefined
  if (!hasSuite && !hasActions)
    fail(`${base}.suite`, 'flow check needs a suite (an existing suite name) or actions (a fixed action set)')
  if (hasSuite && hasActions)
    fail(`${base}.suite`, 'flow check carries both suite and actions; a flow check is one or the other')
  if (hasSuite) {
    const suite = nonEmptyString(value.suite, `${base}.suite`, 'suite')
    return { kind: 'flow', ...(name !== undefined ? { name } : {}), suite, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }
  }
  let actions
  try {
    actions = parseFlowActions(value.actions, `${base}.actions`)
  } catch (error) {
    // The shared flow parser names its errors with the plan loader's type; a
    // job load throws the job loader's type, carrying the same field and text.
    if (error instanceof PlanValidationError) throw new JobValidationError(error.field, error.message)
    throw error
  }
  return {
    kind: 'flow',
    ...(name !== undefined ? { name } : {}),
    actions,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  }
}

function parseCheck(value: unknown, base: string): JobCheck {
  if (!isRecord(value)) fail(base, 'check must be a YAML object with kind and run')
  if (value.kind === 'mail') return parseMailCheck(value, base)
  if (value.kind === 'flow') return parseFlowCheck(value, base)
  if (value.kind !== 'command')
    fail(`${base}.kind`, `unknown check kind ${JSON.stringify(value.kind)} (job checks are command, mail or flow checks, expected "command", "mail" or "flow")`)
  const run = nonEmptyString(value.run, `${base}.run`, 'run command')
  const cwd = value.cwd === undefined ? undefined : nonEmptyString(value.cwd, `${base}.cwd`, 'working directory')
  const timeoutMs = parseTimeoutMs(value.timeoutMs, `${base}.timeoutMs`)
  const env = value.env === undefined ? undefined : parseCheckEnv(value.env, `${base}.env`)
  return {
    kind: 'command',
    run,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(env !== undefined ? { env } : {}),
  }
}

function parseMailCheck(value: Record<string, unknown>, base: string): JobMailCheck {
  const name = value.name === undefined ? undefined : nonEmptyString(value.name, `${base}.name`, 'name')
  const address = nonEmptyString(value.address, `${base}.address`, 'address')
  const from = value.from === undefined ? undefined : nonEmptyString(value.from, `${base}.from`, 'from')
  const subject = value.subject === undefined ? undefined : nonEmptyString(value.subject, `${base}.subject`, 'subject')
  const body = value.body === undefined ? undefined : nonEmptyString(value.body, `${base}.body`, 'body')
  const timeoutMs = parseTimeoutMs(value.timeoutMs, `${base}.timeoutMs`)
  if (value.singleUse !== undefined && typeof value.singleUse !== 'boolean')
    fail(`${base}.singleUse`, 'singleUse must be a boolean')
  const singleUse = value.singleUse as boolean | undefined
  return {
    kind: 'mail',
    ...(name !== undefined ? { name } : {}),
    address,
    ...(from !== undefined ? { from } : {}),
    ...(subject !== undefined ? { subject } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(singleUse !== undefined ? { singleUse } : {}),
  }
}

function parseCheckEnv(value: unknown, field: string): Record<string, string> {
  if (!isRecord(value)) fail(field, 'env must be a YAML map of string to string')
  const env: Record<string, string> = {}
  for (const [key, val] of Object.entries(value)) {
    if (typeof key !== 'string')
      fail(field, `env keys must be strings (got ${JSON.stringify(key)})`)
    if (typeof val !== 'string')
      fail(field, `env value for ${JSON.stringify(key)} must be a string (got ${typeof val})`)
    env[key] = val
  }
  return env
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
