import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { MAIN_PASSES_PATH, parseMainPasses, serializeLedgerDocument, type LedgerEntry } from '@qare/core'
import { GitHubClient } from '../src/github.js'
import { main } from '../src/index.js'
import { GitHubQaAssetsPusher } from '../src/qa-assets.js'
import { FAKE_TOKEN, startFakeGithub, type FakeGithub } from './fake-github.js'

// #295: a run on the default branch records what it proved, beside the
// ledger on the qa-assets branch, and a later failure is filed as a
// regression against that pass and traced to the changes since. Everything
// here runs `qare-action main-findings` the way the main lane's judge step
// does, against the fake of GitHub's API.

const PASSED_AT = 'a1'.repeat(20)
const FAILED_AT = 'b2'.repeat(20)
const PASSED_DATE = '2026-10-08T12:00:00Z'
// Assembled, never literal: no network marker sits as a literal in a test.
const runUrl = (id: number): string => ['https:', `//github.example/octocat/qare/actions/runs/${id}`].join('')

const ENTRIES: LedgerEntry[] = [
  { criterion: 'BIL-014', status: 'active', source: ['suite:billing'], proof: 'flow', text: 'A host sees the 1099 notice.', checks: ['suite:billing', 'app/payouts'] },
  { criterion: 'BIL-021', status: 'active', source: ['suite:billing'], proof: 'flow', text: 'The receipt is sent once.', checks: ['suite:receipts'] },
  { criterion: 'NOT-YET', status: 'proposed', source: ['suite:billing'], proof: 'flow', text: 'Proposed.', checks: ['suite:billing'] },
]

let fake: FakeGithub
let dir: string
let out: string[]
let err: string[]

beforeEach(async () => {
  fake = await startFakeGithub()
  out = []
  err = []
  for (const name of ['QARE_APP_ID', 'QARE_APP_PRIVATE_KEY', 'QARE_GITHUB_TOKEN']) vi.stubEnv(name, '')
  vi.stubEnv('GITHUB_TOKEN', FAKE_TOKEN)
  vi.stubEnv('GITHUB_RUN_ID', '77')
  vi.stubEnv('GITHUB_RUN_ATTEMPT', '1')
  dir = await mkdtemp(join(tmpdir(), 'qare-main-passes-'))
  // The ledger has no history of a pass: the only record of one is the one a run writes.
  await writeFile(join(dir, 'ledger.json'), serializeLedgerDocument(ENTRIES, []))
  // The revision the first run checks. A pull request brought it, by bob: it passed, so bob is never to blame.
  fake.commitLog.push({ sha: PASSED_AT, message: 'Add receipts (#11)', date: PASSED_DATE })
  fake.commitPulls.set(PASSED_AT, [11])
  fake.pullRecords.set(11, { title: 'Add receipts', author: { login: 'bob', type: 'User' }, merged: true, files: ['app/payouts/a.rb'], reviews: [] })
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await fake.close()
})

async function result(verdict: string, outcomes: Record<string, 'proven' | 'failed' | 'unverified'>): Promise<string> {
  const path = join(dir, `judged-${Math.random().toString(16).slice(2)}.json`)
  const criteria = Object.entries(outcomes).map(([id, outcome]) =>
    outcome === 'unverified' ? { id, outcome, reason: 'boot did not come up' } : { id, outcome, evidence: [`checks/${id}/0/stdout.txt`] },
  )
  await writeFile(path, JSON.stringify({ schemaVersion: '1', verdict, criteria }))
  return path
}

function run(resultPath: string, sha: string, extra: string[] = []): Promise<number> {
  return main(
    ['main-findings', '--result', resultPath, '--ledger', dir, '--sha', sha, '--repository', 'octocat/qare', '--api-root', fake.url, ...extra],
    { write: (chunk) => out.push(chunk) },
    { write: (chunk) => err.push(chunk) },
  )
}

function client(): GitHubClient {
  return new GitHubClient({ repository: 'octocat/qare', apiRoot: fake.url, token: FAKE_TOKEN })
}

