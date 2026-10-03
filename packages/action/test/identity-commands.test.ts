import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { criterionIdFor, integrityOf, RESULT_SCHEMA_VERSION, serializeLedger, type LedgerEntry, type RunResult } from '@qare/core'
import { main } from '../src/index.js'
import { EVIDENCE_MARKER } from '../src/post-evidence.js'
import { FAKE_TOKEN, startFakeGithub, type FakeGithub } from './fake-github.js'

// #61: the commands a pipeline runs take their identity from the environment
// the step hands them, so switching an install between the App and a token
// is a change of secrets and of nothing else. Each command below is run the
// way the pipeline runs it: no flag names a token.

const SHA = 'b'.repeat(40)
const PAT = 'github_pat_fake_user'
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PRIVATE_KEY = pair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()

const passed: RunResult = {
  schemaVersion: RESULT_SCHEMA_VERSION,
  verdict: 'passed',
  criteria: [{ id: 'totals', outcome: 'proven', evidence: ['checks/totals/0/stdout.txt'] }],
}

let fake: FakeGithub
let out: string[]
let err: string[]

beforeEach(async () => {
  fake = await startFakeGithub()
  fake.app = {
    id: '4242',
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    slug: 'qare',
    installationId: 77,
    installed: true,
  }
  fake.tokens.set(PAT, { login: 'jason', kind: 'user' })
  fake.issues.set(12, { number: 12, title: 'a pull request', body: '', comments: [] })
  out = []
  err = []
  // Whatever the machine running the tests carries is not this install's.
  for (const name of ['QARE_APP_ID', 'QARE_APP_PRIVATE_KEY', 'QARE_GITHUB_TOKEN', 'GITHUB_TOKEN']) vi.stubEnv(name, '')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await fake.close()
})

function configure(env: Record<string, string>): void {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
}

const APP = { QARE_APP_ID: '4242', QARE_APP_PRIVATE_KEY: PRIVATE_KEY, GITHUB_TOKEN: FAKE_TOKEN }
const TOKEN = { QARE_GITHUB_TOKEN: PAT, GITHUB_TOKEN: FAKE_TOKEN }
const ACTIONS = { GITHUB_TOKEN: FAKE_TOKEN }

function run(argv: string[]): Promise<number> {
  return main(
    [...argv, '--repository', 'octocat/qare', '--api-root', fake.url],
    { write: (chunk) => out.push(chunk) },
    { write: (chunk) => err.push(chunk) },
  )
}

async function resultFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-identity-'))
  const path = join(dir, 'judged-result.json')
  await writeFile(path, JSON.stringify(passed))
  return path
}

async function postEvidence(): Promise<number> {
  return run(['post-evidence', '--result', await resultFile(), '--pr', '12', '--sha', SHA])
}

const evidenceComments = () => fake.commentRecords.filter((record) => record.body.startsWith(EVIDENCE_MARKER))

for (const [name, env, login, checksAuthor] of [
  ['the App', APP, 'qare[bot]', 'Bearer ghs_fake_installation_1'],
  ['a personal access token', TOKEN, 'jason', `Bearer ${FAKE_TOKEN}`],
  ['the Actions token', ACTIONS, 'github-actions[bot]', `Bearer ${FAKE_TOKEN}`],
] as const) {
  test(`post-evidence as ${name}: one comment under that login, updated in place, and a check run`, async () => {
    configure(env)
    expect(await postEvidence()).toBe(0)
    expect(await postEvidence()).toBe(0)
    expect(err.join('')).toBe('')
    // The second run found the first run's comment by its author, the
    // identity's own login, and updated it instead of adding another.
    expect(evidenceComments().map((record) => record.author)).toEqual([login])
    expect(fake.checkRuns).toHaveLength(2)
    expect(fake.calls.find((call) => call.path.endsWith('/check-runs'))?.authorization).toBe(checksAuthor)
  })
}

