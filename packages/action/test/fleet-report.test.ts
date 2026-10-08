import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { FLEET_LABEL, FLEET_SUMMARY_MARKER, LEDGER_FILE, METRICS_SCHEMA_VERSION, appendChange, fleetAttentionKeyOf, parseFleetConfig, serializeLedgerDocument } from '@qare/core'
import type { LedgerChange, LedgerEntry } from '@qare/core'
import { GitHubClient } from '../src/github.js'
import { buildFleetReport, publishFleetReport } from '../src/fleet-report.js'
import { main } from '../src/index.js'
import { FAKE_TOKEN, startFakeGithub, type FakeGithub } from './fake-github.js'

// #151: the fleet report reads every listed repository through GitHub's API
// and publishes one page and one summary issue in the repository it runs in.
// Each repository here is its own fake of GitHub's API: nothing reads or
// writes a real one.

const NOW = new Date('2026-10-08T12:00:00.000Z')
const HOME = 'acme/qa-home'

const fakes: FakeGithub[] = []
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.close()))
})

async function fakeRepo(): Promise<FakeGithub> {
  const fake = await startFakeGithub()
  fakes.push(fake)
  return fake
}

let objects = 0
/** Put files on a branch of a fake repository, as one commit holding the whole tree. */
function commitFiles(fake: FakeGithub, branch: string, files: Record<string, string>): void {
  const entries = Object.entries(files).map(([path, content]) => {
    objects += 1
    const sha = `blob${objects}`
    fake.blobs.set(sha, Buffer.from(content, 'utf8'))
    return { path, mode: '100644' as const, type: 'blob' as const, sha }
  })
  objects += 1
  fake.trees.set(`tree${objects}`, entries)
  fake.commits.set(`commit${objects}`, { tree: `tree${objects}`, parents: [] })
  fake.refs.set(`refs/heads/${branch}`, `commit${objects}`)
}

function entry(criterion: string): LedgerEntry {
  return { criterion, status: 'active', source: ['suite:web'], proof: 'flow' }
}

function ledgerText(proven: Array<[string, string]>, all: string[]): string {
  let changes: LedgerChange[] = []
  for (const [criterion, timestamp] of proven) changes = appendChange(changes, { kind: 'verify', actor: 'run-1', timestamp, reason: 'run run-1: pass', criteria: [criterion] })
  // The ledger file as the harness writes it.
  return serializeLedgerDocument(all.map(entry), changes)
}

function record(runId: string, recordedAt: string, verdict: string, pr: number, counts: Record<string, number>): string {
  return JSON.stringify({ schemaVersion: METRICS_SCHEMA_VERSION, runId, recordedAt, startedAt: recordedAt, finishedAt: recordedAt, wallMs: 1, verdict, criteria: { selected: [], counts }, context: { pr } })
}

function openIssue(fake: FakeGithub, number: number, title: string, labels: string[], state: 'open' | 'closed' = 'open'): void {
  fake.issues.set(number, { number, title, body: 'filed by qare', comments: [] })
  fake.issueMeta.set(number, { state, labels, author: 'github-actions[bot]' })
}

function clients(repos: Record<string, FakeGithub>): (repository: string) => GitHubClient {
  return (repository) => {
    const fake = repos[repository]
    if (fake === undefined) throw new Error(`the identity cannot see ${repository}`)
    return new GitHubClient({ repository, apiRoot: fake.url, token: FAKE_TOKEN })
  }
}

