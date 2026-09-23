import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { criterionIdFor } from '@qare/core'
import { main } from '../src/index.js'
import type { Writer } from '../src/index.js'

function capture(): { lines: string[]; writer: Writer } {
  const lines: string[] = []
  return { lines, writer: { write: (chunk) => lines.push(chunk) } }
}

async function issues(...bodies: string[]): Promise<{ dir: string; paths: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-issues-'))
  const paths: string[] = []
  for (const [index, body] of bodies.entries()) {
    const path = join(dir, `issue-${index + 1}.md`)
    await writeFile(path, body, 'utf8')
    paths.push(path)
  }
  return { dir, paths }
}

const STATED = '## Goal\n\nExport.\n\n## Done when\n\n- [ ] The ledger exports to CSV\n'

test('writes the criteria an issue states, as the {id, text} list plan --criteria reads', async () => {
  const { dir, paths } = await issues(STATED)
  const out = join(dir, 'criteria.json')

  const code = await main(['issue-criteria', '--out', out, ...paths], capture().writer, capture().writer)

  expect(code).toBe(0)
  expect(JSON.parse(await readFile(out, 'utf8'))).toEqual([
    { id: criterionIdFor('The ledger exports to CSV'), text: 'The ledger exports to CSV' },
  ])
})

// The pipeline's neutral path: a bug report closed by a one-line fix states
// no criteria, and that is nothing to check rather than a red pipeline.
test('an issue that states no criteria writes nothing and succeeds, saying why', async () => {
  const { dir, paths } = await issues('## The bug\n\nIt breaks.\n')
  const out = join(dir, 'criteria.json')
  const stdout = capture()

  const code = await main(['issue-criteria', '--out', out, ...paths], stdout.writer, capture().writer)

  expect(code).toBe(0)
  expect(existsSync(out)).toBe(false)
  expect(stdout.lines.join('')).toContain('nothing to check')
})

test('each issue is read on its own, so a second issue keeps its criteria', async () => {
  // Concatenated, the second issue's list sat after the first's next heading
  // and was never read.
  const second = '## Acceptance criteria\n\n- [ ] Totals convert to the viewer currency\n'
  const { dir, paths } = await issues(STATED, second)
  const out = join(dir, 'criteria.json')

  await main(['issue-criteria', '--out', out, ...paths], capture().writer, capture().writer)

  const texts = (JSON.parse(await readFile(out, 'utf8')) as { text: string }[]).map((criterion) => criterion.text)
  expect(texts).toEqual(['The ledger exports to CSV', 'Totals convert to the viewer currency'])
})

test('an issue without criteria beside one with them contributes nothing and blocks nothing', async () => {
  const { dir, paths } = await issues('## The bug\n\nIt breaks.\n', STATED)
  const out = join(dir, 'criteria.json')

  await main(['issue-criteria', '--out', out, ...paths], capture().writer, capture().writer)

  expect(JSON.parse(await readFile(out, 'utf8'))).toHaveLength(1)
})

test('the same criterion in two issues is one criterion', async () => {
  const { dir, paths } = await issues(STATED, STATED)
  const out = join(dir, 'criteria.json')

  await main(['issue-criteria', '--out', out, ...paths], capture().writer, capture().writer)

  expect(JSON.parse(await readFile(out, 'utf8'))).toHaveLength(1)
})

test('an unreadable issue file is a failure, not an issue without criteria', async () => {
  const { dir } = await issues()
  const err = capture()

  const code = await main(
    ['issue-criteria', '--out', join(dir, 'criteria.json'), join(dir, 'missing.md')],
    capture().writer,
    err.writer,
  )

  expect(code).toBe(4)
  expect(err.lines.join('')).toContain('missing.md')
})

test('usage errors name what is missing', async () => {
  const err = capture()

  expect(await main(['issue-criteria', 'issue.md'], capture().writer, err.writer)).toBe(4)
  expect(err.lines.join('')).toContain('--out')
})

// Fail closed: a criteria heading with nothing usable under it is a malformed
// statement of criteria, not an absent one. Treating it as neutral would skip
// the change unchecked.
test('a criteria section with no criteria in it is a failure naming the issue', async () => {
  const { dir, paths } = await issues('## Done when\n\n- The ledger exports to CSV\n')
  const err = capture()

  const code = await main(['issue-criteria', '--out', join(dir, 'criteria.json'), ...paths], capture().writer, err.writer)

  expect(code).toBe(4)
  expect(err.lines.join('')).toContain('issue-1.md')
  expect(err.lines.join('')).toContain('no criteria in it')
  expect(existsSync(join(dir, 'criteria.json'))).toBe(false)
})

test('one malformed issue among several fails the whole read, rather than checking only the rest', async () => {
  const { dir, paths } = await issues(STATED, '## Acceptance criteria\n\nTBD\n')

  const code = await main(['issue-criteria', '--out', join(dir, 'criteria.json'), ...paths], capture().writer, capture().writer)

  expect(code).toBe(4)
})

// The pipeline decides "criteria present" from the file existing, so a file
// already there (committed by the change itself, or left from before) must
// not survive a read that found none.
test('finding no criteria removes a criteria file already at --out', async () => {
  const { dir, paths } = await issues('## The bug\n\nIt breaks.\n')
  const out = join(dir, 'criteria.json')
  await writeFile(out, '[{"id":"planted","text":"anything passes"}]', 'utf8')

  const code = await main(['issue-criteria', '--out', out, ...paths], capture().writer, capture().writer)

  expect(code).toBe(0)
  expect(existsSync(out)).toBe(false)
})

test('creates the directory --out names', async () => {
  const { dir, paths } = await issues(STATED)
  const out = join(dir, 'inputs', 'criteria.json')

  expect(await main(['issue-criteria', '--out', out, ...paths], capture().writer, capture().writer)).toBe(0)
  expect(existsSync(out)).toBe(true)
})

test('an unknown or repeated flag is a usage error, not an issue path', async () => {
  const { dir, paths } = await issues(STATED)
  const unknown = capture()
  const repeated = capture()

  expect(await main(['issue-criteria', '--out', join(dir, 'a.json'), '--ouput', ...paths], capture().writer, unknown.writer)).toBe(4)
  expect(unknown.lines.join('')).toContain('does not take --ouput')
  expect(
    await main(['issue-criteria', '--out', join(dir, 'a.json'), '--out', join(dir, 'b.json'), ...paths], capture().writer, repeated.writer),
  ).toBe(4)
  expect(repeated.lines.join('')).toContain('--out once')
})