test('a marked comment someone else wrote is never taken for the identity\'s own', async () => {
  configure(APP)
  fake.commentRecords.push({ id: 1, issue: 12, body: `${EVIDENCE_MARKER}\nforged`, author: 'mallory' })
  expect(await postEvidence()).toBe(0)
  expect(evidenceComments().map((record) => record.author)).toEqual(['mallory', 'qare[bot]'])
  expect(fake.commentRecords[0]?.body).toBe(`${EVIDENCE_MARKER}\nforged`)
})

test('report-failure leaves a verdict the App posted for this commit in place', async () => {
  configure(APP)
  expect(await postEvidence()).toBe(0)
  fake.runJobs.set('77/1', [{ name: 'judge', conclusion: 'failure', steps: [{ name: 'Upload judge artifacts', conclusion: 'failure' }] }])
  expect(await run(['report-failure', '--run-id', '77', '--attempt', '1', '--pr', '12', '--sha', SHA, '--recorded-verdict', 'passed'])).toBe(0)
  expect(out.join('')).toContain('left it in place')
  expect(evidenceComments()).toHaveLength(1)
})

// The constraint the spec names: a pull request opened with the default
// Actions token triggers no workflows, so a proposal opened with it would
// arrive with no checks.
const NEW = 'ingest never writes the ledger itself'

async function proposalFile(): Promise<string> {
  const entries: LedgerEntry[] = []
  const proposed: LedgerEntry = {
    criterion: criterionIdFor(NEW),
    status: 'proposed',
    source: [['https:', '//example.test/issues/37'].join('')],
    proof: 'command',
    note: NEW,
  }
  fake.blobs.set('blob-base', Buffer.from(serializeLedger(entries)))
  fake.trees.set('tree-base', [{ path: '.qa/ledger.json', mode: '100644', type: 'blob', sha: 'blob-base' }])
  fake.commits.set('commit-1', { tree: 'tree-base', parents: [] })
  fake.refs.set('refs/heads/main', 'commit-1')
  const dir = await mkdtemp(join(tmpdir(), 'qare-identity-'))
  const path = join(dir, 'ingest-proposal.json')
  await writeFile(
    path,
    JSON.stringify({
      ledgerPath: '.qa/ledger.json',
      baseFingerprint: integrityOf(entries),
      ledgerText: serializeLedger([proposed]),
      branch: 'qare-ledger-proposal-abcdef12',
      title: 'Propose 1 ledger criteria',
      body: 'Proposes 1 criteria for the criteria ledger.',
    }),
  )
  return path
}

test('ingest-deliver refuses to open a proposal with the Actions token, and writes nothing', async () => {
  configure(ACTIONS)
  expect(await run(['ingest-deliver', '--proposal', await proposalFile(), '--base', 'main'])).toBe(1)
  expect(err.join('')).toMatch(/triggers no workflows/)
  expect(err.join('')).toMatch(/QARE_APP_ID/)
  expect(err.join('')).toMatch(/QARE_GITHUB_TOKEN/)
  expect(fake.pulls).toEqual([])
  expect(fake.refs.has('refs/heads/qare-ledger-proposal-abcdef12')).toBe(false)
  expect(fake.calls.filter((call) => call.method !== 'GET')).toEqual([])
})

for (const [name, env, token] of [
  ['the App', APP, 'ghs_fake_installation_1'],
  ['a personal access token', TOKEN, PAT],
] as const) {
  test(`ingest-deliver opens the proposal as ${name}, so the repository's workflows run on it`, async () => {
    configure(env)
    expect(await run(['ingest-deliver', '--proposal', await proposalFile(), '--base', 'main'])).toBe(0)
    expect(err.join('')).toBe('')
    expect(fake.pulls).toHaveLength(1)
    // The branch and the pull request are both the identity's: neither is
    // the Actions token's, whose pushes and pull requests start no workflow.
    const writes = fake.calls.filter((call) => call.method !== 'GET' && call.path.startsWith('/repos/'))
    expect(writes.length).toBeGreaterThan(0)
    for (const call of writes) expect(call.authorization, `${call.method} ${call.path}`).toBe(`Bearer ${token}`)
  })
}
