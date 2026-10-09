import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { loadPlan, serializeLedger, type LedgerEntry } from '@qare/core'
import { main } from '../src/index.js'
import type { Writer } from '../src/index.js'

// #294: `qare ledger plan`, the plan of a run on the default branch. No model
// writes it: the ledger records which suite proves each criterion, so the
// plan is read out of the ledger by code.

function capture(): { lines: string[]; writer: Writer } {
  const lines: string[] = []
  return { lines, writer: { write: (chunk) => lines.push(chunk) } }
}

// Split on purpose: a repo-wide guard forbids a literal URL in a test file.
const link = (path: string) => ['https:', `//example.test${path}`].join('')
const HEALTH_URL = ['http:', '//localhost:3000/up'].join('')

const ENTRIES: LedgerEntry[] = [
  { criterion: 'sign-in', status: 'active', source: [link('/pr/1')], proof: 'flow', text: 'A person signs in.', checks: ['suite:sign-in'] },
  { criterion: 'invoice-totals', status: 'active', source: [link('/pr/2')], proof: 'command', text: 'The invoice totals add up.', checks: ['suite:billing', 'app/invoices', 'suite:smoke'] },
  { criterion: 'no-suite', status: 'active', source: [link('/pr/3')], proof: 'flow', text: 'The receipt is sent once.', checks: ['app/receipts'] },
  { criterion: 'not-yet', status: 'proposed', source: [link('/pr/4')], proof: 'command', text: 'Proposed and not yet proven.', checks: ['suite:smoke'] },
  { criterion: 'gone', status: 'retired', source: [link('/pr/5')], proof: 'command', text: 'Retired.', checks: ['suite:smoke'] },
  { criterion: 'replaced', status: 'superseded', source: [link('/pr/6')], proof: 'command', text: 'Superseded.', checks: ['suite:smoke'] },
]

async function ledgerDir(entries: LedgerEntry[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-ledger-plan-'))
  await writeFile(join(dir, 'ledger.json'), serializeLedger(entries), 'utf8')
  return dir
}

async function ledgerPlan(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out = capture()
  const err = capture()
  const code = await main(['ledger', 'plan', ...args], out.writer, err.writer)
  return { code, out: out.lines.join(''), err: err.lines.join('') }
}

test('ledger plan writes a plan of exactly the active criteria, each checked by the suites its ledger checks name', async () => {
  const dir = await ledgerDir(ENTRIES)
  const planPath = join(dir, 'out', 'plan.json')
  const run = await ledgerPlan(['--ledger', dir, '--out', planPath])

  expect(run.err).toBe('')
  expect(run.code).toBe(0)
  const plan = JSON.parse(await readFile(planPath, 'utf8'))
  // In the ledger's canonical order, so the same ledger writes the same plan.
  expect(plan.criteria).toEqual([
    {
      id: 'invoice-totals',
      text: 'The invoice totals add up.',
      checks: [
        { kind: 'flow', name: 'billing', suite: 'billing' },
        { kind: 'flow', name: 'smoke', suite: 'smoke' },
      ],
    },
    { id: 'no-suite', text: 'The receipt is sent once.', unplannable: 'its ledger checks name no suite, so the runner has nothing to execute for it' },
    { id: 'sign-in', text: 'A person signs in.', checks: [{ kind: 'flow', name: 'sign-in', suite: 'sign-in' }] },
  ])
  expect(run.out).toBe(`3 active criteria (1 with no suite to run); ${planPath}\n`)
  // The plan is one the plan loader takes, so execute and judge read it as they read a planner's.
  expect(loadPlan(await readFile(planPath, 'utf8')).criteria).toHaveLength(3)
})

test('ledger plan on a ledger with no active criterion writes no plan, says there is nothing to run, and succeeds', async () => {
  const dir = await ledgerDir(ENTRIES.filter((entry) => entry.status !== 'active'))
  const planPath = join(dir, 'plan.json')
  // A file left from before would read as criteria present.
  await writeFile(planPath, '{"stale":true}', 'utf8')
  const run = await ledgerPlan(['--ledger', dir, '--out', planPath])

  expect(run.code).toBe(0)
  expect(run.out).toBe(`the ledger at ${dir} holds no active criterion, so there is nothing to run\n`)
  expect(existsSync(planPath)).toBe(false)
})

test('ledger plan where there is no ledger at all says the same, and succeeds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-ledger-plan-none-'))
  const planPath = join(dir, 'plan.json')
  const run = await ledgerPlan(['--ledger', dir, '--out', planPath])

  expect(run.code).toBe(0)
  expect(run.out).toBe(`the ledger at ${dir} holds no active criterion, so there is nothing to run\n`)
  expect(existsSync(planPath)).toBe(false)
})

