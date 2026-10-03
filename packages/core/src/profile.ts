import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { A11Y_IMPACTS, A11Y_STANDARDS, type A11yAccepted, type A11yImpact, type ProfileA11y } from './a11y.js'
import { parseDurationMs, shellCharacter } from './duration.js'
import { MAIL_SOURCE_KINDS, type DeclaredMailSource, type MailSourceKind } from './mail-source.js'
import { channelToolName } from './mcp.js'
import { RedactionError, redactionRules, validateMaskSelectors, type ProfileRedaction } from './redact.js'

/**
 * The second factor a profile seeds (#64). The secret is a test-only value the
 * seed step plants in the QA database, so the app's real two-factor path is
 * exercised rather than disabled.
 */
export interface ProfileLoginTotp {
  secret: string
  digits: number
  period: number
  algorithm: 'SHA1' | 'SHA256' | 'SHA512'
}

export interface ProfileLogin {
  fixture: string
  role: string
  totp?: ProfileLoginTotp
  /** A seeded recovery code, for apps that accept one instead of the rotating code (#64). */
  backupCode?: { value: string }
}

export interface ProfileApp {
  boot: { compose: string; service: string }
  health: { http: string; timeout: string }
  seed: { command: string }
  login: ProfileLogin
}

/**
 * A deployed app qare did not boot (#122): staging, a preview, a public site.
 * The health check proves it is up; `hosts` are the other hosts a check may
 * reach, besides the target's own.
 */
export interface ProfileTarget {
  url: string
  health: { http: string; timeout: string }
  hosts: string[]
}

/**
 * The client drivers a profile may name (#72). The browser is the default and
 * is not named; a driver a host maps onto its own tools is an MCP mapping.
 */
export const CLIENT_DRIVERS = ['electron'] as const

export type ClientDriver = (typeof CLIENT_DRIVERS)[number]

/**
 * A build qare launches rather than a server it boots or a URL it reaches
 * (#72): a desktop application, driven through its own windows. `executable`
 * resolves from the repository the run checks. Naming the binary is the
 * minimum a driver needs; building, fetching and installing it is
 * provisioning (#75), which is not this section's to do.
 */
export interface ProfileClient {
  driver: ClientDriver
  executable: string
  args: string[]
}

export interface ProfileStub {
  service: string
  hosts: string[]
  provided_by: { compose_service: string }
}

export interface ProfileVisual {
  widths: number[]
  themes: string[]
}

export type ProfileSuiteKind = 'command' | 'flow' | 'visual'

export interface ProfileSuite {
  name: string
  command: string
  kind: ProfileSuiteKind
  /**
   * True when the suite's command mutates shared state of the app (#48), so
   * a criterion the ledger verifies by this suite runs against an app
   * instance of its own instead of the run's shared one.
   */
  isolated?: boolean
}

export interface ProfileCommand {
  run: string
  about: string
  /**
   * The placeholder of `run` whose filled token is the test filter (#157):
   * the runner reads the check's machine-readable report and counts the tests
   * the filter selected, so a filter that selects nothing or everything stays
   * unverified instead of proving the wrong thing.
   */
  filter?: string
  /** The machine-readable report the command prints on stdout (#157). */
  report?: ReportFormat
}

/** The report formats a command check's selection can be read from (#157). */
export const REPORT_FORMATS = ['vitest-json', 'junit-xml', 'node-tap'] as const

export type ReportFormat = (typeof REPORT_FORMATS)[number]

/**
 * The pipeline steps a registered host tool server may run in (#93). The plan
 * step looks through its tools at the running app; the execute step runs pull
 * request code, so a server that needs a credential is never placed there.
 */
export type McpStep = 'plan' | 'execute'

export interface ProfileMcpServer {
  /** The name the server's tools are reached under, and the evidence records. */
  name: string
  /** How to start the server: a command split on whitespace, spawned with no shell. */
  command?: string
  /** How to reach the server: an http or https URL speaking MCP. */
  url?: string
  /** Which of the server's tools the session may call. */
  tools: string[]
  /** The steps the server may run in. */
  steps: McpStep[]
  /** The credential the server needs, by name; never a value (#93). */
  credential?: string
  /**
   * The flow intents this server's tools drive (#94). The mapping is the
   * driver's capability declaration, so a plan is rejected at plan time for
   * an action the mapping does not bind; one server at most may carry it.
   */
  driver?: Record<string, ProfileMcpToolMap>
}

/**
 * The flow intents a driver mapping may name, and the action fields each
 * intent carries (#94): the mapping binds a tool argument to every slot, so
 * the harness knows what to hand the tool when the step runs.
 */
export const MCP_DRIVER_INTENTS: Record<string, { slots: readonly string[] }> = {
  open: { slots: ['url'] },
  type: { slots: ['element', 'value'] },
  click: { slots: ['element'] },
  choose: { slots: ['element', 'value'] },
  waitFor: { slots: ['element'] },
  assertText: { slots: ['text'] },
  assertElement: { slots: ['element'] },
  capture: { slots: [] },
  snapshot: { slots: [] },
}

export interface ProfileMcpToolMap {
  /** The tool the intent's action drives. */
  tool: string
  /** Tool argument names bound to the slots the intent carries. */
  args?: Record<string, string>
}

export interface QaProfile {
  /** The boot recipe; absent when the profile names a target instead. */
  app?: ProfileApp
  /** A running app to check in place of booting one (#122); exclusive with app. */
  target?: ProfileTarget
  /** A build the run launches and drives through a client driver (#72); exclusive with app and target. */
  client?: ProfileClient
  stubs: ProfileStub[]
  visual: ProfileVisual
  suites: ProfileSuite[]
  /**
   * The image flavour the profile's checks need (#88): the published image
   * the pipeline's execute step runs them in. Absent means the base image is
   * enough, which a profile of command and mail checks is.
   */
  flavour?: ImageFlavour
  /** Where the harness reads the mail a check waits for (#67). */
  mail?: ProfileMail
  /** The host's MCP servers the planner may look through (#93). */
  mcp?: ProfileMcpServer[]
  /** Fixture data that must not be published in evidence (#52). */
  redact?: ProfileRedaction
  commands?: Record<string, ProfileCommand>
  instructions?: string
  /**
   * The areas of the repository this profile covers (#55): the touched paths
   * that select it when `.qa/` holds several profiles. A single root profile
   * covers the whole repository and is selected without them.
   */
  paths?: string[]
  /**
   * What the base side of a run costs (#147). A run of a booted profile
   * executes the plan at the base revision too, so regressions are found
   * against it; this section bounds that: which criteria run there, and for
   * how long. Whatever it leaves out is reported as not compared.
   */
  base?: ProfileBase
  /**
   * What an accessibility audit holds a page to (#149): the rule set, the
   * impacts that fail, the violations accepted with a reason, and whether
   * every flow is audited. Absent, a planned `a11y` check takes the defaults
   * and no flow is audited without one.
   */
  a11y?: ProfileA11y
  /**
   * The advisory UX review (#150): whether it runs, and the house rules it
   * holds screens to. Absent, the review runs with no house rules.
   */
  ux?: ProfileUx
  /**
   * Who a finding on `main` reaches (#154): the fallback an issue mentions
   * when no change can be blamed, and the logins treated as bots. Absent, an
   * issue with nobody to blame mentions nobody and says so.
   */
  findings?: ProfileFindings
}

