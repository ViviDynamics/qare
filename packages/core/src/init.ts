import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { ProfileValidationError, validateProfileConfig } from './profile.js'
import { INIT_PLACEHOLDER, readinessInventory, type ReadinessInventory } from './readiness.js'
import { VERSION } from './version.js'

/**
 * `qare init` (#146): the readiness inventory, turned into a starting `.qa/`
 * and the caller workflow for the reusable pipeline (#145).
 *
 * This module decides what the files say and writes nothing. What it cannot
 * know (what the app is, how QA signs in, what seeds the data) it leaves as
 * `TODO(qare init):` lines, which readiness reports as gaps until a person
 * replaces them, so a skeleton never reads as a finished profile.
 */

export const INIT_WORKFLOW_PATH = '.github/workflows/qare.yml'
/** The reusable pipeline a caller names in `uses:`, before the release tag. */
export const PIPELINE_WORKFLOW = 'ViviDynamics/qare/.github/workflows/pipeline.yml'
export const INIT_DEFAULT_MODEL = 'gpt-4.1-mini'
/** The repository secret the generated caller reads the model key from. */
export const INIT_MODEL_SECRET = 'OPENAI_API_KEY'

export class InitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InitError'
  }
}

export interface InitOptions {
  /** A running app to check; makes a target profile whatever compose files exist. */
  target?: string
  /**
   * The path the health check asks for, which must answer 200. Without it a
   * booted profile takes the path of the service's own healthcheck, and a
   * target profile takes "/" and asks a person to confirm it.
   */
  health?: string
  /** The compose service that is the application, when init's choice is wrong. */
  service?: string
  /** The model the pipeline asks, as the provider names it. */
  model?: string
  /** The branch whose pushes re-queue refused pull requests. */
  defaultBranch?: string
}

export interface InitFile {
  /** Repo-relative, with "/" separators. */
  path: string
  content: string
}

export interface InitPlan {
  kind: 'app' | 'target'
  /** The files of `.qa/`, config.yml first. */
  profile: InitFile[]
  workflow: InitFile
  /** The repository secret the workflow reads the model key from. */
  secret: string
  /** The inventory the plan was drawn from, before anything is written. */
  inventory: ReadinessInventory
}

interface ComposeService {
  name: string
  build: boolean
  hostPort?: string
  healthPath?: string
  /** The scheme the service's own healthcheck asks with; http when it names none. */
  healthScheme?: string
}

