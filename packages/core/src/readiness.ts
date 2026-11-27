import { execFile } from 'node:child_process'
import { lstat, readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { matchesStub } from './egress.js'
import { clientExecutableName, isCommandBoot, loadProfile } from './profile.js'
import { hasContainedCommand, UNCONTAINED_COMMAND_NOTICE } from './placement.js'

export const READINESS_MAX_FILES = 2000
export const READINESS_MAX_FILE_BYTES = 1024 * 1024

const COMPOSE_CANDIDATES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.qa'])
/** How many ignored paths the report names before it counts the rest (#425). */
const IGNORED_NAMED = 10

/**
 * What the origin scan leaves out (#415): files that name URLs the running
 * application never reaches. Docs and specs describe services, fixtures and
 * seeds plant data, tool and agent config drives the editor or CI, design
 * assets carry their format's namespaces, and lockfiles name registries. The
 * report counts each group it skipped, so nothing is left out unsaid.
 */
const DIR_GROUPS: Array<{ group: string; dirs: ReadonlySet<string> }> = [
  { group: 'docs', dirs: new Set(['docs', 'doc']) },
  { group: 'tests and specs', dirs: new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'e2e', 'cypress']) },
  { group: 'fixtures and seeds', dirs: new Set(['fixtures', '__fixtures__', 'seeds']) },
  { group: 'tool and agent config', dirs: new Set(['.ai', '.agents', '.claude', '.cursor', '.github', '.vscode', '.idea']) },
]
const FILE_GROUPS: Array<{ group: string; test: (name: string) => boolean }> = [
  { group: 'docs', test: (name) => /\.(md|mdx|markdown|rst|adoc|txt)$/i.test(name) },
  { group: 'tests and specs', test: (name) => /(?:[._-](?:spec|test)s?\.[a-z0-9]+$)|(?:^test_.*\.py$)/i.test(name) },
  { group: 'fixtures and seeds', test: (name) => /^seeds?\.[a-z0-9]+$/i.test(name) },
  { group: 'design assets', test: (name) => /\.(svg|ai|eps|pdf|psd|sketch)$/i.test(name) },
  {
    group: 'lockfiles',
    test: (name) =>
      ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'Gemfile.lock', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'Cargo.lock', 'composer.lock', 'go.sum'].includes(name),
  },
]

