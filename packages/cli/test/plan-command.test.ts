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

const CRITERIA = [
  { id: 'c1', text: 'the login form rejects an empty password' },
  { id: 'c2', text: 'the dashboard renders on a phone' },
]

const PLAN = {
  schemaVersion: '1',
  criteria: [
    { id: 'c1', text: CRITERIA[0].text, checks: [{ kind: 'command', name: 'login', command: 'npm test -- login' }] },
    { id: 'c2', text: CRITERIA[1].text, unplannable: 'no visual baseline yet' },
  ],
}

/**
 * A nare stand-in on disk: the CLI spawns whatever --nare names, so the command
 * is exercised through its real path rather than through an injected object.
 */
async function fakeNare(answer: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-plan-'))
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

async function inputs(): Promise<{ criteriaPath: string; diffPath: string; outPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-plan-in-'))
  const criteriaPath = join(dir, 'criteria.json')
  const diffPath = join(dir, 'change.diff')
  await writeFile(criteriaPath, JSON.stringify(CRITERIA), 'utf8')
  await writeFile(diffPath, 'diff --git a/login.ts b/login.ts', 'utf8')
  return { criteriaPath, diffPath, outPath: join(dir, 'plan.json') }
}

test('qare plan writes a plan.json the plan loader accepts', async () => {
  const { criteriaPath, diffPath, outPath } = await inputs()
  const out = capture()

  const code = await main(
    ['plan', '--criteria', criteriaPath, '--diff', diffPath, '--out', outPath, '--nare', await fakeNare(PLAN)],
    out.writer,
    capture().writer,
  )

  expect(code).toBe(0)
  expect(existsSync(outPath)).toBe(true)
  expect(JSON.parse(await readFile(outPath, 'utf8'))).toEqual(PLAN)
  expect(out.lines.join('')).toContain('2 criteria')
})

test('qare plan reports the unplannable criteria it wrote', async () => {
  const { criteriaPath, diffPath, outPath } = await inputs()
  const out = capture()

  await main(
    ['plan', '--criteria', criteriaPath, '--diff', diffPath, '--out', outPath, '--nare', await fakeNare(PLAN)],
    out.writer,
    capture().writer,
  )

  expect(out.lines.join('')).toContain('1 unplannable')
})

test('qare plan fails loudly rather than writing half a plan', async () => {
  const { criteriaPath, diffPath, outPath } = await inputs()
  const err = capture()

  const code = await main(
    [
      'plan',
      '--criteria',
      criteriaPath,
      '--diff',
      diffPath,
      '--out',
      outPath,
      '--nare',
      await fakeNare({ schemaVersion: '1', criteria: [PLAN.criteria[0]] }),
    ],
    capture().writer,
    err.writer,
  )

  expect(code).toBe(4)
  expect(existsSync(outPath)).toBe(false)
  expect(err.lines.join('')).toContain('c2')
})

test('qare plan needs criteria and a diff', async () => {
  const err = capture()

  const code = await main(['plan'], capture().writer, err.writer)

  expect(code).toBe(4)
  expect(err.lines.join('')).toMatch(/--criteria/)
})

test('qare plan reads criteria straight from an issue body', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-plan-issue-'))
  const issuePath = join(dir, 'issue.md')
  const diffPath = join(dir, 'change.diff')
  const outPath = join(dir, 'plan.json')
  await writeFile(issuePath, '## Acceptance criteria\n\n- [ ] the login form rejects an empty password\n', 'utf8')
  await writeFile(diffPath, 'diff --git a/login.ts b/login.ts', 'utf8')
  // The id is derived from the wording, so the fixture derives it the same way
  // rather than hard-coding a guess that would drift.
  const text = 'the login form rejects an empty password'
  const answer = {
    schemaVersion: '1',
    criteria: [{ id: criterionIdFor(text), text, checks: [{ kind: 'command', name: 'login', command: 'npm test' }] }],
  }
  const out = capture()

  const code = await main(
    ['plan', '--issue', issuePath, '--diff', diffPath, '--out', outPath, '--nare', await fakeNare(answer)],
    out.writer,
    capture().writer,
  )

  expect(code).toBe(0)
  expect(out.lines.join('')).toContain('1 criteria')
})

test('qare plan refuses an issue that states no criteria', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-plan-nocrit-'))
  const issuePath = join(dir, 'issue.md')
  const diffPath = join(dir, 'change.diff')
  await writeFile(issuePath, '## Problem\n\nnothing stated\n', 'utf8')
  await writeFile(diffPath, 'diff', 'utf8')
  const err = capture()

  const code = await main(
    ['plan', '--issue', issuePath, '--diff', diffPath, '--out', join(dir, 'plan.json')],
    capture().writer,
    err.writer,
  )

  expect(code).toBe(4)
  expect(err.lines.join('')).toMatch(/acceptance criteria|done when/i)
})

test('--flow-actions takes kind names, not free-form text', async () => {
  const { criteriaPath, diffPath } = await inputs()
  const err = capture()

  const code = await main(
    ['plan', '--criteria', criteriaPath, '--diff', diffPath, '--flow-actions', 'totp login'],
    capture().writer,
    err.writer,
  )

  expect(code).toBe(4)
  expect(err.lines.join('')).toContain('--flow-actions takes comma-separated kind names')
})

test('planning hands the planner the change\'s own flow action kinds, and the plan the loader accepts', async () => {
  const { criteriaPath, diffPath, outPath } = await inputs()
  const answer = {
    schemaVersion: '1',
    criteria: [
      {
        id: 'c1',
        text: CRITERIA[0].text,
        checks: [{ kind: 'flow', name: 'magic login', actions: [{ action: 'magicLink', element: { testId: 'sign-in' } }] }],
      },
      { id: 'c2', text: CRITERIA[1].text, unplannable: 'no phone layout yet' },
    ],
  }
  const out = capture()

  const code = await main(
    ['plan', '--criteria', criteriaPath, '--diff', diffPath, '--out', outPath, '--nare', await fakeNare(answer), '--flow-actions', 'magicLink'],
    out.writer,
    capture().writer,
  )

  expect(code).toBe(0)
  const plan = JSON.parse(await readFile(outPath, 'utf8'))
  expect(plan.criteria[0]).toMatchObject({ checks: [{ actions: [{ action: 'magicLink' }] }] })
  expect(out.lines.join('')).toContain('magicLink')
})
