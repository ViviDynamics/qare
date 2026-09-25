import { lstat, readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { matchesStub } from './egress.js'
import { loadProfile } from './profile.js'

export const READINESS_MAX_FILES = 2000
export const READINESS_MAX_FILE_BYTES = 1024 * 1024

const COMPOSE_CANDIDATES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.qa'])

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
  loadError?: string
  healthUrl?: string
  /** The running app a target profile checks (#122); such a profile boots nothing. */
  target?: { url: string; hosts: string[] }
  stubs: Array<{ service: string; hosts: string[] }>
}

export interface ReadinessScanStats {
  filesScanned: number
  skippedOversized: number
  skippedBinary: number
  skippedUnreadable: number
  capped: boolean
  maxFiles: number
}

export interface ReadinessInventory {
  repoPath: string
  boot: ReadinessComposeFile[]
  origins: ReadinessOriginHit[]
  profile: ReadinessProfileInfo
  coverage: Array<{ origin: string; coveredBy?: string }>
  scan: ReadinessScanStats
  gaps: string[]
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
  const boot = await inventoryBoot(repo)
  const scan: ReadinessScanStats = {
    filesScanned: 0,
    skippedOversized: 0,
    skippedBinary: 0,
    skippedUnreadable: 0,
    capped: false,
    maxFiles,
  }
  const origins = await scanOrigins(repo, maxFiles, scan)
  const profile = await loadProfileInfo(repo)
  const coverage = coverageOf(origins, profile)

  return {
    repoPath: repo,
    boot,
    origins,
    profile,
    coverage,
    scan,
    gaps: gapsOf(boot, profile, coverage),
  }
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

async function scanOrigins(repo: string, maxFiles: number, scan: ReadinessScanStats): Promise<ReadinessOriginHit[]> {
  const byOrigin = new Map<string, Map<string, number>>()
  await walk(repo, repo, async (path, rel) => {
    if (scan.filesScanned >= maxFiles) {
      scan.capped = true
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

async function walk(dir: string, repo: string, visit: (path: string, rel: string) => Promise<void>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries.sort((a, b) => compareStrings(a.name, b.name))) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await walk(path, repo, visit)
      continue
    }
    if (!entry.isFile()) continue
    await visit(path, relativeLabel(repo, path))
  }
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
      healthUrl: typeof healthUrl === 'string' ? healthUrl : undefined,
      ...(profile.target === undefined ? {} : { target: { url: profile.target.url, hosts: [...profile.target.hosts] } }),
      stubs: (profile.stubs ?? []).map((stub) => ({ service: stub.service, hosts: [...stub.hosts] })),
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
): string[] {
  const gaps: string[] = []
  // A target profile checks an app that is already running: qare boots
  // nothing and stubs nothing, so neither a compose file nor stub coverage is
  // a gap (#122). What the profile itself needs, loading already checked.
  if (profile.present && profile.loadError === undefined && profile.target !== undefined) return gaps
  if (boot.length === 0) gaps.push('no compose file found: qare cannot boot this repo for a QA run')
  for (const file of boot) {
    for (const service of file.services) {
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
    for (const stub of profile.stubs) {
      for (const host of stub.hosts) {
        const observed = coverage.some((entry) => matchesStub(originHost(entry.origin), [{ hosts: [host] }]))
        if (!observed) {
          gaps.push(`stub ${JSON.stringify(stub.service)} lists host ${JSON.stringify(host)} that the scan never observed`)
        }
      }
    }
  }
  return gaps
}

export function buildReadinessReport(inventory: ReadinessInventory): string {
  const lines: string[] = []
  lines.push('# QARE readiness report')
  lines.push('')
  lines.push(`Repo: ${inventory.repoPath}`)
  lines.push('')
  lines.push('## Boot')
  const target = inventory.profile.target
  if (target !== undefined) {
    lines.push(`- target ${target.url}: already running, so qare boots nothing`)
    lines.push(target.hosts.length === 0 ? '- other hosts its checks may reach: none' : `- other hosts its checks may reach: ${target.hosts.join(', ')}`)
  } else if (inventory.boot.length === 0) {
    lines.push('- no compose file found')
  } else {
    for (const file of inventory.boot) {
      lines.push(`- ${file.file}: ${file.services.length} service(s)`)
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
