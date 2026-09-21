import { mergeVerdicts } from './egress.js'
import type { ProfileStub } from './profile.js'

export interface StubDiff {
  added: ProfileStub[]
  removed: ProfileStub[]
  unchanged: ProfileStub[]
}

const byService = (a: ProfileStub, b: ProfileStub): number =>
  a.service < b.service ? -1 : a.service > b.service ? 1 : 0

export function diffStubs(base: ProfileStub[], head: ProfileStub[]): StubDiff {
  const baseByKey = stubsByService(base)
  const headByKey = stubsByService(head)
  const added: ProfileStub[] = []
  const removed: ProfileStub[] = []
  const unchanged: ProfileStub[] = []
  for (const [service, headStub] of headByKey) {
    const baseStub = baseByKey.get(service)
    if (baseStub === undefined) {
      added.push(headStub)
    } else if (sameStub(baseStub, headStub)) {
      unchanged.push(headStub)
    } else {
      added.push(headStub)
      removed.push(baseStub)
    }
  }
  for (const [service, baseStub] of baseByKey) {
    if (!headByKey.has(service)) removed.push(baseStub)
  }
  return {
    added: added.sort(byService),
    removed: removed.sort(byService),
    unchanged: unchanged.sort(byService),
  }
}

export function flagAddedStubs(
  diff: StubDiff,
  opts: { requiredServices: string[] },
): { findings: string[]; verdict: 'refused' | 'allowed' } {
  const required = new Set(opts?.requiredServices ?? [])
  const findings: string[] = []
  const verdicts: Array<'refused' | 'allowed'> = []
  for (const stub of diff?.added ?? []) {
    findings.push(`stub-added-in-change: ${stub.service} (hosts: ${(stub.hosts ?? []).join(', ')})`)
    verdicts.push(required.has(stub.service) ? 'refused' : 'allowed')
  }
  return { findings, verdict: mergeVerdicts(verdicts) === 'refused' ? 'refused' : 'allowed' }
}

function stubsByService(stubs: ProfileStub[]): Map<string, ProfileStub> {
  const byService = new Map<string, ProfileStub>()
  for (const stub of stubs ?? []) byService.set(stub.service, stub)
  return byService
}

function sameStub(a: ProfileStub, b: ProfileStub): boolean {
  const aHosts = [...(a.hosts ?? [])].sort()
  const bHosts = [...(b.hosts ?? [])].sort()
  if (aHosts.length !== bHosts.length) return false
  for (let i = 0; i < aHosts.length; i++) {
    if (aHosts[i] !== bHosts[i]) return false
  }
  return (a.provided_by?.compose_service ?? '') === (b.provided_by?.compose_service ?? '')
}
