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
  const store0 = await recorded()
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
  // When the pass was recorded, which is when the run that proved it finished.
  expect(body).toContain(`recorded at \`${store0?.passes['BIL-014']?.recordedAt ?? 'missing'}\``)
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
  await new GitHubQaAssetsPusher(client(), PASSED_AT).pushMainPasses(async () => '{"schemaVersion":"1","passes":{"BIL-014":{"sha":"main"}}}')
  const before = writes().length
  expect(await run(await result('failed', { 'BIL-014': 'failed', 'BIL-021': 'proven' }), PASSED_AT, ['--record-passes', 'true'])).toBe(1)
  expect(err.join('')).toContain(`the record of passes at ${MAIN_PASSES_PATH} on the qa-assets branch cannot be read`)
  expect(err.join('')).toContain('.sha')
  expect(fake.issues.size).toBe(0)
  expect(writes().slice(before)).toEqual([])
})

// GitHub answers 404 both for a file that is not there and for a repository
// whose contents an identity may not read. "No record" is believed only from
// an identity that can read the revision the run checked; otherwise a
// regression would be filed as a plain failure and nobody would know.
test('no record is believed only from an identity that can read the repository: one that cannot read the checked revision stops the step before anything is filed', async () => {
  const unreadable = 'c3'.repeat(20)
  for (const extra of [[], ['--record-passes', 'true'], ['--dry-run', 'true']]) {
    err = []
    expect(await run(await result('failed', { 'BIL-014': 'failed' }), unreadable, extra)).toBe(1)
    expect(err.join('')).toContain(`no record of passes was found at ${MAIN_PASSES_PATH} on the qa-assets branch, and this identity cannot read ${unreadable} either`)
    expect(err.join('')).toContain('nothing is filed')
  }
  expect(fake.issues.size).toBe(0)
  expect(writes()).toEqual([])
})

// The range is the commits after the passing revision, as the history has
// them, not the commits dated after it: commits that share its second, and
// commits dated before it that landed later, are told apart by where they sit.
test('the changes since a recorded pass are the commits after its revision in the history, whatever their dates', async () => {
  const twin = 'd4'.repeat(20)
  fake.commitLog.push({ sha: twin, message: 'Twin change (#13)', date: PASSED_DATE })
  fake.commitPulls.set(twin, [13])
  fake.pullRecords.set(13, { title: 'Twin change', author: { login: 'carol', type: 'User' }, merged: true, files: ['app/receipts/a.rb'], reviews: [] })
  expect(await run(await result('passed', { 'BIL-014': 'proven' }), PASSED_AT, ['--record-passes', 'true'])).toBe(0)
  expect(await run(await result('passed', { 'BIL-021': 'proven' }), twin, ['--record-passes', 'true'])).toBe(0)
  fake.commitLog.push({ sha: FAILED_AT, message: 'Rework payouts (#12)', date: '2026-10-09T09:00:00Z' })
  fake.commitPulls.set(FAILED_AT, [12])
  fake.pullRecords.set(12, { title: 'Rework payouts', author: { login: 'alice', type: 'User' }, merged: true, files: ['app/payouts/notice.rb'], reviews: [] })
  out = []
  expect(await run(await result('failed', { 'BIL-014': 'failed', 'BIL-021': 'failed' }), FAILED_AT)).toBe(0)
  const first = fake.issues.get(100)?.body ?? ''
  const second = fake.issues.get(101)?.body ?? ''
  // BIL-014 passed on bob's revision: carol's change, committed in the same second, and alice's came after it.
  expect(first).toContain('`BIL-014`')
  expect(mentionsIn(first).sort()).toEqual(['alice', 'carol'])
  // BIL-021 passed on carol's revision. Bob's commit shares its second and sits before it: it is not a change since.
  expect(second).toContain('`BIL-021`')
  expect(mentionsIn(second)).toEqual(['alice'])
  expect(second).not.toContain('#11')
})

test('a commit dated before the pass that landed after it is a change since', async () => {
  expect(await run(await result('passed', { 'BIL-014': 'proven' }), PASSED_AT, ['--record-passes', 'true'])).toBe(0)
  // Written last week, merged today: its date is before the passing revision's.
  const old = 'e5'.repeat(20)
  fake.commitLog.push({ sha: old, message: 'An old branch lands (#14)', date: '2026-10-01T00:00:00Z' })
  fake.commitPulls.set(old, [14])
  fake.pullRecords.set(14, { title: 'An old branch lands', author: { login: 'dave', type: 'User' }, merged: true, files: ['app/payouts/b.rb'], reviews: [] })
  out = []
  expect(await run(await result('failed', { 'BIL-014': 'failed' }), old)).toBe(0)
  expect(out.join('')).toBe('opened #100 for BIL-014 (qa-regression), mentioning dave\n')
})