async function recorded(): Promise<ReturnType<typeof parseMainPasses> | undefined> {
  const content = await client().getContents(MAIN_PASSES_PATH, 'qa-assets')
  return content === undefined ? undefined : parseMainPasses(content.toString('utf8'))
}

const writes = (): string[] => fake.calls.filter((call) => call.method !== 'GET').map((call) => `${call.method} ${call.path}`)

/** The mentions a reader of the Markdown is notified by: at signs outside code spans. */
function mentionsIn(markdown: string): string[] {
  const visible = markdown.replace(/(`+)[\s\S]*?\1/g, '')
  return [...visible.matchAll(/@([A-Za-z0-9][A-Za-z0-9/._-]*)/g)].map((match) => match[1] ?? '')
}

test('a run that proves criteria records a pass for each, on qa-assets, naming the revision, when it was committed and the run', async () => {
  const passing = await result('passed', { 'BIL-014': 'proven', 'BIL-021': 'proven', 'NOT-YET': 'proven' })
  expect(await run(passing, PASSED_AT, ['--record-passes', 'true', '--run-url', runUrl(77)])).toBe(0)
  expect(err.join('')).toBe('')
  expect(out.join('')).toBe(
    `no finding on main to file, update or close\nrecorded a pass for 2 criteria at ${PASSED_AT.slice(0, 12)} on qa-assets (${MAIN_PASSES_PATH}): BIL-014, BIL-021\n`,
  )
  const store = await recorded()
  // Only what the ledger carries as active: a proposed criterion has no pass to record.
  expect(Object.keys(store?.passes ?? {})).toEqual(['BIL-014', 'BIL-021'])
  expect(store?.passes['BIL-014']).toMatchObject({ sha: PASSED_AT, at: PASSED_DATE, run: runUrl(77) })
  // Nothing but the qa-assets branch was written, and no issue.
  expect(fake.issues.size).toBe(0)
  expect(writes().every((write) => / \/repos\/octocat\/qare\/git\//.test(write))).toBe(true)
  expect([...fake.refs.keys()]).toEqual(['refs/heads/qa-assets'])
})

test('a later failure is filed as a regression against the recorded pass, and blames the change since, not the one that passed', async () => {
  expect(await run(await result('passed', { 'BIL-014': 'proven', 'BIL-021': 'proven' }), PASSED_AT, ['--record-passes', 'true', '--run-url', runUrl(77)])).toBe(0)
  // A day later a pull request by alice lands, and the next run fails one criterion.
  fake.commitLog.push({ sha: FAILED_AT, message: 'Rework payouts (#12)', date: '2026-10-09T09:00:00Z' })
  fake.commitPulls.set(FAILED_AT, [12])
  fake.pullRecords.set(12, { title: 'Rework payouts', author: { login: 'alice', type: 'User' }, merged: true, files: ['app/payouts/notice.rb'], reviews: [] })
  out = []
  expect(await run(await result('failed', { 'BIL-014': 'failed', 'BIL-021': 'proven' }), FAILED_AT, ['--record-passes', 'true', '--run-url', runUrl(78)])).toBe(0)
  expect(err.join('')).toBe('')
  expect(out.join('')).toBe(
    `opened #100 for BIL-014 (qa-regression), mentioning alice\nrecorded a pass for 1 criteria at ${FAILED_AT.slice(0, 12)} on qa-assets (${MAIN_PASSES_PATH}): BIL-021\n`,
  )
  expect(fake.issueMeta.get(100)).toMatchObject({ state: 'open', labels: ['qa-regression'] })
  const body = fake.issues.get(100)?.body ?? ''
  // The issue names the run and the time the criterion last passed, and the revision.
  expect(body).toContain(`\`${runUrl(77)}\``)
  expect(body).toContain(`\`${PASSED_DATE}\``)
  expect(body).toContain(`\`${PASSED_AT}\``)
  // Alice's change came after the pass. Bob's is the revision that passed: it is not in the range.
  expect(mentionsIn(body)).toEqual(['alice'])
  expect(body).toContain('#12')
  expect(body).not.toContain('#11')
  // The failed criterion keeps the pass it had: the next run counts from the same revision.
  const store = await recorded()
  expect(store?.passes['BIL-014']).toMatchObject({ sha: PASSED_AT, run: runUrl(77) })
  expect(store?.passes['BIL-021']).toMatchObject({ sha: FAILED_AT, run: runUrl(78) })
})