/** Which group a path the scan leaves out falls in, or undefined when the scan reads it (#415). */
export function excludedGroup(rel: string): string | undefined {
  const segments = rel.replace(/^\.\//, '').split('/')
  const name = segments.pop() ?? ''
  for (const { group, dirs } of DIR_GROUPS) if (segments.some((segment) => dirs.has(segment))) return group
  for (const { group, test } of FILE_GROUPS) if (test(name)) return group
  return undefined
}

export interface ReadinessComposeService {
  name: string
  image?: string
  healthcheck: boolean
  command?: string
}

export interface ReadinessComposeFile {
  file: string
  services: ReadinessComposeService[]
}

export interface ReadinessOriginHit {
  origin: string
  totalHits: number
  files: Array<{ file: string; count: number }>
}

export interface ReadinessProfileInfo {
  present: boolean
  /** Informational containment notice for a successfully loaded profile (#292). */
  commandNotice?: string
  loadError?: string
  healthUrl?: string
  /** The running app a target profile checks (#122); such a profile boots nothing. */
  target?: { url: string; hosts: string[] }
  /** The build a client profile launches (#72); such a profile boots nothing either. */
  client?: { driver: string; executable: string; artefact?: { kind: string; head: string; base?: string } }
  /** The compose file and service a booted profile names (#146). */
  boot?: { compose: string; service: string }
  /** The start command, image and port a profile boots by command instead (#379): no compose file is needed. */
  commandBoot?: { command: string; image: string; port: number }
  stubs: Array<{ service: string; hosts: string[]; composeService?: string }>
}

/**
 * A reached host with no working stub (#146), in the shape a stub issue is
 * drafted from: either no stub covers it, or the stub that does names a
 * compose service nothing defines (then `service` and `composeService` say
 * which).
 */
export interface ReadinessStubGap {
  host: string
  port: string
  protocol: string
  hits: number
  files: string[]
  service?: string
  composeService?: string
}

/** The marker `qare init` leaves where a person has to write something. */
export const INIT_PLACEHOLDER = 'TODO(qare init):'

export interface ReadinessScanStats {
  filesScanned: number
  skippedOversized: number
  skippedBinary: number
  skippedUnreadable: number
  capped: boolean
  maxFiles: number
  /**
   * What git ignores, skipped unscanned (#425): a virtualenv, a build, a log
   * holds URLs the application never reaches. Paths relative to the repo, a
   * directory ending in `/`. Absent outside a git checkout, or without git,
   * when the scan reads everything but the fixed skip list.
   */
  ignored?: string[]
  /** How many files of each group the origin scan left out (#415): docs, tests and specs, fixtures and seeds, and the rest. Absent when none. */
  excluded?: Record<string, number>
}

export interface ReadinessInventory {
  repoPath: string
  boot: ReadinessComposeFile[]
  origins: ReadinessOriginHit[]
  profile: ReadinessProfileInfo
  coverage: Array<{ origin: string; coveredBy?: string }>
  scan: ReadinessScanStats
  gaps: string[]
  /** The gaps that are a missing stub, one per host (#146). */
  stubGaps: ReadinessStubGap[]
}

export async function readinessInventory(
  repoPath: string,
  opts: { maxFiles?: number } = {},
): Promise<ReadinessInventory> {
  const repo = normalizeDir(repoPath)
  const info = await stat(repo).catch(() => undefined)
  if (!info) throw new Error(`readiness: repo path ${JSON.stringify(repo)} does not exist`)
  if (!info.isDirectory()) throw new Error(`readiness: repo path ${JSON.stringify(repo)} is not a directory`)

  const maxFiles = opts.maxFiles ?? READINESS_MAX_FILES
  const profile = await loadProfileInfo(repo)
  // A profile that boots from compose names its file (#415): that file is
  // the boot, not whichever compose file a guess finds first.
  const boot = profile.boot !== undefined ? await profileComposeFile(repo, profile.boot.compose) : await inventoryBoot(repo)
  const scan: ReadinessScanStats = {
    filesScanned: 0,
    skippedOversized: 0,
    skippedBinary: 0,
    skippedUnreadable: 0,
    capped: false,
    maxFiles,
  }
  const profileBoot = await inspectProfileBoot(repo, profile)
  // A compose service reaches its neighbours by name: `http://search:9200`
  // is the stack talking to itself, not something a stub has to answer.
  const internal = new Set([...boot.flatMap((file) => file.services.map((service) => service.name)), ...(profileBoot.services ?? [])])
  const ignored = await gitIgnored(repo)
  if (ignored !== undefined && ignored.length > 0) scan.ignored = ignored
  const origins = await scanOrigins(repo, maxFiles, scan, internal, new Set(ignored ?? []))
  const coverage = coverageOf(origins, profile)
  const placeholders = profile.present ? await placeholdersIn(repo) : []

  return {
    repoPath: repo,
    boot,
    origins,
    profile,
    coverage,
    scan,
    gaps: gapsOf(boot, profile, coverage, placeholders, profileBoot),
    stubGaps: stubGapsOf(origins, profile, profileBoot),
  }
}

/** What the compose file a booted profile names really holds. */
interface ProfileBoot {
  /** The services the file defines; absent when there is no file to read. */
  services?: string[]
  /** Why the file could not be used, as a gap. */
  problem?: string
}

async function inspectProfileBoot(repo: string, profile: ReadinessProfileInfo): Promise<ProfileBoot> {
  if (profile.boot === undefined) return {}
  // The run hands the path to `docker compose -f` from the repository root.
  const path = join(repo, profile.boot.compose)
  if (!(await isFile(path)))
    return { problem: `the profile boots from ${JSON.stringify(profile.boot.compose)}, which the repository does not have` }
  try {
    return { services: parseComposeServices(path, await readFile(path, 'utf8')).map((service) => service.name) }
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The placeholders `qare init` wrote that are still there (#146). A profile
 * loads with them in place, so nothing else would say the profile is a
 * skeleton: each one is a gap until a person replaces it.
 */
async function placeholdersIn(repo: string): Promise<string[]> {
  const found: string[] = []
  for (const name of ['QA.md', 'config.yml']) {
    const text = await readFile(join(repo, '.qa', name), 'utf8').catch(() => '')
    for (const line of text.split('\n')) {
      const at = line.indexOf(INIT_PLACEHOLDER)
      if (at === -1) continue
      found.push(`.qa/${name} is not filled in: ${line.slice(at + INIT_PLACEHOLDER.length).trim()}`)
    }
  }
  return found
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || /^127(?:\.\d{1,3}){3}$/.test(host)
}

function stubGapsOf(origins: ReadinessOriginHit[], profile: ReadinessProfileInfo, profileBoot: ProfileBoot): ReadinessStubGap[] {
  // Only a booted profile that loads has stubs to be missing.
  if (!profile.present || profile.loadError !== undefined || profile.target !== undefined || profile.client !== undefined) return []
  const byHost = new Map<string, ReadinessStubGap>()
  for (const hit of origins) {
    const host = originHost(hit.origin)
    const stub = profile.stubs.find((candidate) => matchesStub(host, [{ hosts: candidate.hosts }]))
    const unprovided =
      stub !== undefined && stub.composeService !== undefined && profileBoot.services !== undefined && !profileBoot.services.includes(stub.composeService)
    if (stub !== undefined && !unprovided) continue
    const protocol = hit.origin.slice(0, hit.origin.indexOf('://'))
    const port = /:(\d+)$/.exec(hit.origin)?.[1] ?? (protocol === 'https' ? '443' : '80')
    const files = hit.files.map((file) => file.file)
    const existing = byHost.get(host)
    if (existing !== undefined) {
      existing.hits += hit.totalHits
      existing.files = [...new Set([...existing.files, ...files])].sort(compareStrings)
      continue
    }
    byHost.set(host, {
      host,
      port,
      protocol,
      hits: hit.totalHits,
      files,
      ...(stub === undefined ? {} : { service: stub.service, composeService: stub.composeService }),
    })
  }
  return [...byHost.values()].sort((a, b) => compareStrings(a.host, b.host))
}

function originHost(origin: string): string {
  return origin.slice(origin.indexOf('://') + 3).replace(/:\d+$/, '')
}

function normalizeDir(dir: string): string {
  const trimmed = dir.trim()
  if (trimmed === '') throw new Error('readiness: repo path is required')
  return trimmed.endsWith(sep) ? trimmed.slice(0, -1) : trimmed
}

async function inventoryBoot(repo: string): Promise<ReadinessComposeFile[]> {
  const dirs = [repo, ...(await immediateSubdirectories(repo))]
  const files: ReadinessComposeFile[] = []
  for (const dir of dirs) {
    for (const name of COMPOSE_CANDIDATES) {
      const path = join(dir, name)
      if (!(await isFile(path))) continue
      files.push({ file: relativeLabel(repo, path), services: parseComposeServices(path, await readFile(path, 'utf8')) })
      break
    }
  }
  return files
}

/** The compose file a profile boots from, when the repository has it and it parses (#415); its problem is a gap of its own. */
async function profileComposeFile(repo: string, compose: string): Promise<ReadinessComposeFile[]> {
  const path = join(repo, compose)
  if (!(await isFile(path))) return []
  try {
    return [{ file: relativeLabel(repo, path), services: parseComposeServices(path, await readFile(path, 'utf8')) }]
  } catch {
    return []
  }
}

async function immediateSubdirectories(repo: string): Promise<string[]> {
  const entries = await readdir(repo, { withFileTypes: true })
  const dirs: string[] = []
  for (const entry of entries.sort((a, b) => compareStrings(a.name, b.name))) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue
    dirs.push(join(repo, entry.name))
  }
  return dirs
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

async function isFile(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => undefined)
  return info !== undefined && info.isFile()
}

export function parseComposeServices(path: string, text: string): ReadinessComposeService[] {
  let doc: unknown
  try {
    doc = parseYaml(text)
  } catch (error) {
    throw new Error(
      `readiness: compose file ${JSON.stringify(path)} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`readiness: compose file ${JSON.stringify(path)} must be a YAML mapping with a services key`)
  }
  const services = (doc as Record<string, unknown>).services
  if (services === undefined) return []
  if (!services || typeof services !== 'object' || Array.isArray(services)) {
    throw new Error(`readiness: compose file ${JSON.stringify(path)} has a services key that is not a mapping`)
  }
  const out: ReadinessComposeService[] = []
  for (const [name, raw] of Object.entries(services as Record<string, unknown>)) {
    const record = (raw ?? {}) as Record<string, unknown>
    const command = commandOf(record)
    out.push({
      name,
      image: typeof record.image === 'string' ? record.image : undefined,
      healthcheck: record.healthcheck !== undefined && record.healthcheck !== null,
      command: command === undefined ? undefined : command,
    })
  }
  return out.sort((a, b) => compareStrings(a.name, b.name))
}

function commandOf(record: Record<string, unknown>): string | undefined {
  if (typeof record.command === 'string') return record.command
  if (Array.isArray(record.command)) return record.command.map(String).join(' ')
  if (typeof record.entrypoint === 'string') return record.entrypoint
  if (Array.isArray(record.entrypoint)) return record.entrypoint.map(String).join(' ')
  return undefined
}

async function scanOrigins(
  repo: string,
  maxFiles: number,
  scan: ReadinessScanStats,
  internal: ReadonlySet<string>,
  ignored: ReadonlySet<string> = new Set(),
): Promise<ReadinessOriginHit[]> {
  const byOrigin = new Map<string, Map<string, number>>()
  await walk(repo, repo, ignored, async (path, rel) => {
    if (scan.filesScanned >= maxFiles) {
      scan.capped = true
      return
    }
    const group = excludedGroup(rel)
    if (group !== undefined) {
      scan.excluded = { ...scan.excluded, [group]: (scan.excluded?.[group] ?? 0) + 1 }
      return
    }
    const info = await lstat(path)
    if (!info.isFile()) return
    if (info.size > READINESS_MAX_FILE_BYTES) {
      scan.skippedOversized += 1
      return
    }
    const text = await readFile(path, 'utf8').catch(() => undefined)
    if (text === undefined) {
      scan.skippedUnreadable += 1
      return
    }
    if (text.slice(0, 1024).includes('\u0000')) {
      scan.skippedBinary += 1
      return
    }
    scan.filesScanned += 1
    for (const match of text.matchAll(ORIGIN_PATTERN)) {
      const origin = normalizeOrigin(match[0])
      if (origin === '') continue
      // The machine itself and the stack's own services are not outbound.
      const host = originHost(origin)
      if (isLoopback(host) || internal.has(host)) continue
      const perFile = byOrigin.get(origin) ?? new Map<string, number>()
      perFile.set(rel, (perFile.get(rel) ?? 0) + 1)
      byOrigin.set(origin, perFile)
    }
  })
  const hits: ReadinessOriginHit[] = []
  for (const [origin, perFile] of [...byOrigin.entries()].sort((a, b) => compareStrings(a[0], b[0]))) {
    const files = [...perFile.entries()].sort((a, b) => compareStrings(a[0], b[0]))
    hits.push({
      origin,
      totalHits: files.reduce((sum, [, count]) => sum + count, 0),
      files: files.map(([file, count]) => ({ file, count })),
    })
  }
  return hits
}

const ORIGIN_PATTERN = /https?:\/\/(?:[a-z0-9._~\-]+(?::[a-z0-9._~\-]*)?@)?[a-z0-9][a-z0-9._-]*(?::\d+)?/gi

export function normalizeOrigin(match: string): string {
  const schemeSplit = match.indexOf('://')
  if (schemeSplit !== 4 && schemeSplit !== 5) return ''
  let rest = match.slice(schemeSplit + 3)
  const at = rest.lastIndexOf('@')
  if (at !== -1) rest = rest.slice(at + 1)
  const host = rest.replace(/[.\-:]+$/, '').toLowerCase()
  if (host === '') return ''
  return `${match.slice(0, schemeSplit).toLowerCase()}://${host}`
}

async function walk(dir: string, repo: string, ignored: ReadonlySet<string>, visit: (path: string, rel: string) => Promise<void>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries.sort((a, b) => compareStrings(a.name, b.name))) {
    const path = join(dir, entry.name)
    const rel = relative(repo, path).split(sep).join('/')
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || ignored.has(`${rel}/`)) continue
      await walk(path, repo, ignored, visit)
      continue
    }
    if (!entry.isFile() || ignored.has(rel)) continue
    await visit(path, relativeLabel(repo, path))
  }
}

/**
 * The paths git ignores in the repository (#425), as git names them: a
 * directory it ignores whole ends in `/`. Undefined when the path is not a
 * git checkout or git cannot be run: the scan then reads everything but the
 * fixed skip list, as it did before.
 */
function gitIgnored(repo: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', repo, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
      { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error !== null) return resolve(undefined)
        resolve(stdout.split('\u0000').filter((path) => path !== '').sort(compareStrings))
      },
    )
  })
}

