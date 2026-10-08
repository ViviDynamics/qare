import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { main } from '../src/index.js'
import type { Writer } from '../src/index.js'

// #259: `qare plan` asks the model for a batch of criteria a turn, through
// the real nare path, and one lost turn costs only its own criteria.

function capture(): { text: () => string; writer: Writer } {
  const lines: string[] = []
  return { text: () => lines.join(''), writer: { write: (chunk) => lines.push(chunk) } }
}

const CRITERIA = ['c1', 'c2', 'c3'].map((id) => ({ id, text: `criterion ${id} holds` }))

/**
 * A nare stand-in that plans whatever criteria its prompt lists, logs each
 * call's ids, and is cut off at max_tokens whenever a listed id is in `cutOff`.
 */
async function batchNare(cutOff: string[] = []): Promise<{ binary: string; calls: () => Promise<string[][]> }> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-plan-batch-'))
  const binary = join(dir, 'nare')
  const log = join(dir, 'calls.jsonl')
  const script = [
    '#!/usr/bin/env node',
    `import { appendFileSync } from 'node:fs'`,
    `const prompt = process.argv[3] ?? ''`,
    `const list = (prompt.split('Criteria:\\n')[1] ?? '').split('\\n\\n')[0] ?? ''`,
    `const ids = [...list.matchAll(/^- (c\\d+): /gm)].map((match) => match[1])`,
    `appendFileSync(${JSON.stringify(log)}, JSON.stringify(ids) + '\\n')`,
    `const base = { type: 'result', questions: [], usage: { input: 10, output: 2 }, turns: 1, contract: 1 }`,
    `if (ids.some((id) => ${JSON.stringify(cutOff)}.includes(id))) {`,
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
    calls: async () =>
      existsSync(log)
        ? (await readFile(log, 'utf8'))
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => JSON.parse(line) as string[])
        : [],
  }
}

async function planArgs(binary: string): Promise<{ argv: string[]; outPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-plan-batch-in-'))
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

let before: string | undefined
beforeEach(() => {
  before = process.env.QARE_PLAN_BATCH_SIZE
  delete process.env.QARE_PLAN_BATCH_SIZE
})
afterEach(() => {
  if (before === undefined) delete process.env.QARE_PLAN_BATCH_SIZE
  else process.env.QARE_PLAN_BATCH_SIZE = before
})

test('qare plan asks for one criterion a turn by default, and writes one plan holding each exactly once', async () => {
  const nare = await batchNare()
  const { argv, outPath } = await planArgs(nare.binary)
  const out = capture()

  expect(await main(argv, out.writer, capture().writer)).toBe(0)

  expect(await nare.calls()).toEqual([['c1'], ['c2'], ['c3']])
  const plan = JSON.parse(await readFile(outPath, 'utf8')) as WrittenPlan
  expect(plan.criteria.map((criterion) => criterion.id)).toEqual(['c1', 'c2', 'c3'])
  expect(plan.criteria.map((criterion) => criterion.checks?.[0]?.name)).toEqual(['check c1', 'check c2', 'check c3'])
  // The recorded usage is the sum over the three turns.
  expect(plan.usage).toEqual({ inputTokens: 30, outputTokens: 6 })
  expect(out.text()).toContain('planned batch 1 of 3 (c1) [10 input tokens, 2 output]')
  expect(out.text()).toContain('planned batch 3 of 3 (c3)')
  expect(out.text()).toContain('planned 3 criteria (0 unplannable)')
})

test('a turn cut off costs its own criterion only: the others stay planned, and the run goes on', async () => {
  const nare = await batchNare(['c2'])
  const { argv, outPath } = await planArgs(nare.binary)
  const out = capture()

  expect(await main(argv, out.writer, capture().writer)).toBe(0)

  expect(await nare.calls()).toEqual([['c1'], ['c2'], ['c3']])
  const plan = JSON.parse(await readFile(outPath, 'utf8')) as WrittenPlan
  expect(plan.criteria.map((criterion) => criterion.id)).toEqual(['c1', 'c2', 'c3'])
  expect(plan.criteria[0]?.checks).toHaveLength(1)
  expect(plan.criteria[2]?.checks).toHaveLength(1)
  expect(plan.criteria[1]?.checks).toBeUndefined()
  expect(plan.criteria[1]?.unplannable).toMatch(/^planning failed \(PlanStepError: the planning run did not complete \(stop reason max_tokens/)
  expect(plan.usage).toEqual({ inputTokens: 30, outputTokens: 6 })
  expect(out.text()).toMatch(/batch 2 of 3 \(c2\) could not be planned, so its criteria are marked unplannable: PlanStepError: .*max_tokens/)
  expect(out.text()).toContain('planned 3 criteria (1 unplannable)')
})

test('the environment sets the batch size', async () => {
  process.env.QARE_PLAN_BATCH_SIZE = '2'
  const nare = await batchNare()
  const { argv, outPath } = await planArgs(nare.binary)

  expect(await main(argv, capture().writer, capture().writer)).toBe(0)

  expect(await nare.calls()).toEqual([['c1', 'c2'], ['c3']])
  const plan = JSON.parse(await readFile(outPath, 'utf8')) as WrittenPlan
  expect(plan.criteria.map((criterion) => criterion.id)).toEqual(['c1', 'c2', 'c3'])
})

test('a batch size that is not a number stops the plan by name, and nothing is asked or written', async () => {
  process.env.QARE_PLAN_BATCH_SIZE = 'lots'
  const nare = await batchNare()
  const { argv, outPath } = await planArgs(nare.binary)
  const err = capture()

  expect(await main(argv, capture().writer, err.writer)).toBe(4)

  expect(err.text()).toMatch(/QARE_PLAN_BATCH_SIZE is "lots"/)
  expect(await nare.calls()).toEqual([])
  expect(existsSync(outPath)).toBe(false)
})

test('when every turn is cut off the plan is all unplannable, as before, and still says what it cost', async () => {
  const nare = await batchNare(['c1', 'c2', 'c3'])
  const { argv, outPath } = await planArgs(nare.binary)
  const out = capture()

  expect(await main(argv, out.writer, capture().writer)).toBe(0)

  const plan = JSON.parse(await readFile(outPath, 'utf8')) as WrittenPlan
  expect(plan.criteria.map((criterion) => criterion.id)).toEqual(['c1', 'c2', 'c3'])
  for (const criterion of plan.criteria) expect(criterion.unplannable).toMatch(/planning failed \(PlanStepError: none of the 3 batches could be planned/)
  expect(plan.usage).toEqual({ inputTokens: 30, outputTokens: 6 })
  expect(out.text()).toContain('every criterion is marked unplannable')
})
