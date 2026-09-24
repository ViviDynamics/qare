import { randomUUID } from 'node:crypto'
import { JobValidationError } from './job.js'

export type RunValues = Record<string, string>

/**
 * Values minted once per run and referenced by name as `{{run.<name>}}` from
 * user-authored strings. The mail address embeds the run id, so two concurrent
 * runs never share an address, and a rerun never sees the previous run's mail.
 */
export function mintRunValues(): RunValues {
  const id = randomUUID()
  return {
    id,
    started_at: new Date().toISOString(),
    mail_address: `qare-${id}@localhost`,
  }
}

const REFERENCE = /\{\{([^{}]*)\}\}/g

/**
 * Replace every `{{run.<name>}}` in text with the minted value. This is
 * substitution, not a language: no expressions, no conditionals, no nesting.
 */
export function substituteValues(text: string, values: RunValues): string {
  return text.replace(REFERENCE, (token, name) => {
    // name carries the "run." namespace; the minted keys do not.
    const value = name === undefined ? undefined : values[name.slice(4)]
    return value === undefined ? token : value
  })
}

/**
 * Fail closed when text carries a `{{...}}` reference the harness does not mint.
 * Called at plan time, before anything boots, because an unknown name is a
 * caller mistake that would otherwise surface halfway through a run. An
 * unterminated `{{` is refused the same way: half a reference is still a
 * reference, and silently passing it through would publish broken input.
 */
export function validateValueReferences(text: string, values: RunValues, field: string): void {
  const complete = [...text.matchAll(REFERENCE)]
  for (const match of complete) {
    const name = match[1] ?? ''
    if (!name.startsWith('run.') || values[name.slice(4)] === undefined) {
      throw new JobValidationError(field, `unknown run value ${JSON.stringify(match[0])}; minted values are ${Object.keys(values).map((key) => `{{run.${key}}}`).join(', ')}`)
    }
  }
  let leftover = text
  for (const match of complete) leftover = leftover.replace(match[0], '')
  if (leftover.includes('{{')) {
    throw new JobValidationError(field, 'unterminated run value reference; a reference is "{{run.<name>}}" and must open and close in the same string')
  }
}

/** True when the string carries at least one `{{...}}` reference. */
export function hasValueReferences(text: string): boolean {
  return new RegExp(REFERENCE.source).test(text)
}
