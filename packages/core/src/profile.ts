import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { parseDurationMs } from './duration.js'
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
}

export interface QaProfile {
  /** The boot recipe; absent when the profile names a target instead. */
  app?: ProfileApp
  /** A running app to check in place of booting one (#122); exclusive with app. */
  target?: ProfileTarget
  stubs: ProfileStub[]
  visual: ProfileVisual
  suites: ProfileSuite[]
  /** Where the harness reads the mail a check waits for (#67). */
  mail?: ProfileMail
  /** Fixture data that must not be published in evidence (#52). */
  redact?: ProfileRedaction
}

export interface ProfileMail {
  inbox: string
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

async function requireDirectory(dirPath: string, field: string, label: string): Promise<void> {
  const info = await stat(dirPath).catch(() => undefined)
  if (!info) missing(field, `${label} is required but missing at ${dirPath}`)
  if (!info.isDirectory()) fail(field, `${label} must be a directory, but ${dirPath} is not`)
}

export async function loadProfile(dir: string): Promise<QaProfile> {
  await requireFile(join(dir, 'QA.md'), 'QA.md', 'the .qa/ profile instructions')

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
    await requireDirectory(join(dir, 'fixtures'), 'fixtures', 'the .qa/ fixtures directory')
    await requireDirectory(join(dir, 'stubs'), 'stubs', 'the .qa/ stubs directory')
  }
  return profile
}

export function validateProfileConfig(config: unknown): QaProfile {
  if (!isRecord(config))
    fail('config.yml', 'config.yml must be a YAML object with app, stubs, visual and suites, or with target')
  if (config.target !== undefined) return validateTargetConfig(config)
  return {
    app: parseApp(config.app),
    stubs: parseStubs(config.stubs),
    visual: parseVisual(config.visual),
    suites: parseSuites(config.suites),
    ...(config.mail === undefined ? {} : { mail: parseMail(config.mail) }),
    ...(config.redact === undefined ? {} : { redact: parseRedact(config.redact) }),
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
  return {
    target: parseTarget(config.target),
    stubs: [],
    visual: config.visual === undefined ? { widths: [], themes: [] } : parseVisual(config.visual),
    suites: config.suites === undefined ? [] : parseSuites(config.suites),
    ...(config.mail === undefined ? {} : { mail: parseMail(config.mail) }),
    ...(config.redact === undefined ? {} : { redact: parseRedact(config.redact) }),
  }
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
  return {
    name: nonEmptyString(value.name, `${base}.name`, 'name'),
    command: nonEmptyString(value.command, `${base}.command`, 'command'),
    kind: kind as ProfileSuiteKind,
  }
}

function parseMail(value: unknown): ProfileMail {
  if (!isRecord(value)) fail('mail', 'mail must be a YAML object with inbox')
  const inbox = nonEmptyString(value.inbox, 'mail.inbox', 'mail inbox')
  httpUrl(inbox, 'mail.inbox', 'mail inbox')
  return { inbox }
}

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
