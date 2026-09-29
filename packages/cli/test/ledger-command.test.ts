import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  BranchLedgerStore,
  FileLedgerStore,
  LEDGER_FILE,
  appendChange,
  criterionIdFor,
  questionIdFor,
  type LedgerEntry,
} from '@qare/core'
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
    'Error: unknown ledger subcommand "explode"; usage: qare ledger <list|show|diff|status|contradict|resolve|decide|export|import|publish|migrate> [--ledger <dir>]',
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

const HELD_WORDS = 'the payouts page shows the 1099 notice for a host paid past the annual threshold'

async function resolveInputs(work: string, verdict: 'failed' | 'passed'): Promise<{ resultPath: string; criteriaPath: string }> {
  const resultPath = join(work, 'result.json')
  const criteriaPath = join(work, 'criteria.json')
  await writeFile(
    resultPath,
    `${JSON.stringify({
      schemaVersion: '1',
      verdict,
      criteria: [{ id: criterionIdFor(HELD_WORDS), outcome: 'failed', evidence: ['evidence/a.txt'] }],
    })}\n`,
    'utf8',
  )
  await writeFile(criteriaPath, `${JSON.stringify([{ id: NEW_ID, text: NEW_WORDS }])}\n`, 'utf8')
  return { resultPath, criteriaPath }
}

test('ledger resolve asks no question when the evidence settles the conflict, and holds nothing', async () => {
  const dir = await ledgerDir([
    { criterion: criterionIdFor(HELD_WORDS), status: 'active', source: [PR_12], proof: 'command', note: HELD_WORDS },
  ])
  const work = await mkdtemp(join(tmpdir(), 'qare-resolve-'))
  const { resultPath, criteriaPath } = await resolveInputs(work, 'failed')
  const out = capture()
  const errs = capture()
  const code = await runLedgerCommand(
    ['resolve', '--result', resultPath, '--criteria', criteriaPath, '--ledger', dir],
    out.writer,
    errs.writer,
  )
  expect(code).toBe(0)
  expect(linesOf(out.chunks)).toEqual([
    `settled  regression  ${criterionIdFor(HELD_WORDS)}  (executed-evidence)`,
    'no questions: every conflict is settled',
    `verdict with open questions held: failed`,
  ])
  expect(errs.chunks).toEqual([])
})

test('ledger resolve asks one question over an unproven replacement and holds only the affected criteria', async () => {
  const dir = await ledgerDir([
    { criterion: criterionIdFor(HELD_WORDS), status: 'active', source: [PR_12], proof: 'command', note: HELD_WORDS },
  ])
  const work = await mkdtemp(join(tmpdir(), 'qare-resolve-'))
  const { resultPath, criteriaPath } = await resolveInputs(work, 'failed')
  const nare = await fakeNare({
    pairs: [{ criterion: criterionIdFor(HELD_WORDS), replacement: NEW_ID, intendsReplacement: true, reason: 'the diff rewords the notice' }],
  })
  const out = capture()
  const errs = capture()
  const reportPath = join(work, 'resolution.json')
  const heldPath = join(work, 'held-result.json')
  const code = await runLedgerCommand(
    [
      'resolve',
      '--result', resultPath,
      '--criteria', criteriaPath,
      '--ledger', dir,
      '--nare', nare,
      '--out', reportPath,
      '--hold-out', heldPath,
    ],
    out.writer,
    errs.writer,
  )
  expect(code).toBe(0)
  const questionId = questionIdFor(criterionIdFor(HELD_WORDS), NEW_ID)
  expect(linesOf(out.chunks)).toEqual([
    `question  ${questionId}  ${criterionIdFor(HELD_WORDS)} → ${NEW_ID}  recommends supersede`,
    'held: ' + criterionIdFor(HELD_WORDS),
    'verdict with open questions held: blocked',
    'report: ' + reportPath,
    'held result: ' + heldPath,
  ])
  expect(errs.chunks).toEqual([])

  const held = JSON.parse(await readFile(heldPath, 'utf8'))
  expect(held.verdict).toBe('blocked')
  expect(held.criteria[0].outcome).toBe('unverified')
  expect(held.criteria[0].reason).toContain('held for an open question')
})

test('ledger resolve refuses a criteria-issue question without the issue and its author', async () => {
  const dir = await ledgerDir([FLOW_LOGIN])
  const work = await mkdtemp(join(tmpdir(), 'qare-resolve-'))
  const { resultPath, criteriaPath } = await resolveInputs(work, 'passed')
  const out = capture()
  const errs = capture()
  const code = await runLedgerCommand(
    ['resolve', '--result', resultPath, '--criteria', criteriaPath, '--ledger', dir, '--place', 'issue'],
    out.writer,
    errs.writer,
  )
  expect(code).toBe(1)
  expect(linesOf(errs.chunks)).toEqual([
    'Error: qare ledger resolve: --place issue requires --issue <issue number>',
  ])
})

