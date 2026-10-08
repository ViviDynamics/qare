import { expect, test } from 'vitest'
import {
  FLEET_SUMMARY_MARKER,
  FleetConfigError,
  METRICS_SCHEMA_VERSION,
  coverageOf,
  fleetAttention,
  fleetAttentionKey,
  fleetAttentionKeyOf,
  fleetLedger,
  fleetRunOf,
  fleetSummaryDraft,
  parseFleetConfig,
  renderFleetReport,
  type FleetRepositoryState,
} from '../src/index.js'

// #151: every repository qare runs in, on one page, built from what each
// already publishes. This is the pure half: the config, what needs
// attention, and the page.

const AT = '2026-10-08T12:00:00.000Z'

function healthy(repository: string, extra: Partial<FleetRepositoryState> = {}): FleetRepositoryState {
  return {
    repository,
    ledger: { size: 4, proven: 4, stale: [], unverified: 0 },
    runs: [{ runId: 'pr-12', recordedAt: '2026-10-08T09:00:00.000Z', verdict: 'passed', pr: 12, counts: { proven: 4 } }],
    issues: { regression: [], environment: [], failure: [] },
    ...extra,
  }
}

test('the fleet is the repositories its config lists, each with the branch and the ledger directory it is read from', () => {
  expect(parseFleetConfig({ repositories: ['acme/web', { repository: 'acme/api', branch: 'trunk', ledger: 'qa/ledger' }], runs: 3 })).toEqual({
    repositories: [
      { repository: 'acme/web', branch: 'main', ledger: '.qa' },
      { repository: 'acme/api', branch: 'trunk', ledger: 'qa/ledger' },
    ],
    runs: 3,
  })
  expect(parseFleetConfig({ repositories: ['acme/web'] }).runs).toBe(5)
})

test.each([
  [[], /fleet config must be a JSON object/],
  [{}, /repositories.*non-empty list/],
  [{ repositories: [] }, /repositories.*non-empty list/],
  [{ repositories: ['acme'] }, /repositories\[0\]\.repository.*owner\/name/],
  [{ repositories: ['acme/web', 'Acme/Web'] }, /repositories\[1\]\.repository.*listed twice/],
  [{ repositories: [{ repository: 'acme/web', branch: '../main' }] }, /repositories\[0\]\.branch.*plain path/],
  [{ repositories: [{ repository: 'acme/web', ledger: 'a/../b' }] }, /repositories\[0\]\.ledger.*plain path/],
  [{ repositories: [{ repository: 'acme/web', brnach: 'main' }] }, /repositories\[0\]\.brnach.*not brnach/],
  [{ repositories: ['acme/web'], repos: [] }, /repos.*takes repositories and runs/],
  [{ repositories: ['acme/web'], runs: 0 }, /runs.*whole number from 1 to 50/],
  [{ repositories: [7] }, /repositories\[0\].*owner\/name/],
])('a fleet config that is not what it should be is refused, naming the field: %j', (input, message) => {
  expect(() => parseFleetConfig(input)).toThrow(FleetConfigError)
  expect(() => parseFleetConfig(input)).toThrow(message)
})

test('a ledger is counted from its standing picture, and its coverage is the share proven and current', () => {
  const ledger = fleetLedger({ proven: ['a', 'b', 'c'], stale: ['d'], unverified: ['e', 'f'], quarantined: [], refused: [] })
  // What the ledger's own record says. Quarantined and refused are a repository's last held result, which the fleet does not read, so it reports neither.
  expect(ledger).toEqual({ size: 6, proven: 3, stale: ['d'], unverified: 2 })
  expect(ledger).not.toHaveProperty('quarantined')
  expect(ledger).not.toHaveProperty('refused')
  expect(coverageOf(ledger)).toBe(50)
  expect(coverageOf(fleetLedger({ proven: [], stale: [], unverified: [], quarantined: [], refused: [] }))).toBeUndefined()
})

