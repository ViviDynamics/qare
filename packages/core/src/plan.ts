// The flow vocabulary is the runner's (flow.ts); the plan loader accepts it
// verbatim and rejects anything else. Type-only import: the loader adds no
// runtime dependency on the runner.
import type { FlowAction, FlowDriverCapabilities, FlowElement } from './flow.js'
import { isUnsafeProfileName } from './profile.js'
import { DEFAULT_PROFILE_NAME } from './monorepo.js'

export const PLAN_SCHEMA_VERSION = '1'

export type CheckKind = 'command' | 'flow' | 'visual' | 'mail'

export type FlowActionStep = FlowAction

export interface CommandCheck {
  kind: 'command'
  name: string
  command: string
  inferred?: boolean
}

export interface FlowCheck {
  kind: 'flow'
  name: string
  suite?: string
  actions?: FlowActionStep[]
  inferred?: boolean
}

export interface VisualCheck {
  kind: 'visual'
  name: string
  screenshot: string
  widths?: number[]
  themes?: string[]
  inferred?: boolean
}

export interface MailCheck {
  kind: 'mail'
  name: string
  address: string
  from?: string
  subject?: string
  body?: string
  timeoutMs?: number
  /** The links in this message are spent when followed, so the harness follows each at most once per run. */
  singleUse?: boolean
  /**
   * The message body carries a one-time code the harness extracts at run time
   * (#64): later checks read it as `{{mail.<name>.code}}`, and it is swept
   * from the evidence like any other secret.
   */
  code?: { pattern?: string }
  inferred?: boolean
}

export type PlanCheck = CommandCheck | FlowCheck | VisualCheck | MailCheck

export interface PlannedCriterion {
  id: string
  text: string
  checks: PlanCheck[]
  /**
   * The app this criterion is checked against, named after the plan's
   * `profiles`. A plan that names its profiles must name one on every
   * criterion, or nothing runs (#55); a plan that names no profiles
   * cannot name one on any criterion, because the single-profile run
   * would silently ignore it.
   */
  profile?: string
}

export interface UnplannableCriterion {
  id: string
  text: string
  unplannable: string
  profile?: string
}

export type PlanCriterion = PlannedCriterion | UnplannableCriterion

/**
 * The apps a plan is planned against (#55). The paths are repo-relative
 * directories under `.qa/`, so the same plan runs wherever the repository is.
 */
export interface PlanProfileRef {
  name: string
  path: string
}

export interface Plan {
  schemaVersion: string
  criteria: PlanCriterion[]
  /**
   * The apps the plan is planned against, named and repo-relative (#55). When
   * it is present, every criterion names the app it is checked against, and
   * `qare run --plan` builds one run that checks them all and reports them in
   * one comment.
   */
  profiles?: PlanProfileRef[]
}

const CHECK_KINDS: CheckKind[] = ['command', 'flow', 'visual', 'mail']

export class PlanValidationError extends Error {
  readonly field: string

  constructor(field: string, message: string) {
    super(`${field}: ${message}`)
    this.name = 'PlanValidationError'
    this.field = field
  }
}