test('ledger decide folds a supersede answer into a proposal and never writes the ledger file', async () => {
  const dir = await ledgerDir([
    { criterion: criterionIdFor(HELD_WORDS), status: 'active', source: [PR_12], proof: 'command', note: HELD_WORDS },
  ])
  const work = await mkdtemp(join(tmpdir(), 'qare-decide-'))
  const proposalPath = join(work, 'proposed-ledger.json')
  const out = capture()
  const errs = capture()
  const code = await runLedgerCommand(
    [
      'decide',
      '--criterion', criterionIdFor(HELD_WORDS),
      '--replacement', NEW_ID,
      '--text', NEW_WORDS,
      '--classification', 'supersede',
      '--by', 'jason',
      '--why', 'the email-only payout is the intended behaviour',
      '--at', '2026-09-29',
      '--ledger', dir,
      '--out', proposalPath,
    ],
    out.writer,
    errs.writer,
  )
  expect(code).toBe(0)
  expect(errs.chunks).toEqual([])
  const proposal = JSON.parse(await readFile(proposalPath, 'utf8'))
  const byCriterion = new Map(proposal.entries.map((entry: LedgerEntry) => [entry.criterion, entry]))
  expect(byCriterion.get(criterionIdFor(HELD_WORDS)).status).toBe('superseded')
  const replacement = byCriterion.get(NEW_ID)
  expect(replacement.status).toBe('proposed')
  expect(replacement.supersedes).toEqual([criterionIdFor(HELD_WORDS)])
  expect(replacement.resolution).toMatchObject({
    classification: 'supersede',
    by: 'jason',
    why: 'the email-only payout is the intended behaviour',
    at: '2026-09-29',
  })
  // The ledger file itself is untouched: the proposal waits for review.
  const untouched = await new FileLedgerStore(dir).load()
  expect(untouched.find((entry) => entry.criterion === criterionIdFor(HELD_WORDS))?.status).toBe('active')
})

test('ledger decide records a regression answer on the rule that failed, changing no status', async () => {
  const dir = await ledgerDir([
    { criterion: criterionIdFor(HELD_WORDS), status: 'active', source: [PR_12], proof: 'command', note: HELD_WORDS },
  ])
  const work = await mkdtemp(join(tmpdir(), 'qare-decide-'))
  const proposalPath = join(work, 'proposed-ledger.json')
  const out = capture()
  const errs = capture()
  const code = await runLedgerCommand(
    [
      'decide',
      '--criterion', criterionIdFor(HELD_WORDS),
      '--classification', 'regression',
      '--by', 'jason',
      '--why', 'a bug in the diff, not a plan',
      '--at', '2026-09-29',
      '--ledger', dir,
      '--out', proposalPath,
    ],
    out.writer,
    errs.writer,
  )
  expect(code).toBe(0)
  const proposal = JSON.parse(await readFile(proposalPath, 'utf8'))
  expect(proposal.entries).toHaveLength(1)
  expect(proposal.entries[0].status).toBe('active')
  expect(proposal.entries[0].resolution).toMatchObject({ classification: 'regression', by: 'jason' })
})

test('ledger decide rejects an answer whose question id does not name the conflict', async () => {
  const dir = await ledgerDir([FLOW_LOGIN])
  const out = capture()
  const errs = capture()
  const code = await runLedgerCommand(
    [
      'decide',
      '--criterion', 'flow-login',
      '--classification', 'regression',
      '--by', 'jason',
      '--why', 'no',
      '--question', 'q-0000000000000000',
      '--ledger', dir,
    ],
    out.writer,
    errs.writer,
  )
  expect(code).toBe(1)
  expect(linesOf(errs.chunks)).toEqual(
    expect.arrayContaining([expect.stringContaining('does not name this conflict')]),
  )
})

test('ledger export writes the whole ledger as plain files', async () => {
  const dir = await ledgerDir([FLOW_LOGIN, EXPORT_CSV])
  const exportDir = join(await mkdtemp(join(tmpdir(), 'qare-export-')), 'exported')
  const out = capture()
  const code = await runLedgerCommand(['export', '--out', exportDir, '--ledger', dir], out.writer, capture().writer)
  expect(code).toBe(0)
  const document = JSON.parse(await readFile(join(exportDir, 'ledger.json'), 'utf8'))
  expect(document.entries).toEqual([FLOW_LOGIN, EXPORT_CSV])
  const criteria = await readFile(join(exportDir, 'CRITERIA.md'), 'utf8')
  expect(criteria).toContain('# Criteria')
  expect(criteria).toContain('flow-login')
  const history = await readFile(join(exportDir, 'HISTORY.md'), 'utf8')
  expect(history).toContain('# Ledger history')
  expect(linesOf(out.chunks)).toEqual([expect.stringContaining('exported 2 entries and 0 change records')])
})