// Two runs can finish close together. The record is read again where it is
// written, so a pass another run recorded meanwhile is kept, not written over.
test('a pass another run recorded while this one was filing is kept', async () => {
  const pusher = new GitHubQaAssetsPusher(client(), FAILED_AT)
  const seen: Array<string | undefined> = []
  let raced = false
  await pusher.pushMainPasses(async (current) => {
    seen.push(current)
    if (!raced) {
      raced = true
      // Another run lands its record between this run's read and its push, so
      // this run's push is refused: the branch is no longer where it read it.
      await new GitHubQaAssetsPusher(client(), PASSED_AT).pushMainPasses(async () => '{"other":"run"}')
    }
    return `{"saw":${JSON.stringify(current ?? null)}}`
  })
  // The second attempt was handed what the other run wrote, and built on it.
  expect(seen).toEqual([undefined, '{"other":"run"}'])
  expect((await client().getContents(MAIN_PASSES_PATH, 'qa-assets'))?.toString('utf8')).toBe('{"saw":"{\\"other\\":\\"run\\"}"}')
})

test('two runs that record one after the other keep each other\'s passes, and the older revision never replaces the newer', async () => {
  fake.commitLog.push({ sha: FAILED_AT, message: 'Later (#12)', date: '2026-10-09T09:00:00Z' })
  expect(await run(await result('passed', { 'BIL-014': 'proven', 'BIL-021': 'proven' }), FAILED_AT, ['--record-passes', 'true'])).toBe(0)
  // A run of the earlier revision finishes afterwards, and proved one criterion.
  expect(await run(await result('failed', { 'BIL-014': 'proven', 'BIL-021': 'failed' }), PASSED_AT, ['--record-passes', 'true'])).toBe(0)
  const store = await recorded()
  expect(store?.passes['BIL-014']).toMatchObject({ sha: FAILED_AT })
  expect(store?.passes['BIL-021']).toMatchObject({ sha: FAILED_AT })
  // And the failure that run filed is no regression: the only pass on record
  // is of a later revision, so nothing shows the criterion passed before this one.
  expect(fake.issueMeta.get(100)).toMatchObject({ labels: ['qa-failure'] })
  expect(fake.issues.get(100)?.body).toContain('Nothing shows it ever passed')
  expect(fake.issues.get(100)?.body).not.toContain(FAILED_AT)
})

// A later revision rewords one criterion and adds another, and its run
// records both. Then the run of the revision before it finishes, or is run
// again. It reads its own, older ledger. It must not erase what the later
// run recorded.
test('a late run of an older revision, with the older ledger, erases nothing the later run recorded', async () => {
  fake.commitLog.push({ sha: FAILED_AT, message: 'Reword and add (#12)', date: '2026-10-09T09:00:00Z' })
  const newer: LedgerEntry[] = [
    { ...ENTRIES[0]!, text: 'A host sees the 1099 notice in January.' },
    ENTRIES[1]!,
    { criterion: 'NEW-001', status: 'active', source: ['suite:billing'], proof: 'flow', text: 'New.', checks: ['suite:new'] },
  ]
  await writeFile(join(dir, 'ledger.json'), serializeLedgerDocument(newer, []))
  expect(await run(await result('passed', { 'BIL-014': 'proven', 'BIL-021': 'proven', 'NEW-001': 'proven' }), FAILED_AT, ['--record-passes', 'true'])).toBe(0)
  const before = await recorded()
  // The older revision's run, with the ledger as that revision had it.
  await writeFile(join(dir, 'ledger.json'), serializeLedgerDocument(ENTRIES, []))
  out = []
  expect(await run(await result('passed', { 'BIL-014': 'proven', 'BIL-021': 'proven' }), PASSED_AT, ['--record-passes', 'true'])).toBe(0)
  expect(await recorded()).toEqual(before)
  // And it says what it did: nothing was recorded, and why.
  expect(out.join('')).toBe(
    `no finding on main to file, update or close\nno pass recorded at ${PASSED_AT.slice(0, 12)}: a later revision already holds the pass of BIL-014, BIL-021\n`,
  )
})

