import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ProfileValidationError, isUnsafeProfileName, loadProfile, type QaProfile } from './profile.js'

/**
 * One profile of a repository that may hold several (#55). `name` is the
 * profile's directory under `.qa/`, or `default` for the single root profile,
 * whose directory is `.qa/` itself.
 */
export interface NamedProfile {
  name: string
  dir: string
  profile: QaProfile
}

export const DEFAULT_PROFILE_NAME = 'default'

/**
 * Read every profile a repository's `.qa/` holds (#55): the single root form
 * (`.qa/config.yml`), or named profiles, one per subdirectory of `.qa/` that
 * carries a `config.yml`. The two forms do not mix: a repository is either
 * one app or several, and a `.qa/` that holds both is a mistake somebody has
 * to settle, so loading fails closed.
 *
 * The root form is present exactly when `.qa/config.yml` is: a root profile
 * whose QA.md is missing is malformed, not absent, so it fails the load
 * instead of quietly reading as a named-profile layout. The name `default` is
 * reserved for the root form: a named profile directory of that name is a
 * layout nobody can select from, so it fails closed too.
 *
 * A malformed profile still fails the load — only absence is discovery. A
 * named profile shares the root's fixtures and stubs when it keeps none of
 * its own (#55).
 */
export async function discoverProfiles(qaDir: string): Promise<NamedProfile[]> {
  // The root is present when the entry exists, whatever it is: a config.yml
  // that is a directory or a broken symlink is a malformed root, and the load
  // reports it, rather than reading as a named-profile layout.
  const exists = async (path: string): Promise<boolean> => (await lstat(path).then(() => true, () => false))
  const root: NamedProfile | undefined = (await exists(join(qaDir, 'config.yml')))
    ? { name: DEFAULT_PROFILE_NAME, dir: qaDir, profile: await loadProfile(qaDir) }
    : undefined
  const entries = await readdir(qaDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const named: NamedProfile[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === DEFAULT_PROFILE_NAME) {
      if (await exists(join(qaDir, entry.name, 'config.yml')))
        throw new ProfileValidationError(
          'config.yml',
          `a named profile cannot be called ${DEFAULT_PROFILE_NAME}: the name is reserved for the single root profile, so a ${join(qaDir, entry.name, 'config.yml')} is a layout nobody can select from; rename the directory to the app it checks`,
        )
      continue
    }
    const dir = join(qaDir, entry.name)
    // A subdirectory without a config.yml is not a profile: it is a directory
    // of fixtures, stubs or learned notes the root form keeps. A directory
    // that carries the entry is a profile, so every load error — a missing
    // QA.md, unreadable YAML, absent fixtures — fails closed rather than
    // reading as absence.
    if (!(await exists(join(dir, 'config.yml')))) continue
    // The directory's name becomes the app's profile name everywhere it is
    // published — `qare profiles` output, evidence file names, a plan's
    // profile list — so a name the filesystem allowed but no job or plan
    // could carry is refused here, at discovery, before anything is written
    // under it (#55).
    if (isUnsafeProfileName(entry.name))
      throw new ProfileValidationError(
        'profiles',
        `profile name ${JSON.stringify(entry.name)} must not contain path separators, ".." or control characters; the directory under ${qaDir} names the app, and the name becomes evidence file names`,
      )
    const profile = await loadProfile(dir, { resources: qaDir })
    named.push({ name: entry.name, dir, profile })
  }
  if (root !== undefined && named.length > 0)
    throw new ProfileValidationError(
      'config.yml',
      `either one profile at ${qaDir}, or named profiles in its subdirectories, not both; a repository that is one app uses the root form and a monorepo names its apps, so both at once is a layout nobody can select from`,
    )
  if (root !== undefined) return [root]
  named.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return named
}

/**
 * The profiles a change with `touched` paths selects (#55). The single root
 * profile is always selected: a repository that is one app is checked on every
 * change. Named profiles are selected when a touched path falls under one of
 * the areas the profile declares in `paths`, or under the profile's own
 * directory, so editing a boot recipe selects the app it boots; a profile that
 * declares no areas is selected only by its own directory. A change that
 * matches no profile selects none, and the caller refuses: nothing was checked,
 * and a verdict would have to say so.
 */
export function selectProfiles(profiles: NamedProfile[], touched: readonly string[]): NamedProfile[] {
  if (profiles.length === 0) return []
  const first = profiles[0]
  if (profiles.length === 1 && first !== undefined && first.name === DEFAULT_PROFILE_NAME) return [first]
  const selected = profiles.filter((named) => touched.some((path) => profileCovers(named, path)))
  return selected
}