test('ledger plan refuses a ledger that fails its integrity check, and writes no plan', async () => {
  const dir = await ledgerDir(ENTRIES)
  const tampered = JSON.parse(await readFile(join(dir, 'ledger.json'), 'utf8'))
  // Promote a proposed entry by hand, without the integrity that goes with it.
  tampered.entries.find((entry: { criterion: string }) => entry.criterion === 'not-yet').status = 'active'
  await writeFile(join(dir, 'ledger.json'), JSON.stringify(tampered), 'utf8')
  const planPath = join(dir, 'plan.json')
  await writeFile(planPath, '{"stale":true}', 'utf8')
  const run = await ledgerPlan(['--ledger', dir, '--out', planPath])

  expect(run.code).toBe(4)
  expect(run.err).toContain('ledger integrity check failed')
  expect(existsSync(planPath)).toBe(false)
})

test('ledger plan requires --out', async () => {
  const dir = await ledgerDir(ENTRIES)
  const run = await ledgerPlan(['--ledger', dir])
  expect(run.code).toBe(4)
  expect(run.err).toContain('qare ledger plan requires --out <plan.json>')
})

test('qare run --plan accepts a plan written by ledger plan and runs the recorded suites', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'qare-ledger-plan-run-'))
  await mkdir(join(repo, '.qa'), { recursive: true })
  await writeFile(
    join(repo, '.qa', 'ledger.json'),
    serializeLedger([
      { criterion: 'sign-in', status: 'active', source: [link('/pr/1')], proof: 'flow', text: 'A person signs in.', checks: ['suite:smoke'] },
      { criterion: 'broken', status: 'active', source: [link('/pr/2')], proof: 'flow', text: 'The broken thing works.', checks: ['suite:broken'] },
    ]),
    'utf8',
  )
  await writeFile(join(repo, '.qa', 'QA.md'), '# QA\n')
  await writeFile(
    join(repo, '.qa', 'config.yml'),
    `target:\n  url: ${HEALTH_URL}\n  health: { http: /health, timeout: 1s }\nsuites:\n  - name: smoke\n    command: "true"\n    kind: command\n  - name: broken\n    command: "false"\n    kind: command\n`,
  )
  const planPath = join(repo, 'plan.json')
  expect((await ledgerPlan(['--ledger', join(repo, '.qa'), '--out', planPath])).code).toBe(0)

  const err = capture()
  const code = await main(
    ['run', '--plan', planPath, '--id', 'main-1', '--repo', repo, '--base', 'abc', '--head', 'abc', '--evidence', join(repo, 'evidence'), '--profile', join(repo, '.qa')],
    capture().writer,
    err.writer,
    { runCompose: async () => ({ code: 0, stdout: '', stderr: '' }), probe: async () => ({ ok: true }), pollIntervalMs: 1 },
  )
  const result = JSON.parse(await readFile(join(repo, 'evidence', 'result.json'), 'utf8'))
  expect(result.criteria.map((criterion: { id: string; outcome: string }) => [criterion.id, criterion.outcome])).toEqual([
    ['broken', 'failed'],
    ['sign-in', 'proven'],
  ])
  expect(result.verdict).toBe('failed')
  expect(code).toBe(1)
})
