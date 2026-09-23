/**
 * The issues a pull request promises to close.
 *
 * Only the closing keywords GitHub itself honours count. A bare `#12` is a
 * mention rather than a promise, and reading a mentioned issue's criteria
 * would check the wrong thing. A cross-repository link is skipped for the same
 * reason: its criteria are not this change's to satisfy, and the job reads
 * issues from the repository it runs in.
 *
 * No links is not an error. A chore states no criteria, and what to do about
 * that belongs to the caller.
 */
const LINK = /(?:^|[^\w/])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi

export function linkedIssues(body: string): number[] {
  const seen: number[] = []
  for (const match of String(body ?? '').matchAll(LINK)) {
    const number = Number(match[1])
    if (!seen.includes(number)) seen.push(number)
  }
  return seen
}
