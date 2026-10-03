import { readFile } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'
import { isUnsafeProfileName, type QaProfile } from './profile.js'
import { MAX_VISUAL_WIDTH, PlanValidationError, parseFlowActions, parseToolAssertions, parseToolArgs, type FlowActionStep, type ToolAssertion } from './plan.js'
import { DEFAULT_PROFILE_NAME } from './monorepo.js'

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
  /** One-time code extraction from the message body (#64). */
  code?: { pattern?: string }
}

export interface JobFlowCheck {
  kind: 'flow'
  name?: string
  suite?: string
  actions?: FlowActionStep[]
  timeoutMs?: number
}

/** Calls a host tool directly and asserts on its result with explicit matchers (#94). */
export interface JobToolCheck {
  kind: 'tool'
  name?: string
  tool: string
  args?: Record<string, string>
  assert: ToolAssertion[]
  timeoutMs?: number
}

/**
 * Captures a page at each width and theme (#143). On a run with two sides the
 * captures of the head are compared with the captures the base side took of
 * the same page; on a run with one side they are evidence by themselves.
 */
export interface JobVisualCheck {
  kind: 'visual'
  name?: string
  /** What the screenshot is called in the evidence record. */
  screenshot: string
  /** The page: a path on the app, or a URL. The app's root when absent. */
  url?: string
  /** The viewport widths to capture at; the profile's `visual.widths` when absent. */
  widths?: number[]
  /** The colour schemes to capture in; the profile's `visual.themes` when absent. */
  themes?: string[]
  /** How long one capture may take. */
  timeoutMs?: number
}

export type JobCheck = JobCommandCheck | JobMailCheck | JobFlowCheck | JobToolCheck | JobVisualCheck

export interface JobCriterion {
  id: string
  text: string
  checks?: JobCheck[]
  /**
   * True when the checks mutate shared state of the app, so the criterion
   * runs against an app instance of its own instead of the run's shared one
   * (#48). A criterion that mutates what its neighbours read must not run
   * beside them, whatever a parallel worker schedule would otherwise allow.
   */
  isolated?: boolean
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

/**
 * One named profile of a several-profile job (#55). The job carries a group
 * per app it checks, each with its own profile and its own criteria, so one
 * run boots every selected app and reports them in one comment.
 */
export interface JobProfileGroup {
  /** The profile's name in the report; unique across the job. */
  name: string
  profile: JobProfileRef
  criteria: JobCriterion[]
}

interface JobBase {
  id: string
  repoPath: string
  baseRef: string
  headRef: string
  evidenceDir: string
  post: JobPostTarget
}

/**
 * The job of one profile: one app, one criteria list. This is the only form
 * `qare plan` and the single-run path know.
 */
export interface SingleProfileJob extends JobBase {
  profile: JobProfileRef
  criteria: JobCriterion[]
}

/**
 * The job of several profiles (#55): one group per app it checks. Criterion
 * ids must be unique across every group, so evidence directories never
 * collide between apps.
 */
export interface SeveralProfilesJob extends JobBase {
  profiles: JobProfileGroup[]
}

/**
 * Exactly one of the two forms: a job carries either one profile with its
 * criteria, or named profiles each with their own criteria — never both.
 */
export type Job = SingleProfileJob | SeveralProfilesJob

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
  const base = {
    id: nonEmptyString(input.id, 'id', 'id'),
    repoPath: nonEmptyString(input.repoPath, 'repoPath', 'repo path'),
    baseRef: nonEmptyString(input.baseRef, 'baseRef', 'base ref'),
    headRef: nonEmptyString(input.headRef, 'headRef', 'head ref'),
  }
  // The fields are validated in the order a job file names them, so the first
  // mistake a plan made is the first one reported.
  if (input.profiles !== undefined) {
    if (input.profile !== undefined)
      fail('profile', 'a job carries either one profile, or named profiles for several apps, not both')
    if (input.criteria !== undefined)
      fail('criteria', "a job with named profiles carries each group's criteria inside it, so a top-level criteria list has nothing to attach to")
    const profiles = parseProfileGroups(input.profiles)
    const evidenceDir = nonEmptyString(input.evidenceDir, 'evidenceDir', 'evidence output directory')
    return { ...base, evidenceDir, post: parsePost(input.post), profiles }
  }
  const profile = parseProfileRef(input.profile)
  const criteria = parseCriteria(input.criteria)
  const evidenceDir = nonEmptyString(input.evidenceDir, 'evidenceDir', 'evidence output directory')
  return { ...base, profile, criteria, evidenceDir, post: parsePost(input.post) }
}

