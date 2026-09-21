import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { FileLedgerStore, LEDGER_FILE, type LedgerEntry } from '@qare/core'
import { main, runLedgerCommand } from '../src/index.js'
import type { Writer } from '../src/index.js'

const link = (path: string) => ['https:', `//example.test${path}`].join('')
const PR_12 = link('/pr/12')

const FLOW_LOGIN: LedgerEntry = {
  criterion: 'flow-login',
  status: 'active',
  source: [PR_12],
  proof: 'command',
  note: 'pinned by spec-up-200',
}
const EXPORT_CSV: LedgerEntry = {
  criterion: 'ledger-export-csv',
  status: 'proposed',
  source: [link('/pr/13')],
  proof: 'command',
}
const PAYOUT_NOTICE: LedgerEntry = {
  criterion: 'payout-1099-notice',
  status: 'retired',
  source: [link('/pr/14'), link('/pr/15')],
  proof: 'command',
}

async function ledgerDir(entries: LedgerEntry[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-ledger-'))
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

test('ledger list prints one line per entry in canonical criterion order', async () => {
  const dir = await ledgerDir([PAYOUT_NOTICE, FLOW_LOGIN, EXPORT_CSV])
  const out = capture()
  const errs = capture()
  const code = await runLedgerCommand(['list', '--ledger', dir], out.writer, errs.writer)
  expect(code).toBe(0)
  expect(linesOf(out.chunks)).toEqual([
    'flow-login  active  command',
    'ledger-export-csv  proposed  command',
    'payout-1099-notice  retired  command',
  ])
  expect(errs.chunks).toEqual([])
})

test('ledger list on an empty ledger prints nothing and exits 0', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-ledger-'))
  const out = capture()
  const errs = capture()
  const code = await runLedgerCommand(['list', '--ledger', dir], out.writer, errs.writer)
  expect(code).toBe(0)
  expect(linesOf(out.chunks)).toEqual([])
  expect(errs.chunks).toEqual([])
})

test('ledger show pretty-prints the single entry with sources and note', async () => {
  const dir = await ledgerDir([FLOW_LOGIN, PAYOUT_NOTICE])
  const out = capture()
  const errs = capture()
  const code = await runLedgerCommand(['show', 'flow-login', '--ledger', dir], out.writer, errs.writer)
  expect(code).toBe(0)
  expect(linesOf(out.chunks)).toEqual([
    'criterion: flow-login',
    'status: active',
    'proof: command',
    `source: ${PR_12}`,
    'note: pinned by spec-up-200',
  ])
  expect(errs.chunks).toEqual([])
})

test('ledger show on an unknown criterion exits 1 with a named error on stderr', async () => {
  const dir = await ledgerDir([FLOW_LOGIN])
  const out = capture()
  const errs = capture()
  const code = await runLedgerCommand(['show', 'absent-criterion', '--ledger', dir], out.writer, errs.writer)
  expect(code).toBe(1)
  expect(linesOf(out.chunks)).toEqual([])
  expect(linesOf(errs.chunks)).toEqual([
    'Error: ledger: show: no entry for criterion "absent-criterion"',
  ])
})

test('ledger diff between identical ledgers exits 0 with no output', async () => {
  const dir = await ledgerDir([FLOW_LOGIN, EXPORT_CSV])
  const other = await ledgerDir([FLOW_LOGIN, EXPORT_CSV])
  const out = capture()
  const errs = capture()
  const code = await runLedgerCommand(['diff', '--ledger', dir, '--against', other], out.writer, errs.writer)
  expect(code).toBe(0)
  expect(linesOf(out.chunks)).toEqual([])
  expect(errs.chunks).toEqual([])
})

test('ledger diff reports added, removed and changed entries', async () => {
  const base = await ledgerDir([
    FLOW_LOGIN,
    {
      criterion: 'legacy-proofs',
      status: 'retired',
      source: [link('/pr/16')],
      proof: 'command',
      note: 'replaced by flow-login',
    },
  ])
  const other = await ledgerDir([
    { ...FLOW_LOGIN, status: 'retired' },
    { criterion: 'legacy-proofs', status: 'retired', source: [link('/pr/16')], proof: 'check' },
    EXPORT_CSV,
  ])
  const out = capture()
  const errs = capture()
  const code = await runLedgerCommand(['diff', '--ledger', base, '--against', other], out.writer, errs.writer)
  expect(code).toBe(0)
  expect(linesOf(out.chunks)).toEqual([
    '~ flow-login active → retired',
    '+ ledger-export-csv proposed command',
    '~ legacy-proofs retired proof=command note="replaced by flow-login" → retired proof=check',
  ])
  expect(errs.chunks).toEqual([])
})

test('ledger diff reports note-only changes', async () => {
  const base = await ledgerDir([{ ...FLOW_LOGIN, note: 'old note' }])
  const other = await ledgerDir([{ ...FLOW_LOGIN, note: 'new note' }])
  const out = capture()
  const errs = capture()
  const code = await runLedgerCommand(['diff', '--ledger', base, '--against', other], out.writer, errs.writer)
  expect(code).toBe(0)
  expect(linesOf(out.chunks)).toEqual(['~ flow-login active note="old note" → active note="new note"'])
  expect(errs.chunks).toEqual([])
})

test('ledger diff without --against exits 1 with the usage error on stderr', async () => {
  const dir = await ledgerDir([FLOW_LOGIN])
  const out = capture()
  const errs = capture()
  const code = await runLedgerCommand(['diff', '--ledger', dir], out.writer, errs.writer)
  expect(code).toBe(1)
  expect(linesOf(out.chunks)).toEqual([])
  expect(linesOf(errs.chunks)).toEqual(['Error: qare ledger diff requires --against <other-ledger-dir>'])
})

test('ledger status prints counts and integrity ok', async () => {
  const dir = await ledgerDir([FLOW_LOGIN, EXPORT_CSV, PAYOUT_NOTICE])
  const out = capture()
  const errs = capture()
  const code = await runLedgerCommand(['status', '--ledger', dir], out.writer, errs.writer)
  expect(code).toBe(0)
  expect(linesOf(out.chunks)).toEqual([
    'proposed: 1 active: 1 superseded: 0 retired: 1 total: 3',
    'integrity: ok',
  ])
  expect(errs.chunks).toEqual([])
})

test('ledger status on a tampered ledger exits 1 with integrity tampered on stderr', async () => {
  const dir = await ledgerDir([FLOW_LOGIN, EXPORT_CSV])
  const ledgerPath = join(dir, LEDGER_FILE)
  const document = JSON.parse(await readFile(ledgerPath, 'utf8'))
  document.integrity = `sha256:${'0'.repeat(64)}`
  await writeFile(ledgerPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  const out = capture()
  const errs = capture()
  const code = await runLedgerCommand(['status', '--ledger', dir], out.writer, errs.writer)
  expect(code).toBe(1)
  expect(linesOf(out.chunks)).toEqual([])
  expect(linesOf(errs.chunks)).toEqual([
    'integrity: tampered (Error: ledger: document.integrity: ledger integrity check failed: '
      + 'expected sha256:466875b62ba3bfd66efbe9bf87bce9509bb0d5d0e375ec126211465447522025, '
      + `got "sha256:${'0'.repeat(64)}")`,
  ])
})

test('main routes the ledger command through the single entrypoint', async () => {
  const dir = await ledgerDir([FLOW_LOGIN, PAYOUT_NOTICE])
  const out = capture()
  const errs = capture()
  const code = await main(['ledger', 'list', '--ledger', dir], out.writer, errs.writer)
  expect(code).toBe(0)
  expect(linesOf(out.chunks)).toEqual([
    'flow-login  active  command',
    'payout-1099-notice  retired  command',
  ])
  expect(errs.chunks).toEqual([])
})

test('main rejects an unknown ledger subcommand with exit 1', async () => {
  const dir = await ledgerDir([FLOW_LOGIN])
  const out = capture()
  const errs = capture()
  const code = await main(['ledger', 'explode', '--ledger', dir], out.writer, errs.writer)
  expect(code).toBe(1)
  expect(linesOf(out.chunks)).toEqual([])
  expect(linesOf(errs.chunks)).toEqual([
    'Error: unknown ledger subcommand "explode"; usage: qare ledger <list|show|diff|status> [--ledger <dir>]',
  ])
})