export async function planInit(repoPath: string, opts: InitOptions = {}): Promise<InitPlan> {
  const inventory = await readinessInventory(repoPath)
  const suites = await recogniseSuites(inventory.repoPath)
  const model = opts.model ?? INIT_DEFAULT_MODEL
  if (opts.health !== undefined && !/^\/[^\s"\\]*$/.test(opts.health))
    throw new InitError(`--health ${JSON.stringify(opts.health)} is not a path: it starts with "/" and carries no space or quote`)

  let kind: InitPlan['kind']
  let config: string
  // A target profile that is already there says where the app runs, so a
  // repository that only lacks the workflow needs no flag.
  // It holds whatever compose files lie beside it: a compose file kept for
  // local development does not turn a target repository into a booted one.
  const target = opts.target ?? inventory.profile.target?.url
  if (target !== undefined) {
    kind = 'target'
    config = targetConfig(target, opts.health, suites)
  } else {
    // A profile that is already there may boot from a file the inventory
    // does not look for (compose.qa.yaml): its own word on the file and the
    // service comes first, so such a repository can still get its workflow.
    const booted = inventory.profile.boot
    const own = booted !== undefined && (await exists(join(inventory.repoPath, booted.compose), 'file')) ? booted : undefined
    const compose = own === undefined ? inventory.boot[0]?.file : `./${own.compose.replace(/^\.\//, '')}`
    if (compose === undefined)
      throw new InitError(
        'no compose file found, so there is nothing for qare to boot: name the running app to check with --target <url>',
      )
    kind = 'app'
    const service = await chooseService(inventory.repoPath, compose, opts.service ?? own?.service)
    config = appConfig({ ...service, ...(opts.health === undefined ? {} : { healthPath: opts.health }) }, compose, inventory, suites)
  }

  // Fail closed: a profile init would write is one the loader accepts.
  try {
    validateProfileConfig(parseYaml(config))
  } catch (error) {
    if (error instanceof ProfileValidationError) throw new InitError(`the profile init would write does not load: ${error.message}`)
    throw error
  }

  const profile: InitFile[] = [
    { path: '.qa/config.yml', content: config },
    { path: '.qa/QA.md', content: QA_SKELETON },
  ]
  if (kind === 'app') {
    profile.push({ path: '.qa/fixtures/users.yml', content: FIXTURE_SKELETON })
    profile.push({ path: '.qa/stubs/.gitkeep', content: '' })
  }
  return {
    kind,
    profile,
    workflow: {
      path: INIT_WORKFLOW_PATH,
      // Re-queueing is for pull requests refused for want of a stub, and
      // only a booted profile has stubs.
      content: callerWorkflow({ model, ...(kind === 'app' ? { requeue: { branch: opts.defaultBranch ?? 'main' } } : {}) }),
    },
    secret: INIT_MODEL_SECRET,
    inventory,
  }
}

/**
 * The caller of the reusable pipeline, as docs/pipeline.md shows it. The pin
 * is this build's own release, which scripts/sync-version.mjs stamps, so the
 * workflow init writes always names the pipeline of the qare that wrote it.
 */
export function callerWorkflow(opts: { model: string; requeue?: { branch: string } }): string {
  // Both values land in a workflow file: neither may be YAML of its own.
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(opts.model))
    throw new InitError(`--model ${JSON.stringify(opts.model)} is not a model name: letters, digits and . _ : / @ - only`)
  if (opts.requeue !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(opts.requeue.branch))
    throw new InitError(`${JSON.stringify(opts.requeue.branch)} is not a branch name init can write into a workflow`)
  return [
    'name: QARE',
    'on:',
    '  pull_request:',
    ...(opts.requeue === undefined ? [] : ['  push:', `    branches: [${yamlString(opts.requeue.branch)}]`, "    paths: ['.qa/**']"]),
    'jobs:',
    '  qare:',
    '    permissions:',
    '      actions: read',
    '      checks: write',
    '      contents: write',
    '      issues: write',
    '      pull-requests: write',
    `    uses: ${PIPELINE_WORKFLOW}@${VERSION}`,
    '    with:',
    `      nare-model: ${yamlString(opts.model)}`,
    '    secrets:',
    `      model-key: \${{ secrets.${INIT_MODEL_SECRET} }}`,
    '',
  ].join('\n')
}

/**
 * A value as a YAML string. A branch or a model may be named `true`, `null`
 * or `123`, which a bare scalar would read as something else; those are
 * quoted, and every other name is written as a person would write it.
 */
function yamlString(value: string): string {
  return parseYaml(value) === value ? value : JSON.stringify(value)
}

const HEADER = [
  '# The starting profile `qare init` wrote. Every TODO(qare init) line is',
  '# something only you know; `qare readiness` lists the ones still open.',
]

function targetConfig(url: string, health: string | undefined, suites: Suite[]): string {
  return [
    ...HEADER,
    '#',
    '# A target profile checks an app that is already running: qare boots',
    '# nothing and stubs nothing. Every host a flow reaches must be the',
    "# target's own or listed in hosts; anything else refuses the run.",
    'target:',
    `  url: ${JSON.stringify(url)}`,
    // The probe passes on 200 alone, and many roots answer with a redirect.
    ...(health === undefined
      ? [`  # ${INIT_PLACEHOLDER} confirm the health path answers 200 when the app is up (a redirect does not pass), then remove this line`]
      : []),
    `  health: { http: ${JSON.stringify(health ?? '/')}, timeout: 30s }`,
    '  hosts: []',
    '# The image the checks run in: web carries the browser the flows drive.',
    'flavour: web',
    ...suiteLines(suites, false),
    '',
  ].join('\n')
}

function appConfig(service: ComposeService, composeLabel: string, inventory: ReadinessInventory, suites: Suite[]): string {
  const compose = composeLabel.replace(/^\.\//, '')
  const guessed = service.hostPort === undefined
  const health = `${service.healthScheme ?? 'http'}://localhost:${service.hostPort ?? '3000'}${service.healthPath ?? '/'}`
  const hosts = [...new Set(inventory.origins.map((hit) => hit.origin.slice(hit.origin.indexOf('://') + 3).replace(/:\d+$/, '')))].sort()
  return [
    ...HEADER,
    'app:',
    `  boot: { compose: ${JSON.stringify(compose)}, service: ${JSON.stringify(service.name)} }`,
    ...(guessed
      ? [
          `  # ${INIT_PLACEHOLDER} the service ${JSON.stringify(service.name)} publishes no port: publish one, and correct the health URL`,
        ]
      : []),
    `  health: { http: ${JSON.stringify(health)}, timeout: 120s }`,
    `  # ${INIT_PLACEHOLDER} name the command that seeds the QA data, in place of "true"`,
    '  seed: { command: "true" }',
    `  # ${INIT_PLACEHOLDER} describe the user QA signs in as in .qa/fixtures/users.yml, and name its role here`,
    '  login: { fixture: fixtures/users.yml, role: admin }',
    '# One stub per outbound origin the scan read in the repository. The scan',
    '# reads every URL, so remove the ones the app never calls at runtime. Each',
    '# stub left needs the compose service it names, answering as that host.',
    ...(hosts.length === 0
      ? ['stubs: []']
      : [
          'stubs:',
          ...hosts.flatMap((host) => {
            const name = stubServiceName(host)
            return [`  - service: ${name}`, `    hosts: [${JSON.stringify(host)}]`, `    provided_by: { compose_service: ${name}-stub }`]
          }),
        ]),
    'visual:',
    '  widths: [1440, 390]',
    '  themes: [light]',
    '# The image the checks run in: web carries the browser the flows drive.',
    'flavour: web',
    ...suiteLines(suites, true),
    '',
  ].join('\n')
}

/** A stub is named for its whole host, so two hosts never share a name. */
function stubServiceName(host: string): string {
  return host.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'stub'
}

interface Suite {
  name: string
  command: string
}

function suiteLines(suites: Suite[], required: boolean): string[] {
  if (suites.length === 0) return required ? ['suites: []'] : []
  return [
    'suites:',
    ...suites.map((suite) => `  - { name: ${suite.name}, command: ${JSON.stringify(suite.command)}, kind: command }`),
  ]
}

const QA_SKELETON = [
  '# QA profile',
  '',
  'The planner reads this file before it plans a check. Replace each TODO',
  'with what is true of this app; `qare readiness` lists the ones still open.',
  '',
  `${INIT_PLACEHOLDER} say what this app is, in a sentence or two`,
  '',
  `${INIT_PLACEHOLDER} say what matters most, so the planner knows what a regression would cost`,
  '',
  `${INIT_PLACEHOLDER} list the pages the flow and visual checks should cover`,
  '',
  `${INIT_PLACEHOLDER} say how to sign in, or that there is no login`,
  '',
].join('\n')

const FIXTURE_SKELETON = [
  '# The users the seed step creates for QA. app.login in config.yml names',
  '# the one QA signs in as, by role. Use values that exist only in QA.',
  'admin:',
  '  email: admin@qa.example',
  '  role: admin',
  '',
].join('\n')

async function exists(path: string, kind: 'file' | 'dir'): Promise<boolean> {
  const info = await stat(path).catch(() => undefined)
  return info !== undefined && (kind === 'file' ? info.isFile() : info.isDirectory())
}

/** The suites init knows by the files they leave in a repository. */
async function recogniseSuites(repo: string): Promise<Suite[]> {
  const suites: Suite[] = []
  if (await hasFeatureFile(join(repo, 'features'), 3))
    suites.push({ name: 'cucumber', command: (await exists(join(repo, 'Gemfile'), 'file')) ? 'bundle exec cucumber' : 'npx cucumber-js' })
  for (const extension of ['ts', 'js', 'mjs', 'cjs']) {
    if (!(await exists(join(repo, `playwright.config.${extension}`), 'file'))) continue
    suites.push({ name: 'playwright', command: 'npx playwright test' })
    break
  }
  if (await exists(join(repo, 'spec', 'system'), 'dir')) suites.push({ name: 'rspec-system', command: 'bundle exec rspec spec/system' })
  return suites
}

async function hasFeatureFile(dir: string, depth: number): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.feature')) return true
    if (entry.isDirectory() && depth > 1 && (await hasFeatureFile(join(dir, entry.name), depth - 1))) return true
  }
  return false
}