test('an exported ledger imports back with no loss, history intact', async () => {
  const source = await ledgerDir([FLOW_LOGIN])
  const exported = appendChange([], {
    kind: 'ingest',
    actor: 'jason',
    timestamp: '2026-09-29T00:00:00Z',
    reason: 'seeded the ledger',
    criteria: ['flow-login'],
  })
  await new FileLedgerStore(source).saveDocument([FLOW_LOGIN], exported)
  const exportDir = join(await mkdtemp(join(tmpdir(), 'qare-export-')), 'exported')
  await runLedgerCommand(['export', '--out', exportDir, '--ledger', source], capture().writer, capture().writer)
  const target = join(await mkdtemp(join(tmpdir(), 'qare-import-')), '.qa')
  const out = capture()
  const code = await runLedgerCommand(
    ['import', '--from', exportDir, '--ledger', target, '--by', 'jason', '--why', 'restored from export'],
    out.writer,
    capture().writer,
  )
  expect(code).toBe(0)
  const document = await new FileLedgerStore(target).loadDocument()
  expect(document.entries).toEqual([FLOW_LOGIN])
  expect(document.changes).toEqual([
    ...exported,
    {
      seq: 2,
      kind: 'import',
      actor: 'jason',
      timestamp: document.changes[1].timestamp,
      reason: 'restored from export',
      criteria: [],
      digest: document.changes[1].digest,
    },
  ])
  expect(linesOf(out.chunks)).toEqual([
    'imported 1 entries with 2 change records: history intact',
    expect.stringContaining('published view refreshed'),
  ])
})

test('an import that would rewrite the target history is refused', async () => {
  const target = join(await mkdtemp(join(tmpdir(), 'qare-import-')), '.qa')
  const divergent = appendChange([], {
    kind: 'ingest',
    actor: 'jason',
    timestamp: '2026-09-29T00:00:00Z',
    reason: 'seeded this ledger',
    criteria: ['flow-login'],
  })
  await new FileLedgerStore(target).saveDocument([FLOW_LOGIN], divergent)
  const elsewhere = join(await mkdtemp(join(tmpdir(), 'qare-ledger-')), '.qa')
  const other = appendChange([], {
    kind: 'ingest',
    actor: 'someone else',
    timestamp: '2026-09-29T02:00:00Z',
    reason: 'seeded elsewhere',
    criteria: ['flow-login'],
  })
  await new FileLedgerStore(elsewhere).saveDocument([FLOW_LOGIN], other)
  const exportDir = join(await mkdtemp(join(tmpdir(), 'qare-export-')), 'exported')
  await runLedgerCommand(['export', '--out', exportDir, '--ledger', elsewhere], capture().writer, capture().writer)
  const errs = capture()
  const code = await runLedgerCommand(
    ['import', '--from', exportDir, '--ledger', target, '--by', 'jason', '--why', 'downgrade'],
    capture().writer,
    errs.writer,
  )
  expect(code).toBe(1)
  expect(linesOf(errs.chunks)).toEqual([
    expect.stringContaining('does not carry the ledger history forward'),
  ])
})

test('ledger publish writes the current state and names held criteria', async () => {
  const dir = await ledgerDir([FLOW_LOGIN, EXPORT_CSV])
  await writeFile(
    join(dir, 'held-result.json'),
    JSON.stringify({
      criteria: [
        { id: 'ledger-export-csv', outcome: 'unverified', reason: 'held for an open question (q-1) — conflict' },
        { id: 'flow-login', outcome: 'unverified', reason: 'no proof carried' },
      ],
    }),
  )
  const view = join(await mkdtemp(join(tmpdir(), 'qare-publish-')), 'CRITERIA.md')
  const out = capture()
  const code = await runLedgerCommand(['publish', '--out', view, '--ledger', dir], out.writer, capture().writer)
  expect(code).toBe(0)
  const text = await readFile(view, 'utf8')
  expect(text).toContain('## Quarantined')
  expect(text).toContain(': ledger-export-csv.')
  expect(linesOf(out.chunks)).toEqual(['published 2 criteria to ' + view])
})

