import { mkdtemp, readFile, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import { NareAgentRunner, type AgentRunRequest } from '../src/index.js'

/**
 * A stand-in for the nare binary: a real executable the runner really spawns,
 * so these tests exercise argv, stdout parsing and exit codes rather than a
 * mock of them. It records the argv it was called with, then prints the lines
 * it was told to print and exits with the code it was told to use.
 */
async function fakeNare(
  lines: unknown[],
  exitCode = 0,
): Promise<{ binary: string; argv: () => Promise<string[]>; schemaSeen: () => Promise<string> }> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-nare-'))
  const argvPath = join(dir, 'argv.json')
  const schemaPath = join(dir, 'schema-seen.json')
  const binary = join(dir, 'nare')
  const script = [
    '#!/usr/bin/env node',
    `import { writeFileSync, readFileSync } from 'node:fs'`,
    `const argv = process.argv.slice(2)`,
    `writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(argv))`,
    // Read the schema while the run is in flight: the runner cleans its temp
    // directory up afterwards, which is what a caller should be able to rely on.
    `const at = argv.indexOf('--schema')`,
    `if (at !== -1) writeFileSync(${JSON.stringify(schemaPath)}, readFileSync(argv[at + 1], 'utf8'))`,
    `for (const line of ${JSON.stringify(lines)}) console.log(JSON.stringify(line))`,
    `process.exit(${exitCode})`,
  ].join('\n')
  await writeFile(`${binary}.mjs`, script, 'utf8')
  await writeFile(binary, `#!/bin/sh\nexec node ${binary}.mjs "$@"\n`, 'utf8')
  await chmod(binary, 0o755)
  return {
    binary,
    argv: async () => JSON.parse(await readFile(argvPath, 'utf8')) as string[],
    schemaSeen: async () => await readFile(schemaPath, 'utf8'),
  }
}

const REQUEST: AgentRunRequest = {
  prompt: 'judge this',
  system: 'you are a verifier',
  toolPolicy: 'none',
  outputSchema: JSON.stringify({ type: 'object', properties: { verdict: { type: 'string' } } }),
  budget: { maxOutputTokens: 512 },
}

function result(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'result',
    session_id: 'abc',
    status: 'done',
    questions: [],
    usage: { input: 11, output: 22, cache_read: 0, cache_write: 0 },
    stop_reason: 'end_turn',
    turns: 1,
    contract: 1,
    output: { verdict: 'pass' },
    error: null,
    ...overrides,
  }
}

test('a completed run comes back typed, carrying the answer as text', async () => {
  // output is the answer TEXT, which is what qare's parsers consume. With a
  // schema, nare has already proven that text is JSON satisfying it.
  const nare = await fakeNare([
    { type: 'progress', text: 'thinking' },
    { type: 'output', text: '{"verdict": "pass"}', detail: { output: { verdict: 'pass' } } },
    result(),
  ])

  const run = await new NareAgentRunner({ binary: nare.binary }).run(REQUEST)

  expect(run).toEqual({
    status: 'completed',
    stopReason: 'end_turn',
    usage: { inputTokens: 11, outputTokens: 22 },
    output: '{"verdict": "pass"}',
  })
})

test('the answer text survives a round trip through the verifier parser', async () => {
  const findings = JSON.stringify({ findings: [{ criterionId: 'c1', problem: 'no evidence' }] })
  const nare = await fakeNare([{ type: 'output', text: findings, detail: {} }, result()])

  const run = await new NareAgentRunner({ binary: nare.binary }).run(REQUEST)

  expect(JSON.parse(run.output as string)).toEqual({
    findings: [{ criterionId: 'c1', problem: 'no evidence' }],
  })
})

test('the request reaches nare as flags, not as prose', async () => {
  const nare = await fakeNare([result()])

  await new NareAgentRunner({ binary: nare.binary }).run(REQUEST)
  const argv = await nare.argv()

  expect(argv[0]).toBe('run')
  expect(argv).toContain('judge this')
  expect(argv).toContain('--yes')
  expect(argv).toContain('--jsonl')
  expect(argv.join(' ')).toContain('--contract 1')
  expect(argv.join(' ')).toContain('--tools none')
  expect(argv.join(' ')).toContain('--max-tokens 512')
  expect(argv.join(' ')).toContain('--system you are a verifier')
})

test('a read-only policy allows reading and nothing else', async () => {
  const nare = await fakeNare([result()])

  await new NareAgentRunner({ binary: nare.binary }).run({ ...REQUEST, toolPolicy: 'read-only' })

  expect((await nare.argv()).join(' ')).toContain('--tools read')
})

test('the schema is handed over as a file nare can read', async () => {
  const nare = await fakeNare([result()])

  await new NareAgentRunner({ binary: nare.binary }).run(REQUEST)

  expect(JSON.parse(await nare.schemaSeen())).toEqual(JSON.parse(REQUEST.outputSchema))
})

test('no schema means no --schema flag', async () => {
  const nare = await fakeNare([result({ output: null })])

  await new NareAgentRunner({ binary: nare.binary }).run({ ...REQUEST, outputSchema: '' })

  expect(await nare.argv()).not.toContain('--schema')
})

test('a blocked run fails closed', async () => {
  const nare = await fakeNare([
    { type: 'output', text: 'partial thinking', detail: {} },
    result({ status: 'blocked', questions: ['which environment?'], stop_reason: 'tool_use', output: null }),
  ])

  const run = await new NareAgentRunner({ binary: nare.binary }).run(REQUEST)

  expect(run.status).toBe('failed')
  expect(run.output).toBeUndefined()
})

test('a truncated run fails closed and keeps its stop reason', async () => {
  const nare = await fakeNare([result({ status: 'error', stop_reason: 'max_tokens', output: null })], 1)

  const run = await new NareAgentRunner({ binary: nare.binary }).run(REQUEST)

  expect(run.status).toBe('failed')
  expect(run.stopReason).toBe('max_tokens')
})

test('a schema violation is a failure, not an answer', async () => {
  const nare = await fakeNare(
    [result({ status: 'error', stop_reason: 'schema_violation', output: null, error: 'answer does not satisfy' })],
    1,
  )

  const run = await new NareAgentRunner({ binary: nare.binary }).run(REQUEST)

  expect(run.status).toBe('failed')
  expect(run.stopReason).toBe('error')
})

test('a run that never started is an error the caller must fix, not a verdict', async () => {
  const nare = await fakeNare([], 2)

  await expect(new NareAgentRunner({ binary: nare.binary }).run(REQUEST)).rejects.toThrow(/never started|exit 2/i)
})

test('a contract nare does not speak is refused rather than parsed', async () => {
  const nare = await fakeNare([result({ contract: 99 })])

  await expect(new NareAgentRunner({ binary: nare.binary }).run(REQUEST)).rejects.toThrow(/contract/i)
})

test('a run with no result line is refused rather than guessed at', async () => {
  const nare = await fakeNare([{ type: 'progress', text: 'thinking' }])

  await expect(new NareAgentRunner({ binary: nare.binary }).run(REQUEST)).rejects.toThrow(/result/i)
})

test('a missing nare binary says so plainly', async () => {
  const runner = new NareAgentRunner({ binary: join(tmpdir(), 'nare-does-not-exist') })

  await expect(runner.run(REQUEST)).rejects.toThrow(/nare/i)
})
