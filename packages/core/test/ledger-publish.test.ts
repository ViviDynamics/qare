import { describe, expect, test } from 'vitest'
import {
  appendChange,
  parseLedgerDocument,
  serializeLedgerDocument,
  type LedgerChange,
  type LedgerEntry,
} from '../src/ledger.js'
import { renderCriteriaMarkdown, renderHistoryMarkdown, verificationBuckets } from '../src/ledger-publish.js'

const SOURCE = [['https:', '//example.test/pr/1'].join('')]

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    criterion: 'spec-up-200',
    status: 'active',
    source: SOURCE,
    proof: 'command',
    ...overrides,
  }
}

function documentFor(entries: LedgerEntry[], changes: LedgerChange[] = []) {
  return parseLedgerDocument(JSON.parse(serializeLedgerDocument(entries, changes)))
}

function record(seq: number, kind: string, criteria: string[]): Parameters<typeof appendChange>[1] {
  return {
    kind: kind as never,
    actor: 'actor',
    timestamp: `2026-09-2${seq}T00:00:0${seq}Z`,
    reason: `reason ${seq}`,
    criteria,
  }
}

describe('verificationBuckets', () => {
  test('proposed criteria are unverified', () => {
    const changes = appendChange([], record(1, 'ingest', ['proposed-a']))
    const buckets = verificationBuckets([entry({ criterion: 'proposed-a', status: 'proposed' })], changes)
    expect(buckets).toEqual({ unverified: ['proposed-a'], stale: [], quarantined: [] })
  })

  test('an active criterion no run verified since its last change is stale', () => {
    const changes = appendChange(appendChange([], record(1, 'verify', ['active-a'])), record(2, 'supersede', ['active-a']))
    const buckets = verificationBuckets([entry({ criterion: 'active-a' })], changes)
    expect(buckets.stale).toEqual(['active-a'])
  })

  test('an active criterion never verified is stale', () => {
    const buckets = verificationBuckets([entry({ criterion: 'active-a' })], [])
    expect(buckets.stale).toEqual(['active-a'])
  })

  test('an active criterion verified after its last change is neither unverified nor stale', () => {
    const changes = appendChange(appendChange([], record(1, 'ingest', ['active-a'])), record(2, 'verify', ['active-a']))
    const buckets = verificationBuckets([entry({ criterion: 'active-a' })], changes)
    expect(buckets).toEqual({ unverified: [], stale: [], quarantined: [] })
  })

  test('superseded and retired criteria stay out of every bucket', () => {
    const entries = [entry({ criterion: 'gone-a', status: 'retired' }), entry({ criterion: 'gone-b', status: 'superseded' })]
    expect(verificationBuckets(entries, [])).toEqual({ unverified: [], stale: [], quarantined: [] })
  })

  test('quarantined criteria are named and pulled out of the other buckets', () => {
    const entries = [
      entry({ criterion: 'held-a', status: 'proposed' }),
      entry({ criterion: 'active-a' }),
    ]
    const buckets = verificationBuckets(entries, [], ['held-a'])
    expect(buckets).toEqual({ unverified: [], stale: ['active-a'], quarantined: ['held-a'] })
  })
})

describe('renderCriteriaMarkdown', () => {
  test('names the unverified, stale and quarantined criteria with their meaning', () => {
    const changes = appendChange(appendChange([], record(1, 'verify', ['active-a'])), record(2, 'ingest', ['active-a']))
    const document = documentFor(
      [
        entry({ criterion: 'active-a' }),
        entry({ criterion: 'proposed-a', status: 'proposed' }),
        entry({ criterion: 'held-a', status: 'proposed' }),
        entry({ criterion: 'gone-a', status: 'retired' }),
      ],
      changes,
    )
    const text = renderCriteriaMarkdown(document, ['held-a'])
    expect(text).toContain('# Criteria')
    expect(text).toContain('Current criteria: 4 total, 1 active.')
    expect(text).toContain('## Verified criteria')
    expect(text).toContain('| active-a () | command | 2026-09-21T00:00:01Z |')
    expect(text).toContain('## Unverified')
    expect(text).toContain(': proposed-a.')
    expect(text).toContain('## Stale')
    expect(text).toContain(': active-a.')
    expect(text).toContain('## Quarantined')
    expect(text).toContain(': held-a.')
    expect(text).toContain('## History keepers')
    expect(text).toContain('gone-a: retired with a reason, kept in history')
  })

  test('omits the sections that have nothing in them', () => {
    const changes = appendChange([], record(1, 'verify', ['active-a']))
    const document = documentFor([entry({ criterion: 'active-a' })], changes)
    const text = renderCriteriaMarkdown(document)
    expect(text).not.toContain('## Unverified')
    expect(text).not.toContain('## Stale')
    expect(text).not.toContain('## Quarantined')
  })
})

describe('renderHistoryMarkdown', () => {
  test('lists each recorded change with actor, time and reason', () => {
    const changes = appendChange(appendChange([], record(1, 'ingest', ['active-a'])), record(2, 'verify', ['active-a']))
    const text = renderHistoryMarkdown(changes)
    expect(text).toContain('# Ledger history')
    expect(text).toContain('- 1. ingest by actor at 2026-09-21T00:00:01Z: reason 1 (active-a)')
    expect(text).toContain('- 2. verify by actor at 2026-09-22T00:00:02Z: reason 2 (active-a)')
  })

  test('an empty history says so instead of showing nothing', () => {
    expect(renderHistoryMarkdown([])).toContain('No changes recorded yet.')
  })
})