/**
 * The groups of a several-profile job (#55). Names and criterion ids are
 * unique across the whole job: a group's criteria become evidence directories,
 * and two apps writing the same directory would overwrite each other.
 */
function parseProfileGroups(value: unknown): JobProfileGroup[] {
  if (!Array.isArray(value)) fail('profiles', 'profiles must be an array of { name, profile, criteria } groups')
  if (value.length === 0)
    fail('profiles', 'profiles is empty: a job that names no profile checks nothing, so it fails closed')
  const groups = value.map((entry, index) => {
    const base = `profiles[${index}]`
    if (!isRecord(entry)) fail(base, 'profile group must be a YAML object with name, profile and criteria')
    const name = nonEmptyString(entry.name, `${base}.name`, 'profile name')
    if (name.includes(':'))
      fail(`${base}.name`, `profile name "${name}" contains ":"; ":" is reserved for namespace prefixes, so it cannot appear in a profile name`)
    if (isUnsafeProfileName(name))
      fail(`${base}.name`, `profile name ${JSON.stringify(name)} must not contain path separators, ".." or control characters`)
    if (name === DEFAULT_PROFILE_NAME)
      fail(
        `${base}.name`,
        `a named profile cannot be called ${DEFAULT_PROFILE_NAME}: the name is reserved for the single root profile, so a job group named default is a layout nobody can select from`,
      )
    const profile = parseProfileRef(entry.profile)
    // A several-app run publishes where each app's profile lives, and judge
    // and redact re-read every named profile from the .qa root the run
    // publishes (#55). An inline profile travels in the result itself; a path
    // must be one the artifact carries, so anything else is refused before a
    // result is written that judge could not follow.
    if ('path' in profile && profile.path !== `.qa/${name}`)
      fail(
        `${base}.profile.path`,
        `profile path ${JSON.stringify(profile.path)} must be ${JSON.stringify(`.qa/${name}`)}: a several-app job names its apps by the directories of the .qa root, because judge and redact re-read them from the artifact the run publishes`,
      )
    return {
      name,
      profile,
      criteria: parseCriteria(entry.criteria),
    }
  })
  const seenNames = new Set<string>()
  for (const group of groups) {
    if (seenNames.has(group.name))
      fail('profiles', `duplicate profile name "${group.name}"; profile names must be unique within a job`)
    seenNames.add(group.name)
  }
  const owners = new Map<string, string>()
  for (const group of groups) {
    for (const criterion of group.criteria) {
      const owner = owners.get(criterion.id)
      if (owner !== undefined)
        fail('profiles', `duplicate criterion id "${criterion.id}" in profiles ${owner} and ${group.name}; criterion ids must be unique across every profile of a job, so evidence directories never collide`)
      owners.set(criterion.id, group.name)
    }
  }
  return groups
}

