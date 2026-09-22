import { expect, test } from 'vitest'
import {
  missingStubs,
  missingStubsFromResult,
  stubIssueDraft,
  stubIssueMarker,
  parseStubIssueMarkers,
  refusedRegistryLine,
  parseRefusedRegistry,
  requeueTargets,
  type StubIssuePoster,
} from '../src/index.js'

const finding = (host: string, port: string, protocol: string, count = 1) => ({
  kind: 'refused' as const,
  reason: `refused: missing stub: ${host}:${port} (${protocol})`,
  count,
})

test('missingStubs parses the shipped egress finding shape', () => {
  const stubs = missingStubs([finding('api.billing-vendor.example', '443', 'https', 3)])
  expect(stubs).toEqual([{ host: 'api.billing-vendor.example', port: '443', protocol: 'https', count: 3 }])
})

test('missingStubs skips malformed and non-refused findings (fail closed, never guess a host)', () => {
  const stubs = missingStubs([
    { kind: 'refused', reason: 'refused: missing stub: no shape here', count: 1 },
    { kind: 'refused', reason: 'refused: missing stub: bad host$name:443 (https)', count: 1 },
    { kind: 'refused', reason: 'refused: missing stub: api.example.com:443', count: 1 },
    { kind: 'refused', reason: 'refused: other reason', count: 2 },
    { kind: 'refused', reason: 'refused: missing stub: ok.example.com:8443 (https)', count: 2 },
  ])
  expect(stubs).toEqual([{ host: 'ok.example.com', port: '8443', protocol: 'https', count: 2 }])
})

test('missingStubs merges by host summing counts, deterministic first-seen port and protocol', () => {
  const stubs = missingStubs([
    { kind: 'refused', reason: 'refused: missing stub: api.example.com:443 (https)', count: 1 },
    { kind: 'refused', reason: 'refused: missing stub: api.example.com:443 (https)', count: 3 },
  ])
  expect(stubs).toEqual([{ host: 'api.example.com', port: '443', protocol: 'https', count: 4 }])
})

test('missingStubs sorts by host', () => {
  const stubs = missingStubs([
    { kind: 'refused', reason: 'refused: missing stub: z.example.com:443 (https)' },
    { kind: 'refused', reason: 'refused: missing stub: a.example.com:443 (https)' },
  ])
  expect(stubs.map((entry) => entry.host)).toEqual(['a.example.com', 'z.example.com'])
})

test('stubIssueDraft is byte-identical for identical inputs and contains the YAML entry', () => {
  const draft = stubIssueDraft({ host: 'api.billing-vendor.example', port: '443', protocol: 'https', count: 3 })
  const again = stubIssueDraft({ host: 'api.billing-vendor.example', port: '443', protocol: 'https', count: 3 })
  expect(draft).toEqual(again)
  expect(draft.title).toBe('Stub needed for api.billing-vendor.example')
  expect(draft.key).toBe('api.billing-vendor.example')
  expect(draft.body).toContain(stubIssueMarker('api.billing-vendor.example'))
  expect(draft.body).toContain('```yaml')
  expect(draft.body).toContain('hosts: ["api.billing-vendor.example"]')
  expect(draft.body).toContain('provided_by: { compose_service: api-stub }')
  expect(draft.body).toContain('- api.billing-vendor.example:443 (https) — 3 attempt(s)')
  expect(draft.body).not.toMatch(/\d{4}-\d{2}-\d{2}/)
})

test('missingStubsFromResult extracts from unverified criteria only', () => {
  const result = {
    schemaVersion: '1',
    verdict: 'refused' as const,
    criteria: [
      { id: 'c1', outcome: 'unverified' as const, reason: 'refused: missing stub: api.billing-vendor.example:443 (https)' },
      { id: 'c2', outcome: 'unverified' as const, reason: 'refused: missing stub: not a shape' },
      { id: 'c3', outcome: 'proven' as const, evidence: [] },
    ],
  }
  expect(missingStubsFromResult(result)).toEqual([
    { host: 'api.billing-vendor.example', port: '443', protocol: 'https', count: 1 },
  ])
})

test('marker and registry helpers round-trip', () => {
  expect(stubIssueMarker('api.example.com')).toBe('qare-stub: api.example.com')
  expect(parseStubIssueMarkers('text\nqare-stub: api.example.com\nqare-stub: b.example.net\nqare-stub: api.example.com')).toEqual([
    'api.example.com',
    'b.example.net',
  ])
  expect(parseStubIssueMarkers('no markers')).toEqual([])
  expect(refusedRegistryLine(12)).toBe('qare-refused: #12')
  expect(parseRefusedRegistry('qare-refused: #3\nqare-refused: #12\nqare-refused: #3')).toEqual([3, 12])
})

test('requeueTargets returns deduped sorted PRs whose keys intersect the merged keys', () => {
  const merged = ['api.billing-vendor.example']
  const refused = [
    { pr: 7, keys: ['api.billing-vendor.example'] },
    { pr: 3, keys: ['api.mailgun.net'] },
    { pr: 5, keys: ['api.billing-vendor.example', 'api.mailgun.net'] },
    { pr: 5, keys: ['api.billing-vendor.example'] },
  ]
  expect(requeueTargets(merged, refused)).toEqual([5, 7])
})

test('requeueTargets is empty on disjoint keys and tolerates garbage entries', () => {
  expect(requeueTargets(['a.example.com'], [{ pr: 1, keys: ['b.example.com'] }])).toEqual([])
  expect(requeueTargets(['a.example.com'], [{ pr: Number.NaN, keys: ['a.example.com'] }, undefined as never])).toEqual([])
  expect(requeueTargets([], [{ pr: 1, keys: ['a.example.com'] }])).toEqual([])
})

test('StubIssuePoster is an interface: a conforming implementation type-checks and round-trips', async () => {
  const posted: Array<{ issue: number; pr: number }> = []
  const poster: StubIssuePoster = {
    fileIfMissing: async () => 42,
    addToRegistry: async (issue, pr) => {
      posted.push({ issue, pr })
    },
    comment: async () => {},
  }
  const issue = await poster.fileIfMissing(
    stubIssueDraft({ host: 'api.example.com', port: '443', protocol: 'https', count: 1 }),
  )
  await poster.addToRegistry(issue, 7)
  await poster.comment(7, 're-queued')
  expect(issue).toBe(42)
  expect(posted).toEqual([{ issue: 42, pr: 7 }])
})
