import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { FileLedgerStore, type LedgerEntry } from '@qare/core'
import { main } from '../src/index.js'
import type { Writer } from '../src/index.js'

const link = (path: string) => ['https:', `//example.test${path}`].join('')

function entry(overrides: Partial<LedgerEntry> & { criterion: string }): LedgerEntry {
  return { status: 'active', source: [link('/pr/1')], proof: 'command', ...overrides }
}

const PAYOUT: LedgerEntry = entry({
  criterion: 'BIL-014',
  text: 'A host paid more than the annual threshold gets a 1099 in January.',
  checks: ['billing/spec/payout_tax_spec.rb:1099_threshold'],
})

async function ledgerDir(entries: LedgerEntry[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-select-'))
  await new FileLedgerStore(dir).save(entries)
  return dir
}

function capture(): { chunks: string[]; writer: Writer } {
  const chunks: string[] = []
  return { chunks, writer: { write: (chunk) => void chunks.push(chunk) } }
}

function linesOf(chunks: string[]): string[] {
  const text = chunks.join('')
  if (text === '') return []
  return text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
}

test('a one-file change selects the criteria whose checks cover the file', async () => {
  const dir = await ledgerDir([
    PAYOUT,
    entry({ criterion: 'BIL-015', checks: ['billing/spec/invoice_spec.rb'] }),
    entry({ criterion: 'BIL-021', text: 'the ledger opens', checks: ['suite:smoke'] }),
  ])
  const out = capture()
  const errs = capture()

  const code = await main(
    ['select', '--ledger', dir, '--paths', 'billing/spec/payout_tax_spec.rb'],
    out.writer,
    errs.writer,
  )

  expect(code).toBe(0)
  expect(errs.chunks).toEqual([])
  const lines = linesOf(out.chunks)
  expect(lines[0]).toMatch(/selected 2 of 3 criteria/)
  expect(lines).toEqual([
    expect.stringMatching(/^selected 2 of 3 criteria; estimated \d+ ms of a 900000 ms budget; 1 touched paths$/),
    '+ BIL-021\tsmoke\tthe ledger opens',
    '+ BIL-014\timpact\tA host paid more than the annual threshold gets a 1099 in January.',
    '- BIL-015\tunaffected\t',
  ])
})

test('the JSON report carries the selection and what was not selected', async () => {
  const dir = await ledgerDir([PAYOUT, entry({ criterion: 'BIL-009', status: 'retired', checks: ['billing/spec/payout_tax_spec.rb'] })])
  const out = capture()
  const reportPath = join(dir, 'selection.json')

  const code = await main(
    ['select', '--ledger', dir, '--paths', 'billing/spec/payout_tax_spec.rb', '--out', reportPath],
    out.writer,
    capture().writer,
  )

  expect(code).toBe(0)
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  expect(report.selected).toEqual([
    { criterion: 'BIL-014', reason: 'impact', text: PAYOUT.text },
  ])
  expect(report.notSelected).toEqual([
    { criterion: 'BIL-009', reason: 'status', detail: 'retired' },
  ])
  expect(report.touched).toEqual(['billing/spec/payout_tax_spec.rb'])
  expect(report.budgetMs).toBe(900000)
})

test('a mapped ledger with nothing touched selects the smoke set and the unmapped ones', async () => {
  const dir = await ledgerDir([
    entry({ criterion: 'BIL-021', checks: ['suite:smoke'] }),
    entry({ criterion: 'BIL-030' }),
    PAYOUT,
  ])
  const out = capture()

  const code = await main(['select', '--ledger', dir, '--paths', 'web/home.rb'], out.writer, capture().writer)

  expect(code).toBe(0)
  expect(linesOf(out.chunks).filter((line) => line.startsWith('+') || line.startsWith('-'))).toEqual([
    '+ BIL-021\tsmoke\t',
    '+ BIL-030\tunmapped\t',
    '- BIL-014\tunaffected\tA host paid more than the annual threshold gets a 1099 in January.',
  ])
})

test('selection takes a diff file when the paths are not known by hand', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-select-diff-'))
  const diffPath = join(dir, 'change.diff')
  await writeFile(
    diffPath,
    'diff --git a/billing/spec/payout_tax_spec.rb b/billing/spec/payout_tax_spec.rb\n--- a/x\n+++ b/x\n',
  )
  const ledger = await ledgerDir([PAYOUT])
  const out = capture()

  const code = await main(['select', '--ledger', ledger, '--diff', diffPath], out.writer, capture().writer)

  expect(code).toBe(0)
  expect(linesOf(out.chunks)[1]).toBe('+ BIL-014\timpact\tA host paid more than the annual threshold gets a 1099 in January.')
})

test('the invocation is wrong when the selection has nothing to work from', async () => {
  const errs = capture()
  const code = await main(['select'], capture().writer, errs.writer)
  expect(code).toBe(4)
  expect(errs.chunks.join('')).toMatch(/requires --diff|--paths/)

  const both = capture()
  const bothCode = await main(['select', '--diff', 'a', '--paths', 'b'], capture().writer, both.writer)
  expect(bothCode).toBe(4)
  expect(both.chunks.join('')).toMatch(/not both/)

  const budget = capture()
  const budgetCode = await main(['select', '--paths', 'x', '--budget', 'nope'], capture().writer, budget.writer)
  expect(budgetCode).toBe(4)
  expect(budget.chunks.join('')).toMatch(/positive whole number of milliseconds/)
})

test('a ledger that is not there selects nothing rather than failing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-select-empty-'))
  const out = capture()
  const code = await main(['select', '--ledger', dir, '--paths', 'app/main.rb'], out.writer, capture().writer)
  expect(code).toBe(0)
  expect(linesOf(out.chunks)[0]).toMatch(/^selected 0 of 0 criteria/)
  expect(linesOf(out.chunks).at(-1)).toMatch(/no criteria selected/)
})
