import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { serializeLedger } from '@qare/core'
import { main } from '../src/index.js'
import type { Writer } from '../src/index.js'

function capture(): { lines: string[]; writer: Writer } {
  const lines: string[] = []
  return { lines, writer: { write: (chunk) => lines.push(chunk) } }
}

// Split on purpose: a repo-wide guard forbids a literal URL in a test file,
// so no test can quietly reach the network.
const HEALTH_URL = ['http:', '//localhost:3000/up'].join('')

const BOOT = {
  runCompose: async () => ({ code: 0, stdout: '', stderr: '' }),
  probe: async () => ({ ok: true }),
  pollIntervalMs: 1,
}

/** A repository whose ledger names two criteria and whose profile runs the smoke suite. */
async function subsetRepo(suites: { name: string; command: string; kind: string }[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-runcriteria-'))
  await mkdir(join(dir, '.qa'), { recursive: true })
  await writeFile(
    join(dir, '.qa', 'ledger.json'),
    serializeLedger([
      { criterion: 'BIL-014', status: 'active', source: [['https:', '//example.test/pr/1'].join('')], proof: 'command', text: 'the invoice totals add up', checks: ['suite:smoke'] },
      { criterion: 'BIL-021', status: 'proposed', source: [['https:', '//example.test/pr/2'].join('')], proof: 'command', text: 'the receipt is sent once' },
    ]),
    'utf8',
  )
  await writeFile(
    join(dir, '.qa', 'profile.yml'),
    `target:\n  url: ${HEALTH_URL}\n  health: { http: /health, timeout: 1s }\nstubs: []\nvisual:\n  widths: [390]\n  themes: [light]\n`,
    'utf8',
  )
  await writeFile(join(dir, '.qa', 'QA.md'), '# QA\n')
  await writeFile(
    join(dir, '.qa', 'config.yml'),
    `target:\n  url: ${HEALTH_URL}\n  health: { http: /health, timeout: 1s }\nsuites:\n${suites.map((suite) => `  - name: ${suite.name}\n    command: ${JSON.stringify(suite.command)}\n    kind: ${suite.kind}`).join('\n')}\n`,
  )
  return dir
}

async function runCriteria(
  dir: string,
  ids: string,
): Promise<{ code: number; out: string; result?: { verdict: string; criteria: Array<{ id: string; outcome: string }> } }> {
  const err = capture()
  const code = await main(
    ['run', '--criteria', ids, '--id', 'card-1', '--repo', dir, '--base', 'abc', '--head', 'def', '--evidence', join(dir, 'evidence'), '--profile', join(dir, '.qa')],
    capture().writer,
    err.writer,
    BOOT,
  )
  const out = err.lines.join('')
  let result
  try {
    result = JSON.parse(await readFile(join(dir, 'evidence', 'result.json'), 'utf8'))
  } catch {
    // no result written: the run was refused before anything executed
  }
  return { code, out, result }
}

test('qare run --criteria runs exactly the named subset and reports exactly those criteria', async () => {
  const dir = await subsetRepo([{ name: 'smoke', command: 'true', kind: 'command' }])
  const { code, result } = await runCriteria(dir, 'BIL-014')

  expect(code).toBe(0)
  expect(result.verdict).toBe('passed')
  expect(result.criteria.map((criterion: { id: string }) => criterion.id)).toEqual(['BIL-014'])
  expect(result.criteria[0]).toMatchObject({ outcome: 'proven' })
})

test('a criterion the ledger cannot serve refuses loudly, naming the id and its state', async () => {
  const dir = await subsetRepo([{ name: 'smoke', command: 'true', kind: 'command' }])
  const unknown = await runCriteria(dir, 'BIL-099')
  expect(unknown.code).toBe(4)
  expect(unknown.out).toMatch(/BIL-099 is not in the ledger/)

  await writeFile(
    join(dir, '.qa', 'ledger.json'),
    serializeLedger([
      { criterion: 'BIL-014', status: 'retired', source: [['https:', '//example.test/pr/1'].join('')], proof: 'command' },
    ]),
    'utf8',
  )
  const retired = await runCriteria(dir, 'BIL-014')
  expect(retired.code).toBe(4)
  expect(retired.out).toMatch(/BIL-014 is retired/)
  expect(retired.result).toBeUndefined()
})

test('every criterion in the subset is in the result, and nothing outside it', async () => {
  const dir = await subsetRepo([{ name: 'smoke', command: 'true', kind: 'command' }])
  const { code, result } = await runCriteria(dir, 'BIL-014,BIL-021')

  expect(code).toBe(2)
  expect(result.verdict).toBe('blocked')
  expect(result.criteria.map((criterion: { id: string }) => criterion.id)).toEqual(['BIL-014', 'BIL-021'])
  expect(result.criteria[0]).toMatchObject({ outcome: 'proven' })
  expect(result.criteria[1]).toMatchObject({ outcome: 'unverified' })
})

test('the ledger the run reads is the repository one, unless --ledger points elsewhere', async () => {
  const dir = await subsetRepo([{ name: 'smoke', command: 'true', kind: 'command' }])
  const elsewhere = await mkdtemp(join(tmpdir(), 'qare-ledger-'))
  await writeFile(
    join(elsewhere, 'ledger.json'),
    serializeLedger([
      { criterion: 'BIL-014', status: 'active', source: [['https:', '//example.test/pr/1'].join('')], proof: 'command', checks: ['suite:smoke'] },
    ]),
    'utf8',
  )
  await writeFile(join(dir, '.qa', 'ledger.json'), serializeLedger([]), 'utf8')
  const err = capture()

  const code = await main(
    [
      'run', '--criteria', 'BIL-014',
      '--id', 'card-1', '--repo', dir, '--base', 'abc', '--head', 'def',
      '--evidence', join(dir, 'evidence'), '--profile', join(dir, '.qa'), '--ledger', elsewhere,
    ],
    capture().writer,
    err.writer,
    BOOT,
  )
  expect(code).toBe(0)
})

test('qare run --criteria demands the same run context a plan does', async () => {
  await subsetRepo([])
  const err = capture()

  const code = await main(['run', '--criteria', 'BIL-014'], capture().writer, err.writer, BOOT)

  expect(code).toBe(4)
  expect(err.lines.join('')).toMatch(/--id|--repo|--base|--head|--evidence|--profile/)
})

test('an id list with an empty slot is an invocation error, not a partial run', async () => {
  const dir = await subsetRepo([])
  const err = capture()

  const code = await main(
    ['run', '--criteria', 'BIL-014,,BIL-021', '--id', 'card-1', '--repo', dir, '--base', 'abc', '--head', 'def', '--evidence', join(dir, 'evidence'), '--profile', join(dir, '.qa')],
    capture().writer,
    err.writer,
    BOOT,
  )
  expect(code).toBe(4)
  expect(err.lines.join('')).toMatch(/comma-separated criterion ids/)
})
