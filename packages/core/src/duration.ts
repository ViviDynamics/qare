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
