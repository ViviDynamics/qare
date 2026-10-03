/**
 * What the platform under a flow wrote while the flow ran (#72, #78): a
 * browser page's console, a desktop application's two streams and its
 * windows, a device's log. Each driver records into one of these, so every
 * client's log is bounded the same way and can be cut to the window around
 * a failure the same way.
 */
export interface PlatformLogEntry {
  /** When the line was written, in milliseconds since the epoch. */
  at: number
  line: string
}

export interface PlatformLog {
  /** One line, under the label that says where it came from. */
  record(label: string, text?: string): void
  /** Every line kept, in order, led by how many were dropped when any were. */
  lines(): string[]
  /** Every line kept, with the moment it was written. */
  entries(): PlatformLogEntry[]
}

/** The lines one check keeps; a chatty application drops its oldest, and the log says how many. */
export const MAX_PLATFORM_LOG_LINES = 5_000
/** The characters one line keeps; what is under test is pull request code, and a line with no end must not grow the run. */
export const MAX_PLATFORM_LOG_LINE_CHARACTERS = 8_192

export function makePlatformLog(opts: { maxLines?: number; maxLineCharacters?: number; now?: () => number } = {}): PlatformLog {
  const maxLines = opts.maxLines ?? MAX_PLATFORM_LOG_LINES
  const maxLineCharacters = opts.maxLineCharacters ?? MAX_PLATFORM_LOG_LINE_CHARACTERS
  const now = opts.now ?? Date.now
  const kept: PlatformLogEntry[] = []
  let dropped = 0
  const cut = (text: string): string => (text.length <= maxLineCharacters ? text : `${text.slice(0, maxLineCharacters)} [line cut at ${maxLineCharacters} characters]`)
  return {
    record: (label, text) => {
      kept.push({ at: now(), line: text === undefined ? `[${label}]` : `[${label}] ${cut(text)}` })
      if (kept.length > maxLines) {
        kept.shift()
        dropped += 1
      }
    },
    lines: () => {
      const lines = kept.map((entry) => entry.line)
      return dropped === 0 ? lines : [`[console] ${dropped} earlier lines dropped: the log keeps the last ${maxLines}`, ...lines]
    },
    entries: () => kept.map((entry) => ({ ...entry })),
  }
}

/** How far back from a failure its log excerpt reaches. */
export const EXCERPT_BEFORE_MS = 30_000
/** The lines an excerpt keeps from before the failure: the ones nearest it. */
export const EXCERPT_MAX_BEFORE = 200
/** The lines an excerpt keeps from after the failure: the ones nearest it. */
export const EXCERPT_MAX_AFTER = 100

function count(lines: number, where: string): string {
  return `${lines} ${where} ${lines === 1 ? 'line is' : 'lines are'} in console.log`
}

/**
 * The log for the window around a failure (#78): what the platform wrote in
 * the seconds that led up to the moment a check stopped, a mark where it
 * stopped, and what the platform wrote from there to the end of the check.
 * Each line carries its distance from that moment. The whole log stays in
 * `console.log`; this is the part of it a reader of a failure wants first,
 * bounded on both sides, and it says what it left out.
 */
export function excerptAround(
  entries: readonly PlatformLogEntry[],
  at: number,
  opts: { beforeMs?: number; maxBefore?: number; maxAfter?: number } = {},
): string[] {
  const beforeMs = opts.beforeMs ?? EXCERPT_BEFORE_MS
  const maxBefore = opts.maxBefore ?? EXCERPT_MAX_BEFORE
  const maxAfter = opts.maxAfter ?? EXCERPT_MAX_AFTER
  const upTo = entries.filter((entry) => entry.at <= at)
  const inWindow = upTo.filter((entry) => entry.at >= at - beforeMs)
  const before = inWindow.slice(Math.max(0, inWindow.length - maxBefore))
  const following = entries.filter((entry) => entry.at > at)
  const after = following.slice(0, maxAfter)
  const earlier = upTo.length - before.length
  const later = following.length - after.length
  const distance = (entry: PlatformLogEntry): string => `[${entry.at > at ? '+' : '-'}${(Math.abs(entry.at - at) / 1000).toFixed(3)}s]`
  const heading = `the platform log from ${beforeMs / 1000} s before the check stopped to its end`
  return [
    earlier === 0 ? heading : `${heading}; ${count(earlier, 'earlier')}`,
    ...before.map((entry) => `${distance(entry)} ${entry.line}`),
    '--- the check stopped here ---',
    ...after.map((entry) => `${distance(entry)} ${entry.line}`),
    ...(later === 0 ? [] : [count(later, 'later')]),
    ...(before.length === 0 && after.length === 0 ? ['the platform wrote nothing in this window'] : []),
  ]
}