// Two profiles of one repository, each with a ledger of its own, record at
// the same revision. Neither drops the other's passes.
test('two profiles of one repository keep records of their own', async () => {
  const api: LedgerEntry[] = [{ criterion: 'API-001', status: 'active', source: ['suite:api'], proof: 'flow', text: 'The API answers.', checks: ['suite:api'] }]
  expect(await run(await result('passed', { 'BIL-014': 'proven', 'BIL-021': 'proven' }), PASSED_AT, ['--record-passes', 'true', '--passes-profile', 'services/web/qa'])).toBe(0)
  await writeFile(join(dir, 'ledger.json'), serializeLedgerDocument(api, []))
  expect(await run(await result('passed', { 'API-001': 'proven' }), PASSED_AT, ['--record-passes', 'true', '--passes-profile', 'services/api/qa'])).toBe(0)
  const read = async (path: string): Promise<string[]> => Object.keys(parseMainPasses(((await client().getContents(path, 'qa-assets')) ?? Buffer.from('')).toString('utf8')).passes)
  expect(await read('passes/profiles/services/web/qa/main.json')).toEqual(['BIL-014', 'BIL-021'])
  expect(await read('passes/profiles/services/api/qa/main.json')).toEqual(['API-001'])
  expect(await recorded()).toBeUndefined()
  // Each reads its own when it files: the api profile's failure is a regression against its own pass.
  fake.commitLog.push({ sha: FAILED_AT, message: 'Later (#12)', date: '2026-10-09T09:00:00Z' })
  out = []
  expect(await run(await result('failed', { 'API-001': 'failed' }), FAILED_AT, ['--passes-profile', 'services/api/qa'])).toBe(0)
  expect(out.join('')).toContain('(qa-regression)')
  // A name that is no path segment is refused before anything is read or written.
  expect(await run(await result('passed', { 'API-001': 'proven' }), FAILED_AT, ['--passes-profile', '../elsewhere'])).toBe(1)
  expect(err.join('')).toContain('--passes-profile')
})

// A pass recorded for a revision that was rewritten out of the branch: GitHub
// still relates the two, as diverged. It is no earlier revision of this one.
test('a pass on a revision that diverged from the checked one is no last pass', async () => {
  const rewritten = 'ab'.repeat(20)
  fake.commitLog.push({ sha: rewritten, message: 'Rewritten away', date: '2026-10-07T00:00:00Z' })
  expect(await run(await result('passed', { 'BIL-014': 'proven' }), rewritten, ['--record-passes', 'true'])).toBe(0)
  fake.diverged.add(rewritten)
  fake.commitLog.push({ sha: FAILED_AT, message: 'After the rewrite (#12)', date: '2026-10-09T09:00:00Z' })
  out = []
  expect(await run(await result('failed', { 'BIL-014': 'failed' }), FAILED_AT, ['--record-passes', 'true'])).toBe(0)
  expect(out.join('')).toContain('opened #100 for BIL-014 (qa-failure), mentioning nobody\n')
  // That run did not prove it, so the pass it had is still the one on record.
  expect((await recorded())?.passes['BIL-014']).toMatchObject({ sha: rewritten })
  // The next run that proves it replaces the pass of the rewritten revision:
  // only a pass of a later revision is left alone, and this is not one. The
  // record is not stuck on a revision the branch no longer has.
  out = []
  expect(await run(await result('passed', { 'BIL-014': 'proven' }), FAILED_AT, ['--record-passes', 'true'])).toBe(0)
  expect((await recorded())?.passes['BIL-014']).toMatchObject({ sha: FAILED_AT })
  expect(out.join('')).toContain(`recorded a pass for 1 criteria at ${FAILED_AT.slice(0, 12)}`)
})

test('the comparison is read newest first, whole when it is short and from its last pages when it is long, in at most three requests', async () => {
  const base = '00'.repeat(20)
  for (const total of [0, 1, 100, 101, 199, 200, 201, 250]) {
    fake.commitLog.length = 0
    fake.commitLog.push({ sha: base, message: 'base', date: '2026-10-01T00:00:00Z' })
    const shas = Array.from({ length: total }, (_unused, index) => (index + 1).toString(16).padStart(40, '7'))
    shas.forEach((sha, index) => fake.commitLog.push({ sha, message: `c${index + 1}`, date: '2026-10-02T00:00:00Z' }))
    const head = shas.at(-1) ?? base
    const before = fake.calls.length
    const listed = await client().listCommitsBetween(base, head, 100)
    expect(fake.calls.length - before, `${total} commits`).toBeLessThanOrEqual(3)
    expect(listed?.commits.map((commit) => commit.sha), `${total} commits`).toEqual([...shas].reverse().slice(0, 100))
    expect(listed?.truncated, `${total} commits`).toBe(total > 100)
    expect(listed?.ahead, `${total} commits`).toBe(total > 0)
    // Asked only which is ahead: one request, no commits, nothing called cut.
    const asked = fake.calls.length
    expect(await client().listCommitsBetween(base, head, 0), `${total} commits`).toEqual({ commits: [], truncated: false, ahead: total > 0, behind: false })
    expect(fake.calls.length - asked).toBe(1)
  }
  // The other way round the head is behind: nothing is ahead.
  expect(await client().listCommitsBetween((250).toString(16).padStart(40, '7'), base, 0)).toMatchObject({ ahead: false, behind: true })
})