/** Two repositories with something to report, and one the identity cannot see. */
async function fleet(): Promise<{ repos: Record<string, FakeGithub>; web: FakeGithub; api: FakeGithub; home: FakeGithub }> {
  const web = await fakeRepo()
  commitFiles(web, 'main', { [`.qa/${LEDGER_FILE}`]: ledgerText([['WEB-1', '2026-10-01T00:00:00.000Z'], ['WEB-2', '2026-10-01T00:00:00.000Z']], ['WEB-1', 'WEB-2', 'WEB-3']) })
  commitFiles(web, 'qa-assets', {
    'metrics/2026-10-07/aaa/pr-11.json': record('pr-11', '2026-10-07T09:00:00.000Z', 'passed', 11, { proven: 3 }),
    'metrics/2026-10-08/bbb/pr-12.json': record('pr-12', '2026-10-08T09:00:00.000Z', 'failed', 12, { proven: 2, failed: 1 }),
    'runs/2026-10-08/bbb/pr-12/checks/x/0/page.png': 'not a record',
  })
  openIssue(web, 31, 'WEB-3 regressed on main', ['qa-regression'])
  openIssue(web, 30, 'an older regression, fixed', ['qa-regression'], 'closed')
  openIssue(web, 40, 'somebody else asked a question', ['question'])

  const api = await fakeRepo()
  // A ledger on another branch and in another directory, with a criterion last proven long ago,
  // and its own threshold for what is stale.
  commitFiles(api, 'trunk', {
    [`qa/${LEDGER_FILE}`]: ledgerText([['API-1', '2026-10-07T00:00:00.000Z'], ['API-2', '2026-09-01T00:00:00.000Z']], ['API-1', 'API-2']),
    'qa/sweep.json': JSON.stringify({ default: { staleAfter: '14d' } }),
  })
  commitFiles(api, 'qa-assets', { 'metrics/2026-10-08/ccc/pr-5.json': record('pr-5', '2026-10-08T08:00:00.000Z', 'passed', 5, { proven: 2 }) })

  const home = await fakeRepo()
  return { repos: { 'acme/web': web, 'acme/api': api, [HOME]: home }, web, api, home }
}

const CONFIG = parseFleetConfig({ repositories: ['acme/web', { repository: 'acme/api', branch: 'trunk', ledger: 'qa' }, 'acme/private'] })

test("one page shows every listed repository's state, read from its ledger, its run records and the issues qare filed", async () => {
  const { repos } = await fleet()
  const report = await buildFleetReport(CONFIG, clients(repos), { now: NOW })

  expect(report.states.map((state) => state.repository)).toEqual(['acme/web', 'acme/api', 'acme/private'])
  const [web, api, dark] = report.states
  expect(web?.ledger).toEqual({ size: 3, proven: 2, stale: [], unverified: 1 })
  // Newest first, and only the run records: a screenshot on the same branch is not one.
  expect(web?.runs).toEqual([
    { runId: 'pr-12', recordedAt: '2026-10-08T09:00:00.000Z', verdict: 'failed', pr: 12, counts: { proven: 2, failed: 1 } },
    { runId: 'pr-11', recordedAt: '2026-10-07T09:00:00.000Z', verdict: 'passed', pr: 11, counts: { proven: 3 } },
  ])
  // Open issues carrying qare's labels: not a closed one, not somebody else's.
  expect(web?.issues).toEqual({ regression: [{ number: 31, title: 'WEB-3 regressed on main' }], environment: [], failure: [] })
  // The other repository's own branch, directory and stale threshold are honoured.
  expect(api?.ledger).toEqual({ size: 2, proven: 1, stale: ['API-2'], unverified: 0 })
  // A repository the identity cannot see is unread in every part, with the reason.
  expect(dark).toEqual({
    repository: 'acme/private',
    ledger: { unread: 'the identity cannot see acme/private' },
    runs: { unread: 'the identity cannot see acme/private' },
    issues: { unread: 'the identity cannot see acme/private' },
  })

  expect(report.page).toContain('3 repositories; 6 things need attention.')
  expect(report.page).toContain('| `acme/web` | `failed` (2026-10-08) | 1 | 3 criteria | 67% | 0 | yes (2) |')
  expect(report.page).toContain('| `acme/api` | `passed` (2026-10-08) | 0 | 2 criteria | 50% | 1 | yes (1) |')
  expect(report.page).toContain('| `acme/private` | unread | unread | unread |  |  | yes (3) |')
  expect(report.attention).toBe(6)
})

