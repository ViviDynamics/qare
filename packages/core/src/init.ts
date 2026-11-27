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
  /** `client` is a profile that is already there and names a build to launch (#75): init writes its workflow and no profile. */
  kind: 'app' | 'target' | 'client'
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
  /** The host port the service publishes the app on, as the compose file's default names it. */
  hostPort?: string
  /** The port inside the container the published port leads to. */
  containerPort?: string
  /** True when the published port is the one the run hands compose as QARE_APP_PORT. */
  runPort: boolean
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

  // A client profile that is already there says what the run launches (#75).
  // It is written by hand, so init leaves it as it is and writes only the
  // workflow, whatever compose file lies beside it. Nothing is stubbed for a
  // client, so nothing is re-queued for want of a stub.
  if (opts.target === undefined && inventory.profile.client !== undefined)
    return {
      kind: 'client',
      profile: [],
      workflow: { path: INIT_WORKFLOW_PATH, content: callerWorkflow({ model }) },
      secret: INIT_MODEL_SECRET,
      inventory,
    }

  let kind: InitPlan['kind']
  let config: string
  // A command boot has no stubs (#379): no stubs directory, and nothing to re-queue for want of one.
  let commandBooted = false
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
    // With no compose file to boot from, a start script is booted by
    // command instead (#379), or the command a profile already names.
    const started = compose === undefined ? (inventory.profile.commandBoot ?? (await startCommand(inventory.repoPath))) : undefined
    if (compose === undefined && started === undefined)
      throw new InitError(
        'no compose file found and no start script, so there is nothing for qare to boot: name the running app to check with --target <url>; a desktop build is checked through a client profile, which is written by hand (docs/SPEC.md, Clients)',
      )
    kind = 'app'
    if (started !== undefined) {
      if (opts.service !== undefined)
        throw new InitError(`--service ${JSON.stringify(opts.service)} names a compose service, and the repository has no compose file: the app is booted by its start command`)
      commandBooted = true
      config = commandConfig(started, inventory.profile.commandBoot !== undefined, opts.health, suites)
    } else {
      const service = await chooseService(inventory.repoPath, compose as string, opts.service ?? own?.service)
      config = appConfig({ ...service, ...(opts.health === undefined ? {} : { healthPath: opts.health }) }, compose as string, inventory, suites)
    }
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
    // No stubs directory (#416): every stub is a compose service config.yml names.
    profile.push({ path: '.qa/fixtures/users.yml', content: FIXTURE_SKELETON })
  }
  return {
    kind,
    profile,
    workflow: {
      path: INIT_WORKFLOW_PATH,
      // Re-queueing is for pull requests refused for want of a stub, and
      // only a booted profile has stubs.
      content: callerWorkflow({ model, ...(kind === 'app' && !commandBooted ? { requeue: { branch: opts.defaultBranch ?? 'main' } } : {}) }),
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
    // A newer push supersedes the run of the older one, which would
    // otherwise run to the end and be paid for (#374).
    'concurrency:',
    '  group: qare-${{ github.event.pull_request.number || github.ref }}',
    '  cancel-in-progress: true',
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
    // Nothing is booted beside a target, so its suites run where the run does.
    ...suiteLines(suites, false),
    '',
  ].join('\n')
}

