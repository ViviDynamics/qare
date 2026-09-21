export interface EgressAttempt {
  host: string
  port: number
  protocol: string
  at?: string
}

export interface EgressFinding {
  kind: 'refused'
  reason: string
  count?: number
}

export interface EgressStub {
  hosts: string[]
}

export function matchesStub(rawHost: string, stubs: EgressStub[]): boolean {
  // normalize + guard: a hostile or malformed attempt record must become a
  // refused finding, never a crash — nothing about the record is trusted
  const host = normalizeHost(rawHost)
  if (host === '') return false
  for (const stub of stubs ?? []) {
    for (const rawStubHost of stub.hosts ?? []) {
      const stubHost = normalizeHost(rawStubHost)
      if (stubHost.startsWith('*.')) {
        const suffix = stubHost.slice(1)
        if (host.endsWith(suffix)) {
          const prefix = host.slice(0, host.length - suffix.length)
          if (prefix && !prefix.includes('.')) return true
        }
      } else if (host === stubHost) {
        return true
      }
    }
  }
  return false
}

function normalizeHost(host: unknown): string {
  if (typeof host !== 'string') return ''
  return host.toLowerCase().replace(/\.$/, '').trim()
}

/**
 * Aggregate run verdicts where refusal always wins. `refused` must be
 * unmaskable: no combination of other verdicts may downgrade it.
 */
export function mergeVerdicts(
  verdicts: Array<'passed' | 'failed' | 'blocked' | 'refused' | 'unverified' | string>,
): 'passed' | 'failed' | 'blocked' | 'refused' {
  if (verdicts.includes('refused')) return 'refused'
  if (verdicts.includes('blocked')) return 'blocked'
  if (verdicts.includes('failed')) return 'failed'
  return 'passed'
}

export function summarizeEgress(
  attempts: EgressAttempt[],
  stubs: EgressStub[],
): { findings: EgressFinding[]; verdict: 'refused' | 'allowed' } {
  const seen = new Map<string, EgressFinding>()
  const order: string[] = []
  for (const attempt of attempts ?? []) {
    if (matchesStub(attempt?.host, stubs ?? [])) continue
    const host = sanitize(normalizeHost(attempt?.host) || 'unknown')
    const port = sanitize(reasonPart(attempt?.port))
    const protocol = sanitize(reasonPart(attempt?.protocol))
    const key = `${host}:${port} (${protocol})`
    const existing = seen.get(key)
    if (existing !== undefined) {
      existing.count = (existing.count ?? 1) + 1
      continue
    }
    order.push(key)
    seen.set(key, { kind: 'refused', reason: `refused: missing stub: ${key}`, count: 1 })
  }
  const findings = order.map((key) => seen.get(key) as EgressFinding)
  return { findings, verdict: findings.length > 0 ? 'refused' : 'allowed' }
}

function reasonPart(value: unknown): string {
  if (value === null || value === undefined) return 'unknown'
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return typeof value
}

function sanitize(text: string): string {
  return text.replace(/[\r\n]+/g, ' ')
}
