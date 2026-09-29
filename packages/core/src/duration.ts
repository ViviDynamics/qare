/** A timeout such as `120s`, `500ms` or `2m`, in milliseconds. */
export function parseDurationMs(timeout: string): number {
  const match = /^(\d+)(ms|s|m)$/.exec(timeout.trim())
  if (!match) {
    throw new Error(`"${timeout}" is not a duration like 120s`)
  }
  const value = Number(match[1])
  if (match[2] === 'ms') return value
  if (match[2] === 's') return value * 1000
  return value * 60000
}

/**
 * The runner's shell-syntax judgment, shared with plan-time validation (#136):
 * plan-step must reject exactly the commands this runner would, so both sides
 * read one character class instead of two copies that can drift apart. It sits
 * here, in a module with no imports, so the profile's validation (#93) can read
 * the same class without reaching the runner through a cycle.
 */
export function shellCharacter(run: string): string | undefined {
  return run.match(/[|&;<>$`"'\\()\n\r]/)?.[0]
}