test('a held criterion whose question is answered and entry promoted is no longer quarantined', async () => {
  const dir = await ledgerDir([FLOW_LOGIN])
  await writeFile(
    join(dir, 'held-result.json'),
    JSON.stringify({
      criteria: [{ id: 'flow-login', outcome: 'unverified', reason: 'held for an open question (q-1) — conflict' }],
    }),
  )
  const view = join(await mkdtemp(join(tmpdir(), 'qare-publish-')), 'CRITERIA.md')
  await runLedgerCommand(['publish', '--out', view, '--ledger', dir], capture().writer, capture().writer)
  expect(await readFile(view, 'utf8')).not.toContain('## Quarantined')
})

async function gitRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'qare-migrate-repo-'))
  execSync('git init -q', { cwd: repo })
  execSync('git config user.email t@e.st', { cwd: repo })
  execSync('git config user.name t', { cwd: repo })
  return repo
}

async function ledgerWithHistory(): Promise<string> {
  const dir = await ledgerDir([FLOW_LOGIN, EXPORT_CSV])
  const changes = appendChange([], {
    kind: 'ingest',
    actor: 'jason',
    timestamp: '2026-09-29T00:00:00Z',
    reason: 'seeded the ledger',
    criteria: ['flow-login', 'ledger-export-csv'],
  })
  await new FileLedgerStore(dir).saveDocument([FLOW_LOGIN, EXPORT_CSV], changes)
  return dir
}

test('ledger migrate --to branch moves the document whole: ids unchanged, history intact', async () => {
  const repo = await gitRepo()
  const dir = await ledgerWithHistory()
  const original = await new FileLedgerStore(dir).loadDocument()
  const out = capture()
  const code = await runLedgerCommand(
    ['migrate', '--to', 'branch', '--ledger', dir, '--repo', repo],
    out.writer,
    capture().writer,
  )
  expect(code).toBe(0)
  const migrated = await new BranchLedgerStore(repo, 'qare-ledger').loadDocument()
  expect(migrated.entries).toEqual(original.entries)
  expect(migrated.changes).toEqual(original.changes)
  expect(linesOf(out.chunks)).toEqual([
    `migrate: 2 entries and 1 change record moved from files (${dir}) to branch (qare-ledger in ${repo})`,
  ])
})

test('ledger migrate --to files moves the branch document whole', async () => {
  const repo = await gitRepo()
  const source = await ledgerWithHistory()
  await runLedgerCommand(
    ['migrate', '--to', 'branch', '--ledger', source, '--repo', repo],
    capture().writer,
    capture().writer,
  )
  const target = join(await mkdtemp(join(tmpdir(), 'qare-migrate-')), '.qa')
  const out = capture()
  const code = await runLedgerCommand(
    ['migrate', '--to', 'files', '--ledger', target, '--repo', repo],
    out.writer,
    capture().writer,
  )
  expect(code).toBe(0)
  const migrated = await new FileLedgerStore(target).loadDocument()
  expect(migrated.entries).toEqual([FLOW_LOGIN, EXPORT_CSV])
  expect(migrated.changes).toEqual(await new BranchLedgerStore(repo, 'qare-ledger').loadDocument().then((d) => d.changes))
  expect(linesOf(out.chunks)).toEqual([
    expect.stringContaining(`moved from branch (qare-ledger in ${repo}) to files (${target})`),
  ])
})

test('ledger migrate --dry-run reports what would move and writes nothing', async () => {
  const repo = await gitRepo()
  const dir = await ledgerWithHistory()
  const out = capture()
  const code = await runLedgerCommand(
    ['migrate', '--to', 'branch', '--dry-run', '--ledger', dir, '--repo', repo],
    out.writer,
    capture().writer,
  )
  expect(code).toBe(0)
  expect(linesOf(out.chunks)).toEqual([
    'migrate: 2 entries and 1 change record would move from files (' +
      dir +
      ') to branch (qare-ledger in ' +
      repo +
      ')',
  ])
  expect(execSync('git for-each-ref refs/heads', { cwd: repo }).toString()).toBe('')
  expect(await new FileLedgerStore(dir).load()).toEqual([FLOW_LOGIN, EXPORT_CSV])
})

