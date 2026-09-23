import { mkdtemp, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { main } from '../src/index.js'
import type { Writer } from '../src/index.js'

function capture(): { lines: string[]; writer: Writer } {
  const lines: string[] = []
  return { lines, writer: { write: (chunk) => lines.push(chunk) } }
}

async function bodyFile(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-links-'))
  const path = join(dir, 'body.md')
  await writeFile(path, text, 'utf8')
  return path
}

test('qare linked-issues prints one issue number per line', async () => {
  const out = capture()

  const code = await main(
    ['linked-issues', '--body', await bodyFile('Closes #9 and fixes #10.')],
    out.writer,
    capture().writer,
  )

  expect(code).toBe(0)
  expect(out.lines.join('').trim().split('\n')).toEqual(['9', '10'])
})

test('a body linking nothing prints nothing and still succeeds', async () => {
  // The pipeline decides what no criteria means; this command only reports.
  const out = capture()

  const code = await main(['linked-issues', '--body', await bodyFile('A chore.')], out.writer, capture().writer)

  expect(code).toBe(0)
  expect(out.lines.join('')).toBe('')
})

test('qare plan can be told that no criteria is not a failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-plan-neutral-'))
  const issuePath = join(dir, 'issue.md')
  const diffPath = join(dir, 'change.diff')
  const outPath = join(dir, 'plan.json')
  await writeFile(issuePath, '## Problem\n\nno criteria stated\n', 'utf8')
  await writeFile(diffPath, 'diff', 'utf8')
  const out = capture()

  const code = await main(
    ['plan', '--issue', issuePath, '--diff', diffPath, '--out', outPath, '--allow-no-criteria'],
    out.writer,
    capture().writer,
  )

  expect(code).toBe(0)
  expect(existsSync(outPath)).toBe(false)
  expect(out.lines.join('')).toMatch(/no acceptance criteria/i)
})

test('without that flag, no criteria is still a failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-plan-strict-'))
  const issuePath = join(dir, 'issue.md')
  const diffPath = join(dir, 'change.diff')
  await writeFile(issuePath, '## Problem\n\nno criteria stated\n', 'utf8')
  await writeFile(diffPath, 'diff', 'utf8')

  const code = await main(
    ['plan', '--issue', issuePath, '--diff', diffPath, '--out', join(dir, 'plan.json')],
    capture().writer,
    capture().writer,
  )

  expect(code).toBe(4)
})
