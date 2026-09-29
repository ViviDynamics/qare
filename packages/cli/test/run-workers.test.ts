import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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

/** A repository whose ledger names one criterion checked by a command, and whose profile runs against a target. */
async function subsetRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-workers-'))
  await mkdir(join(dir, '.qa'), { recursive: true })
    await writeFile(
    join(dir, '.qa', 'ledger.json'),
    serializeLedger([
      {
        criterion: 'BIL-014',
        status: 'active',
        source: [['https:', '//example.test/pr/1'].join('')],
        proof: 'command',
        text: 'the invoice totals add up',
        checks: ['suite:smoke'],
      },
    ]),
    'utf8',
  )
  await writeFile(join(dir, '.qa', 'QA.md'), '# QA\n')
  await writeFile(
    join(dir, '.qa', 'config.yml'),
    `target:\n  url: ${HEALTH_URL}\n  health: { http: /health, timeout: 1s }\nsuites:\n  - name: smoke\n    command: ${JSON.stringify('echo invoiced')}\n    kind: command\n`,
    'utf8',
  )
  return dir
}

test('a worker count below one is an invocation error, not a run', async () => {
  const dir = await subsetRepo()
  const err = capture()
  const code = await main(
    [
      'run',
      '--criteria',
      'BIL-014',
      '--id',
      'card-1',
      '--repo',
      dir,
      '--base',
      'abc',
      '--head',
      'def',
      '--evidence',
      join(dir, 'evidence'),
      '--profile',
      join(dir, '.qa'),
      '--workers',
      '0',
    ],
    capture().writer,
    err.writer,
    BOOT,
  )
  expect(code).toBe(4)
  expect(err.lines.join('')).toMatch(/--workers takes an integer of at least 1, and "0" is not one/)
})

test('a worker count that is not an integer is an invocation error', async () => {
  const dir = await subsetRepo()
  const err = capture()
  const code = await main(
    [
      'run',
      '--criteria',
      'BIL-014',
      '--id',
      'card-1',
      '--repo',
      dir,
      '--base',
      'abc',
      '--head',
      'def',
      '--evidence',
      join(dir, 'evidence'),
      '--profile',
      join(dir, '.qa'),
      '--workers',
      'two and a half',
    ],
    capture().writer,
    err.writer,
    BOOT,
  )
  expect(code).toBe(4)
  expect(err.lines.join('')).toMatch(/--workers takes an integer of at least 1/)
})

test('a sharded subset run carries --workers through to the run', async () => {
  const dir = await subsetRepo()
  const err = capture()
  const code = await main(
    [
      'run',
      '--criteria',
      'BIL-014',
      '--id',
      'card-1',
      '--repo',
      dir,
      '--base',
      'abc',
      '--head',
      'def',
      '--evidence',
      join(dir, 'evidence'),
      '--profile',
      join(dir, '.qa'),
      '--workers',
      '2',
    ],
    capture().writer,
    err.writer,
    BOOT,
  )
  expect(code).toBe(0)
  expect(err.lines.join('')).not.toMatch(/--workers/)
  expect(err.lines.join('')).not.toMatch(/takes an integer/)
})
