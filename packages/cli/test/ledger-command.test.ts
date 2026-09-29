import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { FileLedgerStore, LEDGER_FILE, criterionIdFor, type LedgerEntry } from '@qare/core'
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
    'Error: unknown ledger subcommand "explode"; usage: qare ledger <list|show|diff|status|contradict> [--ledger <dir>]',
  ])
})

const OLD_WORDS = 'the payouts page shows the 1099 notice for a host paid past the annual threshold'
const NEW_WORDS = 'payouts above the annual threshold are email-only and never produce a paper notice'
const OLD_ID = criterionIdFor(OLD_WORDS)
const NEW_ID = criterionIdFor(NEW_WORDS)

/**
 * A nare stand-in on disk: the CLI spawns whatever --nare names, so the
 * classifier is exercised through its real path rather than an injected object.
 */
async function fakeNare(answer: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-ledger-contradict-'))
  const binary = join(dir, 'nare')
  const script = [
    '#!/usr/bin/env node',
    `const answer = ${JSON.stringify(JSON.stringify(answer))}`,
    `console.log(JSON.stringify({ type: 'output', text: answer, detail: {} }))`,
    `console.log(JSON.stringify({ type: 'result', status: 'done', questions: [], usage: { input: 1, output: 1 },`,
    `  stop_reason: 'end_turn', turns: 1, contract: 1, output: JSON.parse(answer), error: null }))`,
  ].join('\n')
  await writeFile(`${binary}.mjs`, script, 'utf8')
  await writeFile(binary, `#!/bin/sh\nexec node ${binary}.mjs "$@"\n`, 'utf8')
  const { chmod } = await import('node:fs/promises')
  await chmod(binary, 0o755)
  return binary
}

test('ledger contradict classifies a supersede, writes the proposal, and leaves the ledger file alone', async () => {
  const dir = await ledgerDir([
    { criterion: OLD_ID, status: 'active', source: [PR_12], proof: 'command', note: OLD_WORDS },
  ])
  const work = await mkdtemp(join(tmpdir(), 'qare-contradict-'))
  const resultPath = join(work, 'result.json')
  const criteriaPath = join(work, 'criteria.json')
  const outPath = join(work, 'contradiction.json')
  await writeFile(resultPath, `${JSON.stringify({ criteria: [{ id: OLD_ID, outcome: 'failed' }, { id: NEW_ID, outcome: 'proven' }] })}\n`, 'utf8')
  await writeFile(criteriaPath, `${JSON.stringify([{ id: NEW_ID, text: NEW_WORDS }])}\n`, 'utf8')
  const out = capture()
  const errs = capture()
  const code = await runLedgerCommand(
    [
      'contradict',
      '--result',
      resultPath,
      '--criteria',
      criteriaPath,
      '--ledger',
      dir,
      '--nare',
      await fakeNare({ pairs: [{ criterion: OLD_ID, replacement: NEW_ID, intendsReplacement: true, reason: 'email-only' }] }),
      '--out',
      outPath,
    ],
    out.writer,
    errs.writer,
  )
  expect(code).toBe(0)
  expect(linesOf(out.chunks)).toEqual([
    `supersede  ${OLD_ID} → ${NEW_ID}  (executed-evidence)`,
    `proposal: ${outPath}`,
  ])
  expect(errs.chunks).toEqual([])
  const report = JSON.parse(await readFile(outPath, 'utf8'))
  expect(report.contradictions).toHaveLength(1)
  expect(report.contradictions[0]).toMatchObject({
    criterion: OLD_ID,
    replacement: NEW_ID,
    classification: 'supersede',
    basis: 'executed-evidence',
  })
  const entries = await new FileLedgerStore(dir).load()
  expect(entries.find((entry) => entry.criterion === OLD_ID)?.status).toBe('active')
})

test('ledger contradict without a classifier reads the failure as a regression', async () => {
  const dir = await ledgerDir([
    { criterion: OLD_ID, status: 'active', source: [PR_12], proof: 'command', note: OLD_WORDS },
  ])
  const work = await mkdtemp(join(tmpdir(), 'qare-contradict-'))
  const resultPath = join(work, 'result.json')
  const criteriaPath = join(work, 'criteria.json')
  await writeFile(resultPath, `${JSON.stringify({ criteria: [{ id: OLD_ID, outcome: 'failed' }] })}\n`, 'utf8')
  await writeFile(criteriaPath, `${JSON.stringify([{ id: NEW_ID, text: NEW_WORDS }])}\n`, 'utf8')
  const out = capture()
  const errs = capture()
  const code = await runLedgerCommand(
    ['contradict', '--result', resultPath, '--criteria', criteriaPath, '--ledger', dir],
    out.writer,
    errs.writer,
  )
  expect(code).toBe(0)
  expect(linesOf(out.chunks)).toEqual([`regression  ${OLD_ID}  (executed-evidence)`])
  expect(errs.chunks).toEqual([])
})

test('ledger contradict names its required arguments on stderr', async () => {
  const dir = await ledgerDir([FLOW_LOGIN])
  const out = capture()
  const errs = capture()
  const code = await runLedgerCommand(['contradict', '--ledger', dir], out.writer, errs.writer)
  expect(code).toBe(1)
  expect(linesOf(out.chunks)).toEqual([])
  expect(linesOf(errs.chunks)).toEqual(['Error: qare ledger contradict requires --result <judged-result.json>'])
})
