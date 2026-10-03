import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { appendChange, serializeLedgerDocument, type LedgerEntry } from '@qare/core'
import { main } from '../src/index.js'
import { FAKE_TOKEN, startFakeGithub, type FakeGithub } from './fake-github.js'

// #154: `qare-action main-findings`, run the way a judge-side step runs it:
// the result, the ledger and the profile are files, the identity comes from
// the environment, and GitHub is the fake.

const HEAD = 'c0ffee0123456789c0ffee0123456789c0ffee01'
const profileFixture = fileURLToPath(new URL('../../core/fixtures/qa-valid/.qa', import.meta.url))
// Assembled, never literal: no network marker sits as a literal in a test.
const RUN_URL = ['https:', '//github.example/octocat/qare/actions/runs/77'].join('')

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

  dir = await mkdtemp(join(tmpdir(), 'qare-main-findings-'))
  const entries: LedgerEntry[] = [
    { criterion: 'BIL-014', status: 'active', source: ['suite:billing'], proof: 'flow', text: 'A host sees the 1099 notice.', checks: ['app/payouts'] },
  ]
  const changes = appendChange([], { kind: 'verify', actor: 'run-9', timestamp: '2026-09-28T04:17:00.000Z', reason: 'run run-9: pass', criteria: ['BIL-014'] })
  await writeFile(join(dir, 'ledger.json'), serializeLedgerDocument(entries, changes))
  await writeFile(
    join(dir, 'judged-result.json'),
    JSON.stringify({ schemaVersion: '1', verdict: 'failed', criteria: [{ id: 'BIL-014', outcome: 'failed', reason: 'verifier saw hunter2 on the page', evidence: ['checks/BIL-014/0/actions.json'] }] }),
  )
  cpSync(profileFixture, join(dir, 'profile'), { recursive: true })
  writeFileSync(
    join(dir, 'profile', 'config.yml'),
    `${readFileSync(join(profileFixture, 'config.yml'), 'utf8')}\nfindings:\n  fallback: acme/qa-leads\nredact:\n  values:\n    - hunter2\n`,
  )

  fake.commitLog.push({ sha: '2'.repeat(40), message: 'Add the notice (#12)', date: '2026-09-29T00:00:00Z' })
  fake.commitPulls.set('2'.repeat(40), [12])
  fake.pullRecords.set(12, { title: 'Add the notice', author: { login: 'alice', type: 'User' }, merged: true, files: [], reviews: [] })
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await fake.close()
})

function run(extra: string[] = [], base?: string[]): Promise<number> {
  const args = base ?? ['--result', join(dir, 'judged-result.json'), '--ledger', dir, '--sha', HEAD, '--repository', 'octocat/qare', '--api-root', fake.url]
  return main(['main-findings', ...args, ...extra], { write: (chunk) => out.push(chunk) }, { write: (chunk) => err.push(chunk) })
}

test('files the finding as the identity of the step, and says what it did', async () => {
  expect(await run(['--run-url', RUN_URL, '--profile', join(dir, 'profile')])).toBe(0)
  expect(err.join('')).toBe('')
  expect(out.join('')).toBe('opened #100 for BIL-014 (qa-regression), mentioning alice\n')
  expect(fake.issueMeta.get(100)).toMatchObject({ state: 'open', labels: ['qa-regression'], author: 'github-actions[bot]' })
  const body = fake.issues.get(100)?.body ?? ''
  expect(body).toContain(`[the run](<${RUN_URL}>)`)
  // The profile's redact values are swept from what is published.
  expect(body).not.toContain('hunter2')
  expect(body).toContain('[redacted]')

  out = []
  expect(await run()).toBe(0)
  expect(out.join('')).toBe('commented on #100 for BIL-014: still failing\n')
})

test('names the fallback of the profile it is given when no change can be blamed', async () => {
  await writeFile(join(dir, 'ledger.json'), serializeLedgerDocument([{ criterion: 'BIL-014', status: 'active', source: ['suite:billing'], proof: 'flow' }], []))
  expect(await run(['--profile', join(dir, 'profile')])).toBe(0)
  expect(out.join('')).toBe('opened #100 for BIL-014 (qa-failure), mentioning acme/qa-leads\n')
})

test('a dry run prints what it would do and writes nothing', async () => {
  expect(await run(['--dry-run', 'true'])).toBe(0)
  expect(out.join('')).toBe('dry run: nothing is written\nwould open an issue for BIL-014 (qa-regression), mentioning alice\n')
  expect(fake.issues.size).toBe(0)
  expect(fake.calls.every((call) => call.method === 'GET')).toBe(true)
})

test('a run with nothing to file says so', async () => {
  await writeFile(
    join(dir, 'judged-result.json'),
    JSON.stringify({ schemaVersion: '1', verdict: 'passed', criteria: [{ id: 'BIL-014', outcome: 'proven', evidence: ['checks/BIL-014/0/actions.json'] }] }),
  )
  expect(await run()).toBe(0)
  expect(out.join('')).toBe('no finding on main to file, update or close\n')
})

test('refuses to run without the result, the ledger or a whole commit id, naming what is missing', async () => {
  expect(await run([], ['--ledger', dir, '--sha', HEAD])).toBe(1)
  expect(err.join('')).toContain('qare-action main-findings needs --result <path to judged-result.json>')
  err = []
  expect(await run([], ['--result', join(dir, 'judged-result.json'), '--sha', HEAD])).toBe(1)
  expect(err.join('')).toContain('qare-action main-findings needs --ledger <the ledger directory>')
  err = []
  expect(await run([], ['--result', join(dir, 'judged-result.json'), '--ledger', dir, '--sha', 'main'])).toBe(1)
  expect(err.join('')).toContain('--sha must be the 40 character commit the run checked')
  err = []
  expect(await run(['--run-url', 'javascript:alert(1)'])).toBe(1)
  expect(err.join('')).toContain('--run-url must be an https URL')
  expect(fake.issues.size).toBe(0)
})