function relativeLabel(repo: string, path: string): string {
  const rel = relative(repo, path)
  return rel.startsWith('.') ? rel : `./${rel.split(sep).join('/')}`
}

async function loadProfileInfo(repo: string): Promise<ReadinessProfileInfo> {
  const dir = join(repo, '.qa')
  const info = await stat(dir).catch(() => undefined)
  if (!info || !info.isDirectory()) {
    return { present: false, stubs: [] }
  }
  try {
    const profile = await loadProfile(dir)
    const healthUrl = profile.app?.health?.http ?? profile.target?.health.http
    return {
      present: true,
      ...(!hasContainedCommand(profile) ? { commandNotice: UNCONTAINED_COMMAND_NOTICE } : {}),
      healthUrl: typeof healthUrl === 'string' ? healthUrl : undefined,
      ...(profile.target === undefined ? {} : { target: { url: profile.target.url, hosts: [...profile.target.hosts] } }),
      ...(profile.client === undefined
        ? {}
        : {
            client: {
              driver: profile.client.driver,
              executable: clientExecutableName(profile.client),
              ...(profile.client.artefact === undefined
                ? {}
                : {
                    artefact: {
                      kind: profile.client.artefact.kind,
                      head: profile.client.artefact.head.path,
                      ...(profile.client.artefact.base === undefined ? {} : { base: profile.client.artefact.base.path }),
                    },
                  }),
            },
          }),
      ...(profile.app === undefined
        ? {}
        : isCommandBoot(profile.app.boot)
          ? { commandBoot: { command: profile.app.boot.command, image: profile.app.boot.image, port: profile.app.boot.port } }
          : { boot: { compose: profile.app.boot.compose, service: profile.app.boot.service } }),
      stubs: (profile.stubs ?? []).map((stub) => ({
        service: stub.service,
        hosts: [...stub.hosts],
        composeService: stub.provided_by.compose_service,
      })),
    }
  } catch (error) {
    return {
      present: true,
      loadError: error instanceof Error ? error.message : String(error),
      stubs: [],
    }
  }
}