function fail(field: string, message: string): never {
  throw new PlanValidationError(field, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown, field: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    fail(field, `${label} must be a non-empty string`)
  return value
}

function stringArray(value: unknown, field: string, label: string): string[] {
  if (!Array.isArray(value)) fail(field, `${label} must be an array of strings`)
  return value.map((entry, index) =>
    nonEmptyString(entry, `${field}[${index}]`, `${label} entry`),
  )
}

function numberArray(value: unknown, field: string, label: string): number[] {
  if (!Array.isArray(value)) fail(field, `${label} must be an array of numbers`)
  return value.map((entry, index) => {
    if (typeof entry !== 'number' || !Number.isFinite(entry))
      fail(`${field}[${index}]`, `${label} entry must be a number`)
    return entry
  })
}

export function loadPlan(text: string, extraFlowActions: readonly string[] = [], driver?: FlowDriverCapabilities): Plan {
  let input: unknown
  try {
    input = JSON.parse(text)
  } catch (error) {
    throw new PlanValidationError(
      'json',
      `plan.json is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  return parsePlan(input, extraFlowActions, driver)
}

export function parsePlan(input: unknown, extraFlowActions: readonly string[] = [], driver?: FlowDriverCapabilities): Plan {
  const plan = parseLoose(input, extraFlowActions)
  if (driver !== undefined) rejectUndeclaredActions(plan, driver)
  return plan
}

function parseLoose(input: unknown, extraFlowActions: readonly string[]): Plan {
  if (!isRecord(input)) fail('plan', 'plan.json must be a JSON object')

  const { schemaVersion } = input
  if (typeof schemaVersion !== 'string')
    fail('schemaVersion', `plan.json must carry a schemaVersion string (this loader understands "${PLAN_SCHEMA_VERSION}")`)
  if (schemaVersion !== PLAN_SCHEMA_VERSION)
    fail('schemaVersion', `unknown schemaVersion "${schemaVersion}" (this loader understands "${PLAN_SCHEMA_VERSION}")`)

  if (!Array.isArray(input.criteria)) fail('criteria', 'plan.json must carry a criteria array')
  if (input.criteria.length === 0)
    fail('criteria', 'plan is empty: no criterion was planned, and an empty plan passes nothing, so it fails closed')

  const profiles = input.profiles === undefined ? undefined : parseProfiles(input.profiles)
  const criteria = input.criteria.map((entry, index) => parseCriterion(entry, index, extraFlowActions, profiles))
  if (profiles !== undefined) {
    for (const [index, criterion] of criteria.entries()) {
      if (criterion.profile === undefined)
        fail(`criteria[${index}]`, `criterion "${criterion.id}" names no profile; a plan that names its profiles checks every criterion against the app it names`)
    }
  }
  return { schemaVersion, criteria, ...(profiles === undefined ? {} : { profiles }) }
}

function parseProfiles(value: unknown): PlanProfileRef[] {
  if (!Array.isArray(value)) fail('profiles', 'profiles must be an array of { name, path }')
  if (value.length === 0) fail('profiles', 'profiles is empty: a plan that names its profiles names at least one app')
  const seen = new Set<string>()
  const profiles = value.map((entry, index) => {
    const base = `profiles[${index}]`
    if (!isRecord(entry)) fail(base, 'a planned profile must be a JSON object with a name and a path')
    const name = nonEmptyString(entry.name, `${base}.name`, 'name')
    if (name.includes(':'))
      fail(`${base}.name`, `profile name "${name}" contains ":"; ":" is reserved for namespace prefixes, so it cannot appear in a profile name`)
    if (isUnsafeProfileName(name))
      fail(`${base}.name`, `profile name ${JSON.stringify(name)} must not contain path separators, ".." or control characters; profile names become evidence file names`)
    if (name === DEFAULT_PROFILE_NAME)
      fail(
        `${base}.name`,
        `a planned profile cannot be called ${DEFAULT_PROFILE_NAME}: the name is reserved for the single root profile, so a plan naming default is a layout nobody can select from`,
      )
    if (seen.has(name)) fail(`${base}.name`, `two planned profiles are named ${JSON.stringify(name)}; a plan names each app once`)
    seen.add(name)
    const path = nonEmptyString(entry.path, `${base}.path`, 'path')
    if (path.includes('\\')) fail(`${base}.path`, `profile path ${JSON.stringify(path)} must use "/" as its separator; a git diff path never carries a backslash`)
    if (path.startsWith('/')) fail(`${base}.path`, `profile path ${JSON.stringify(path)} must be repo-relative, not absolute`)
    if (path.split('/').includes('..'))
      fail(`${base}.path`, `profile path ${JSON.stringify(path)} climbs out of the repository (".." is not allowed)`)
    if (path !== '.' && path.split('/').includes('.'))
      fail(`${base}.path`, `profile path ${JSON.stringify(path)} carries a "." segment, which no git diff path can match (write the path without it)`)
    // The plan's profiles are re-read by judge and redact from the .qa root
    // the run publishes (#55), so a plan selects its apps from the named
    // directories of that root and nothing else.
    if (path !== `.qa/${name}`)
      fail(`${base}.path`, `planned profile path ${JSON.stringify(path)} must be ${JSON.stringify(`.qa/${name}`)}: judge and redact re-read every named profile from the .qa root the run publishes, so a plan selects its apps from the named directories of .qa`)
    return { name, path }
  })
  return profiles
}

function parseCriterion(value: unknown, index: number, extraFlowActions: readonly string[], profiles?: PlanProfileRef[]): PlanCriterion {
  const base = `criteria[${index}]`
  if (!isRecord(value)) fail(base, 'criterion must be a JSON object')

  const id = nonEmptyString(value.id, `${base}.id`, 'id')
  const text = nonEmptyString(value.text, `${base}.text`, 'text')
  let profile: string | undefined
  if (value.profile !== undefined) {
    profile = nonEmptyString(value.profile, `${base}.profile`, 'profile')
    if (profiles === undefined)
      fail(`${base}.profile`, `criterion "${id}" names ${JSON.stringify(profile)}, but the plan names no profiles; a criterion is checked against one of the apps the plan names, so a plan that routes a criterion must name its profiles`)
    else if (!profiles.some((planned) => planned.name === profile))
      fail(`${base}.profile`, `criterion "${id}" names ${JSON.stringify(profile)}, which the plan does not plan; a criterion is checked against one of the apps the plan names`)
  }

  const hasChecks = value.checks !== undefined
  const hasUnplannable = value.unplannable !== undefined
  if (!hasChecks && !hasUnplannable)
    fail(base, `criterion "${id}" maps to no checks; carry a checks array or an unplannable reason`)
  if (hasChecks && hasUnplannable)
    fail(base, `criterion "${id}" carries both checks and unplannable; a criterion is planned or unplannable, not both`)
  if (hasUnplannable)
    return {
      id,
      text,
      unplannable: nonEmptyString(value.unplannable, `${base}.unplannable`, 'unplannable reason'),
      ...(profile === undefined ? {} : { profile }),
    }

  if (!Array.isArray(value.checks)) fail(`${base}.checks`, 'checks must be an array')
  if (value.checks.length === 0)
    fail(`${base}.checks`, `criterion "${id}" maps to zero checks; carry at least one check or mark the criterion unplannable`)

  return {
    id,
    text,
    checks: value.checks.map((check, checkIndex) => parseCheck(check, `${base}.checks[${checkIndex}]`, extraFlowActions)),
    ...(profile === undefined ? {} : { profile }),
  }
}

function parseCheck(value: unknown, base: string, extraFlowActions: readonly string[]): PlanCheck {
  if (!isRecord(value)) fail(base, 'check must be a JSON object')

  const kind = value.kind
  if (typeof kind !== 'string' || !CHECK_KINDS.includes(kind as CheckKind))
    fail(`${base}.kind`, `unknown check kind ${JSON.stringify(kind)} (expected "command", "flow", "visual" or "mail")`)
  const name = nonEmptyString(value.name, `${base}.name`, 'name')
  const inferred = parseInferred(value.inferred, `${base}.inferred`)

  switch (kind as CheckKind) {
    case 'command': {
      const command = nonEmptyString(value.command, `${base}.command`, 'command')
      return finish({ kind: 'command', name, command }, inferred)
    }
    case 'flow': {
      const hasSuite = value.suite !== undefined
      const hasActions = value.actions !== undefined
      if (!hasSuite && !hasActions)
        fail(`${base}.suite`, 'flow check needs a suite (an existing suite name) or actions (a fixed action set)')
      if (hasSuite && hasActions)
        fail(`${base}.suite`, 'flow check carries both suite and actions; a flow check is one or the other')
      if (hasSuite) {
        const suite = nonEmptyString(value.suite, `${base}.suite`, 'suite')
        return finish({ kind: 'flow', name, suite }, inferred)
      }
      const actions = parseFlowActions(value.actions, `${base}.actions`, extraFlowActions)
      return finish({ kind: 'flow', name, actions }, inferred)
    }
    case 'visual': {
      const screenshot = nonEmptyString(value.screenshot, `${base}.screenshot`, 'screenshot')
      const widths = value.widths === undefined ? undefined : numberArray(value.widths, `${base}.widths`, 'widths')
      const themes = value.themes === undefined ? undefined : stringArray(value.themes, `${base}.themes`, 'themes')
      if (themes !== undefined)
        for (const [index, theme] of themes.entries())
          if (/[/\\]|\.\.|[\x00-\x1f\x7f]/.test(theme))
            fail(
              `${base}.themes[${index}]`,
              `theme ${JSON.stringify(theme)} must not contain path separators, ".." or control characters; themes become evidence file names`,
            )
      return finish({ kind: 'visual', name, screenshot, ...(widths !== undefined ? { widths } : {}), ...(themes !== undefined ? { themes } : {}) }, inferred)
    }
    case 'mail': {
      const address = nonEmptyString(value.address, `${base}.address`, 'address')
      const from = value.from === undefined ? undefined : nonEmptyString(value.from, `${base}.from`, 'from')
      const subject = value.subject === undefined ? undefined : nonEmptyString(value.subject, `${base}.subject`, 'subject')
      const body = value.body === undefined ? undefined : nonEmptyString(value.body, `${base}.body`, 'body')
      const timeoutMs = value.timeoutMs === undefined ? undefined : parseTimeoutMs(value.timeoutMs, `${base}.timeoutMs`)
      const singleUse = value.singleUse === undefined ? undefined : parseSingleUse(value.singleUse, `${base}.singleUse`)
      const code = parseCode(value.code, `${base}.code`)
      return finish(
        {
          kind: 'mail',
          name,
          address,
          ...(from !== undefined ? { from } : {}),
          ...(subject !== undefined ? { subject } : {}),
          ...(body !== undefined ? { body } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(singleUse !== undefined ? { singleUse } : {}),
          ...(code !== undefined ? { code } : {}),
        },
        inferred,
      )
    }
  }
}

/**
 * Flow actions are typed, not free-form strings (#121): a plan whose actions
 * are instructions a human improvises is rejected here, where it loads, so
 * nothing downstream is left to interpret them.
 */
export function parseFlowActions(value: unknown, base: string, extraFlowActions: readonly string[] = []): FlowActionStep[] {
  if (!Array.isArray(value)) fail(base, 'actions must be an array of typed actions')
  return value.map((entry, index) => parseFlowAction(entry, `${base}[${index}]`, extraFlowActions))
}

export const FLOW_ACTION_KINDS = [
  'open',
  'type',
  'click',
  'choose',
  'waitFor',
  'assertText',
  'assertElement',
  'capture',
  'totp',
  'backupCode',
] as const

/**
 * A plan naming an action the target driver lacks is rejected here, where it
 * loads, with the action and the driver named (#70): nothing downstream gets
 * to boot and fail halfway through.
 */
function rejectUndeclaredActions(plan: Plan, driver: FlowDriverCapabilities): void {
  for (const [criterionIndex, criterion] of plan.criteria.entries()) {
    if ('unplannable' in criterion) continue
    for (const [checkIndex, check] of criterion.checks.entries()) {
      if (check.kind !== 'flow' || check.actions === undefined) continue
      const base = `criteria[${criterionIndex}].checks[${checkIndex}]`
      for (const [actionIndex, action] of check.actions.entries()) {
        if (!driver.actions.includes(action.action)) {
          fail(
            `${base}.actions[${actionIndex}].action`,
            `flow action ${JSON.stringify(action.action)} is not one of the actions the ${driver.name} driver declares, so the plan cannot run against it (declared: ${driver.actions.map((k) => JSON.stringify(k)).join(', ')})`,
          )
        }
      }
    }
  }
}

function parseFlowAction(value: unknown, base: string, extraFlowActions: readonly string[] = []): FlowActionStep {
  if (!isRecord(value)) fail(base, 'a flow action must be an object, not a free-form string')
  const kind = value.action
  if (typeof kind !== 'string' || (!FLOW_ACTION_KINDS.includes(kind as 'open') && !extraFlowActions.includes(kind))) {
    const expected = [...FLOW_ACTION_KINDS, ...extraFlowActions.filter((extra) => !FLOW_ACTION_KINDS.includes(extra as 'open'))]
      .map((k) => `"${k}"`)
      .join(', ')
    fail(`${base}.action`, `unknown flow action ${JSON.stringify(kind)} (expected ${expected})`)
  }
  if (!FLOW_ACTION_KINDS.includes(kind as 'open') && extraFlowActions.includes(kind)) {
    // A kind the change under review introduces, so this loader — running at
    // the base revision — has no strict shape for it, and the plan it writes
    // is carried to the head revision's run, whose loader knows its own
    // vocabulary and is the authority for the shape. The cast is the seam:
    // every kind this revision knows is validated strictly below.
    return { ...value, action: kind } as unknown as FlowActionStep
  }
  switch (kind) {
    case 'open': {
      const url = nonEmptyString(value.url, `${base}.url`, 'url')
      return { action: 'open', url }
    }
    case 'type': {
      const element = parseFlowElement(value.element, `${base}.element`)
      const actionValue = nonEmptyString(value.value, `${base}.value`, 'typed value')
      return { action: 'type', element, value: actionValue }
    }
    case 'click': {
      const element = parseFlowElement(value.element, `${base}.element`)
      return { action: 'click', element }
    }
    case 'choose': {
      const element = parseFlowElement(value.element, `${base}.element`)
      const actionValue = nonEmptyString(value.value, `${base}.value`, 'chosen option')
      return { action: 'choose', element, value: actionValue }
    }
    case 'waitFor': {
      const element = parseFlowElement(value.element, `${base}.element`)
      return { action: 'waitFor', element }
    }
    case 'assertText': {
      const text = nonEmptyString(value.text, `${base}.text`, 'asserted text')
      return { action: 'assertText', text }
    }
    case 'assertElement': {
      const element = parseFlowElement(value.element, `${base}.element`)
      return { action: 'assertElement', element }
    }
    case 'capture':
      return { action: 'capture' }
    case 'totp': {
      // The element only: the code comes from the profile's seeded secret at
      // run time, so no plan carries a secret or a code (#64).
      const element = parseFlowElement(value.element, `${base}.element`)
      return { action: 'totp', element }
    }
    case 'backupCode': {
      const element = parseFlowElement(value.element, `${base}.element`)
      return { action: 'backupCode', element }
    }
    default:
      throw new Error(`unreachable: ${String(kind)} was validated against the vocabulary above`)
  }
}

function parseFlowElement(value: unknown, base: string): FlowElement {
  if (!isRecord(value)) fail(base, 'an element reference must be an object: {"role":...,"name":...} or {"testId":...}')
  const hasRole = value.role !== undefined
  const hasName = value.name !== undefined
  const hasTestId = value.testId !== undefined
  if (hasTestId) {
    if (hasRole || hasName)
      fail(base, 'an element reference is a test id or a role with its accessible name, not both')
    return { testId: nonEmptyString(value.testId, `${base}.testId`, 'test id') }
  }
  if (!hasRole || !hasName)
    fail(base, 'an element reference names a role with its accessible name, or a test id')
  return {
    role: nonEmptyString(value.role, `${base}.role`, 'role'),
    name: nonEmptyString(value.name, `${base}.name`, 'accessible name'),
  }
}

function parseInferred(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') fail(field, 'inferred must be a boolean')
  return value
}

function parseSingleUse(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') fail(field, 'singleUse must be a boolean')
  return value
}

/**
 * The `code` section of a mail check: a one-time code is extracted from the
 * message body at run time (#64). The pattern is compiled here, so an
 * unusable one is named at load rather than in the middle of a run.
 */
function parseCode(value: unknown, field: string): { pattern?: string } | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) fail(field, 'code must be a YAML object with an optional pattern')
  const pattern = value.pattern === undefined ? undefined : nonEmptyString(value.pattern, `${field}.pattern`, 'code pattern')
  if (pattern !== undefined) {
    try {
      new RegExp(pattern)
    } catch {
      fail(`${field}.pattern`, `code pattern ${JSON.stringify(pattern)} is not a valid regular expression`)
    }
  }
  return pattern === undefined ? {} : { pattern }
}

function parseTimeoutMs(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    fail(field, 'timeoutMs must be a positive number of milliseconds')
  return value
}

function finish<T extends PlanCheck>(check: T, inferred: boolean | undefined): T {
  return inferred === undefined ? check : { ...check, inferred }
}
