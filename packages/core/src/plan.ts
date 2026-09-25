export const PLAN_SCHEMA_VERSION = '1'

export type CheckKind = 'command' | 'flow' | 'visual' | 'mail'

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
  actions?: string[]
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
  inferred?: boolean
}

export type PlanCheck = CommandCheck | FlowCheck | VisualCheck | MailCheck

export interface PlannedCriterion {
  id: string
  text: string
  checks: PlanCheck[]
}

export interface UnplannableCriterion {
  id: string
  text: string
  unplannable: string
}

export type PlanCriterion = PlannedCriterion | UnplannableCriterion

export interface Plan {
  schemaVersion: string
  criteria: PlanCriterion[]
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

export function loadPlan(text: string): Plan {
  let input: unknown
  try {
    input = JSON.parse(text)
  } catch (error) {
    throw new PlanValidationError(
      'json',
      `plan.json is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  return parsePlan(input)
}

export function parsePlan(input: unknown): Plan {
  if (!isRecord(input)) fail('plan', 'plan.json must be a JSON object')

  const { schemaVersion } = input
  if (typeof schemaVersion !== 'string')
    fail('schemaVersion', `plan.json must carry a schemaVersion string (this loader understands "${PLAN_SCHEMA_VERSION}")`)
  if (schemaVersion !== PLAN_SCHEMA_VERSION)
    fail('schemaVersion', `unknown schemaVersion "${schemaVersion}" (this loader understands "${PLAN_SCHEMA_VERSION}")`)

  if (!Array.isArray(input.criteria)) fail('criteria', 'plan.json must carry a criteria array')
  if (input.criteria.length === 0)
    fail('criteria', 'plan is empty: no criterion was planned, and an empty plan passes nothing, so it fails closed')

  return { schemaVersion, criteria: input.criteria.map((entry, index) => parseCriterion(entry, index)) }
}

function parseCriterion(value: unknown, index: number): PlanCriterion {
  const base = `criteria[${index}]`
  if (!isRecord(value)) fail(base, 'criterion must be a JSON object')

  const id = nonEmptyString(value.id, `${base}.id`, 'id')
  const text = nonEmptyString(value.text, `${base}.text`, 'text')

  const hasChecks = value.checks !== undefined
  const hasUnplannable = value.unplannable !== undefined
  if (!hasChecks && !hasUnplannable)
    fail(base, `criterion "${id}" maps to no checks; carry a checks array or an unplannable reason`)
  if (hasChecks && hasUnplannable)
    fail(base, `criterion "${id}" carries both checks and unplannable; a criterion is planned or unplannable, not both`)
  if (hasUnplannable)
    return { id, text, unplannable: nonEmptyString(value.unplannable, `${base}.unplannable`, 'unplannable reason') }

  if (!Array.isArray(value.checks)) fail(`${base}.checks`, 'checks must be an array')
  if (value.checks.length === 0)
    fail(`${base}.checks`, `criterion "${id}" maps to zero checks; carry at least one check or mark the criterion unplannable`)

  return {
    id,
    text,
    checks: value.checks.map((check, checkIndex) => parseCheck(check, `${base}.checks[${checkIndex}]`)),
  }
}

function parseCheck(value: unknown, base: string): PlanCheck {
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
      const actions = stringArray(value.actions, `${base}.actions`, 'actions')
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
        },
        inferred,
      )
    }
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

function parseTimeoutMs(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    fail(field, 'timeoutMs must be a positive number of milliseconds')
  return value
}

function finish<T extends PlanCheck>(check: T, inferred: boolean | undefined): T {
  return inferred === undefined ? check : { ...check, inferred }
}
