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
    const hosts = (stub.hosts ?? []).map((host) => sanitize(host))
    // host-overlap rule: a rename that keeps a required service's hosts cannot
    // dodge stubs-merge-first — the added stub inherits required-ness from any
    // base stub (removed or modified) whose hosts it shares
    const modifiedBase = diff?.removed?.find((base) => base.service === stub.service)
    const inheritedRequired =
      modifiedBase !== undefined && hostsOverlap(modifiedBase, stub) && required.has(modifiedBase.service) ||
      diff?.removed?.some((base) => required.has(base.service) && hostsOverlap(base, stub)) === true
    const label = modifiedBase !== undefined ? 'stub-modified-in-change' : 'stub-added-in-change'
    findings.push(
      `${label}: ${sanitize(stub.service)} (hosts: ${hosts.join(', ')})`,
    )
    verdicts.push(required.has(stub.service) || inheritedRequired ? 'refused' : 'allowed')
  }
  return { findings, verdict: mergeVerdicts(verdicts) === 'refused' ? 'refused' : 'allowed' }
}

function hostsOverlap(base: ProfileStub, head: ProfileStub): boolean {
  const baseHosts = new Set((base.hosts ?? []).map((host) => host.toLowerCase()))
  return (head.hosts ?? []).some((host) => baseHosts.has(host.toLowerCase()))
}

function sanitize(text: string): string {
  return String(text ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
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
