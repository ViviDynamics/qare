export interface EgressAttempt {
  host: string
  port: number
  protocol: 'http' | 'https' | 'tcp' | string
  at?: string
}

export interface EgressFinding {
  kind: 'refused'
  reason: string
}

export interface EgressStub {
  hosts: string[]
}

export function matchesStub(host: string, stubs: EgressStub[]): boolean {
  for (const stub of stubs ?? []) {
    for (const stubHost of stub.hosts ?? []) {
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

export function summarizeEgress(
  attempts: EgressAttempt[],
  stubs: EgressStub[],
): { findings: EgressFinding[]; verdict: 'refused' | 'allowed' } {
  const seen = new Set<string>()
  const findings: EgressFinding[] = []
  for (const egressAttempt of attempts ?? []) {
    if (matchesStub(egressAttempt.host, stubs ?? [])) continue
    const key = `${egressAttempt.host}:${egressAttempt.port} (${egressAttempt.protocol})`
    if (seen.has(key)) continue
    seen.add(key)
    findings.push({
      kind: 'refused',
      reason: `refused: missing stub: ${egressAttempt.host}:${egressAttempt.port} (${egressAttempt.protocol})`,
    })
  }
  return { findings, verdict: findings.length > 0 ? 'refused' : 'allowed' }
}
