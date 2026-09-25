import { randomUUID } from 'node:crypto'
import { JobValidationError } from './job.js'

export type RunValues = Record<string, string>

/**
 * Values minted once per run and referenced by name as `{{run.<name>}}` from
 * user-authored strings. The mail address embeds the run id, so two concurrent
 * runs never share an address, and a rerun never sees the previous run's mail.
 *
 * A run against a target also carries `target_url`, the URL its checks point
 * at (#122); a profile that boots its own stack does not mint it, so a
 * reference to it there fails closed at plan time.
 */
export function mintRunValues(opts: { targetUrl?: string } = {}): RunValues {
  const id = randomUUID()
  return {
    id,
    started_at: new Date().toISOString(),
    mail_address: `qare-${id}@localhost`,
    // No trailing slash, so {{run.target_url}}/path never doubles one.
    ...(opts.targetUrl === undefined ? {} : { target_url: opts.targetUrl.replace(/\/+$/, '') }),
  }
}

export const REFERENCE = /\{\{([^{}]*)\}\}/g

/**
 * Replace every `{{run.<name>}}` in text with the minted value. This is
 * substitution, not a language: no expressions, no conditionals, no nesting.
 */
export function substituteValues(text: string, values: RunValues): string {
  return text.replace(REFERENCE, (token, name) => {
    // name carries the "run." namespace; the minted keys do not. hasOwn keeps
    // inherited Object.prototype names (constructor, toString) out of the mint.
    const value = name === undefined || !name.startsWith('run.') || !Object.hasOwn(values, name.slice(4))
      ? undefined
      : values[name.slice(4)]
    return value === undefined ? token : value
  })
}

/**
 * Fail closed when text carries a `{{...}}` reference the harness does not mint.
 * Called at plan time, before anything boots, because an unknown name is a
 * caller mistake that would otherwise surface halfway through a run. An
 * unterminated `{{` is refused the same way: half a reference is still a
 * reference, and silently passing it through would publish broken input.
 *
 * `allow` names references outside the mint that a later stage resolves and
 * validates in full (the run's own validation of mail artefacts): the generic
 * walk only decides that such a name is not a caller mistake. Only strings that
 * enter execution through the run pipeline are validated here; suite commands
 * in the profile's `suites` list are substitution sites for the flow runner to
 * inherit deliberately.
 */
export function validateValueReferences(
  text: string,
  values: RunValues,
  field: string,
  allow?: (name: string) => boolean,
): void {
  const complete = [...text.matchAll(REFERENCE)]
  for (const match of complete) {
    const name = match[1] ?? ''
    // hasOwn: inherited Object.prototype names are not minted values, so
    // {{run.constructor}} is an unknown name, not Object.prototype.constructor.
    if (name.startsWith('run.') && Object.hasOwn(values, name.slice(4))) continue
    if (allow !== undefined && allow(name)) continue
    throw new JobValidationError(field, `unknown run value ${JSON.stringify(match[0])}; minted values are ${Object.keys(values).map((key) => `{{run.${key}}}`).join(', ')}`)
  }
  let leftover = text
  for (const match of complete) leftover = leftover.replace(match[0], '')
  if (leftover.includes('{{')) {
    throw new JobValidationError(field, 'unterminated run value reference; a reference is "{{run.<name>}}" and must open and close in the same string')
  }
}

/**
 * Fail closed on an unknown `{{run.<name>}}` reference only, leaving every
 * other `{{...}}` alone. For text that legitimately carries braces of its own:
 * a suite command (`docker ps --format '{{.Names}}'`), or a value a flow types
 * or a text it asserts on a page that shows template syntax.
 */
export function validateRunReferences(text: string, values: RunValues, field: string): void {
  for (const match of text.matchAll(REFERENCE)) {
    const name = match[1] ?? ''
    if (!name.startsWith('run.') || Object.hasOwn(values, name.slice(4))) continue
    throw new JobValidationError(field, `unknown run value ${JSON.stringify(match[0])}; minted values are ${Object.keys(values).map((key) => `{{run.${key}}}`).join(', ')}`)
  }
}