export function parseProfileRef(value: unknown): JobProfileRef {
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
  if (value.isolated !== undefined && typeof value.isolated !== 'boolean')
    fail(`${base}.isolated`, 'isolated must be a boolean')
  const isolated = value.isolated as boolean | undefined
  const checks = value.checks === undefined ? undefined : parseChecks(value.checks, base)
  const unrunnable = value.unrunnable === undefined ? undefined : nonEmptyString(value.unrunnable, `${base}.unrunnable`, 'unrunnable reason')
  const skipped = value.skipped === undefined ? undefined : nonEmptyString(value.skipped, `${base}.skipped`, 'skipped reason')
  if (unrunnable !== undefined && checks !== undefined && checks.length > 0)
    fail(`${base}.unrunnable`, 'a criterion with checks has something to run; unrunnable says why one has nothing, so it carries one or the other')
  return {
    id,
    text,
    ...(checks === undefined ? {} : { checks }),
    ...(isolated === undefined ? {} : { isolated }),
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
  if (!isRecord(value)) fail(base, 'check must be a YAML object with a kind and the fields of that kind')
  if (value.kind === 'mail') return parseMailCheck(value, base)
  if (value.kind === 'flow') return parseFlowCheck(value, base)
  if (value.kind === 'tool') return parseToolCheck(value, base)
  if (value.kind === 'visual') return parseVisualCheck(value, base)
  if (value.kind !== 'command')
    fail(`${base}.kind`, `unknown check kind ${JSON.stringify(value.kind)} (job checks are command, mail, flow, tool or visual checks, expected "command", "mail", "flow", "tool" or "visual")`)
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

/**
 * A visual check (#143). Widths and themes become evidence file names
 * (`<width>x<theme>.png`), so both are held to what a file name may carry,
 * and an empty list is refused: a check that names no width says nothing a
 * check that leaves the field out does not.
 */
function parseVisualCheck(value: Record<string, unknown>, base: string): JobVisualCheck {
  const name = value.name === undefined ? undefined : nonEmptyString(value.name, `${base}.name`, 'name')
  const screenshot = nonEmptyString(value.screenshot, `${base}.screenshot`, 'screenshot name')
  const url = value.url === undefined ? undefined : nonEmptyString(value.url, `${base}.url`, 'url')
  let widths: number[] | undefined
  if (value.widths !== undefined) {
    if (!Array.isArray(value.widths) || value.widths.length === 0)
      fail(`${base}.widths`, 'widths must be a non-empty array of viewport widths; leave it out to take the profile\'s visual.widths')
    widths = value.widths.map((width: unknown, index) => {
      if (typeof width !== 'number' || !Number.isInteger(width) || width < 1 || width > MAX_VISUAL_WIDTH)
        fail(`${base}.widths[${index}]`, `width ${JSON.stringify(width)} must be a whole number of pixels between 1 and ${MAX_VISUAL_WIDTH}`)
      return width
    })
  }
  let themes: string[] | undefined
  if (value.themes !== undefined) {
    if (!Array.isArray(value.themes) || value.themes.length === 0)
      fail(`${base}.themes`, 'themes must be a non-empty array of theme names; leave it out to take the profile\'s visual.themes')
    themes = value.themes.map((theme: unknown, index) => {
      const text = nonEmptyString(theme, `${base}.themes[${index}]`, 'theme')
      if (/[/\\]|\.\.|[\x00-\x1f\x7f]/.test(text))
        fail(`${base}.themes[${index}]`, `theme ${JSON.stringify(text)} must not contain path separators, ".." or control characters; themes become evidence file names`)
      return text
    })
  }
  const timeoutMs = parseTimeoutMs(value.timeoutMs, `${base}.timeoutMs`)
  return {
    kind: 'visual',
    ...(name !== undefined ? { name } : {}),
    screenshot,
    ...(url !== undefined ? { url } : {}),
    ...(widths !== undefined ? { widths } : {}),
    ...(themes !== undefined ? { themes } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  }
}

function parseToolCheck(value: Record<string, unknown>, base: string): JobToolCheck {
  const name = value.name === undefined ? undefined : nonEmptyString(value.name, `${base}.name`, 'name')
  const tool = nonEmptyString(value.tool, `${base}.tool`, 'tool name')
  const timeoutMs = parseTimeoutMs(value.timeoutMs, `${base}.timeoutMs`)
  let args: Record<string, string> | undefined
  try {
    args = parseToolArgs(value.args, `${base}.args`)
  } catch (error) {
    if (error instanceof PlanValidationError) throw new JobValidationError(error.field, error.message)
    throw error
  }
  let assert
  try {
    assert = parseToolAssertions(value.assert, `${base}.assert`)
  } catch (error) {
    // The shared assertion parser names its errors with the plan loader's
    // type; a job load throws the job loader's type, carrying the same text.
    if (error instanceof PlanValidationError) throw new JobValidationError(error.field, error.message)
    throw error
  }
  return {
    kind: 'tool',
    ...(name !== undefined ? { name } : {}),
    tool,
    ...(args === undefined ? {} : { args }),
    assert,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
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
  const code = parseJobCode(value.code, `${base}.code`)
  return {
    kind: 'mail',
    ...(name !== undefined ? { name } : {}),
    address,
    ...(from !== undefined ? { from } : {}),
    ...(subject !== undefined ? { subject } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(singleUse !== undefined ? { singleUse } : {}),
    ...(code !== undefined ? { code } : {}),
  }
}

/** Mirrors plan.ts's parseCode: the pattern must compile before the run needs it (#64). */
function parseJobCode(value: unknown, field: string): { pattern?: string } | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(field, 'code must be an object with an optional pattern')
  const record = value as Record<string, unknown>
  const pattern = record.pattern === undefined ? undefined : nonEmptyString(record.pattern, `${field}.pattern`, 'code pattern')
  if (pattern !== undefined) {
    try {
      new RegExp(pattern)
    } catch {
      fail(`${field}.pattern`, `code pattern ${JSON.stringify(pattern)} is not a valid regular expression`)
    }
  }
  return pattern === undefined ? {} : { pattern }
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