function coverageOf(
  origins: ReadinessOriginHit[],
  profile: ReadinessProfileInfo,
): Array<{ origin: string; coveredBy?: string }> {
  const egressStubs = profile.stubs.map((stub) => ({ hosts: stub.hosts }))
  const cover: Array<{ origin: string; coveredBy?: string }> = []
  for (const hit of origins) {
    const covered = egressStubs.length > 0 ? profile.stubs.find((stub) => matchesStub(originHost(hit.origin), [{ hosts: stub.hosts }])) : undefined
    cover.push({ origin: hit.origin, coveredBy: covered?.service })
  }
  return cover
}

function gapsOf(
  boot: ReadinessComposeFile[],
  profile: ReadinessProfileInfo,
  coverage: Array<{ origin: string; coveredBy?: string }>,
  placeholders: string[],
  profileBoot: ProfileBoot,
): string[] {
  const gaps: string[] = [...placeholders]
  // A target profile checks an app that is already running: qare boots
  // nothing and stubs nothing, so neither a compose file nor stub coverage is
  // a gap (#122). What the profile itself needs, loading already checked.
  if (profile.present && profile.loadError === undefined && profile.target !== undefined) return gaps
  // A client profile launches a build the project made (#72): nothing boots
  // and nothing is stubbed there either.
  if (profile.present && profile.loadError === undefined && profile.client !== undefined) return gaps
  // A command boot runs the app from its start command (#379): it needs no
  // compose file, and one kept beside it for other uses is not what boots.
  const composeBooted = profile.commandBoot === undefined
  // A profile that names a compose file it lacks has that as its gap, below.
  if (composeBooted && boot.length === 0 && profile.boot === undefined) gaps.push('no compose file found: qare cannot boot this repo for a QA run')
  // With a profile, only the service it boots is held to a healthcheck
  // (#415): its stubs and neighbours are waited on as running, and listing
  // each one was noise nobody acted on.
  for (const file of composeBooted ? boot : []) {
    for (const service of file.services) {
      if (profile.boot !== undefined && service.name !== profile.boot.service) continue
      if (!service.healthcheck) {
        gaps.push(`service ${JSON.stringify(service.name)} in ${file.file} has no healthcheck`)
      }
    }
  }
  if (!profile.present) {
    gaps.push('no .qa/ profile: there is nothing for qare to check yet (write a profile in .qa/ to enable QA)')
  } else if (profile.loadError) {
    gaps.push(`.qa/ profile could not be loaded: ${profile.loadError}`)
  } else {
    for (const entry of coverage) {
      if (!entry.coveredBy) {
        gaps.push(`outbound origin ${entry.origin} is reached but not stubbed by the .qa/ profile`)
      }
    }
    if (profileBoot.problem !== undefined) gaps.push(profileBoot.problem)
    if (profileBoot.services !== undefined && profile.boot !== undefined) {
      if (!profileBoot.services.includes(profile.boot.service))
        gaps.push(`the profile boots the service ${JSON.stringify(profile.boot.service)}, which ${profile.boot.compose} does not define`)
      for (const stub of profile.stubs) {
        if (stub.composeService !== undefined && !profileBoot.services.includes(stub.composeService))
          gaps.push(
            `stub ${JSON.stringify(stub.service)} is provided by the compose service ${JSON.stringify(stub.composeService)}, which ${profile.boot.compose} does not define`,
          )
      }
    }
    // A stub host the scan never saw is no gap (#415): every stub is a
    // compose service the app reaches by its host name, often through
    // extra_hosts, which no URL in the tree spells out.
  }
  return gaps
}