// Found by a dry run against a real repository: a record's path is its date,
// then the commit it ran on, so the records of one day sort by commit and
// not by time. The newest run of a busy day must still be the one shown.
test('the latest run is the latest by when it was recorded, however many ran that day and however their commits sort', async () => {
  const busy = await fakeRepo()
  const files: Record<string, string> = { 'metrics/2026-10-07/zzz/pr-1.json': record('pr-1', '2026-10-07T23:00:00.000Z', 'passed', 1, {}) }
  // Thirty runs on the 8th. The newest ran on the commit that sorts first.
  for (let hour = 0; hour < 30; hour += 1) {
    const sha = String(29 - hour).padStart(4, '0')
    files[`metrics/2026-10-08/${sha}/pr-${hour + 2}.json`] = record(`pr-${hour + 2}`, new Date(Date.parse('2026-10-08T00:00:00.000Z') + hour * 20 * 60_000).toISOString(), hour === 29 ? 'failed' : 'passed', hour + 2, {})
  }
  commitFiles(busy, 'qa-assets', files)

  const report = await buildFleetReport(parseFleetConfig({ repositories: ['acme/busy'], runs: 3 }), clients({ 'acme/busy': busy }), { now: NOW })
  const runs = report.states[0]?.runs
  expect(Array.isArray(runs) ? runs.map((run) => run.runId) : runs).toEqual(['pr-31', 'pr-30', 'pr-29'])
  expect(Array.isArray(runs) ? runs[0]?.verdict : undefined).toBe('failed')
  // The day before is not read at all: the newest day already holds more than are shown.
  expect(busy.calls.filter((call) => call.path.includes('/contents/metrics/2026-10-07/'))).toEqual([])
})

test('a day with more run records than can be read is said to be unread, not guessed at', async () => {
  const flood = await fakeRepo()
  const files: Record<string, string> = {}
  for (let index = 0; index < 401; index += 1) files[`metrics/2026-10-08/${String(index).padStart(4, '0')}/pr-${index}.json`] = record(`pr-${index}`, '2026-10-08T00:00:00.000Z', 'passed', index + 1, {})
  commitFiles(flood, 'qa-assets', files)
  const report = await buildFleetReport(parseFleetConfig({ repositories: ['acme/flood'] }), clients({ 'acme/flood': flood }), { now: NOW })
  expect(report.states[0]?.runs).toEqual({ unread: '2026-10-08 holds 401 run records on qa-assets, more than the 400 the report reads to find the latest' })
  expect(flood.calls.filter((call) => call.path.includes('/contents/metrics/'))).toEqual([])
})

// The search index lags a new issue by minutes, and the search has a rate
// limit of its own. A regression filed a moment ago must be on the page.
test("the issues qare filed are read from the issue listing, not the search, so one filed a moment ago is there", async () => {
  const { repos, web, api } = await fleet()
  await buildFleetReport(CONFIG, clients(repos), { now: NOW })
  for (const fake of [web, api]) {
    expect(fake.calls.filter((call) => call.path === '/search/issues')).toEqual([])
    expect(fake.calls.filter((call) => call.path.endsWith('/issues') && call.method === 'GET').map((call) => new URLSearchParams(call.query).get('labels')).sort()).toEqual(['qa-environment', 'qa-failure', 'qa-regression'])
  }
})

test('reading the fleet writes nothing to the repositories it reads', async () => {
  const { repos, web, api } = await fleet()
  await buildFleetReport(CONFIG, clients(repos), { now: NOW })
  for (const fake of [web, api]) expect(fake.calls.filter((call) => call.method !== 'GET').map((call) => `${call.method} ${call.path}`)).toEqual([])
})

