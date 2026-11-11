import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { parse } from 'yaml'
import { FileLedgerStore, loadProfile } from '@qare/core'

// #363: qare runs its own ledger on the default branch. The main lane is on
// in qare's caller, every active criterion is planned with a suite its
// profile declares, and a finding nobody can be blamed for has someone to
// reach.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const CLI = join(repoRoot, 'packages', 'cli', 'dist', 'index.js')
const QA = join(repoRoot, '.qa')

interface Caller {
  on: { schedule?: Array<{ cron: string }> }
  jobs: { qare: { with: Record<string, string> } }
}

test("qare's own caller runs the main lane daily, files for real and records passes, before the sweep reads them", () => {
  const caller = parse(readFileSync(join(repoRoot, '.github', 'workflows', 'qare.yml'), 'utf8')) as Caller
  const inputs = caller.jobs.qare.with
  expect(inputs['main-lane']).toBe('true')
  expect(inputs['main-lane-dry-run']).toBe('false')
  expect(inputs['main-lane-record-passes']).toBe('true')
  const sweep = parse(readFileSync(join(repoRoot, '.github', 'workflows', 'sweep.yml'), 'utf8')) as Caller
  const minuteOfDay = (cron: string): number => {
    const [minute, hour] = cron.split(' ')
    return Number(hour) * 60 + Number(minute)
  }
  const lane = caller.on.schedule?.map((entry) => entry.cron) ?? []
  expect(lane).toHaveLength(1)
  expect(lane[0]).toMatch(/^\d+ \d+ \* \* \*$/)
  expect(minuteOfDay(lane[0] ?? '')).toBeLessThan(minuteOfDay(sweep.on.schedule?.[0]?.cron ?? ''))
})

test("every active criterion in qare's own ledger is planned with a suite its profile declares", async () => {
  const document = await new FileLedgerStore(QA).loadDocument()
  const active = document.entries.filter((entry) => entry.status === 'active').map((entry) => entry.criterion)
  expect(active).toEqual(expect.arrayContaining(['mail-missing-code-retains-delivery', 'mail-missing-code-stays-unverified', 'mail-quoted-values-preserve-whitespace']))
  const profile = await loadProfile(QA)
  const declared = new Map((profile.suites ?? []).map((suite) => [suite.name, suite.command]))
  const out = join(mkdtempSync(join(tmpdir(), 'qare-self-lane-')), 'plan.json')
  const planned = spawnSync(process.execPath, [CLI, 'ledger', 'plan', '--ledger', QA, '--out', out], { encoding: 'utf8' })
  expect(planned.status, planned.stderr).toBe(0)
  expect(planned.stdout).toContain(`${active.length} active criteria (0 with no suite to run)`)
  const plan = JSON.parse(readFileSync(out, 'utf8')) as { criteria: Array<{ id: string; checks?: Array<{ suite?: string }> }> }
  expect(plan.criteria.map((criterion) => criterion.id).sort()).toEqual([...active].sort())
  for (const criterion of plan.criteria) {
    expect(criterion.checks?.length, criterion.id).toBeGreaterThan(0)
    for (const check of criterion.checks ?? []) expect(declared.has(check.suite ?? ''), `${criterion.id}: ${check.suite}`).toBe(true)
  }
  // The mail suites run the declared mail self-checks, nothing else.
  expect(declared.get('mail-quoted-auth')).toBe('node -- .qa/checks/mail-evidence.mjs quoted-auth')
  expect(declared.get('mail-missing-code')).toBe('node -- .qa/checks/mail-evidence.mjs missing-code')
})

test("qare's own profile names who hears of a finding on main that no change can be blamed for", async () => {
  const profile = await loadProfile(QA)
  expect(profile.findings?.fallback?.length ?? 0).toBeGreaterThan(0)
})