test('a run is read from its metrics record, and what is not a record is not a run', () => {
  const whole = { schemaVersion: METRICS_SCHEMA_VERSION, runId: 'pr-12', recordedAt: '2026-10-08T09:00:00Z', startedAt: '2026-10-08T08:50:00Z', finishedAt: '2026-10-08T09:00:00Z', wallMs: 600000, verdict: 'blocked', criteria: { selected: [], counts: { proven: 2, unverified: 1, odd: -1, text: 'x' } }, context: { pr: 12 } }
  expect(fleetRunOf(whole)).toEqual({ runId: 'pr-12', recordedAt: '2026-10-08T09:00:00.000Z', verdict: 'blocked', pr: 12, counts: { proven: 2, unverified: 1 } })
  expect(fleetRunOf({ ...whole, recordedAt: 'yesterday' })).toBeUndefined()
  // A file that merely carries a verdict is not a run: it is held to the metrics record's whole shape, schema version included.
  expect(fleetRunOf({ runId: 'pr-12', recordedAt: '2026-10-08T09:00:00Z', verdict: 'passed' })).toBeUndefined()
  expect(fleetRunOf({ ...whole, schemaVersion: '0', verdict: 'passed' })).toBeUndefined()
  expect(fleetRunOf({ ...whole, criteria: undefined, verdict: 'passed' })).toBeUndefined()
  expect(fleetRunOf({ ...whole, wallMs: 'long', verdict: 'passed' })).toBeUndefined()
  expect(fleetRunOf(['not', 'a', 'record'])).toBeUndefined()
  expect(fleetRunOf(null)).toBeUndefined()
})

test('a healthy fleet needs no attention, and the summary says so', () => {
  const states = [healthy('acme/web'), healthy('acme/api')]
  expect(fleetAttention(states)).toEqual([])
  const summary = fleetSummaryDraft(states, AT)
  expect(summary.body).toContain(FLEET_SUMMARY_MARKER)
  expect(summary.body).toContain('Nothing, as of 2026-10-08T12:00:00.000Z')
  expect(fleetAttentionKeyOf(summary.body)).toBe(summary.key)
})

test('a regression, a stale criterion, a latest run that did not pass and an open environment or failure issue each need attention, in any repository', () => {
  const states = [
    healthy('acme/web', {
      issues: { regression: [{ number: 31, title: 'checkout total is wrong' }], environment: [{ number: 32, title: 'nothing booted' }], failure: [{ number: 33, title: 'never passed' }] },
    }),
    healthy('acme/api', { ledger: { size: 4, proven: 3, stale: ['API-7'], unverified: 0 } }),
    healthy('acme/jobs', { runs: [{ runId: 'pr-4', recordedAt: '2026-10-08T10:00:00.000Z', verdict: 'refused', pr: 4, counts: { unverified: 2 } }, { runId: 'pr-3', recordedAt: '2026-10-07T10:00:00.000Z', verdict: 'passed', counts: {} }] }),
    healthy('acme/quiet'),
  ]
  const attention = fleetAttention(states)
  expect(attention.map((item) => [item.repository, item.kind, item.subject])).toEqual([
    ['acme/api', 'stale', 'API-7'],
    ['acme/jobs', 'run', 'pr-4'],
    ['acme/web', 'regression', '#31'],
    ['acme/web', 'environment', '#32'],
    ['acme/web', 'failure', '#33'],
  ])
  const page = renderFleetReport(states, AT)
  expect(page).toContain('4 repositories; 5 things need attention.')
  expect(page).toContain('| `acme/web` | `passed` (2026-10-08) | 1 | 4 criteria | 100% | 0 | yes (3) |')
  expect(page).toContain('| `acme/api` | `passed` (2026-10-08) | 0 | 4 criteria | 75% | 1 | yes (1) |')
  expect(page).toContain('| `acme/jobs` | `refused` (2026-10-08) | 0 | 4 criteria | 100% | 0 | yes (1) |')
  expect(page).toContain('| `acme/quiet` | `passed` (2026-10-08) | 0 | 4 criteria | 100% | 0 | no |')
  expect(page).toContain('- Stale criteria: `API-7`')
  expect(page).toContain('- Open `qa-regression` issue `#31`: `checkout total is wrong`')
  expect(page).toContain('  - 2026-10-08: `refused`, pull request `#4`, 2 `unverified` (run `pr-4`)')
  // Only the latest run counts: an older one that failed is history, not a thing to look at.
  expect(fleetAttention([healthy('acme/web', { runs: [{ runId: 'b', recordedAt: '2026-10-08T10:00:00.000Z', verdict: 'passed', counts: {} }, { runId: 'a', recordedAt: '2026-10-07T10:00:00.000Z', verdict: 'failed', counts: {} }] })])).toEqual([])
})

