import { describe, expect, test } from 'vitest'
import { matchesStub, summarizeEgress, type EgressAttempt } from '../src/index.js'

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
      { kind: 'refused', reason: 'refused: missing stub: api.mailgun.net:443 (https)' },
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
      { kind: 'refused', reason: 'refused: missing stub: api.mailgun.net:443 (https)' },
      { kind: 'refused', reason: 'refused: missing stub: api.mailgun.net:25 (tcp)' },
    ])
  })

  test('empty stub map refuses any attempts', () => {
    const result = summarizeEgress([attempt('localhost', 3000, 'http')], [])
    expect(result.verdict).toBe('refused')
    expect(result.findings).toHaveLength(1)
  })
})
