import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { FileLedgerStore } from '@qare/core'
import { main } from '../src/index.js'
import type { Writer } from '../src/index.js'

function capture(): { lines: string[]; writer: Writer } {
  const lines: string[] = []
  return { lines, writer: { write: (chunk) => lines.push(chunk) } }
}

const RESULT = {
  schemaVersion: '1',
  verdict: 'failed',
  job: { id: 'pr-51-run' },
  startedAt: '2026-09-29T10:00:00.000Z',
  finishedAt: '2026-09-29T10:01:00.000Z',
  judgeUsage: { inputTokens: 40, outputTokens: 8 },
  criteria: [
    { id: 'c1', outcome: 'proven', evidence: ['evidence/c1/stdout.txt'] },
    { id: 'c2', outcome: 'failed', evidence: ['evidence/c2/stdout.txt'], reason: 'the verifier read the evidence' },
  ],
}

const PLAN = {
  schemaVersion: '1',
  usage: { inputTokens: 900, outputTokens: 120 },
  criteria: [{ id: 'c1', text: 'Totals convert to the viewer currency.', checks: [{ kind: 'command', name: 'look', command: 'true' }] }],
}

async function workspace(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'qare-metrics-cli-'))
}

test('metrics record joins the run, the plan and the verifier into one store line', async () => {
  const dir = await workspace()
  try {
    await writeFile(join(dir, 'judged-result.json'), JSON.stringify(RESULT), 'utf8')
    await writeFile(join(dir, 'plan.json'), JSON.stringify(PLAN), 'utf8')
    const { writer } = capture()
    const code = await main(
      ['metrics', 'record', '--result', join(dir, 'judged-result.json'), '--plan', join(dir, 'plan.json'), '--store', join(dir, 'qa-metrics'), '--out', join(dir, 'metrics.json'), '--pr', '51', '--base', 'main', '--head', 'abc'],
      writer,
      { write: () => {} },
    )
    expect(code).toBe(0)
    const record = JSON.parse(await readFile(join(dir, 'metrics.json'), 'utf8'))
    expect(record).toMatchObject({
      schemaVersion: 'qare.metrics.v1',
      recordedAt: expect.any(String),
      runId: 'pr-51-run',
      wallMs: 60_000,
      verdict: 'failed',
      model: { plan: { inputTokens: 900, outputTokens: 120 }, judge: { inputTokens: 40, outputTokens: 8 } },
      context: { pr: 51, base: 'main', head: 'abc' },
    })
    expect(record.criteria.selected).toHaveLength(2)
    const store = await readFile(join(dir, 'qa-metrics', 'runs.jsonl'), 'utf8')
    expect(store.split('\n')).toHaveLength(2)
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('metrics record refuses a result without the timestamps the wall clock needs', async () => {
  const dir = await workspace()
  try {
    await writeFile(join(dir, 'judged-result.json'), JSON.stringify({ ...RESULT, startedAt: undefined, finishedAt: undefined, judgeUsage: undefined }), 'utf8')
    const { writer } = capture()
    const errs = capture()
    const code = await main(['metrics', 'record', '--result', join(dir, 'judged-result.json')], writer, errs.writer)
    expect(code).toBe(1)
    expect(errs.lines.join('')).toContain('no startedAt/finishedAt timestamps')
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('metrics record stamps recordedAt once, and names the run by job id or --run (#51)', async () => {
  const dir = await workspace()
  try {
    const withoutJob = { ...RESULT, job: undefined }
    await writeFile(join(dir, 'judged-result.json'), JSON.stringify(withoutJob), 'utf8')
    const { writer } = capture()
    const code = await main(
      ['metrics', 'record', '--result', join(dir, 'judged-result.json'), '--run', 'workflow-42-1', '--store', join(dir, 'qa-metrics'), '--out', join(dir, 'metrics.json')],
      writer,
      { write: () => {} },
    )
    expect(code).toBe(0)
    const record = JSON.parse(await readFile(join(dir, 'metrics.json'), 'utf8'))
    expect(record.runId).toBe('workflow-42-1')
    expect(typeof record.recordedAt).toBe('string')
    // The store line and the --out copy are the same record: one recordedAt,
    // so a reader can join them without guessing which was written first.
    const line = JSON.parse((await readFile(join(dir, 'qa-metrics', 'runs.jsonl'), 'utf8')).trim())
    expect(line.recordedAt).toBe(record.recordedAt)
    expect(line.runId).toBe('workflow-42-1')
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('metrics record refuses a result with no job id and no --run: a record that names no run joins nothing (#51)', async () => {
  const dir = await workspace()
  try {
    const withoutJob = { ...RESULT, job: undefined }
    await writeFile(join(dir, 'judged-result.json'), JSON.stringify(withoutJob), 'utf8')
    const errs = capture()
    const code = await main(['metrics', 'record', '--result', join(dir, 'judged-result.json')], capture().writer, errs.writer)
    expect(code).toBe(1)
    expect(errs.lines.join('')).toContain('--run')
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('metrics note records what the runs cannot see, and ledger status reports the store (#51)', async () => {
  const dir = await workspace()
  try {
    const ledger = join(dir, '.qa')
    await new FileLedgerStore(ledger).saveDocument([], [])
    const { writer } = capture()
    const noteCode = await main(
      ['metrics', 'note', '--kind', 'qa-minutes', '--minutes', '30', '--text', 'retested the CSV crash by hand', '--store', join(ledger, 'metrics')],
      writer,
      { write: () => {} },
    )
    expect(noteCode).toBe(0)
    const status = capture()
    const statusCode = await main(['ledger', 'status', '--ledger', ledger], status.writer, { write: () => {} })
    expect(statusCode).toBe(0)
    const out = status.lines.join('')
    expect(out).toContain('metrics: runs recorded: 0')
    expect(out).toContain('metrics: human QA minutes: 30')
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('ledger status of a repository that recorded nothing says metrics: none', async () => {
  const dir = await workspace()
  try {
    const ledger = join(dir, '.qa')
    await new FileLedgerStore(ledger).saveDocument([], [])
    const { lines, writer } = capture()
    const code = await main(['ledger', 'status', '--ledger', ledger], writer, { write: () => {} })
    expect(code).toBe(0)
    expect(lines.join('')).toContain('metrics: none')
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('ledger status of a store of malformed lines alone does not mistake them for nothing (#51)', async () => {
  const dir = await workspace()
  try {
    const ledger = join(dir, '.qa')
    await new FileLedgerStore(ledger).saveDocument([], [])
    await mkdir(join(ledger, 'metrics'), { recursive: true })
    await writeFile(join(ledger, 'metrics', 'runs.jsonl'), 'null\n', 'utf8')
    const { lines, writer } = capture()
    const code = await main(['ledger', 'status', '--ledger', ledger], writer, { write: () => {} })
    expect(code).toBe(0)
    const out = lines.join('')
    expect(out).not.toContain('metrics: none')
    expect(out).toContain('metrics: 1 store line(s) were not valid and were skipped')
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('ledger status names a metrics store it cannot read instead of calling it none (#51)', async () => {
  const dir = await workspace()
  try {
    const ledger = join(dir, '.qa')
    await new FileLedgerStore(ledger).saveDocument([], [])
    await mkdir(join(ledger, 'metrics', 'runs.jsonl'), { recursive: true })
    const { lines, writer } = capture()
    const code = await main(['ledger', 'status', '--ledger', ledger], writer, { write: () => {} })
    expect(code).toBe(0)
    expect(lines.join('')).toMatch(/metrics: unreadable \(/)
  } finally {
    await rm(join(dir, '.qa', 'metrics'), { recursive: true })
    await rm(dir, { recursive: true })
  }
})