/**
 * The service that is the application: the one named, else the first built
 * from the repository, else the first that publishes a port, else the first
 * by name. A database beside the app has an image and no build.
 */
async function chooseService(repo: string, composeLabel: string, named: string | undefined): Promise<ComposeService> {
  const services = composeServices(await readFile(join(repo, composeLabel), 'utf8'))
  if (services.length === 0) throw new InitError(`${composeLabel} defines no services, so there is nothing for qare to boot`)
  if (named !== undefined) {
    const service = services.find((candidate) => candidate.name === named)
    if (service === undefined)
      throw new InitError(
        `--service ${JSON.stringify(named)} is not a service of ${composeLabel} (it defines ${services.map((candidate) => candidate.name).join(', ')})`,
      )
    return service
  }
  return (
    services.find((service) => service.build && service.hostPort !== undefined) ??
    services.find((service) => service.build) ??
    services.find((service) => service.hostPort !== undefined) ??
    (services[0] as ComposeService)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The inventory already parsed this file, so it is a mapping with services. */
function composeServices(text: string): ComposeService[] {
  const doc: unknown = parseYaml(text)
  const services = isRecord(doc) && isRecord(doc.services) ? doc.services : {}
  return Object.entries(services)
    .map(([name, raw]) => {
      const record = isRecord(raw) ? raw : {}
      const hostPort = Array.isArray(record.ports) ? record.ports.map(publishedPort).find((port) => port !== undefined) : undefined
      const health = healthOf(record.healthcheck)
      return {
        name,
        build: record.build !== undefined && record.build !== null,
        ...(hostPort === undefined ? {} : { hostPort }),
        ...(health === undefined ? {} : { healthPath: health.path, healthScheme: health.scheme }),
      }
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * The host side of a compose port entry: `8080:3000`, `127.0.0.1:8080:3000`,
 * `${QARE_APP_PORT:-8080}:3000` (the default is the port), or the long form's
 * `published`. An entry with no host side publishes on a port nobody chose.
 */
function publishedPort(entry: unknown): string | undefined {
  if (isRecord(entry)) return /^\d+$/.test(String(entry.published ?? '')) ? String(entry.published) : undefined
  if (typeof entry !== 'string' && typeof entry !== 'number') return undefined
  const text = String(entry)
    .replace(/\$\{[^}:]*:-(\d+)\}/g, '$1')
    .replace(/\/\w+$/, '')
  const parts = text.split(':')
  const host = parts.length >= 2 ? parts[parts.length - 2] : undefined
  const first = host?.split('-')[0]
  return first !== undefined && /^\d+$/.test(first) ? first : undefined
}

/** The scheme and path the service's own healthcheck asks with, when it names a URL. */
function healthOf(healthcheck: unknown): { scheme: string; path: string } | undefined {
  if (!isRecord(healthcheck)) return undefined
  const test = Array.isArray(healthcheck.test) ? healthcheck.test.map(String).join(' ') : String(healthcheck.test ?? '')
  const match = /https?:\/\/[^\s"'|;&)]+/.exec(test)
  if (match === null) return undefined
  try {
    const url = new URL(match[0])
    return { scheme: url.protocol.replace(/:$/, ''), path: `${url.pathname}${url.search}` }
  } catch {
    return undefined
  }
}