test('a repository whose ledger does not parse, whose records are not records, or whose tree is cut short is said to be unread there, and the rest still stands', async () => {
  const broken = await fakeRepo()
  commitFiles(broken, 'main', { [`.qa/${LEDGER_FILE}`]: '{ this is not json' })
  commitFiles(broken, 'qa-assets', { 'metrics/2026-10-08/ddd/pr-1.json': '["not", "a", "record"]' })
  const cut = await fakeRepo()
  commitFiles(cut, 'main', { 'README.md': 'a repository with no ledger' })
  commitFiles(cut, 'qa-assets', { 'metrics/2026-10-08/eee/pr-2.json': record('pr-2', '2026-10-08T08:00:00.000Z', 'passed', 2, {}) })
  cut.truncatedTrees.add(cut.commits.get(cut.refs.get('refs/heads/qa-assets') ?? '')?.tree ?? '')

  const report = await buildFleetReport(parseFleetConfig({ repositories: ['acme/broken', 'acme/cut'] }), clients({ 'acme/broken': broken, 'acme/cut': cut }), { now: NOW })
  const [first, second] = report.states
  expect(first?.ledger).toMatchObject({ unread: expect.stringMatching(/JSON/) })
  expect(first?.runs).toEqual({ unread: '1 of the 1 newest run records on qa-assets could not be read as one, so the latest run is not known' })
  expect(first?.issues).toEqual({ regression: [], environment: [], failure: [] })
  // No ledger at the path is absent, which is not unread.
  expect(second?.ledger).toBe('absent')
  expect(second?.runs).toMatchObject({ unread: expect.stringContaining('cut the listing') })
  expect(report.page).not.toContain('`passed`')
})

// GitHub answers 404 for a private repository a token cannot see, exactly as
// it does for a file or a branch that is not there. Read as "absent", that
// would show an unreadable repository as one with no ledger, no runs and no
// issues: healthy, and wrong.
test('a repository the token cannot see is unread in every part, never one with no ledger and no runs', async () => {
  const hidden = await fakeRepo()
  commitFiles(hidden, 'main', { [`.qa/${LEDGER_FILE}`]: ledgerText([['H-1', '2026-10-07T00:00:00.000Z']], ['H-1']) })
  hidden.hidden = true
  const report = await buildFleetReport(parseFleetConfig({ repositories: ['acme/hidden'] }), clients({ 'acme/hidden': hidden }), { now: NOW })
  const [state] = report.states
  for (const part of [state?.ledger, state?.runs, state?.issues]) expect(part).toEqual({ unread: expect.stringContaining('cannot see acme/hidden') })
  expect(report.page).toContain('| `acme/hidden` | unread | unread | unread |  |  | yes (3) |')
  expect(report.attention).toBe(3)
})

test('a ledger branch that is not there is unread, not a repository with no ledger; a repository with no qa-assets branch has recorded no run', async () => {
  const repo = await fakeRepo()
  commitFiles(repo, 'main', { 'README.md': 'no ledger here' })
  const [wrongBranch, noLedger] = (
    await buildFleetReport(parseFleetConfig({ repositories: [{ repository: 'acme/a', branch: 'trunk' }, 'acme/b'] }), clients({ 'acme/a': repo, 'acme/b': repo }), { now: NOW })
  ).states
  expect(wrongBranch?.ledger).toEqual({ unread: 'the branch trunk was not found, so its ledger cannot be read' })
  expect(noLedger?.ledger).toBe('absent')
  expect(noLedger?.runs).toEqual([])
})