test('a recorded pass is read whether or not this run records: a job that only files still files a regression', async () => {
  expect(await run(await result('passed', { 'BIL-014': 'proven' }), PASSED_AT, ['--record-passes', 'true'])).toBe(0)
  fake.commitLog.push({ sha: FAILED_AT, message: 'Rework payouts (#12)', date: '2026-10-09T09:00:00Z' })
  out = []
  const before = writes().length
  expect(await run(await result('failed', { 'BIL-014': 'failed' }), FAILED_AT)).toBe(0)
  expect(out.join('')).toBe('opened #100 for BIL-014 (qa-regression), mentioning nobody\n')
  // It filed the issue and wrote nothing to qa-assets.
  expect(writes().slice(before)).toEqual(['POST /repos/octocat/qare/issues'])
})

test('a dry run records nothing and says what it would record', async () => {
  expect(await run(await result('passed', { 'BIL-014': 'proven', 'BIL-021': 'proven' }), PASSED_AT, ['--record-passes', 'true', '--dry-run', 'true'])).toBe(0)
  expect(out.join('')).toBe(
    `dry run: nothing is written\nno finding on main to file, update or close\nwould record a pass for 2 criteria at ${PASSED_AT.slice(0, 12)}: BIL-014, BIL-021\n`,
  )
  expect(writes()).toEqual([])
  expect(await recorded()).toBeUndefined()
})

test('without --record-passes nothing is recorded, and only the exact word true records', async () => {
  const passing = await result('passed', { 'BIL-014': 'proven' })
  expect(await run(passing, PASSED_AT)).toBe(0)
  for (const value of ['false', 'TRUE', 'yes', '1', '']) expect(await run(passing, PASSED_AT, ['--record-passes', value])).toBe(0)
  expect(writes()).toEqual([])
  expect(await recorded()).toBeUndefined()
  expect(out.join('')).not.toContain('pass')
})

test('a run that proves nothing writes no record, and says so', async () => {
  expect(await run(await result('blocked', { 'BIL-014': 'unverified', 'BIL-021': 'unverified' }), PASSED_AT, ['--record-passes', 'true'])).toBe(0)
  expect(out.join('')).toContain('no pass to record: the run proved no criterion the ledger carries as active\n')
  expect(await recorded()).toBeUndefined()
  // The environment issue was filed; nothing went to qa-assets.
  expect([...fake.refs.keys()]).toEqual([])
})

test('a record that cannot be read stops the step by name before anything is filed, and is never written over', async () => {
  await new GitHubQaAssetsPusher(client(), PASSED_AT).pushMainPasses('{"schemaVersion":"1","passes":{"BIL-014":{"sha":"main"}}}')
  const before = writes().length
  expect(await run(await result('failed', { 'BIL-014': 'failed', 'BIL-021': 'proven' }), PASSED_AT, ['--record-passes', 'true'])).toBe(1)
  expect(err.join('')).toContain(`the record of passes at ${MAIN_PASSES_PATH} on the qa-assets branch cannot be read`)
  expect(err.join('')).toContain('.sha')
  expect(fake.issues.size).toBe(0)
  expect(writes().slice(before)).toEqual([])
})

test('a pass is not recorded for a revision whose commit date cannot be read: the changes since could not be counted from it', async () => {
  const unknown = 'c3'.repeat(20)
  expect(await run(await result('passed', { 'BIL-014': 'proven' }), unknown, ['--record-passes', 'true'])).toBe(1)
  expect(err.join('')).toContain(`could not read when ${unknown} was committed`)
  expect(await recorded()).toBeUndefined()
})