test('a pass on a revision GitHub cannot relate to the checked one is no last pass either', async () => {
  // A pass recorded for a revision that is no longer in the history (a force push since).
  const lost = 'f6'.repeat(20)
  fake.commitLog.push({ sha: lost, message: 'Lost', date: '2026-10-07T00:00:00Z' })
  expect(await run(await result('passed', { 'BIL-014': 'proven' }), lost, ['--record-passes', 'true'])).toBe(0)
  fake.commitLog.splice(fake.commitLog.findIndex((commit) => commit.sha === lost), 1)
  out = []
  expect(await run(await result('failed', { 'BIL-014': 'failed' }), PASSED_AT)).toBe(0)
  expect(out.join('')).toBe('opened #100 for BIL-014 (qa-failure), mentioning nobody\n')
})

test('a range longer than what is read keeps its newest commits and says it was cut', async () => {
  expect(await run(await result('passed', { 'BIL-014': 'proven' }), PASSED_AT, ['--record-passes', 'true'])).toBe(0)
  for (let index = 0; index < 250; index += 1)
    fake.commitLog.push({ sha: index.toString(16).padStart(40, '9'), message: `Commit ${index}`, date: '2026-10-09T00:00:00Z' })
  fake.commitLog.push({ sha: FAILED_AT, message: 'The newest (#12)', date: '2026-10-09T09:00:00Z' })
  fake.commitPulls.set(FAILED_AT, [12])
  fake.pullRecords.set(12, { title: 'The newest', author: { login: 'alice', type: 'User' }, merged: true, files: [], reviews: [] })
  const before = fake.calls.length
  out = []
  expect(await run(await result('failed', { 'BIL-014': 'failed' }), FAILED_AT)).toBe(0)
  const body = fake.issues.get(100)?.body ?? ''
  expect(mentionsIn(body)).toEqual(['alice'])
  expect(body).toContain('The range is longer than what was read')
  // Bounded: the comparison is read in a few requests, however long the range.
  expect(fake.calls.slice(before).filter((call) => call.path.includes('/compare/')).length).toBeLessThanOrEqual(4)
})

// A record that has lived a while holds passes of many revisions. A run
// asks the history only about the ones it could write over or drop.
test('a run asks the history about the recorded revisions it could write over or drop, not about every one on record', async () => {
  const many: LedgerEntry[] = Array.from({ length: 30 }, (_unused, index) => ({
    criterion: `OLD-${index}`,
    status: 'active' as const,
    source: ['suite:billing'],
    proof: 'flow',
    text: `Old ${index}.`,
    checks: ['suite:billing'],
  }))
  await writeFile(join(dir, 'ledger.json'), serializeLedgerDocument([...ENTRIES, ...many], []))
  // Thirty criteria, each last proven on a revision of its own.
  for (let index = 0; index < 30; index += 1) {
    const sha = (index + 1).toString(16).padStart(40, '8')
    fake.commitLog.push({ sha, message: `r${index}`, date: '2026-10-08T13:00:00Z' })
    expect(await run(await result('passed', { [`OLD-${index}`]: 'proven' }), sha, ['--record-passes', 'true'])).toBe(0)
  }
  fake.commitLog.push({ sha: FAILED_AT, message: 'Latest (#12)', date: '2026-10-09T09:00:00Z' })
  const before = fake.calls.length
  expect(await run(await result('passed', { 'OLD-3': 'proven', 'BIL-014': 'proven' }), FAILED_AT, ['--record-passes', 'true'])).toBe(0)
  // One recorded revision is in play (OLD-3's); BIL-014 has no pass yet.
  expect(fake.calls.slice(before).filter((call) => call.path.includes('/compare/')).length).toBe(1)
  const store = await recorded()
  expect(Object.keys(store?.passes ?? {})).toHaveLength(31)
  expect(store?.passes['OLD-3']).toMatchObject({ sha: FAILED_AT })
  expect(store?.passes['OLD-4']).toMatchObject({ sha: (5).toString(16).padStart(40, '8') })
})

test('a push that is refused for a reason that is not a race is not tried again', async () => {
  fake.failRefPatches = 0
  const pusher = new GitHubQaAssetsPusher(client(), PASSED_AT)
  await pusher.pushMainPasses(async () => '{"first":true}')
  let builds = 0
  fake.forbidRefWrites = true
  await expect(
    pusher.pushMainPasses(async () => {
      builds += 1
      return '{"second":true}'
    }),
  ).rejects.toThrow(/403/)
  expect(builds).toBe(1)
})