test('a part that could not be read is said to be unread, with the reason, and needs attention: it is never shown as healthy', () => {
  const dark: FleetRepositoryState = {
    repository: 'acme/private',
    ledger: { unread: 'GitHub answered 404 Not Found' },
    runs: { unread: 'GitHub answered 404 Not Found' },
    issues: { unread: 'GitHub answered 403 Resource not accessible by integration' },
  }
  const attention = fleetAttention([dark])
  expect(attention.map((item) => [item.kind, item.subject])).toEqual([['unread', 'ledger'], ['unread', 'runs'], ['unread', 'issues']])
  const page = renderFleetReport([dark], AT)
  expect(page).toContain('| `acme/private` | unread | unread | unread |  |  | yes (3) |')
  expect(page).toContain('- Ledger: could not be read: `GitHub answered 404 Not Found`')
  expect(page).not.toContain('100%')
  // A repository with no ledger and no recorded run is said to have none, which is not the same as unread.
  const empty = renderFleetReport([{ repository: 'acme/new', ledger: 'absent', runs: [], issues: { regression: [], environment: [], failure: [] } }], AT)
  expect(empty).toContain('| `acme/new` | no run recorded | 0 | none |  |  | no |')
  expect(empty).toContain('nothing needs attention')
})

test('text that came from a repository never renders, links or mentions, and no issue number becomes a reference', () => {
  const hostile = healthy('acme/web', {
    issues: { regression: [{ number: 7, title: '@everyone see [this](javascript:alert(1)) | `x` acme/api#3\nnext line' }], environment: [], failure: [] },
    runs: [{ runId: '@team/run', recordedAt: '2026-10-08T10:00:00.000Z', verdict: '@owner failed', pr: 9, counts: { '@all': 1 } }],
    ledger: { size: 1, proven: 0, stale: ['@someone'], unverified: 0 },
  })
  for (const text of [renderFleetReport([hostile], AT), fleetSummaryDraft([hostile], AT).body]) {
    // Every occurrence of the hostile text sits inside a code span.
    const outside = text.replace(/`[^`\n]*`/g, '')
    expect(outside).not.toContain('@')
    expect(outside).not.toContain('](')
    expect(outside).not.toMatch(/#\d/)
    expect(outside).not.toContain('acme/api#3')
    expect(text).not.toContain('next line\n')
  }
})

test('the summary changes only when what needs attention changes: its key ignores the time and the wording', () => {
  const regression = healthy('acme/web', { issues: { regression: [{ number: 31, title: 'checkout total is wrong' }], environment: [], failure: [] } })
  const first = fleetSummaryDraft([regression, healthy('acme/api')], AT, 'the report page')
  const later = fleetSummaryDraft([healthy('acme/api'), { ...regression, issues: { regression: [{ number: 31, title: 'checkout total is wrong (retitled)' }], environment: [], failure: [] } }], '2026-10-09T12:00:00.000Z')
  expect(later.key).toBe(first.key)
  expect(first.body).toContain('1 thing, as of')
  expect(first.body).toContain('- open qa-regression issue `#31`: `checkout total is wrong`')
  expect(first.body).toContain('The whole report: the report page')

  const second = fleetSummaryDraft([regression, healthy('acme/api', { ledger: { size: 4, proven: 3, stale: ['API-7'], unverified: 0 } })], AT)
  expect(second.key).not.toBe(first.key)
  expect(fleetAttentionKey([])).not.toBe(first.key)
  expect(fleetAttentionKeyOf('no marker here')).toBeUndefined()
})