export function buildReadinessReport(inventory: ReadinessInventory): string {
  const lines: string[] = []
  lines.push('# QARE readiness report')
  lines.push('')
  lines.push(`Repo: ${inventory.repoPath}`)
  if (inventory.profile.commandNotice !== undefined) {
    lines.push('')
    lines.push(`- ${inventory.profile.commandNotice}`)
  }
  lines.push('')
  lines.push('## Boot')
  const target = inventory.profile.target
  if (target !== undefined) {
    lines.push(`- target ${target.url}: already running, so qare boots nothing`)
    lines.push(target.hosts.length === 0 ? '- other hosts its checks may reach: none' : `- other hosts its checks may reach: ${target.hosts.join(', ')}`)
  } else if (inventory.profile.client !== undefined) {
    const client = inventory.profile.client
    if (client.artefact === undefined) {
      lines.push(`- ${client.driver} build ${client.executable}: launched by the run, so qare boots nothing`)
    } else {
      // A provisioned build (#75): what is installed for each side. Whether
      // the artefact is there yet is the pipeline's business, not a gap.
      lines.push(
        `- ${client.driver} build ${client.executable}: installed by the run from the ${client.artefact.kind} ${client.artefact.head} and removed afterwards, so qare boots nothing`,
      )
      lines.push(
        client.artefact.base === undefined
          ? '- base side: none, because the profile names no build of the base (client.artefact.base), so no regression is looked for'
          : `- base side: the build installed from ${client.artefact.base}, so a criterion that worked there and fails at the head is a regression`,
      )
    }
  } else if (inventory.profile.commandBoot !== undefined) {
    const command = inventory.profile.commandBoot
    lines.push(`- command ${JSON.stringify(command.command)} in ${command.image}, listening on ${command.port}: booted by the run as a compose project of its own`)
  } else if (inventory.profile.boot !== undefined && inventory.boot.length === 0) {
    lines.push(`- the profile boots ${inventory.profile.boot.service} from ${inventory.profile.boot.compose}, which could not be read`)
  } else if (inventory.boot.length === 0) {
    lines.push('- no compose file found')
  } else {
    for (const file of inventory.boot) {
      const booted = inventory.profile.boot === undefined ? '' : ` (the profile boots ${inventory.profile.boot.service} from it)`
      lines.push(`- ${file.file}${booted}: ${file.services.length} service(s)`)
      for (const service of file.services) {
        const parts = [service.image ?? 'no image', service.healthcheck ? 'healthcheck: yes' : 'healthcheck: no']
        if (service.command !== undefined) parts.push(`command: ${service.command}`)
        lines.push(`  - ${service.name}: ${parts.join(', ')}`)
      }
    }
  }
  lines.push('')
  lines.push('## Outbound origins')
  if (inventory.origins.length === 0) {
    lines.push('- no outbound origins observed in the repo scan')
  } else {
    for (const hit of inventory.origins) {
      const where = hit.files.map((f) => `${f.file} (${f.count})`).join(', ')
      lines.push(`- ${hit.origin} — ${hit.totalHits} hit(s): ${where}`)
    }
  }
  lines.push('')
  lines.push('## Stub coverage')
  if (target !== undefined) {
    lines.push('- a target profile has no stubs: the app runs elsewhere, with its real dependencies')
    lines.push(inventory.profile.healthUrl ? `- profile health URL: ${inventory.profile.healthUrl}` : '- profile health URL: none')
  } else if (!inventory.profile.present) {
    lines.push('- no .qa/ profile: no stubs are configured')
  } else if (inventory.profile.loadError) {
    lines.push(`- .qa/ profile could not be loaded: ${inventory.profile.loadError}`)
  } else {
    for (const entry of inventory.coverage) {
      lines.push(entry.coveredBy ? `- ${entry.origin} — covered by stub ${entry.coveredBy}` : `- ${entry.origin} — NOT covered`)
    }
    lines.push(inventory.profile.healthUrl ? `- profile health URL: ${inventory.profile.healthUrl}` : '- profile health URL: none')
  }
  lines.push('')
  lines.push('## Scan')
  lines.push(
    `- ${inventory.scan.filesScanned} file(s) scanned` +
      (inventory.scan.capped ? ` (scan capped at ${inventory.scan.maxFiles} files)` : '') +
      (inventory.scan.skippedOversized > 0 ? `, ${inventory.scan.skippedOversized} skipped over 1 MB` : '') +
      (inventory.scan.skippedBinary > 0 ? `, ${inventory.scan.skippedBinary} skipped as binary` : '') +
      (inventory.scan.skippedUnreadable > 0 ? `, ${inventory.scan.skippedUnreadable} skipped unreadable` : ''),
  )
  const excluded = Object.entries(inventory.scan.excluded ?? {}).sort((a, b) => compareStrings(a[0], b[0]))
  if (excluded.length > 0)
    lines.push(`- not scanned for origins, as the app never reaches what they name: ${excluded.map(([group, count]) => `${group} (${count} file${count === 1 ? '' : 's'})`).join(', ')}`)
  const ignored = inventory.scan.ignored ?? []
  if (ignored.length > 0)
    lines.push(`- skipped what git ignores: ${ignored.slice(0, IGNORED_NAMED).join(', ')}${ignored.length > IGNORED_NAMED ? `, and ${ignored.length - IGNORED_NAMED} more` : ''}`)
  lines.push('')
  lines.push('## Gaps')
  if (inventory.gaps.length === 0) {
    lines.push('- none')
  } else {
    for (const gap of inventory.gaps) lines.push(`- ${gap}`)
  }
  lines.push('')
  return lines.join('\n')
}