test('one run record that cannot be read hides what the latest run was, even beside older ones that passed', async () => {
  const repo = await fakeRepo()
  commitFiles(repo, 'main', { 'README.md': 'x' })
  commitFiles(repo, 'qa-assets', {
    'metrics/2026-10-08/aaa/pr-1.json': record('pr-1', '2026-10-08T08:00:00.000Z', 'passed', 1, {}),
    // The newest file is not a record, and neither is one that only looks like a pass.
    'metrics/2026-10-08/bbb/pr-2.json': '{ cut off',
    'metrics/2026-10-08/ccc/pr-3.json': JSON.stringify({ runId: 'pr-3', recordedAt: '2026-10-08T10:00:00.000Z', verdict: 'passed' }),
  })
  const report = await buildFleetReport(parseFleetConfig({ repositories: ['acme/a'] }), clients({ 'acme/a': repo }), { now: NOW })
  expect(report.states[0]?.runs).toEqual({ unread: '2 of the 3 newest run records on qa-assets could not be read as one, so the latest run is not known' })
  expect(report.page).not.toContain('`passed`')
})

// The search index lags an issue's creation by minutes. A second run soon
// after the first must still find the issue the first one opened.
test('the summary issue is found by its label in the issue listing, not by the search, so a run straight after the first opens no second issue', async () => {
  const { repos, home } = await fleet()
  const homeClient = clients(repos)(HOME)
  const report = await buildFleetReport(CONFIG, clients(repos), { now: NOW })
  const first = await publishFleetReport(homeClient, report, { branch: 'qa-assets', path: 'fleet/report.md' })
  const searchesBefore = home.calls.filter((call) => call.path === '/search/issues').length
  const second = await publishFleetReport(homeClient, report, { branch: 'qa-assets', path: 'fleet/report.md' })
  expect(second.summary).toEqual({ issue: first.summary.issue, action: 'unchanged' })
  expect(home.issues.size).toBe(1)
  // The second run found it in the listing and asked the search nothing.
  expect(home.calls.filter((call) => call.path === '/search/issues').length).toBe(searchesBefore)
  // An identity that may not label an issue has its label dropped by GitHub without a word. The
  // issue is then found by its marker through the search, so a later run still opens no second.
  home.issueMeta.set(first.summary.issue, { state: 'open', labels: [], author: 'github-actions[bot]' })
  expect((await publishFleetReport(homeClient, report, { branch: 'qa-assets', path: 'fleet/report.md' })).summary).toEqual({ issue: first.summary.issue, action: 'unchanged' })
  expect(home.issues.size).toBe(1)
  home.issueMeta.set(first.summary.issue, { state: 'open', labels: [FLEET_LABEL], author: 'github-actions[bot]' })
  // An issue somebody else labelled the same way, without the marker, is not taken for it.
  home.issues.set(7, { number: 7, title: 'a question about the fleet', body: 'no marker', comments: [] })
  home.issueMeta.set(7, { state: 'open', labels: [FLEET_LABEL], author: 'someone' })
  expect((await publishFleetReport(homeClient, report, { branch: 'qa-assets', path: 'fleet/report.md' })).summary.issue).toBe(first.summary.issue)
  expect(home.issues.get(7)?.body).toBe('no marker')
})

test('publishing commits the page to a branch of the home repository and opens one summary issue', async () => {
  const { repos, home } = await fleet()
  const report = await buildFleetReport(CONFIG, clients(repos), { now: NOW, where: 'the page' })
  const published = await publishFleetReport(clients(repos)(HOME), report, { branch: 'qa-assets', path: 'fleet/report.md' })

  expect(published).toEqual({ page: { branch: 'qa-assets', path: 'fleet/report.md' }, summary: { issue: expect.any(Number), action: 'created' } })
  // The page is on the branch, as a file a person can open.
  const head = home.refs.get('refs/heads/qa-assets') ?? ''
  const tree = home.trees.get(home.commits.get(head)?.tree ?? '') ?? []
  const page = home.blobs.get(tree.find((file) => file.path === 'fleet/report.md')?.sha ?? '')?.toString('utf8')
  expect(page).toBe(report.page)
  const issue = home.issues.get(published.summary.issue)
  expect(issue?.title).toBe('QARE fleet: what needs attention')
  // It carries the label it is found again by.
  expect(home.issueMeta.get(published.summary.issue)?.labels).toEqual([FLEET_LABEL])
  expect(issue?.body).toContain(FLEET_SUMMARY_MARKER)
  expect(issue?.body).toContain('- open qa-regression issue `#31`: `WEB-3 regressed on main`')
  expect(issue?.body).toContain('- criterion `API-2` is stale')
  expect(issue?.body).toContain('- its ledger could not be read: `the identity cannot see acme/private`')
})