/**
 * The profile's `findings` section (#154). Both values are published as
 * mentions or compared with logins, so each is a GitHub login, and the
 * fallback may be a team (`org/team`).
 */
export interface ProfileFindings {
  /** A person (`octocat`) or a team (`acme/qa-leads`), without the at sign. */
  fallback?: string
  /** Logins whose pull requests are a bot's: an orchestrator that opens them with a person's token. */
  bots?: string[]
}

/**
 * The profile's `ux` section (#150). The review is advisory whatever this
 * says: nothing here can make a finding part of a verdict.
 */
export interface ProfileUx {
  /** `false` turns the review off for this profile's screens. */
  review?: boolean
  /** House rules, one sentence each: a design system, voice and tone, patterns to hold to. */
  rules?: string[]
}

export interface ProfileBase {
  /**
   * `all` (the default) runs the whole plan at the base; `ledger` only the
   * criteria the ledger at the base already carries; `none` runs nothing
   * there, so the run has one side and says so.
   */
  criteria?: 'all' | 'ledger' | 'none'
  /** The base side's wall clock bound, as a duration like `10m`. */
  budget?: string
}

function parseProfileBase(value: unknown): ProfileBase {
  if (!isRecord(value)) fail('base', 'base must be a YAML object with criteria and budget')
  for (const key of Object.keys(value))
    if (key !== 'criteria' && key !== 'budget') fail(`base.${key}`, `base takes criteria and budget, not ${JSON.stringify(key)}`)
  if (value.criteria !== undefined && value.criteria !== 'all' && value.criteria !== 'ledger' && value.criteria !== 'none')
    fail('base.criteria', `base.criteria must be "all", "ledger" or "none", not ${JSON.stringify(value.criteria)}`)
  let budget: string | undefined
  if (value.budget !== undefined) {
    budget = nonEmptyString(value.budget, 'base.budget', 'base budget')
    try {
      parseDurationMs(budget)
    } catch (error) {
      fail('base.budget', `base.budget ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return {
    ...(value.criteria === undefined ? {} : { criteria: value.criteria }),
    ...(budget === undefined ? {} : { budget }),
  }
}

/**
 * The profile's criteria areas (#55): repo-relative paths, matched as
 * prefixes at a path-segment boundary, so `apps/admin` covers `apps/admin/src`
 * but never `apps/admin-ui`. `.` covers the whole repository. A path that
 * climbs out of the repository, or that no git diff path can carry, is a
 * profile mistake and fails the profile when it loads.
 */
function parseProfilePaths(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) fail(field, `${field} must be an array of repo-relative paths`)
  const paths = stringArray(value, field, 'area path')
  for (const [index, path] of paths.entries()) {
    const base = `${field}[${index}]`
    if (path.includes('\\'))
      fail(base, `area path ${JSON.stringify(path)} must use "/" as its separator; a git diff path never carries a backslash`)
    if (path.startsWith('/')) fail(base, `area path ${JSON.stringify(path)} must be repo-relative, not absolute`)
    if (path.endsWith('/')) fail(base, `area path ${JSON.stringify(path)} must not end in "/"`)
    if (path.split('/').includes('..'))
      fail(base, `area path ${JSON.stringify(path)} climbs out of the repository (".." is not allowed)`)
    if (path !== '.' && path.split('/').includes('.'))
      fail(base, `area path ${JSON.stringify(path)} carries a "." segment, which no git diff path can match (write the path without it)`)
    if (path !== '.' && path.split('/').some((segment) => segment === ''))
      fail(base, `area path ${JSON.stringify(path)} carries an empty path segment`)
    // Evidence is published: a control character in a path is one way to
    // write something a reader cannot name.
    if (/[\x00-\x1f\x7f]/.test(path)) fail(base, `area path ${JSON.stringify(path)} carries control characters`)
  }
  return paths
}

/**
 * Where a run reads the mail its checks wait for (#65). A profile names one
 * source: `inbox`, the listing contract of #67, or `source`, an adapter by
 * kind. `domain` is the domain the per-run address is minted on.
 */
export interface ProfileMail {
  inbox?: string
  source?: DeclaredMailSource
  domain?: string
}

const SUITE_KINDS: ProfileSuiteKind[] = ['command', 'flow', 'visual']

export class ProfileValidationError extends Error {
  readonly field: string

  constructor(field: string, message: string) {
    super(`${field}: ${message}`)
    this.name = 'ProfileValidationError'
    this.field = field
  }
}

/**
 * The profile, or a required part of it, is not there at all (#107).
 *
 * A subclass so every existing handler of ProfileValidationError still catches
 * it, and distinct so a caller can tell absence from a mistake: a repository
 * that has not onboarded is refused, while a malformed file somebody wrote is
 * still an error.
 */
export class ProfileMissingError extends ProfileValidationError {
  constructor(field: string, message: string) {
    super(field, message)
    this.name = 'ProfileMissingError'
  }
}

function fail(field: string, message: string): never {
  throw new ProfileValidationError(field, message)
}

/**
 * Whether a profile name is one a run cannot publish under (#55). Profile
 * names become evidence file names (`isolation-<name>.json`,
 * `values-<name>.json`) and profile directories, wherever the name came from:
 * a hand-written job, a plan that names its apps, or the directory discovery
 * prints for `qare profiles`. ":" is reserved for namespace prefixes, and
 * separators, ".." and control characters would carry the name out of the
 * evidence directory it is published into.
 */
export function isUnsafeProfileName(name: string): boolean {
  return name.includes(':') || /[/\\]|\.\./.test(name) || /[\x00-\x1f\x7f]/.test(name)
}

function missing(field: string, message: string): never {
  throw new ProfileMissingError(field, message)
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

async function requireFile(filePath: string, field: string, label: string): Promise<void> {
  const info = await stat(filePath).catch(() => undefined)
  if (!info) missing(field, `${label} is required but missing at ${filePath}`)
  if (!info.isFile()) fail(field, `${label} must be a file, but ${filePath} is not`)
}

/**
 * The directory a boot profile's fixtures and stubs live in: beside the
 * profile's own config.yml by default, or the ones the `.qa/` root keeps when
 * the profile is one of a repository's several and shares them (#55).
 */
async function requireBootResource(dir: string, sharedRoot: string | undefined, name: string, field: string, label: string): Promise<void> {
  if (await isDirectory(join(dir, name))) return
  if (sharedRoot !== undefined && (await isDirectory(join(sharedRoot, name)))) return
  missing(
    field,
    sharedRoot === undefined
      ? `${label} is required but missing at ${join(dir, name)}`
      : `${label} is required but missing: keep it at ${join(dir, name)}, or share the root's at ${join(sharedRoot, name)}`,
  )
}

async function isDirectory(dirPath: string): Promise<boolean> {
  return (await stat(dirPath).catch(() => undefined))?.isDirectory() ?? false
}

/**
 * Load the profile at `dir`. A named profile of a monorepo passes
 * `shared.resources` — its `.qa/` root — so fixtures and stubs the named
 * profile does not keep of its own can come from the repository's shared
 * directories (#55).
 */
export async function loadProfile(dir: string, shared?: { resources?: string }): Promise<QaProfile> {
  await requireFile(join(dir, 'QA.md'), 'QA.md', 'the .qa/ profile instructions')
  const instructions = await readFile(join(dir, 'QA.md'), 'utf8')

  const configPath = join(dir, 'config.yml')
  let text: string
  try {
    text = await readFile(configPath, 'utf8')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    // Absent is refusal; unreadable for any other reason is a real error.
    const absent = (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
    const Kind = absent ? ProfileMissingError : ProfileValidationError
    throw new Kind('config.yml', `config.yml is required in the .qa/ profile at ${dir} (${reason})`)
  }

  let input: unknown
  try {
    input = parseYaml(text)
  } catch (error) {
    throw new ProfileValidationError(
      'config.yml',
      `config.yml is not valid YAML (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  const profile = validateProfileConfig(input)
  // Fixtures and stubs feed the stack qare boots; a target profile has none.
  if (profile.app !== undefined) {
    await requireBootResource(dir, shared?.resources, 'fixtures', 'fixtures', 'the .qa/ fixtures directory')
    await requireBootResource(dir, shared?.resources, 'stubs', 'stubs', 'the .qa/ stubs directory')
  }
  return { instructions, ...profile }
}

export function validateProfileConfig(config: unknown): QaProfile {
  if (!isRecord(config))
    fail('config.yml', 'config.yml must be a YAML object with app, stubs, visual and suites, or with target, or with client')
  if (config.client !== undefined) return validateClientConfig(config)
  if (config.target !== undefined) return validateTargetConfig(config)
  return {
    app: parseApp(config.app),
    stubs: parseStubs(config.stubs),
    visual: parseVisual(config.visual),
    suites: parseSuites(config.suites),
    ...(config.flavour === undefined ? {} : { flavour: parseFlavour(config.flavour) }),
    ...(config.mail === undefined ? {} : { mail: parseMail(config.mail) }),
    ...(config.mcp === undefined ? {} : { mcp: parseMcp(config.mcp) }),
    ...(config.redact === undefined ? {} : { redact: parseRedact(config.redact) }),
    ...(config.paths === undefined ? {} : { paths: parseProfilePaths(config.paths, 'paths') }),
    ...(config.commands === undefined ? {} : { commands: parseCommands(config.commands) }),
    ...(config.base === undefined ? {} : { base: parseProfileBase(config.base) }),
    ...(config.a11y === undefined ? {} : { a11y: parseA11y(config.a11y) }),
    ...(config.ux === undefined ? {} : { ux: parseUx(config.ux) }),
    ...(config.findings === undefined ? {} : { findings: parseFindings(config.findings) }),
  }
}

/**
 * A profile that points at a running app (#122). It boots nothing, so it has
 * no boot recipe and no stubs; hosts a check may reach are declared on the
 * target instead. visual and suites stay optional.
 */
function validateTargetConfig(config: Record<string, unknown>): QaProfile {
  if (config.app !== undefined)
    fail('target', 'a profile names either app (a stack qare boots) or target (an app already running), not both')
  // An empty list says the same as none, and is what a loaded target profile
  // carries, so a profile passed on inline validates again.
  if (config.stubs !== undefined && !(Array.isArray(config.stubs) && config.stubs.length === 0))
    fail('stubs', 'a target profile boots no stack, so it has no stubs; list the hosts its checks may reach in target.hosts')
  if (config.base !== undefined)
    fail('base', 'a target profile has one side only, so it has no base side to bound; remove the base section')
  return {
    target: parseTarget(config.target),
    stubs: [],
    visual: config.visual === undefined ? { widths: [], themes: [] } : parseVisual(config.visual),
    suites: config.suites === undefined ? [] : parseSuites(config.suites),
    ...(config.flavour === undefined ? {} : { flavour: parseFlavour(config.flavour) }),
    ...(config.mail === undefined ? {} : { mail: parseMail(config.mail) }),
    ...(config.mcp === undefined ? {} : { mcp: parseMcp(config.mcp) }),
    ...(config.redact === undefined ? {} : { redact: parseRedact(config.redact) }),
    ...(config.paths === undefined ? {} : { paths: parseProfilePaths(config.paths, 'paths') }),
    ...(config.commands === undefined ? {} : { commands: parseCommands(config.commands) }),
    ...(config.a11y === undefined ? {} : { a11y: parseA11y(config.a11y) }),
    ...(config.ux === undefined ? {} : { ux: parseUx(config.ux) }),
    ...(config.findings === undefined ? {} : { findings: parseFindings(config.findings) }),
  }
}

/**
 * The arguments a client driver sets for itself (#72): the endpoint it
 * attaches over and the user data directory each launch gets for its own. A
 * profile that passed either would be arguing with the driver.
 */
const DRIVER_OWNED_ARGS = ['--remote-debugging-port', '--remote-debugging-pipe', '--user-data-dir']

/**
 * A profile that names a build to launch (#72). Like a target profile it
 * boots nothing, so it has no boot recipe, no stubs and no base side. What
 * its driver cannot do is refused here, when the profile loads, rather than
 * found out by a check halfway through a run: the electron driver declares
 * no visual check and no a11y check, and a flow is driven by one driver.
 */
function validateClientConfig(config: Record<string, unknown>): QaProfile {
  if (config.app !== undefined || config.target !== undefined)
    fail('client', 'a profile names one of app (a stack qare boots), target (an app already running) or client (a build qare launches), not two')
  if (config.stubs !== undefined && !(Array.isArray(config.stubs) && config.stubs.length === 0))
    fail('stubs', 'a client profile boots no stack, so it has no stubs')
  if (config.base !== undefined)
    fail('base', 'a client profile has one side only, so it has no base side to bound; remove the base section')
  const client = parseClient(config.client)
  const visual = config.visual === undefined ? { widths: [], themes: [] } : parseVisual(config.visual)
  if (visual.widths.length > 0 || visual.themes.length > 0)
    fail('visual', `the ${client.driver} driver declares no visual check, so a client profile names no widths and no themes to capture at`)
  if (config.a11y !== undefined)
    fail('a11y', `the ${client.driver} driver declares no a11y check, so a client profile has no audit to configure; remove the a11y section`)
  const mcp = config.mcp === undefined ? undefined : parseMcp(config.mcp)
  if (mcp?.some((server) => server.driver !== undefined))
    fail('mcp', `a flow is driven by one driver: this profile names the ${client.driver} client, so no MCP server may carry a driver mapping`)
  return {
    client,
    stubs: [],
    visual,
    suites: config.suites === undefined ? [] : parseSuites(config.suites),
    ...(config.flavour === undefined ? {} : { flavour: parseFlavour(config.flavour) }),
    ...(config.mail === undefined ? {} : { mail: parseMail(config.mail) }),
    ...(mcp === undefined ? {} : { mcp }),
    ...(config.redact === undefined ? {} : { redact: parseRedact(config.redact) }),
    ...(config.paths === undefined ? {} : { paths: parseProfilePaths(config.paths, 'paths') }),
    ...(config.commands === undefined ? {} : { commands: parseCommands(config.commands) }),
    ...(config.ux === undefined ? {} : { ux: parseUx(config.ux) }),
    ...(config.findings === undefined ? {} : { findings: parseFindings(config.findings) }),
  }
}

function parseClient(value: unknown): ProfileClient {
  if (!isRecord(value)) fail('client', 'client must be a YAML object with driver, executable and args')
  for (const key of Object.keys(value))
    if (!['driver', 'executable', 'args'].includes(key)) fail(`client.${key}`, `client takes driver, executable and args, not ${JSON.stringify(key)}`)
  if (typeof value.driver !== 'string' || !(CLIENT_DRIVERS as readonly string[]).includes(value.driver))
    fail('client.driver', `client.driver must be one of ${CLIENT_DRIVERS.join(', ')}, not ${JSON.stringify(value.driver)}`)
  const executable = nonEmptyString(value.executable, 'client.executable', 'client executable')
  // Evidence is published, and the path is named in it.
  if (/[\x00-\x1f\x7f]/.test(executable)) fail('client.executable', 'client executable carries control characters')
  if (value.args !== undefined && !Array.isArray(value.args)) fail('client.args', 'client.args must be an array of arguments, each a string')
  const args = value.args === undefined ? [] : stringArray(value.args, 'client.args', 'client argument')
  for (const [index, arg] of args.entries()) {
    const owned = DRIVER_OWNED_ARGS.find((name) => arg === name || arg.startsWith(`${name}=`))
    if (owned !== undefined)
      fail(`client.args[${index}]`, `${owned} is not the profile's to pass: the ${value.driver} driver sets it for every launch`)
  }
  return { driver: value.driver as ClientDriver, executable, args }
}

/**
 * The image flavours the published family ships (#88). A profile names the
 * flavour its checks need, and the run refuses an unknown one before anything
 * boots: the family is the pipeline's, and a name outside it can only be a
 * misspelling or a wish the family has not grown yet.
 */
export const IMAGE_FLAVOURS = ['core', 'web'] as const

export type ImageFlavour = (typeof IMAGE_FLAVOURS)[number]

function parseFlavour(value: unknown): ImageFlavour {
  if (typeof value !== 'string' || !(IMAGE_FLAVOURS as readonly string[]).includes(value))
    fail('flavour', `flavour must be one of ${IMAGE_FLAVOURS.join(', ')}, not ${JSON.stringify(value)}`)
  return value as ImageFlavour
}

function httpUrl(value: string, field: string, label: string): URL {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    fail(field, `${label} ${JSON.stringify(value)} is not a valid URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    fail(field, `${label} ${JSON.stringify(value)} must be an http or https URL`)
  return parsed
}

/**
 * A path on the target, below its URL: `/login` on a target served at
 * `https://org.example/app/` is `https://org.example/app/login`, not the
 * host's root. A path that climbs out of it (`/../admin`, encoded or not)
 * is undefined: it names no page on the target.
 */
export function pathOnTarget(targetUrl: string, path: string): string | undefined {
  const base = new URL(targetUrl)
  base.search = ''
  base.hash = ''
  if (!base.pathname.endsWith('/')) base.pathname = `${base.pathname}/`
  // "./" keeps a colon in the first segment (/Special:Search) from reading as a scheme.
  const resolved = new URL(`./${path.replace(/^\/+/, '')}`, base)
  if (resolved.origin !== base.origin || !resolved.pathname.startsWith(base.pathname)) return undefined
  return resolved.href
}

function parseTarget(value: unknown): ProfileTarget {
  if (!isRecord(value)) fail('target', 'target must be a YAML object with url and health')
  const url = nonEmptyString(value.url, 'target.url', 'target URL')
  const base = httpUrl(url, 'target.url', 'target URL')
  if (!isRecord(value.health)) fail('target.health', 'target.health must be a YAML object with http and timeout')
  // The health check may be a path on the target, which is the usual case.
  const http = nonEmptyString(value.health.http, 'target.health.http', 'health URL')
  let healthUrl: string
  if (http.startsWith('/')) {
    const onTarget = pathOnTarget(base.href, http)
    if (onTarget === undefined) fail('target.health.http', `the health path ${JSON.stringify(http)} climbs out of the target ${url}`)
    healthUrl = onTarget
  } else {
    healthUrl = httpUrl(http, 'target.health.http', 'health URL').href
  }
  const timeout = nonEmptyString(value.health.timeout, 'target.health.timeout', 'health timeout')
  try {
    parseDurationMs(timeout)
  } catch (error) {
    fail('target.health.timeout', error instanceof Error ? error.message : String(error))
  }
  return {
    url,
    health: { http: healthUrl, timeout },
    hosts: value.hosts === undefined ? [] : stringArray(value.hosts, 'target.hosts', 'target hosts'),
  }
}

function parseApp(value: unknown): ProfileApp {
  if (!isRecord(value)) fail('app', 'app must be a YAML object with boot, health, seed and login')
  if (!isRecord(value.boot)) fail('app.boot', 'app.boot must be a YAML object with compose and service')
  if (!isRecord(value.health)) fail('app.health', 'app.health must be a YAML object with http and timeout')
  if (!isRecord(value.seed)) fail('app.seed', 'app.seed must be a YAML object with command')
  if (!isRecord(value.login)) fail('app.login', 'app.login must be a YAML object with fixture and role')
  return {
    boot: {
      compose: nonEmptyString(value.boot.compose, 'app.boot.compose', 'compose file'),
      service: nonEmptyString(value.boot.service, 'app.boot.service', 'compose service'),
    },
    health: {
      http: nonEmptyString(value.health.http, 'app.health.http', 'health URL'),
      timeout: nonEmptyString(value.health.timeout, 'app.health.timeout', 'health timeout'),
    },
    seed: {
      command: nonEmptyString(value.seed.command, 'app.seed.command', 'seed command'),
    },
    login: parseLogin(value.login),
  }
}

const TOTP_DIGITS = [6, 7, 8]
const TOTP_ALGORITHM_VALUES = ['SHA1', 'SHA256', 'SHA512'] as const

function parseLogin(value: Record<string, unknown>): ProfileLogin {
  const login: ProfileLogin = {
    fixture: nonEmptyString(value.fixture, 'app.login.fixture', 'login fixture path'),
    role: nonEmptyString(value.role, 'app.login.role', 'login role'),
    ...(value.totp === undefined ? {} : { totp: parseLoginTotp(value.totp) }),
    ...(value.backupCode === undefined ? {} : { backupCode: parseBackupCode(value.backupCode) }),
  }
  if (login.totp === undefined && login.backupCode !== undefined)
    fail('app.login.backupCode', 'a backup code is an alternative factor, so the profile must also declare login.totp')
  return login
}

function parseLoginTotp(value: unknown): ProfileLoginTotp {
  if (!isRecord(value)) fail('app.login.totp', 'app.login.totp must be a YAML object with secret, digits, period and algorithm')
  const secret = nonEmptyString(value.secret, 'app.login.totp.secret', 'totp secret')
  const digits = value.digits === undefined ? 6 : value.digits
  if (typeof digits !== 'number' || !TOTP_DIGITS.includes(digits))
    fail('app.login.totp.digits', `totp digits must be one of ${TOTP_DIGITS.join(', ')} (got ${JSON.stringify(digits)})`)
  const period = value.period === undefined ? 30 : value.period
  if (typeof period !== 'number' || !Number.isInteger(period) || period <= 0 || period > 3600)
    fail('app.login.totp.period', 'totp period must be a whole number of seconds between 1 and 3600')
  const algorithm = value.algorithm === undefined ? 'SHA1' : value.algorithm
  if (!TOTP_ALGORITHM_VALUES.includes(algorithm as ProfileLoginTotp['algorithm']))
    fail('app.login.totp.algorithm', `totp algorithm must be one of ${TOTP_ALGORITHM_VALUES.join(', ')} (got ${JSON.stringify(algorithm)})`)
  return { secret, digits: digits as ProfileLoginTotp['digits'], period, algorithm: algorithm as ProfileLoginTotp['algorithm'] }
}

function parseBackupCode(value: unknown): { value: string } {
  if (!isRecord(value)) fail('app.login.backupCode', 'app.login.backupCode must be a YAML object with value')
  return { value: nonEmptyString(value.value, 'app.login.backupCode.value', 'backup code value') }
}

function parseStubs(value: unknown): ProfileStub[] {
  if (!Array.isArray(value)) fail('stubs', 'stubs must be an array of stub entries')
  return value.map((entry, index) => parseStub(entry, index))
}

function parseStub(value: unknown, index: number): ProfileStub {
  const base = `stubs[${index}]`
  if (!isRecord(value)) fail(base, 'stub must be a YAML object with service, hosts and provided_by')
  if (!isRecord(value.provided_by))
    fail(`${base}.provided_by`, 'stub provided_by must be a YAML object with compose_service')
  return {
    service: nonEmptyString(value.service, `${base}.service`, 'service name'),
    hosts: stringArray(value.hosts, `${base}.hosts`, 'stub hosts'),
    provided_by: {
      compose_service: nonEmptyString(
        value.provided_by.compose_service,
        `${base}.provided_by.compose_service`,
        'compose service',
      ),
    },
  }
}

function parseVisual(value: unknown): ProfileVisual {
  if (!isRecord(value)) fail('visual', 'visual must be a YAML object with widths and themes')
  return {
    widths: numberArray(value.widths, 'visual.widths', 'widths'),
    themes: stringArray(value.themes, 'visual.themes', 'themes'),
  }
}

/**
 * The profile's `a11y` section (#149): which rule set the audits run, which
 * impacts fail a check, which known violations are accepted and why, and
 * whether every flow is audited. A field nobody knows is refused, because a
 * misspelt `standing` would otherwise quietly audit nothing.
 */
function parseA11y(value: unknown): ProfileA11y {
  if (!isRecord(value)) fail('a11y', 'a11y must be a YAML object with standard, fail, accept and standing')
  for (const key of Object.keys(value))
    if (!['standard', 'fail', 'accept', 'standing'].includes(key)) fail(`a11y.${key}`, `a11y takes standard, fail, accept and standing, not ${JSON.stringify(key)}`)
  if (value.standard !== undefined && (typeof value.standard !== 'string' || !Object.hasOwn(A11Y_STANDARDS, value.standard)))
    fail('a11y.standard', `a11y.standard must be one of ${Object.keys(A11Y_STANDARDS).join(', ')}, not ${JSON.stringify(value.standard)}`)
  let impacts: A11yImpact[] | undefined
  if (value.fail !== undefined) {
    if (!Array.isArray(value.fail) || value.fail.length === 0)
      fail('a11y.fail', `a11y.fail must be a non-empty array of impacts (${A11Y_IMPACTS.join(', ')}); leave it out to fail on serious and critical`)
    impacts = value.fail.map((impact: unknown, index) => {
      if (typeof impact !== 'string' || !(A11Y_IMPACTS as readonly string[]).includes(impact))
        fail(`a11y.fail[${index}]`, `impact ${JSON.stringify(impact)} must be one of ${A11Y_IMPACTS.join(', ')}`)
      return impact as A11yImpact
    })
  }
  if (value.standing !== undefined && typeof value.standing !== 'boolean') fail('a11y.standing', 'a11y.standing must be a boolean')
  let accept: A11yAccepted[] | undefined
  if (value.accept !== undefined) {
    if (!Array.isArray(value.accept)) fail('a11y.accept', 'a11y.accept must be an array of accepted violations, each with a rule and a reason')
    accept = value.accept.map((entry: unknown, index) => {
      const base = `a11y.accept[${index}]`
      if (!isRecord(entry)) fail(base, 'an accepted violation must be a YAML object with rule and reason')
      for (const key of Object.keys(entry))
        if (!['rule', 'page', 'element', 'reason'].includes(key)) fail(`${base}.${key}`, `an accepted violation takes rule, page, element and reason, not ${JSON.stringify(key)}`)
      const rule = nonEmptyString(entry.rule, `${base}.rule`, 'rule')
      const page = entry.page === undefined ? undefined : nonEmptyString(entry.page, `${base}.page`, 'page')
      const element = entry.element === undefined ? undefined : nonEmptyString(entry.element, `${base}.element`, 'element')
      // Accepted debt names why it is carried, or it is just a switch.
      const reason = nonEmptyString(entry.reason, `${base}.reason`, 'reason')
      return { rule, ...(page === undefined ? {} : { page }), ...(element === undefined ? {} : { element }), reason }
    })
  }
  return {
    ...(value.standard === undefined ? {} : { standard: value.standard as string }),
    ...(impacts === undefined ? {} : { fail: impacts }),
    ...(value.standing === undefined ? {} : { standing: value.standing as boolean }),
    ...(accept === undefined ? {} : { accept }),
  }
}

/** A GitHub login: letters, digits and single hyphens, at most 39 characters. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/
/** A team as a mention names it: the organisation, a slash, the team's slug. */
const GITHUB_TEAM = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * The profile's `findings` section (#154). What it names is written after an
 * at sign on a public issue, so each value is held to the shape of a login
 * (or, for the fallback, a team): nothing else can ride in as a mention.
 */
function parseFindings(value: unknown): ProfileFindings {
  if (!isRecord(value)) fail('findings', 'findings must be a YAML object with fallback and bots')
  for (const key of Object.keys(value))
    if (!['fallback', 'bots'].includes(key)) fail(`findings.${key}`, `findings takes fallback and bots, not ${JSON.stringify(key)}`)
  let fallback: string | undefined
  if (value.fallback !== undefined) {
    const named = typeof value.fallback === 'string' ? value.fallback.replace(/^@/, '') : ''
    if (!GITHUB_LOGIN.test(named) && !GITHUB_TEAM.test(named))
      fail('findings.fallback', `findings.fallback must be a GitHub login ("octocat") or a team ("org/team"), not ${JSON.stringify(value.fallback)}`)
    fallback = named
  }
  let bots: string[] | undefined
  if (value.bots !== undefined) {
    if (!Array.isArray(value.bots)) fail('findings.bots', 'findings.bots must be an array of GitHub logins')
    bots = value.bots.map((entry: unknown, index) => {
      const login = typeof entry === 'string' ? entry.replace(/^@/, '') : ''
      // A bot's own login ends in [bot]; GitHub names those itself, and one may be listed here too.
      if (!GITHUB_LOGIN.test(login.replace(/\[bot\]$/, ''))) fail(`findings.bots[${index}]`, `findings.bots[${index}] must be a GitHub login, not ${JSON.stringify(entry)}`)
      return login
    })
  }
  return {
    ...(fallback === undefined ? {} : { fallback }),
    ...(bots === undefined ? {} : { bots }),
  }
}

/**
 * The profile's `ux` section (#150): whether the advisory review runs, and
 * the house rules it is given. A field nobody knows is refused, because a
 * misspelt `review` would otherwise quietly leave the review on.
 */
function parseUx(value: unknown): ProfileUx {
  if (!isRecord(value)) fail('ux', 'ux must be a YAML object with review and rules')
  for (const key of Object.keys(value))
    if (!['review', 'rules'].includes(key)) fail(`ux.${key}`, `ux takes review and rules, not ${JSON.stringify(key)}`)
  if (value.review !== undefined && typeof value.review !== 'boolean') fail('ux.review', 'ux.review must be a boolean')
  let rules: string[] | undefined
  if (value.rules !== undefined) {
    if (!Array.isArray(value.rules)) fail('ux.rules', 'ux.rules must be an array of house rules, one sentence each')
    rules = value.rules.map((rule: unknown, index) => nonEmptyString(rule, `ux.rules[${index}]`, 'house rule'))
  }
  return {
    ...(value.review === undefined ? {} : { review: value.review as boolean }),
    ...(rules === undefined ? {} : { rules }),
  }
}

function parseSuites(value: unknown): ProfileSuite[] {
  if (!Array.isArray(value)) fail('suites', 'suites must be an array of suite entries')
  return value.map((entry, index) => parseSuite(entry, index))
}

function parseSuite(value: unknown, index: number): ProfileSuite {
  const base = `suites[${index}]`
  if (!isRecord(value)) fail(base, 'suite must be a YAML object with name, command and kind')
  const kind = value.kind
  if (typeof kind !== 'string' || !SUITE_KINDS.includes(kind as ProfileSuiteKind))
    fail(`${base}.kind`, `unknown suite kind ${JSON.stringify(kind)} (expected "command", "flow" or "visual")`)
  if (value.isolated !== undefined && typeof value.isolated !== 'boolean')
    fail(`${base}.isolated`, 'isolated must be a boolean')
  return {
    name: nonEmptyString(value.name, `${base}.name`, 'name'),
    command: nonEmptyString(value.command, `${base}.command`, 'command'),
    kind: kind as ProfileSuiteKind,
    ...(value.isolated === undefined ? {} : { isolated: value.isolated as boolean }),
  }
}

function parseMail(value: unknown): ProfileMail {
  if (!isRecord(value)) fail('mail', 'mail must be a YAML object with inbox or source')
  if (value.inbox !== undefined && value.source !== undefined)
    fail('mail', 'mail names one place its messages are read from: inbox or source, not both')
  if (value.inbox === undefined && value.source === undefined)
    fail('mail', 'mail names where its messages are read from: inbox or source')
  const domain = value.domain === undefined ? {} : { domain: parseMailDomain(value.domain) }
  if (value.source === undefined) {
    const inbox = nonEmptyString(value.inbox, 'mail.inbox', 'mail inbox')
    httpUrl(inbox, 'mail.inbox', 'mail inbox')
    return { inbox, ...domain }
  }
  if (!isRecord(value.source)) fail('mail.source', 'mail.source must be a YAML object with kind and url')
  const kind = value.source.kind
  if (typeof kind !== 'string' || !(MAIL_SOURCE_KINDS as readonly string[]).includes(kind))
    fail('mail.source.kind', `unknown mail source kind ${JSON.stringify(kind)} (expected ${MAIL_SOURCE_KINDS.map((name) => JSON.stringify(name)).join(' or ')})`)
  const url = nonEmptyString(value.source.url, 'mail.source.url', 'mail source URL')
  // The URL may name run values ({{run.app_port}}), which the run substitutes
  // and validates; here each stands for a value that leaves a URL a URL.
  httpUrl(url.replace(/\{\{run\.[A-Za-z_][A-Za-z0-9_]*\}\}/g, '1'), 'mail.source.url', 'mail source URL')
  return { source: { kind: kind as MailSourceKind, url }, ...domain }
}

const MAIL_DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/

function parseMailDomain(value: unknown): string {
  // The DNS limits too: 63 characters to a label, 253 to the name.
  if (typeof value !== 'string' || !MAIL_DOMAIN.test(value) || value.length > 253 || value.split('.').some((label) => label.length > 63))
    fail('mail.domain', `mail domain ${JSON.stringify(value)} must be a lower-case host name, such as qa-mail.example.com: it is what follows the @ of every address a run mints`)
  return value
}

function validatePlaceholders(run: string, base: string): void {
  const withoutTokens = run.replace(/\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/g, '')
  if (!/[{}]/.test(withoutTokens)) return
  fail(
    base,
    `run ${JSON.stringify(run)} carries a malformed placeholder; a substitution site is a {{name}} token of letters, digits and underscores`,
  )
}

function parseCommands(value: unknown): Record<string, ProfileCommand> {
  if (!isRecord(value)) fail('commands', 'commands must be a YAML object of named commands')
  const commands = Object.create(null) as Record<string, ProfileCommand>
  for (const [name, entry] of Object.entries(value)) {
    const base = `commands.${name}`
    if (isUnsafeProfileName(name))
      fail(base, `command name ${JSON.stringify(name)} must not carry a separator, ".." or a control character`)
    if (!isRecord(entry)) fail(base, 'a declared command must be a YAML object with run and about')
    const run = nonEmptyString(entry.run, `${base}.run`, 'run')
    const character = shellCharacter(run)
    if (character !== undefined)
      fail(
        base,
        `run ${JSON.stringify(run)} carries ${JSON.stringify(character)}, which a shell would interpret: the command is split on whitespace and spawned with no shell`,
      )
    validatePlaceholders(run, base)
    for (const token of run.split(/\s+/)) {
      const placeholders = token.match(/\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/g)
      if (placeholders !== null && placeholders.length > 1)
        fail(
          base,
          `run ${JSON.stringify(run)} carries more than one placeholder in a token: at most one placeholder per whitespace-separated token`,
        )
    }
    const program = run.split(/\s+/).find((token) => token !== '')
    if (program !== undefined && (program.startsWith('{{') || program.includes('=')))
      fail(
        base,
        `run ${JSON.stringify(run)} must name its program itself: the command is split on whitespace and its first token is the program a check spawns, so a placeholder or an assignment cannot be the program`,
      )
    if (program !== undefined && SHELL_BUILTINS.has(program))
      fail(
        base,
        `run ${JSON.stringify(run)} starts with ${JSON.stringify(program)}, which a shell interprets and the runner cannot spawn: name the program that runs`,
      )
    const about = nonEmptyString(entry.about, `${base}.about`, 'about')
    const filter = entry.filter === undefined ? undefined : nonEmptyString(entry.filter, `${base}.filter`, 'filter')
    const report = entry.report === undefined ? undefined : nonEmptyString(entry.report, `${base}.report`, 'report')
    if (filter === undefined && report === undefined) {
      commands[name] = { run, about }
      continue
    }
    if (filter === undefined)
      fail(
        base,
        `report ${JSON.stringify(report)} needs a filter to verify: name the placeholder whose filled token is the test filter`,
      )
    if (report === undefined)
      fail(
        base,
        `filter ${JSON.stringify(filter)} needs a report to read: declare the machine-readable format the command prints`,
      )
    if (!run.includes(`{{${filter}}}`))
      fail(base, `filter ${JSON.stringify(filter)} must name a placeholder of run, which carries no {{${filter}}}`)
    if (!REPORT_FORMATS.includes(report as ReportFormat))
      fail(
        base,
        `report ${JSON.stringify(report)} must be one of the formats the runner reads: ${REPORT_FORMATS.join(', ')}`,
      )
    commands[name] = { run, about, filter, report: report as ReportFormat }
  }
  return commands
}

/**
 * Words a shell interprets as builtins, which the runner carries no binary
 * for: a declared command naming one would fail to spawn, the exact failure
 * the declared commands exist to prevent.
 */
const SHELL_BUILTINS = new Set([
  'alias',
  'cd',
  'eval',
  'exec',
  'export',
  'logout',
  'read',
  'set',
  'shift',
  'source',
  'times',
  'trap',
  'type',
  'ulimit',
  'umask',
  'wait',
])

function parseRedact(value: unknown): ProfileRedaction {
  if (!isRecord(value)) fail('redact', 'redact must be a YAML object with values, patterns and/or masks')
  const redact: ProfileRedaction = {
    ...(value.values === undefined ? {} : { values: stringArray(value.values, 'redact.values', 'redact values') }),
    ...(value.patterns === undefined
      ? {}
      : { patterns: stringArray(value.patterns, 'redact.patterns', 'redact patterns') }),
    ...(value.masks === undefined ? {} : { masks: stringArray(value.masks, 'redact.masks', 'redact masks') }),
  }
  // Compiled here so a bad pattern stops the profile loading, not the upload
  // at the end of a run. A mask selector that does not parse fails the same
  // way: a screenshot a mask cannot resolve would publish unmasked.
  try {
    redactionRules(redact)
    validateMaskSelectors(redact.masks)
  } catch (error) {
    if (error instanceof RedactionError) fail('redact', error.message)
    throw error
  }
  return redact
}

const MCP_STEPS: McpStep[] = ['plan', 'execute']

/**
 * The host's registered MCP servers (#93). A server that needs a credential
 * declares so by name, and the profile refuses to place it in the execute
 * step, which runs pull request code: the refusal names the reason, so the
 * mistake is a profile mistake, not a run-time surprise.
 */
function parseMcp(value: unknown): ProfileMcpServer[] {
  if (!Array.isArray(value)) fail('mcp', 'mcp must be an array of host tool server entries')
  const seen: string[] = []
  const servers = value.map((entry, index) => {
    const base = `mcp[${index}]`
    if (!isRecord(entry)) fail(base, 'a host tool server must be a YAML object with name, command or url, tools and steps')
    const name = nonEmptyString(entry.name, `${base}.name`, 'name')
    if (isUnsafeProfileName(name))
      fail(base, `server name ${JSON.stringify(name)} must not carry a separator, ".." or a control character: it names the tools on the channel and the evidence records`)
    if (seen.includes(name)) fail(base, `a server named ${JSON.stringify(name)} is already registered`)
    seen.push(name)
    if (entry.command !== undefined && entry.url !== undefined)
      fail(base, 'a server names one of command (start it) or url (reach it), not both')
    if (entry.command === undefined && entry.url === undefined)
      fail(base, 'a server must say how to start or reach it: name command or url')
    let command: string | undefined
    if (entry.command !== undefined) {
      command = nonEmptyString(entry.command, `${base}.command`, 'command')
      const character = shellCharacter(command)
      if (character !== undefined)
        fail(
          base,
          `command ${JSON.stringify(command)} carries ${JSON.stringify(character)}, which a shell would interpret: the command is split on whitespace and spawned with no shell`,
        )
    }
    let url: string | undefined
    if (entry.url !== undefined) {
      url = nonEmptyString(entry.url, `${base}.url`, 'url')
      httpUrl(url, base, 'url')
      const parsed = new URL(url)
      if (parsed.username !== '' || parsed.password !== '')
        fail(
          base,
          `url ${JSON.stringify(url)} carries userinfo, which the server is never reached with: put the secret in the credential store and name it, or serve the MCP endpoint without basic auth`,
        )
    }
    const tools = stringArray(entry.tools, `${base}.tools`, 'tools')
    if (tools.length === 0)
      fail(`${base}.tools`, 'a server must allow at least one tool: an empty allowlist registers nothing')
    for (const tool of tools) {
      if (tool.includes(',') || /[\x00-\x1f\x7f]/.test(tool))
        fail(
          `${base}.tools`,
          `tool name ${JSON.stringify(tool)} must not carry the channel's comma delimiter or a control character: the allowlist reaches the model session comma-separated`,
        )
    }
    const steps: McpStep[] = stringArray(entry.steps, `${base}.steps`, 'steps').map((step, stepIndex) => {
      if (!MCP_STEPS.includes(step as McpStep))
        fail(`${base}.steps[${stepIndex}]`, `unknown step ${JSON.stringify(step)} (expected "plan", "execute")`)
      return step as McpStep
    })
    if (steps.length === 0) fail(`${base}.steps`, 'a server must name the steps it may run in')
    const credential =
      entry.credential === undefined ? undefined : nonEmptyString(entry.credential, `${base}.credential`, 'credential')
    if (credential !== undefined && steps.includes('execute'))
      fail(
        `${base}.steps`,
        `a server that needs the credential ${JSON.stringify(credential)} cannot run in the execute step: the execute step runs pull request code, which must never hold it`,
      )
    const driver = entry.driver === undefined ? undefined : parseMcpDriver(entry.driver, base, tools)
    if (driver !== undefined && !steps.includes('execute'))
      fail(
        `${base}.driver`,
        'a server that drives the flow runs its checks in the execute step, which this entry is not allowed to run in',
     )
    return {
      name,
      ...(command !== undefined ? { command } : { url }),
      tools,
      steps,
      ...(credential === undefined ? {} : { credential }),
      ...(driver === undefined ? {} : { driver }),
    }
  })
  // Two servers whose names and tools build the same channel name (server "a"
  // with tool "b.c" against server "a.b" with tool "c") would leave one of the
  // two unreachable: the profile is refused, by name, before anything starts.
  const routes = new Set<string>()
  for (const server of servers)
    for (const tool of server.tools) {
      const route = channelToolName(server.name, tool)
      if (routes.has(route))
        fail(
          'mcp',
          `the channel names ${JSON.stringify(route)} twice: server tools cannot share one name, so rename a server or a tool`,
        )
      routes.add(route)
    }
  const drivers = servers.filter((server) => server.driver !== undefined)
  if (drivers.length > 1) fail('mcp', 'one server at most may carry a driver mapping: the flow is driven by one host, not two')
  return servers
}

/**
 * The driver mapping on one server entry (#94): each intent must be one the
 * harness carries, and every argument the intent carries must be bound to a
 * tool argument, so the mapping is the driver's capability declaration and
 * nothing is guessed when a step runs. A mapped tool must be on the entry's
 * allowlist, or the plan could reach a tool the profile never published.
 */
function parseMcpDriver(
  value: unknown,
  base: string,
  allowed: readonly string[],
): Record<string, ProfileMcpToolMap> {
  if (!isRecord(value) || Object.keys(value).length === 0)
    fail(`${base}.driver`, `${base}.driver must be a YAML object mapping flow intents to host tools, and cannot be empty`)
  const driver: Record<string, ProfileMcpToolMap> = {}
  for (const [intent, entry] of Object.entries(value)) {
    const intentBase = `${base}.driver.${intent}`
    const slots = MCP_DRIVER_INTENTS[intent]?.slots
    if (slots === undefined)
      fail(
        `${intentBase}`,
        `${JSON.stringify(intent)} is not a flow intent the driver can map; map one of ${Object.keys(MCP_DRIVER_INTENTS).join(', ')}`,
      )
    if (!isRecord(entry)) fail(intentBase, `${intentBase} must be a YAML object with tool, and the arguments its tool takes`)
    const tool = nonEmptyString(entry.tool, `${intentBase}.tool`, 'tool name')
    if (!allowed.includes(tool))
      fail(
        `${intentBase}.tool`,
        `the tool ${JSON.stringify(tool)} the ${intent} mapping drives is not on the server's allowlist, so the plan could never reach it`,
      )
    const args: Record<string, string> = {}
    for (const [arg, slot] of Object.entries(entry.args ?? {})) {
      if (arg === '') fail(`${intentBase}.args`, `${intentBase}.args cannot carry an empty argument name`)
      if (typeof slot !== 'string' || !slots.includes(slot))
        fail(
          `${intentBase}.args.${arg}`,
          `${intentBase}.args.${arg} must be one of the action fields the ${intent} intent carries: ${slots.join(', ')}`,
        )
      args[arg] = slot
    }
    const bound = new Set(Object.values(args))
    const missing = slots.filter((slot) => !bound.has(slot))
    if (missing.length > 0)
      fail(
        intentBase,
        `the ${intent} mapping binds no tool argument to ${missing.join(', ')}, which the intent carries`,
      )
    driver[intent] = { tool, ...(Object.keys(args).length > 0 ? { args } : {}) }
  }
  return driver
}

