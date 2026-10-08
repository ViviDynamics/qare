import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { main } from '../src/index.js'
import type { Writer } from '../src/index.js'

// #265: `qare plan` runs as many batches at once as the environment says,
// through the real nare path: several nare processes alive at the same time.

function capture(): { text: () => string; writer: Writer } {
  const lines: string[] = []
  return { text: () => lines.join(''), writer: { write: (chunk) => lines.push(chunk) } }
}

const CRITERIA = ['c1', 'c2', 'c3'].map((id) => ({ id, text: `criterion ${id} holds` }))

/**
 * A nare stand-in that answers only once `together` of its processes are
 * alive at the same time, and is cut off when they never are. Run one after
 * another, no turn can end, so a plan it wrote was planned side by side.
 * Each process records how many were alive when it looked.
 */
async function meetingNare(together: number, waitMs: number): Promise<{ binary: string; alive: () => Promise<number[]> }> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-plan-concurrency-'))
  const binary = join(dir, 'nare')
  const log = join(dir, 'alive.jsonl')
  const script = [
    '#!/usr/bin/env node',
    `import { appendFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'`,
    `import { join } from 'node:path'`,
    `const dir = ${JSON.stringify(dir)}`,
    `const prompt = process.argv[3] ?? ''`,
    `const list = (prompt.split('Criteria:\\n')[1] ?? '').split('\\n\\n')[0] ?? ''`,
    `const ids = [...list.matchAll(/^- (c\\d+): /gm)].map((match) => match[1])`,
    `const mark = join(dir, 'alive-' + ids.join('-'))`,
    `writeFileSync(mark, '')`,
    `const alive = () => readdirSync(dir).filter((name) => name.startsWith('alive-')).length`,
    `const until = Date.now() + ${String(waitMs)}`,
    `let most = alive()`,
    `while (most < ${String(together)} && Date.now() < until) {`,
    `  await new Promise((resolve) => setTimeout(resolve, 20))`,
    `  most = Math.max(most, alive())`,
    `}`,
    `appendFileSync(${JSON.stringify(log)}, JSON.stringify(most) + '\\n')`,
    // The others must see this one alive before it goes.
    `await new Promise((resolve) => setTimeout(resolve, 100))`,
    `rmSync(mark)`,
    `const base = { type: 'result', questions: [], usage: { input: 10, output: 2 }, turns: 1, contract: 1 }`,
    `if (most < ${String(together)}) {`,
    `  console.log(JSON.stringify({ ...base, status: 'error', stop_reason: 'max_tokens', output: null, error: null }))`,
    `} else {`,
    `  const plan = { schemaVersion: '1', criteria: ids.map((id) => ({ id, text: 'criterion ' + id + ' holds', checks: [{ kind: 'command', name: 'check ' + id, command: 'node --version' }] })) }`,
    `  console.log(JSON.stringify({ type: 'output', text: JSON.stringify(plan), detail: {} }))`,
    `  console.log(JSON.stringify({ ...base, status: 'done', stop_reason: 'end_turn', output: plan, error: null }))`,
    `}`,
  ].join('\n')
  await writeFile(`${binary}.mjs`, script, 'utf8')
  await writeFile(binary, `#!/bin/sh\nexec node ${binary}.mjs "$@"\n`, 'utf8')
  await chmod(binary, 0o755)
  return {
    binary,
    alive: async () =>
      existsSync(log)
        ? (await readFile(log, 'utf8'))
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => JSON.parse(line) as number)
        : [],
  }
}

async function planArgs(binary: string): Promise<{ argv: string[]; outPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-plan-concurrency-in-'))
  const criteriaPath = join(dir, 'criteria.json')
  const diffPath = join(dir, 'change.diff')
  await writeFile(criteriaPath, JSON.stringify(CRITERIA), 'utf8')
  await writeFile(diffPath, 'diff --git a/login.ts b/login.ts', 'utf8')
  const outPath = join(dir, 'plan.json')
  return { argv: ['plan', '--criteria', criteriaPath, '--diff', diffPath, '--out', outPath, '--nare', binary], outPath }
}

interface WrittenPlan {
  usage?: { inputTokens: number; outputTokens: number }
  criteria: Array<{ id: string; checks?: Array<{ name: string }>; unplannable?: string }>
}

const NAMES = ['QARE_PLAN_BATCH_SIZE', 'QARE_PLAN_CONCURRENCY'] as const
let before: Record<string, string | undefined>
beforeEach(() => {
  before = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]))
  for (const name of NAMES) delete process.env[name]
})
afterEach(() => {
  for (const name of NAMES) {
    const value = before[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

test('the environment sets how many batches are with the model at once, and the plan is the one a run one at a time writes', async () => {
  process.env.QARE_PLAN_CONCURRENCY = '3'
  const nare = await meetingNare(3, 20_000)
  const { argv, outPath } = await planArgs(nare.binary)
  const out = capture()

  expect(await main(argv, out.writer, capture().writer)).toBe(0)

  // Every turn saw all three alive: no turn waited for another to end.
  expect(await nare.alive()).toEqual([3, 3, 3])
  const plan = JSON.parse(await readFile(outPath, 'utf8')) as WrittenPlan
  expect(plan.criteria.map((criterion) => criterion.id)).toEqual(['c1', 'c2', 'c3'])
  expect(plan.criteria.map((criterion) => criterion.checks?.[0]?.name)).toEqual(['check c1', 'check c2', 'check c3'])
  expect(plan.usage).toEqual({ inputTokens: 30, outputTokens: 6 })
  for (const index of [1, 2, 3]) expect(out.text()).toContain(`planned batch ${index} of 3 (c${index}) [10 input tokens, 2 output]`)
  expect(out.text()).toContain('planned 3 criteria (0 unplannable)')
}, 60_000)

test('unset, the turns run one after another: no nare process is alive beside another', async () => {
  const nare = await meetingNare(2, 300)
  const { argv } = await planArgs(nare.binary)

  await main(argv, capture().writer, capture().writer)

  expect(await nare.alive()).toEqual([1, 1, 1])
}, 60_000)

test('a concurrency that is not a number stops the plan by name, and nothing is asked or written', async () => {
  process.env.QARE_PLAN_CONCURRENCY = 'many'
  const nare = await meetingNare(1, 0)
  const { argv, outPath } = await planArgs(nare.binary)
  const err = capture()

  expect(await main(argv, capture().writer, err.writer)).toBe(4)

  expect(err.text()).toMatch(/QARE_PLAN_CONCURRENCY is "many"/)
  expect(await nare.alive()).toEqual([])
  expect(existsSync(outPath)).toBe(false)
})
