import type { EgressFinding } from './egress.js'
import type { RunResult } from './result.js'

export interface MissingStub {
  host: string
  port: string
  protocol: string
  count: number
}

export interface StubIssueDraft {
  title: string
  key: string
  body: string
}

export interface StubIssueRefusedEntry {
  pr: number
  keys: string[]
}

export interface StubIssuePoster {
  fileIfMissing(draft: StubIssueDraft): Promise<number>
  addToRegistry(issue: number, pr: number): Promise<void>
  comment(pr: number, body: string): Promise<void>
}

const MISSING_STUB_PREFIX = 'refused: missing stub: '

export function missingStubsFromResult(result: RunResult): MissingStub[] {
  const findings: EgressFinding[] = []
  for (const criterion of result?.criteria ?? []) {
    if (criterion.outcome !== 'unverified') continue
    const reason = criterion.reason
    if (typeof reason === 'string' && reason.startsWith(MISSING_STUB_PREFIX)) {
      findings.push({ kind: 'refused', reason, count: 1 })
    }
  }
  return missingStubs(findings)
}

export function missingStubs(findings: EgressFinding[]): MissingStub[] {
  const byHost = new Map<string, MissingStub>()
  for (const finding of findings ?? []) {
    const missing = parseMissingStub(finding)
    if (missing === undefined) continue
    const existing = byHost.get(missing.host)
    if (existing === undefined) {
      byHost.set(missing.host, missing)
      continue
    }
    existing.count += missing.count
  }
  return [...byHost.values()].sort((a, b) => compareStrings(a.host, b.host))
}

function parseMissingStub(finding: EgressFinding): MissingStub | undefined {
  if (!finding || finding.kind !== 'refused') return undefined
  if (typeof finding.reason !== 'string' || !finding.reason.startsWith(MISSING_STUB_PREFIX)) return undefined
  const rest = finding.reason.slice(MISSING_STUB_PREFIX.length)
  // shipped shape: <host>:<port> (<protocol>)
  const match = /^(\S+):(\d+) \((.+)\)$/.exec(rest)
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) return undefined
  const host = match[1].toLowerCase()
  if (!/^[a-z0-9._*-]+$/.test(host)) return undefined
  const port = match[2]
  const protocol = match[3].trim()
  if (protocol === '') return undefined
  const count = typeof finding.count === 'number' && Number.isFinite(finding.count) && finding.count >= 1 ? finding.count : 1
  return { host, port, protocol, count }
}

export function stubIssueMarker(key: string): string {
  return `qare-stub: ${key}`
}

export function parseStubIssueMarkers(text: string): string[] {
  const markers = new Set<string>()
  for (const match of String(text ?? '').matchAll(/qare-stub: (\S+)/g)) {
    if (match[1] !== undefined) markers.add(match[1])
  }
  return [...markers].sort((a, b) => compareStrings(a, b))
}

export function stubIssueDraft(missing: MissingStub): StubIssueDraft {
  const key = missing.host
  const title = `Stub needed for ${missing.host}`
  const lines: string[] = []
  lines.push('## Calls made')
  lines.push('')
  lines.push(`- ${missing.host}:${missing.port} (${missing.protocol}) — ${missing.count} attempt(s)`)
  lines.push('')
  lines.push('## What the stub must answer')
  lines.push('')
  lines.push(`The app reaches \`${missing.host}\` over ${missing.protocol} on port ${missing.port}.`)
  lines.push('QARE refuses the run until a stub provides it. Add this entry to the profile stub map:')
  lines.push('')
  lines.push('```yaml')
  lines.push('stubs:')
  lines.push(`  - service: ${suggestService(missing.host)}`)
  lines.push(`    hosts: ["${missing.host}"]`)
  lines.push(`    provided_by: { compose_service: ${suggestComposeService(missing.host)} }`)
  lines.push('```')
  lines.push('')
  lines.push('## Linking')
  lines.push('')
  lines.push(`Dedup key: ${stubIssueMarker(key)}`)
  lines.push('Refused PRs are registered here as `qare-refused: #<pr>` lines; when the stub PR merges, those PRs are re-queued.')
  lines.push('')
  return { title, key, body: lines.join('\n') }
}

function suggestService(host: string): string {
  const base = host.replace(/^[*.]/, '')
  const labels = base.split('.')
  const head = labels[0] ?? 'stub'
  const service = head.replace(/[^a-z0-9-]/g, '-')
  return service === '' ? 'stub' : service
}

function suggestComposeService(host: string): string {
  return `${suggestService(host)}-stub`
}

export function refusedRegistryLine(pr: number): string {
  return `qare-refused: #${pr}`
}

export function parseRefusedRegistry(text: string): number[] {
  const prs = new Set<number>()
  for (const match of String(text ?? '').matchAll(/qare-refused: #(\d+)/g)) {
    if (match[1] !== undefined) prs.add(Number(match[1]))
  }
  return [...prs].sort((a, b) => a - b)
}

export function requeueTargets(mergedKeys: string[], refused: StubIssueRefusedEntry[]): number[] {
  const wanted = new Set(mergedKeys ?? [])
  const targets = new Set<number>()
  for (const entry of refused ?? []) {
    if (!entry || typeof entry.pr !== 'number' || !Number.isFinite(entry.pr)) continue
    for (const key of entry.keys ?? []) {
      if (wanted.has(key)) {
        targets.add(entry.pr)
        break
      }
    }
  }
  return [...targets].sort((a, b) => a - b)
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