// The marker is public: anyone can open an issue that carries it. The report
// keeps its own issue current and never writes to somebody else's.
test("an issue somebody else opened with the summary's marker is never taken for the summary, labelled or not", async () => {
  const { repos, home } = await fleet()
  const homeClient = clients(repos)(HOME)
  const report = await buildFleetReport(CONFIG, clients(repos), { now: NOW })
  const planted = `${FLEET_SUMMARY_MARKER}\n<!-- qare:fleet-attention:0000000000000000 -->\nplanted`
  home.issues.set(5, { number: 5, title: 'planted, unlabelled', body: planted, comments: [] })
  home.issueMeta.set(5, { state: 'open', labels: [], author: 'mallory' })
  home.issues.set(6, { number: 6, title: 'planted, labelled', body: planted, comments: [] })
  home.issueMeta.set(6, { state: 'open', labels: [FLEET_LABEL], author: 'mallory' })

  const first = await publishFleetReport(homeClient, report, { branch: 'qa-assets', path: 'fleet/report.md' })
  expect(first.summary.action).toBe('created')
  expect([5, 6]).not.toContain(first.summary.issue)
  const second = await publishFleetReport(homeClient, report, { branch: 'qa-assets', path: 'fleet/report.md' })
  expect(second.summary).toEqual({ issue: first.summary.issue, action: 'unchanged' })
  // Neither planted issue was written to.
  expect(home.issues.get(5)?.body).toBe(planted)
  expect(home.issues.get(6)?.body).toBe(planted)
  expect(home.calls.filter((call) => call.method === 'PATCH' && /\/issues\/[56]$/.test(call.path))).toEqual([])
})

// A listing that stopped early would leave issues out without a word.
test('every page of a label is read, and a repository with more issues than can be read is unread, not short', async () => {
  const many = await fakeRepo()
  commitFiles(many, 'main', { 'README.md': 'x' })
  for (let number = 1; number <= 1205; number += 1) openIssue(many, number, `regression ${number}`, ['qa-regression'])
  const report = await buildFleetReport(parseFleetConfig({ repositories: ['acme/many'] }), clients({ 'acme/many': many }), { now: NOW })
  const issues = report.states[0]?.issues
  expect(issues !== undefined && !('unread' in issues) ? issues.regression.length : issues).toBe(1205)
})

test('the summary issue is left alone while what needs attention is the same, and rewritten when it changes; the page is committed every time', async () => {
  const { repos, home, web } = await fleet()
  const homeClient = clients(repos)(HOME)
  const publish = async (now: Date) => publishFleetReport(homeClient, await buildFleetReport(CONFIG, clients(repos), { now }), { branch: 'qa-assets', path: 'fleet/report.md' })

  const opened = await publish(NOW)
  expect(opened.summary.action).toBe('created')
  const number = opened.summary.issue
  const first = home.issues.get(number)?.body ?? ''
  const commitsAfterFirst = home.commits.size

  // A day later, nothing has changed: no edit to the issue, so nobody is notified, and a fresh page.
  const again = await publish(new Date('2026-10-09T12:00:00.000Z'))
  expect(again.summary).toEqual({ issue: number, action: 'unchanged' })
  expect(home.issues.get(number)?.body).toBe(first)
  expect(home.calls.filter((call) => call.method === 'PATCH' && call.path.includes('/issues/'))).toEqual([])
  expect(home.commits.size).toBe(commitsAfterFirst + 1)
  expect(home.issues.size).toBe(1)

  // The regression is closed: the list changed, so the issue is rewritten.
  web.issueMeta.set(31, { state: 'closed', labels: ['qa-regression'], author: 'github-actions[bot]' })
  const changed = await publish(new Date('2026-10-10T12:00:00.000Z'))
  expect(changed.summary).toEqual({ issue: number, action: 'updated' })
  expect(home.issues.get(number)?.body).not.toContain('#31')
  expect(fleetAttentionKeyOf(home.issues.get(number)?.body ?? '')).not.toBe(fleetAttentionKeyOf(first))
})

