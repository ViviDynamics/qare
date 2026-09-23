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

test('a completed run comes back typed, carrying the answer as JSON text', async () => {
  // output is a JSON STRING, which is what qare's parsers consume. With a
  // schema it is nare's validated object re-serialised, so whatever the model
  // wrapped it in does not reach the caller.
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
    output: JSON.stringify({ verdict: 'pass' }),
  })
})

test('a fenced answer comes back as plain JSON when a schema was set', async () => {
  // A real model fences its JSON. nare's validator sees through the fence, so
  // the run is `done`, but qare's parsers call JSON.parse on the text and a
  // fenced string throws. Found against a live model, not by these tests.
  const fenced = '```json\n{"verdict": "pass"}\n```'
  const nare = await fakeNare([
    { type: 'output', text: fenced, detail: { output: { verdict: 'pass' } } },
    result({ output: { verdict: 'pass' } }),
  ])

  const run = await new NareAgentRunner({ binary: nare.binary }).run(REQUEST)

  expect(JSON.parse(run.output as string)).toEqual({ verdict: 'pass' })
})

test('without a schema the answer is the text as it came', async () => {
  const nare = await fakeNare([
    { type: 'output', text: 'plain prose, no JSON here', detail: {} },
    result({ output: null }),
  ])

  const run = await new NareAgentRunner({ binary: nare.binary }).run({ ...REQUEST, outputSchema: '' })

  expect(run.output).toBe('plain prose, no JSON here')
})

test('the answer text survives a round trip through the verifier parser', async () => {
  const parsed = { findings: [{ criterionId: 'c1', problem: 'no evidence' }] }
  const findings = JSON.stringify(parsed)
  const nare = await fakeNare([
    { type: 'output', text: findings, detail: { output: parsed } },
    result({ output: parsed }),
  ])

  const run = await new NareAgentRunner({ binary: nare.binary }).run(REQUEST)

  expect(JSON.parse(run.output as string)).toEqual({
    findings: [{ criterionId: 'c1', problem: 'no evidence' }],
  })
})

const ANSWER = { type: 'output', text: '{"verdict": "pass"}', detail: {} }
const ANSWER_EVENT = ANSWER

test('the request reaches nare as flags, not as prose', async () => {
  const nare = await fakeNare([ANSWER, result()])

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
  const nare = await fakeNare([ANSWER, result()])

  await new NareAgentRunner({ binary: nare.binary }).run({ ...REQUEST, toolPolicy: 'read-only' })

  expect((await nare.argv()).join(' ')).toContain('--tools read')
})

test('the schema is handed over as a file nare can read', async () => {
  const nare = await fakeNare([ANSWER, result()])

  await new NareAgentRunner({ binary: nare.binary }).run(REQUEST)

  expect(JSON.parse(await nare.schemaSeen())).toEqual(JSON.parse(REQUEST.outputSchema))
})

test('no schema means no --schema flag', async () => {
  const nare = await fakeNare([ANSWER, result({ output: null })])

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

test('a failed run carries the reason nare gave, not just a status', async () => {
  // Without this, a caller sees "stop reason error" and has to reproduce the
  // run by hand to learn that the proxy returned HTTP 524. Found doing exactly
  // that.
  const nare = await fakeNare([
    result({
      status: 'error',
      stop_reason: null,
      output: null,
      error: 'RuntimeError: chat completion failed with HTTP 524: <html>...',
    }),
  ], 1)

  const run = await new NareAgentRunner({ binary: nare.binary }).run(REQUEST)

  expect(run.status).toBe('failed')
  expect(run.error).toContain('HTTP 524')
})

test('a completed run carries no error', async () => {
  const nare = await fakeNare([ANSWER_EVENT, result()])

  const run = await new NareAgentRunner({ binary: nare.binary }).run(REQUEST)

  expect(run.error).toBeUndefined()
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
  const nare = await fakeNare([ANSWER, result({ contract: 99 })])

  await expect(new NareAgentRunner({ binary: nare.binary }).run(REQUEST)).rejects.toThrow(/contract/i)
})

test('a run with no result line is refused rather than guessed at', async () => {
  const nare = await fakeNare([{ type: 'progress', text: 'thinking' }])

  await expect(new NareAgentRunner({ binary: nare.binary }).run(REQUEST)).rejects.toThrow(/result/i)
})

test('a completed run with no answer is refused rather than reported as completed', async () => {
  // nare emits an output event on every done run, so a done result with
  // neither an output event nor a parsed object means the contract was broken.
  // Reporting completed with no answer would hand the caller a pass carrying
  // nothing.
  const nare = await fakeNare([result({ output: null })])

  await expect(new NareAgentRunner({ binary: nare.binary }).run(REQUEST)).rejects.toThrow(/answer|output/i)
})

test('a line that is not JSON fails closed, naming nare rather than throwing a parser error', async () => {
  // A run killed mid-write, or anything that put a stray line on stdout. The
  // caller must see a NareRunnerError, not a SyntaxError from a parser it
  // never called.
  const nare = await fakeNare([result()])
  const { writeFile } = await import('node:fs/promises')
  await writeFile(
    `${nare.binary}.mjs`,
    ['#!/usr/bin/env node', `console.log('{"type": "progress", "text": tru')`, `process.exit(0)`].join('\n'),
    'utf8',
  )

  const run = new NareAgentRunner({ binary: nare.binary }).run(REQUEST)

  await expect(run).rejects.toThrow(/nare/i)
  await expect(run).rejects.not.toThrow(SyntaxError)
})

test('a missing nare binary says so plainly', async () => {
  const runner = new NareAgentRunner({ binary: join(tmpdir(), 'nare-does-not-exist') })

  await expect(runner.run(REQUEST)).rejects.toThrow(/nare/i)
})

test.runIf(process.platform === 'linux')(
  'a prompt too large for one argument is refused by name, before nare is spawned',
  async () => {
    const nare = await fakeNare([result()])

    await expect(
      new NareAgentRunner({ binary: nare.binary }).run({ ...REQUEST, prompt: 'x'.repeat(128 * 1024) }),
    ).rejects.toThrow(/over the 131071 one argument can carry on Linux.*nare#29/)
    await expect(nare.argv()).rejects.toThrow()
  },
)