/**
 * True when `touched` is inside the profile's coverage: under one of the areas
 * it declares, or under the profile's own directory under `.qa/`.
 */
export function profileCovers(named: NamedProfile, touched: string): boolean {
  if (named.name === DEFAULT_PROFILE_NAME) return true
  if (touched === join('.qa', named.name) || touched.startsWith(`${join('.qa', named.name)}/`)) return true
  return (named.profile.paths ?? []).some((area) => pathUnderArea(touched, area))
}

/**
 * Prefix matching at a path-segment boundary: `apps/admin` covers
 * `apps/admin/src` and itself, never `apps/admin-ui`. The area `.` covers the
 * whole repository.
 */
export function pathUnderArea(touched: string, area: string): boolean {
  if (area === '.') return true
  return touched === area || touched.startsWith(`${area}/`)
}

/**
 * The repository paths a git diff touches, from the file headers a diff
 * carries: `diff --git a/<path> b/<path>`, plus the `---`/`+++` sides, so a
 * rename is covered on both sides. Git quotes a path that carries spaces,
 * quotes, tabs or non-ASCII bytes in C style (`diff --git "a/x y" "b/x y"`),
 * so the quoted form is unquoted before the path is read and an exotic path
 * still selects the app whose area declares it. Unparsable or exotic headers
 * contribute nothing: selection misses quietly rather than inventing a path.
 */
export function touchedPathsFromDiff(diff: string): string[] {
  const paths = new Set<string>()
  for (const line of diff.split('\n')) {
    const gitHeader = line.match(/^diff --git a\/(.+) b\/(.+)$/)
    if (gitHeader !== null) {
      const before = gitHeader[1]
      const after = gitHeader[2]
      if (before !== undefined) paths.add(before)
      if (after !== undefined) paths.add(after)
      continue
    }
    const quotedHeader = line.match(/^diff --git ("(?:[^"\\]|\\.)*") (".*")$/)
    if (quotedHeader !== null) {
      const before = quotedHeader[1]
      const after = quotedHeader[2]
      if (before !== undefined) paths.add(withoutSidePrefix(gitPathFromQuoted(before)))
      if (after !== undefined) paths.add(withoutSidePrefix(gitPathFromQuoted(after)))
      continue
    }
    const side = line.match(/^(?:--- a\/|\+\+\+ b\/)(.+?)(?:\t|$)/)
    const path = side?.[1]
    if (path !== undefined) paths.add(path)
    const quotedSide = line.match(/^(?:--- |\+\+\+ )("(?:[^"\\]|\\.)*")/)
    const quotedSpec = quotedSide?.[1]
    if (quotedSpec !== undefined) paths.add(withoutSidePrefix(gitPathFromQuoted(quotedSpec)))
  }
  return [...paths].sort()
}

/**
 * The `a/` or `b/` side prefix git writes before every path in a diff header,
 * quoted or not, is not part of the repository path.
 */
function withoutSidePrefix(path: string): string {
  return path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path
}

const C_ESCAPES: Record<string, string> = {
  a: '\x07',
  b: '\x08',
  t: '\t',
  n: '\n',
  v: '\v',
  f: '\f',
  r: '\r',
  '"': '"',
  '\\': '\\',
}

/**
 * Reads one side of a git header as the path it names: git wraps such a path
 * in double quotes and escapes specials in C style when the path carries
 * spaces, quotes, tabs or non-ASCII bytes. An octal escape carries one UTF-8
 * byte, so the bytes are assembled and decoded as UTF-8, not read one
 * character at a time.
 */
function gitPathFromQuoted(spec: string): string {
  if (!spec.startsWith('"') || !spec.endsWith('"')) return spec
  const bytes: number[] = []
  const pushUtf8 = (char: string): void => {
    for (const byte of new TextEncoder().encode(char)) bytes.push(byte)
  }
  const inner = spec.slice(1, -1)
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i]
    if (char === undefined) break
    if (char !== '\\') {
      pushUtf8(char)
      continue
    }
    const next = inner[i + 1]
    i += 1
    if (next === undefined) break
    if (next in C_ESCAPES) pushUtf8(C_ESCAPES[next] as string)
    else if (next >= '0' && next <= '7') {
      const octal = /^([0-7]{3})/.exec(inner.slice(i))
      if (octal === null) {
        pushUtf8(next)
        continue
      }
      bytes.push(parseInt(octal[1] as string, 8))
      i += 2
    } else pushUtf8(next)
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}