test('a page push that loses a race reads the branch again, and a push that keeps losing fails without touching the issue', async () => {
  const { repos, home } = await fleet()
  const homeClient = clients(repos)(HOME)
  // The branch exists, so a push is a ref update, which the fake can refuse.
  commitFiles(home, 'qa-assets', { 'runs/keep.txt': 'kept' })
  const report = await buildFleetReport(CONFIG, clients(repos), { now: NOW })

  home.failRefPatches = 1
  expect((await publishFleetReport(homeClient, report, { branch: 'qa-assets', path: 'fleet/report.md' })).summary.action).toBe('created')

  home.failRefPatches = 3
  await expect(publishFleetReport(homeClient, report, { branch: 'qa-assets', path: 'fleet/report.md' })).rejects.toThrow()
  expect(home.calls.filter((call) => call.method === 'PATCH' && call.path.includes('/issues/'))).toEqual([])
})

test('the command reads the config, publishes, and with --dry-run publishes nothing and says what it would', async () => {
  const home = await fakeRepo()
  commitFiles(home, 'main', { [`.qa/${LEDGER_FILE}`]: ledgerText([['HOME-1', '2026-10-07T00:00:00.000Z']], ['HOME-1']) })
  const dir = await mkdtemp(join(tmpdir(), 'qare-fleet-'))
  const config = join(dir, 'fleet.json')
  await writeFile(config, JSON.stringify({ repositories: [HOME] }))
  const before = process.env.QARE_TEST_FLEET_TOKEN
  process.env.QARE_TEST_FLEET_TOKEN = FAKE_TOKEN
  try {
    const lines: string[] = []
    const out = { write: (chunk: string) => lines.push(chunk) }
    const argv = ['fleet-report', '--config', config, '--repository', HOME, '--api-root', home.url, '--token-env', 'QARE_TEST_FLEET_TOKEN', '--out', join(dir, 'report.md')]

    expect(await main([...argv, '--dry-run', 'true'], out, out)).toBe(0)
    expect(lines.join('')).toContain('read 1 repository; 0 things need attention')
    expect(lines.join('')).toContain('dry run: nothing published')
    expect(home.calls.filter((call) => call.method !== 'GET')).toEqual([])
    expect(await readFile(join(dir, 'report.md'), 'utf8')).toContain('| `acme/qa-home` | no run recorded | 0 | 1 criteria | 100% | 0 | no |')

    lines.length = 0
    expect(await main(argv, out, out)).toBe(0)
    expect(lines.join('')).toContain('page committed to fleet/report.md on qa-assets')
    expect(lines.join('')).toMatch(/summary issue #\d+ created/)

    lines.length = 0
    expect(await main(['fleet-report', '--repository', HOME], out, out)).toBe(1)
    expect(lines.join('')).toContain('needs --config')
    lines.length = 0
    expect(await main([...argv, '--path', '../outside.md'], out, out)).toBe(1)
    expect(lines.join('')).toContain('--path must be a plain path')
  } finally {
    if (before === undefined) delete process.env.QARE_TEST_FLEET_TOKEN
    else process.env.QARE_TEST_FLEET_TOKEN = before
  }
})