test('a migration onto a non-empty destination is refused without --force', async () => {
  const repo = await gitRepo()
  const dir = await ledgerDir([FLOW_LOGIN])
  await new BranchLedgerStore(repo, 'qare-ledger').save([EXPORT_CSV])
  const errs = capture()
  const code = await runLedgerCommand(
    ['migrate', '--to', 'branch', '--ledger', dir, '--repo', repo],
    capture().writer,
    errs.writer,
  )
  expect(code).toBe(1)
  expect(linesOf(errs.chunks)).toEqual([
    expect.stringContaining('already holds a ledger (1 entry, 0 change records); pass --force to replace it'),
  ])
  const target = await ledgerDir([PAYOUT_NOTICE])
  const fileErrs = capture()
  const fileCode = await runLedgerCommand(
    ['migrate', '--to', 'files', '--ledger', target, '--repo', repo],
    capture().writer,
    fileErrs.writer,
  )
  expect(fileCode).toBe(1)
  expect(linesOf(fileErrs.chunks)).toEqual([
    expect.stringContaining('already holds a ledger (1 entry, 0 change records); pass --force to replace it'),
  ])
})

test('ledger migrate --force replaces a non-empty destination', async () => {
  const repo = await gitRepo()
  const dir = await ledgerDir([FLOW_LOGIN])
  await new BranchLedgerStore(repo, 'qare-ledger').save([EXPORT_CSV])
  const out = capture()
  const code = await runLedgerCommand(
    ['migrate', '--to', 'branch', '--force', '--ledger', dir, '--repo', repo],
    out.writer,
    capture().writer,
  )
  expect(code).toBe(0)
  const migrated = await new BranchLedgerStore(repo, 'qare-ledger').loadDocument()
  expect(migrated.entries).toEqual([FLOW_LOGIN])
  expect(migrated.changes).toEqual([])
})

test('a migration from a backend that holds no ledger is refused instead of moving nothing', async () => {
  const repo = await gitRepo()
  const empty = await mkdtemp(join(tmpdir(), 'qare-ledger-'))
  const errs = capture()
  const branchCode = await runLedgerCommand(
    ['migrate', '--to', 'branch', '--ledger', empty, '--repo', repo],
    capture().writer,
    errs.writer,
  )
  expect(branchCode).toBe(1)
  expect(linesOf(errs.chunks)).toEqual([
    expect.stringContaining(
      `holds no ledger (0 entries and 0 change records); check the --ledger, --repo and --branch flags`,
    ),
  ])
  expect(execSync('git for-each-ref refs/heads', { cwd: repo }).toString()).toBe('')
  const target = join(await mkdtemp(join(tmpdir(), 'qare-ledger-')), '.qa')
  const fileErrs = capture()
  const filesCode = await runLedgerCommand(
    ['migrate', '--to', 'files', '--ledger', target, '--repo', repo],
    capture().writer,
    fileErrs.writer,
  )
  expect(filesCode).toBe(1)
  expect(linesOf(fileErrs.chunks)).toEqual([
    expect.stringContaining('holds no ledger (0 entries and 0 change records)'),
  ])
  await expect(readFile(join(target, LEDGER_FILE), 'utf8')).rejects.toThrow()
})

test('ledger migrate requires --to naming a backend', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-ledger-'))
  const missing = capture()
  const missingCode = await runLedgerCommand(['migrate', '--ledger', dir], capture().writer, missing.writer)
  expect(missingCode).toBe(1)
  expect(linesOf(missing.chunks)).toEqual(['Error: qare ledger migrate requires --to <branch|files>'])
  const nonsense = capture()
  const nonsenseCode = await runLedgerCommand(
    ['migrate', '--to', 'git', '--ledger', dir],
    capture().writer,
    nonsense.writer,
  )
  expect(nonsenseCode).toBe(1)
  expect(linesOf(nonsense.chunks)).toEqual(['Error: ledger migrate: --to must be "branch" or "files", not "git"'])
})

test('a ledger migrated in both directions ends up byte-identical on export', async () => {
  const repo = await gitRepo()
  const dir = await ledgerWithHistory()
  const before = join(await mkdtemp(join(tmpdir(), 'qare-export-')), 'before')
  await runLedgerCommand(['export', '--out', before, '--ledger', dir], capture().writer, capture().writer)
  await runLedgerCommand(
    ['migrate', '--to', 'branch', '--ledger', dir, '--repo', repo],
    capture().writer,
    capture().writer,
  )
  const back = join(await mkdtemp(join(tmpdir(), 'qare-migrate-')), '.qa')
  await runLedgerCommand(
    ['migrate', '--to', 'files', '--ledger', back, '--repo', repo],
    capture().writer,
    capture().writer,
  )
  const after = join(await mkdtemp(join(tmpdir(), 'qare-export-')), 'after')
  await runLedgerCommand(['export', '--out', after, '--ledger', back], capture().writer, capture().writer)
  for (const name of [LEDGER_FILE, 'CRITERIA.md', 'HISTORY.md'])
    expect(await readFile(join(after, name), 'utf8')).toBe(await readFile(join(before, name), 'utf8'))
})
