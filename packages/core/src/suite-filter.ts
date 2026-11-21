/**
 * The longest filter a plan may hand a suite (#376): a test path with a line
 * number, or a name pattern, is far shorter.
 */
export const SUITE_FILTER_LIMIT = 200

/**
 * The characters a planned suite filter may carry (#376): what a test path,
 * a `path:line`, a `file::test` id or a name pattern needs, and nothing a
 * shell gives meaning to beyond a glob. Whitespace, quotes, `$`, backticks,
 * `;`, `|`, `&`, redirection, parentheses, braces and backslashes are out.
 */
const SUITE_FILTER_CHARACTERS = /^[A-Za-z0-9_./:*+?^[\]=,@-]+$/

/**
 * Why a filter value cannot be substituted into a suite's command, or
 * undefined when it can (#376). The value is the planner's, and it lands in a
 * command the profile wrote, so it is held to one token of a fixed character
 * set, never an option (a leading `-`), never an absolute path and never a
 * path that climbs out of the checkout with `..`.
 */
export function suiteFilterViolation(filter: string): string | undefined {
  if (filter === '') return 'the filter is empty: name the test or the path the suite should run'
  if (filter.length > SUITE_FILTER_LIMIT) return `the filter is longer than ${SUITE_FILTER_LIMIT} characters`
  if (!SUITE_FILTER_CHARACTERS.test(filter))
    return 'the filter carries a character outside letters, digits and . _ / : * + ? ^ [ ] = , @ -: it is one token, with no space, quote or shell syntax'
  if (filter.startsWith('-')) return 'the filter starts with -, which the test runner would read as an option'
  if (filter.startsWith('/')) return 'the filter is an absolute path: name a path inside the repository'
  if (filter.split('/').includes('..')) return 'the filter climbs out of the repository with ..'
  return undefined
}
