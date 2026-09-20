import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

export interface ProfileApp {
  boot: { compose: string; service: string }
  health: { http: string; timeout: string }
  seed: { command: string }
  login: { fixture: string; role: string }
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
  app: ProfileApp
  stubs: ProfileStub[]
  visual: ProfileVisual
  suites: ProfileSuite[]
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

function fail(field: string, message: string): never {
  throw new ProfileValidationError(field, message)
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
  if (!info) fail(field, `${label} is required but missing at ${filePath}`)
  if (!info.isFile()) fail(field, `${label} must be a file, but ${filePath} is not`)
}

async function requireDirectory(dirPath: string, field: string, label: string): Promise<void> {
  const info = await stat(dirPath).catch(() => undefined)
  if (!info) fail(field, `${label} is required but missing at ${dirPath}`)
  if (!info.isDirectory()) fail(field, `${label} must be a directory, but ${dirPath} is not`)
}

export async function loadProfile(dir: string): Promise<QaProfile> {
  await requireFile(join(dir, 'QA.md'), 'QA.md', 'the .qa/ profile instructions')
  await requireDirectory(join(dir, 'fixtures'), 'fixtures', 'the .qa/ fixtures directory')
  await requireDirectory(join(dir, 'stubs'), 'stubs', 'the .qa/ stubs directory')

  const configPath = join(dir, 'config.yml')
  let text: string
  try {
    text = await readFile(configPath, 'utf8')
  } catch (error) {
    throw new ProfileValidationError(
      'config.yml',
      `config.yml is required in the .qa/ profile at ${dir} (${error instanceof Error ? error.message : String(error)})`,
    )
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
  return validateProfileConfig(input)
}

export function validateProfileConfig(config: unknown): QaProfile {
  if (!isRecord(config))
    fail('config.yml', 'config.yml must be a YAML object with app, stubs, visual and suites')
  return {
    app: parseApp(config.app),
    stubs: parseStubs(config.stubs),
    visual: parseVisual(config.visual),
    suites: parseSuites(config.suites),
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
    login: {
      fixture: nonEmptyString(value.login.fixture, 'app.login.fixture', 'login fixture path'),
      role: nonEmptyString(value.login.role, 'app.login.role', 'login role'),
    },
  }
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
