import { expect, test } from 'vitest'
import { statusReportMarker, sweepFindingMarker } from '@qare/core'
import type { SweepPayload } from '@qare/core'
import { GitHubClient } from '../src/github.js'
import { GitHubStatusReportUpdater, fileSweepFinding, parseSweepPayload, publishSweep } from '../src/sweep-report.js'
import { FAKE_TOKEN, startFakeGithub, type FakeGithub } from './fake-github.js'

function makeClient(fake: FakeGithub): GitHubClient {
  return new GitHubClient({ repository: 'octocat/qare', apiRoot: fake.url, token: FAKE_TOKEN })
}

function payload(overrides: Partial<SweepPayload> = {}): SweepPayload {
  return {
    at: '2026-09-29T00:00:00Z',
    ledger: '.qa',
    classification: { proven: ['c1'], stale: [], unverified: ['c2'], quarantined: [], refused: [] },
    findings: [],
    lastActor: 'run-1',
    ...overrides,
  }
}

test('publishSweep creates the standing report when none exists', async () => {
  const fake = await startFakeGithub()
  try {
    const { status } = await publishSweep(makeClient(fake), payload())
    expect(status).toBe(100)
    expect(fake.issues.get(100)?.title).toBe('QARE standing report')
    expect(fake.issues.get(100)?.body).toContain(statusReportMarker())
    expect(fake.issues.get(100)?.body).toContain('proven: 1 stale: 0 unverified: 1 quarantined: 0 refused: 0')
  } finally {
    await fake.close()
  }
})

test('publishSweep updates the standing report in place instead of opening a new one', async () => {
  const fake = await startFakeGithub()
  try {
    fake.issueMeta.set(7, { state: 'open', labels: [], author: 'github-actions[bot]' })
    fake.issues.set(7, {
      number: 7,
      title: 'QARE standing report',
      body: `${statusReportMarker()}\n\n# QARE standing report\n\nproven: 0 stale: 0 unverified: 0 quarantined: 0 refused: 0`,
      comments: [],
    })
    await publishSweep(makeClient(fake), payload())
    expect(fake.issues.get(7)?.body).toContain('proven: 1 stale: 0 unverified: 1 quarantined: 0 refused: 0')
    expect(fake.calls.some((call) => call.method === 'POST' && call.path.endsWith('/issues'))).toBe(false)
  } finally {
    await fake.close()
  }
})

test('upsert patches the body of the issue the marker finds', async () => {
  const fake = await startFakeGithub()
  try {
    fake.issueMeta.set(7, { state: 'open', labels: [], author: 'github-actions[bot]' })
    fake.issues.set(7, { number: 7, title: 'QARE standing report', body: statusReportMarker(), comments: [] })
    const updater = new GitHubStatusReportUpdater(makeClient(fake))
    const issue = await updater.upsert({ title: 'QARE standing report', body: `${statusReportMarker()}\n\nfresh` })
    expect(issue).toBe(7)
    expect(fake.issues.get(7)?.body).toContain('fresh')
  } finally {
    await fake.close()
  }
})

test('publishSweep files one issue per finding, mentioning the actor', async () => {
  const fake = await startFakeGithub()
  try {
    const { status, findings } = await publishSweep(
      makeClient(fake),
      payload({
        classification: { proven: [], stale: [], unverified: [], quarantined: [], refused: [] },
        findings: [{ fingerprint: 'sweep:config-invalid', reason: 'sweep.json is invalid: default: bad', actor: 'jason' }],
      }),
    )
    expect(status).toBe(100)
    expect(findings).toEqual([['sweep:config-invalid', 101]])
    expect(fake.issues.get(101)?.title).toBe('QARE sweep finding: sweep:config-invalid')
    expect(fake.issues.get(101)?.body).toContain(sweepFindingMarker('sweep:config-invalid'))
    expect(fake.issues.get(101)?.body).toContain('@jason')
  } finally {
    await fake.close()
  }
})

test('a finding already filed is updated in place, not duplicated', async () => {
  const fake = await startFakeGithub()
  try {
    fake.issueMeta.set(9, { state: 'open', labels: [], author: 'github-actions[bot]' })
    fake.issues.set(9, {
      number: 9,
      title: 'QARE sweep finding: sweep:config-invalid',
      body: sweepFindingMarker('sweep:config-invalid'),
      comments: [],
    })
    const { findings } = await publishSweep(
      makeClient(fake),
      payload({
        classification: { proven: [], stale: [], unverified: [], quarantined: [], refused: [] },
        findings: [{ fingerprint: 'sweep:config-invalid', reason: 'sweep.json is invalid: default: bad', actor: 'jason' }],
      }),
    )
    expect(findings).toEqual([['sweep:config-invalid', 9]])
    expect(fake.issues.get(9)?.body).toContain('@jason')
  } finally {
    await fake.close()
  }
})

test('fileSweepFinding files directly against a client', async () => {
  const fake = await startFakeGithub()
  try {
    const issue = await fileSweepFinding(makeClient(fake), {
      fingerprint: 'sweep:held-result-unreadable',
      reason: 'held-result.json is unreadable: no such file',
      actor: 'unknown',
    })
    expect(issue).toBe(100)
    expect(fake.issues.get(100)?.body).not.toContain('@unknown')
  } finally {
    await fake.close()
  }
})

test('parseSweepPayload validates the payload the CLI wrote', () => {
  expect(parseSweepPayload(payload()).at).toBe('2026-09-29T00:00:00Z')
  expect(() => parseSweepPayload(null)).toThrow(/must be a JSON object/)
  expect(() => parseSweepPayload({ at: '', classification: {}, findings: [] })).toThrow(/needs an "at" timestamp/)
  expect(() => parseSweepPayload({ ...payload(), classification: { proven: 'no' } })).toThrow(
    /classification.proven must be an array of criterion ids/,
  )
  expect(() => parseSweepPayload({ ...payload(), findings: [{ fingerprint: '' }] })).toThrow(/needs a "fingerprint"/)
  expect(parseSweepPayload(payload({ lastActor: undefined })).lastActor).toBeUndefined()
  expect(parseSweepPayload(payload({ lastActor: 'x' })).lastActor).toBe('x')
})

for (const author of ['someone-else', undefined]) {
  test(`sweep leaves a standing report with author ${author ?? 'unread'} untouched`, async () => {
    const fake = await startFakeGithub()
    try {
      const body = statusReportMarker()
      fake.issues.set(7, { number: 7, title: 'report', body, comments: [] })
      if (author !== undefined) fake.issueMeta.set(7, { state: 'open', labels: [], author })
      expect((await publishSweep(makeClient(fake), payload())).status).toBe(100)
      expect(fake.issues.get(7)?.body).toBe(body)
      expect(fake.calls.filter((call) => call.method === 'PATCH')).toEqual([])
    } finally {
      await fake.close()
    }
  })

  test(`sweep leaves a finding with author ${author ?? 'unread'} untouched`, async () => {
    const fake = await startFakeGithub()
    try {
      const fingerprint = 'sweep:config-invalid'
      const body = sweepFindingMarker(fingerprint)
      fake.issues.set(9, { number: 9, title: 'finding', body, comments: [] })
      if (author !== undefined) fake.issueMeta.set(9, { state: 'open', labels: [], author })
      expect(await fileSweepFinding(makeClient(fake), { fingerprint, reason: 'invalid', actor: 'unknown' })).toBe(100)
      expect(fake.issues.get(9)?.body).toBe(body)
      expect(fake.calls.filter((call) => call.method === 'PATCH')).toEqual([])
    } finally {
      await fake.close()
    }
  })
}
