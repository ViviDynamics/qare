import { describe, expect, test } from 'vitest'
import { mergeVerdicts, matchesStub, summarizeEgress, type EgressAttempt } from '../src/index.js'

const attempt = (host: string, port: number, protocol: string): EgressAttempt => ({
  host,
  port,
  protocol,
})

describe('matchesStub', () => {
  test('exact host match', () => {
    expect(matchesStub('api.billing-vendor.example', [{ hosts: ['api.billing-vendor.example'] }])).toBe(true)
  })

  test('unmatched host', () => {
    expect(matchesStub('evil.example', [{ hosts: ['api.billing-vendor.example'] }])).toBe(false)
  })

  test('wildcard matches a single-label subdomain', () => {
    expect(matchesStub('api.example.com', [{ hosts: ['*.example.com'] }])).toBe(true)
  })

  test('wildcard does not match the bare domain', () => {
    expect(matchesStub('example.com', [{ hosts: ['*.example.com'] }])).toBe(false)
  })

  test('wildcard does not match multi-label subdomains', () => {
    expect(matchesStub('a.b.example.com', [{ hosts: ['*.example.com'] }])).toBe(false)
  })

  test('empty stub map matches nothing', () => {
    expect(matchesStub('api.example.com', [])).toBe(false)
  })
})

describe('summarizeEgress', () => {
  test('an attempt to an unstubbed host is refused naming the host', () => {
    const result = summarizeEgress([attempt('api.mailgun.net', 443, 'https')], [
      { hosts: ['api.billing-vendor.example'] },
    ])
    expect(result.verdict).toBe('refused')
    expect(result.findings).toEqual([
      { kind: 'refused', reason: 'refused: missing stub: api.mailgun.net:443 (https)', count: 1 },
    ])
  })

  test('attempts to stubbed hosts are allowed with no findings', () => {
    const stubs = [{ hosts: ['api.billing-vendor.example', '*.example.com'] }]
    const result = summarizeEgress(
      [attempt('api.billing-vendor.example', 443, 'https'), attempt('api.example.com', 443, 'https')],
      stubs,
    )
    expect(result.findings).toEqual([])
    expect(result.verdict).toBe('allowed')
  })

  test('identical tuples deduplicate; different ports are different findings', () => {
    const result = summarizeEgress(
      [
        attempt('api.mailgun.net', 443, 'https'),
        attempt('api.mailgun.net', 443, 'https'),
        attempt('api.mailgun.net', 25, 'tcp'),
      ],
      [],
    )
    expect(result.verdict).toBe('refused')
    expect(result.findings).toEqual([
      { kind: 'refused', reason: 'refused: missing stub: api.mailgun.net:443 (https)', count: 2 },
      { kind: 'refused', reason: 'refused: missing stub: api.mailgun.net:25 (tcp)', count: 1 },
    ])
  })

  test('empty stub map refuses any attempts', () => {
    const result = summarizeEgress([attempt('localhost', 3000, 'http')], [])
    expect(result.verdict).toBe('refused')
    expect(result.findings).toHaveLength(1)
  })
})

test('hostile and malformed attempt records become refused findings, never crashes', () => {
  const { findings, verdict } = summarizeEgress(
    [
      { host: null, port: 443, protocol: 'https' },
      { host: 'api.example.com\nGET /admin', port: 80, protocol: 'http' },
      { host: 42, port: Number.NaN, protocol: { evil: true } },
    ],
    [],
  )
  expect(findings).toHaveLength(3)
  expect(findings.every((finding) => finding.kind === 'refused')).toBe(true)
  expect(findings[0]?.reason).toContain('refused: missing stub: unknown:443 (https)')
  expect(findings[1]?.reason).not.toContain('\n')
  expect(findings[2]?.reason).toContain('object')
})

test('host comparison normalizes case and trailing dots', () => {
  expect(matchesStub('API.Example.COM.', [{ hosts: ['*.example.com'] }])).toBe(true)
  expect(matchesStub('api.example.com.', [{ hosts: ['api.example.com'] }])).toBe(true)
})

test('mergeVerdicts never downgrades refusal', () => {
  expect(mergeVerdicts(['refused'])).toBe('refused')
  expect(mergeVerdicts(['passed', 'failed', 'refused'])).toBe('refused')
  expect(mergeVerdicts(['passed', 'failed'])).toBe('failed')
  expect(mergeVerdicts(['passed'])).toBe('passed')
})