function appConfig(service: ComposeService, composeLabel: string, inventory: ReadinessInventory, suites: Suite[]): string {
  const compose = composeLabel.replace(/^\.\//, '')
  // Each run publishes the app on a port it allocates and hands compose as
  // QARE_APP_PORT (#53), so the health URL names that port and no number.
  const health = `${service.healthScheme ?? 'http'}://localhost:{{run.app_port}}${service.healthPath ?? '/'}`
  const exec = `docker compose -p qare-{{run.id}} -f ${shellWord(compose)} exec -T ${shellWord(service.name)}`
  const hosts = [...new Set(inventory.origins.map((hit) => hit.origin.slice(hit.origin.indexOf('://') + 3).replace(/:\d+$/, '')))].sort()
  return [
    ...HEADER,
    'app:',
    `  boot: { compose: ${JSON.stringify(compose)}, service: ${JSON.stringify(service.name)} }`,
    ...(service.runPort ? [] : [`  # ${INIT_PLACEHOLDER} ${portChange(service, compose)}`]),
    `  health: { http: ${JSON.stringify(health)}, timeout: 120s }`,
    `  # ${INIT_PLACEHOLDER} name the command that seeds the QA data, in place of "true"`,
    '  # qare runs it once the app is healthy, before any check, from the runner. A',
    `  # seed inside the service: ${exec} <command>`,
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
    // The run image has none of the app's runtime, so a suite runs inside
    // the booted service, where its dependencies and the stack's hostnames are.
    ...suiteLines(
      suites.map((suite) => ({ ...suite, command: `${exec} ${suite.command}` })),
      true,
    ),
    '',
  ].join('\n')
}

/** A start command, the image it runs in and the port it listens on (#379). */
interface StartCommand {
  command: string
  image: string
  port: number
}

/**
 * The start script a repository runs with, when it has one init knows:
 * package.json's `start`, run with the package manager its lockfile names,
 * after installing, since the image is a stock one that holds no
 * dependencies. The image and the port are guesses a person confirms.
 */
async function startCommand(repo: string): Promise<StartCommand | undefined> {
  let manifest: unknown
  try {
    manifest = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
  const scripts = isRecord(manifest) && isRecord(manifest.scripts) ? manifest.scripts : {}
  if (typeof scripts.start !== 'string' || scripts.start.trim() === '') return undefined
  const command = (await exists(join(repo, 'pnpm-lock.yaml'), 'file'))
    ? 'corepack enable && pnpm install --frozen-lockfile && pnpm start'
    : (await exists(join(repo, 'yarn.lock'), 'file'))
      ? 'corepack enable && yarn install --frozen-lockfile && yarn start'
      : (await exists(join(repo, 'package-lock.json'), 'file')) || (await exists(join(repo, 'npm-shrinkwrap.json'), 'file'))
        ? 'npm ci && npm start'
        : 'npm install && npm start'
  return { command, image: 'node:22', port: 3000 }
}

/**
 * A profile that boots by command (#379): the run writes the compose project
 * itself, with one service, `app`, so a seed or a suite reaches it by the
 * run's project alone. A command boot runs the app alone, so nothing is
 * stubbed. A command a profile already names is its own word and is kept as
 * it is; one init found is marked for a person to confirm.
 */
function commandConfig(started: StartCommand, own: boolean, healthPath: string | undefined, suites: Suite[]): string {
  const exec = 'docker compose -p qare-{{run.id}} exec -T app'
  return [
    ...HEADER,
    '#',
    '# The app is booted from its start command: qare copies the checkout into',
    '# the image at /app, runs the command there with PORT set to the port, and',
    '# publishes that port on one of its own for each run.',
    'app:',
    ...(own
      ? []
      : [
          `  # ${INIT_PLACEHOLDER} confirm the image the start command runs in: it carries sh and the runtime the app needs, then remove this line`,
          `  # ${INIT_PLACEHOLDER} confirm the port the app listens on inside the image (qare hands it to the app as PORT), then remove this line`,
        ]),
    `  boot: { command: ${JSON.stringify(started.command)}, image: ${JSON.stringify(started.image)}, port: ${started.port} }`,
    ...(healthPath === undefined
      ? [`  # ${INIT_PLACEHOLDER} confirm the health path answers 200 when the app is up (a redirect does not pass), then remove this line`]
      : []),
    `  health: { http: ${JSON.stringify(`http://localhost:{{run.app_port}}${healthPath ?? '/'}`)}, timeout: 120s }`,
    `  # ${INIT_PLACEHOLDER} name the command that seeds the QA data, in place of "true"`,
    '  # qare runs it once the app is healthy, before any check, from the runner. A',
    `  # seed inside the service: ${exec} <command>`,
    '  seed: { command: "true" }',
    `  # ${INIT_PLACEHOLDER} describe the user QA signs in as in .qa/fixtures/users.yml, and name its role here`,
    '  login: { fixture: fixtures/users.yml, role: admin }',
    '# A command boot runs the app alone, so nothing is stubbed: boot from a',
    '# compose file to stub the hosts the app reaches.',
    'stubs: []',
    'visual:',
    '  widths: [1440, 390]',
    '  themes: [light]',
    '# The image the checks run in: web carries the browser the flows drive.',
    'flavour: web',
    // The run image has none of the app's runtime, so a suite runs inside
    // the booted service, as it does for a compose boot.
    ...suiteLines(
      suites.map((suite) => ({ ...suite, command: `${exec} ${suite.command}` })),
      true,
    ),
    '',
  ].join('\n')
}

/**
 * The compose change a service needs to be published on the run's port: the
 * one it names is fixed, or there is none, and a run's app is never there.
 */
function portChange(service: ComposeService, compose: string): string {
  const hostPort = service.hostPort ?? '3000'
  const why =
    service.hostPort === undefined
      ? `the service ${JSON.stringify(service.name)} publishes no port`
      : `the service ${JSON.stringify(service.name)} publishes the fixed port ${service.hostPort}`
  const entry = JSON.stringify(`127.0.0.1:\${QARE_APP_PORT:-${hostPort}}:${service.containerPort ?? hostPort}`)
  return `${why}, and each run publishes the app on its own: in ${compose} give it ports: [${entry}], then remove this line`
}

/** A word a shell reads as itself: bare when it can be, single-quoted when not. */
function shellWord(word: string): string {
  return /^[A-Za-z0-9._/@:+=-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
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
  const published = (service: ComposeService) => service.runPort || service.hostPort !== undefined
  return (
    services.find((service) => service.build && published(service)) ??
    services.find((service) => service.build) ??
    services.find(published) ??
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
      const ports = (Array.isArray(record.ports) ? record.ports : []).map(publishedPort).filter((port) => port !== undefined)
      // The run's port wins: it is the one the app is reached on.
      const port = ports.find((candidate) => candidate.runPort) ?? ports.find((candidate) => candidate.host !== undefined)
      const health = healthOf(record.healthcheck)
      const containerPort = port?.container ?? health?.port
      return {
        name,
        build: record.build !== undefined && record.build !== null,
        runPort: port?.runPort ?? false,
        ...(port?.host === undefined ? {} : { hostPort: port.host }),
        ...(containerPort === undefined ? {} : { containerPort }),
        ...(health === undefined ? {} : { healthPath: health.path, healthScheme: health.scheme }),
      }
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

interface PublishedPort {
  /** The host side as a number: `8080`, or the default of `${QARE_APP_PORT:-8080}`. */
  host?: string
  container?: string
  /** The host side is QARE_APP_PORT, the port the run allocates. */
  runPort: boolean
}

const RUN_PORT_VARIABLE = /\$\{?QARE_APP_PORT\b/

/**
 * A compose port entry: `8080:3000`, `127.0.0.1:8080:3000`,
 * `${QARE_APP_PORT:-8080}:3000` (the default is the host port), or the long
 * form's `published` and `target`. An entry with no host side publishes on a
 * port nobody chose.
 */
function publishedPort(entry: unknown): PublishedPort | undefined {
  const number = (value: string | undefined) => {
    const first = value?.replace(/\$\{[^}:]*:-(\d+)\}/g, '$1').split('-')[0]
    return first !== undefined && /^\d+$/.test(first) ? first : undefined
  }
  if (isRecord(entry)) {
    const published = entry.published === undefined || entry.published === null ? undefined : String(entry.published)
    const host = number(published)
    const container = number(entry.target === undefined ? undefined : String(entry.target))
    const runPort = published !== undefined && RUN_PORT_VARIABLE.test(published)
    if (host === undefined && !runPort) return undefined
    return { runPort, ...(host === undefined ? {} : { host }), ...(container === undefined ? {} : { container }) }
  }
  if (typeof entry !== 'string' && typeof entry !== 'number') return undefined
  // A variable's default may hold a colon of its own, so variables are set
  // aside before the entry is split into its sides.
  const variables: string[] = []
  const parts = String(entry)
    .replace(/\/\w+$/, '')
    .replace(/\$\{[^}]*\}/g, (variable) => `\uE000${variables.push(variable) - 1}\uE000`)
    .split(':')
    .map((part) => part.replace(/\uE000(\d+)\uE000/g, (_, index: string) => variables[Number(index)] as string))
  if (parts.length < 2) return undefined
  const hostSide = parts[parts.length - 2] as string
  const host = number(hostSide)
  const container = number(parts[parts.length - 1])
  const runPort = RUN_PORT_VARIABLE.test(hostSide)
  if (host === undefined && !runPort) return undefined
  return { runPort, ...(host === undefined ? {} : { host }), ...(container === undefined ? {} : { container }) }
}

/** The scheme, path and port the service's own healthcheck asks with, when it names a URL. */
function healthOf(healthcheck: unknown): { scheme: string; path: string; port?: string } | undefined {
  if (!isRecord(healthcheck)) return undefined
  const test = Array.isArray(healthcheck.test) ? healthcheck.test.map(String).join(' ') : String(healthcheck.test ?? '')
  const match = /https?:\/\/[^\s"'|;&)]+/.exec(test)
  if (match === null) return undefined
  try {
    const url = new URL(match[0])
    return { scheme: url.protocol.replace(/:$/, ''), path: `${url.pathname}${url.search}`, ...(url.port === '' ? {} : { port: url.port }) }
  } catch {
    return undefined
  }
}
