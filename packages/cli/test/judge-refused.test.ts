import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { RESULT_SCHEMA_VERSION } from '@qare/core'
import { main } from '../src/index.js'
import type { Writer } from '../src/index.js'

function capture(): { lines: string[]; writer: Writer } {
  const lines: string[] = []
  return { lines, writer: { write: (chunk) => lines.push(chunk) } }
}

const made: string[] = []
afterEach(async () => {
  await Promise.all(made.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function refusedResult(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-judge-refused-'))
  made.push(dir)
  const path = join(dir, 'result.json')
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: RESULT_SCHEMA_VERSION,
      verdict: 'refused',
      criteria: [
        { id: 'c1', outcome: 'unverified', reason: 'this repository has no usable .qa/ profile yet' },
        { id: 'c2', outcome: 'unverified', reason: 'this repository has no usable .qa/ profile yet' },
      ],
      job: { id: 'pr-1' },
    }),
    'utf8',
  )
  return path
}

test('judge keeps a refusal a refusal', async () => {
  // Found on the first green pipeline run: execute said refused and judge
  // said blocked, because judge recomputed the verdict from criteria that
  // were all unverified. A refused run executed nothing, so there is nothing
  // for judge to decide, and the stub-issue step that acts on "refused" never
  // fired.
  const path = await refusedResult()
  const out = capture()

  const code = await main(['judge', '--result', path, '--runner', 'none'], out.writer, capture().writer)

  expect(code).toBe(0)
  const judged = JSON.parse(await readFile(join(path, '..', 'judged-result.json'), 'utf8'))
  expect(judged.verdict).toBe('refused')
  expect(out.lines.join('')).toContain('verdict refused')
})

test('the refusal reasons survive judging', async () => {
  const path = await refusedResult()

  await main(['judge', '--result', path, '--runner', 'none'], capture().writer, capture().writer)

  const judged = JSON.parse(await readFile(join(path, '..', 'judged-result.json'), 'utf8'))
  expect(judged.criteria[0].reason).toContain('.qa/ profile')
})
