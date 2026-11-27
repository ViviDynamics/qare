import { mkdtemp, readFile, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import { NareAgentRunner, nareRunners, type AgentRunRequest } from '../src/index.js'

// Test files carry no network literals (runner.test.ts's guard), so URLs are
// assembled at runtime, the way isolation.test.ts does it.
const url = (rest: string, scheme = 'http'): string => [scheme, '://', rest].join('')

/**
 * A stand-in for the nare binary: a real executable the runner really spawns,
 * so these tests exercise argv, stdout parsing and exit codes rather than a
 * mock of them. It records the argv it was called with, then prints the lines
 * it was told to print and exits with the code it was told to use.
 */
async function fakeNare(
  lines: unknown[],
  exitCode = 0,
): Promise<{
  binary: string
  argv: () => Promise<string[]>
  schemaSeen: () => Promise<string>
  mcpConfigSeen: () => Promise<unknown>
  promptSeen: () => Promise<{ path: string; text: string; mode: number; dirMode: number }>
  envSeen: () => Promise<{
    tools: string | null
    endpoint: string | null
    mcpTools: string | null
    mcpEndpoint: string | null
    contextWindow: string | null
  }>
}> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-nare-'))
  const argvPath = join(dir, 'argv.json')
  const schemaPath = join(dir, 'schema-seen.json')
  const envPath = join(dir, 'env-seen.json')
  const mcpPath = join(dir, 'mcp-config-seen.json')
  const promptPath = join(dir, 'prompt-seen.json')
  const binary = join(dir, 'nare')
  const script = [
    '#!/usr/bin/env node',
    `import { writeFileSync, readFileSync, statSync } from 'node:fs'`,
    `import { dirname } from 'node:path'`,
    `const argv = process.argv.slice(2)`,
    `writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(argv))`,
    // Read the schema while the run is in flight: the runner cleans its temp
    // directory up afterwards, which is what a caller should be able to rely on.
    `const at = argv.indexOf('--schema')`,
    `if (at !== -1) writeFileSync(${JSON.stringify(schemaPath)}, readFileSync(argv[at + 1], 'utf8'))`,
    `const mcpAt = argv.indexOf('--mcp-config')`,
    `if (mcpAt !== -1) writeFileSync(${JSON.stringify(mcpPath)}, readFileSync(argv[mcpAt + 1], 'utf8'))`,
    // The prompt file exists only while the run is in flight, so what it held,
    // and who could read it, is recorded from inside the run.
    `const promptAt = argv.indexOf('--prompt-file')`,
    `if (promptAt !== -1) { const p = argv[promptAt + 1]; writeFileSync(${JSON.stringify(promptPath)}, JSON.stringify({ path: p, text: readFileSync(p, 'utf8'), mode: statSync(p).mode & 0o777, dirMode: statSync(dirname(p)).mode & 0o777 })) }`,
    `writeFileSync(${JSON.stringify(envPath)}, JSON.stringify({ tools: process.env.QARE_EXPLORATION_TOOLS ?? null, endpoint: process.env.QARE_EXPLORATION_ENDPOINT ?? null, mcpTools: process.env.QARE_MCP_TOOLS ?? null, mcpEndpoint: process.env.QARE_MCP_ENDPOINT ?? null, contextWindow: process.env.NARE_CONTEXT_WINDOW ?? null }))`,
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
    mcpConfigSeen: async () => JSON.parse(await readFile(mcpPath, 'utf8')) as unknown,
    promptSeen: async () =>
      JSON.parse(await readFile(promptPath, 'utf8')) as { path: string; text: string; mode: number; dirMode: number },
    envSeen: async () => JSON.parse(await readFile(envPath, 'utf8')) as {
      tools: string | null
      endpoint: string | null
      mcpTools: string | null
      mcpEndpoint: string | null
    },
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
    contract: 3,
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
    turns: 1,
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
  // The prompt travels by file (#401): never as an argument, so no argv size limit applies.
  expect(argv).not.toContain('judge this')
  expect(argv[argv.indexOf('--prompt-file') + 1]).toBe((await nare.promptSeen()).path)
  expect((await nare.promptSeen()).text).toBe('judge this')
  expect(argv).toContain('--yes')
  expect(argv).toContain('--jsonl')
  expect(argv.join(' ')).toContain('--contract 3')
  // qare recovers a cut-off turn itself (#358), so nare ends at the first cut, as before contract 3.
  expect(argv.join(' ')).toContain('--max-cutoffs 0')
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
  const nare = await fakeNare([ANSWER, result()])

  await new NareAgentRunner({ binary: nare.binary }).run({ ...REQUEST, outputSchema: '' })

  expect(await nare.argv()).not.toContain('--schema')
})

test('an explicit exploration channel reaches nare through its MCP client, with only its tools allowed (#87, #377)', async () => {
  const nare = await fakeNare([ANSWER, result()])

  await new NareAgentRunner({ binary: nare.binary }).run({
    ...REQUEST,
    tools: { allowlist: ['observe', 'snapshot'], endpoint: url('127.0.0.1:8080/') },
  })

  const argv = await nare.argv()
  // nare's general MCP client is what connects a session to tools: the
  // endpoint is one Streamable HTTP server, under the alias the tools carry.
  expect(await nare.mcpConfigSeen()).toEqual({ explore: { url: url('127.0.0.1:8080/') } })
  // The allowlist replaces the run's tool policy, so nothing but the channel's tools is callable.
  expect(argv[argv.indexOf('--tools') + 1]).toBe('explore__observe,explore__snapshot')
  expect(argv.filter((arg) => arg === '--tools')).toHaveLength(1)
  // The environment no nare release reads is not set.
  const seen = await nare.envSeen()
  expect(seen.tools).toBeNull()
  expect(seen.endpoint).toBeNull()
})

test('a run with no exploration channel hands nare no MCP config (#377)', async () => {
  const nare = await fakeNare([ANSWER, result()])
  await new NareAgentRunner({ binary: nare.binary }).run(REQUEST)
  const argv = await nare.argv()
  expect(argv).not.toContain('--mcp-config')
  expect(argv[argv.indexOf('--tools') + 1]).toBe('none')
})

test('the host MCP channel reaches nare through its MCP client, one alias per server, with only the allowed tools (#93, #399)', async () => {
  const nare = await fakeNare([ANSWER, result()])

  await new NareAgentRunner({ binary: nare.binary }).run({
    ...REQUEST,
    mcp: {
      servers: [
        { alias: 'rig', url: url('127.0.0.1:8081/rig'), tools: ['power_on', 'read'] },
        { alias: 'sim', url: url('127.0.0.1:8081/sim'), tools: ['tick'] },
      ],
    },
  })

  const argv = await nare.argv()
  expect(await nare.mcpConfigSeen()).toEqual({
    rig: { url: url('127.0.0.1:8081/rig') },
    sim: { url: url('127.0.0.1:8081/sim') },
  })
  // --tools is always set beside a config: left unset, nare offers every tool
  // every configured server lists (its mcp_allow_all default).
  expect(argv[argv.indexOf('--tools') + 1]).toBe('rig__power_on,rig__read,sim__tick')
  expect(argv.filter((arg) => arg === '--tools')).toHaveLength(1)
  expect(argv.filter((arg) => arg === '--mcp-config')).toHaveLength(1)
  // The environment no nare release reads is not set.
  const seen = await nare.envSeen()
  expect(seen.mcpTools).toBeNull()
  expect(seen.mcpEndpoint).toBeNull()
  expect(seen.tools).toBeNull()
  expect(seen.endpoint).toBeNull()
})

test('the exploration and host channels share one MCP config, and --tools names both channels\' tools alone (#399)', async () => {
  const nare = await fakeNare([ANSWER, result()])

  await new NareAgentRunner({ binary: nare.binary }).run({
    ...REQUEST,
    tools: { allowlist: ['observe'], endpoint: url('127.0.0.1:8080/') },
    mcp: { servers: [{ alias: 'rig', url: url('127.0.0.1:8081/rig'), tools: ['power_on'] }] },
  })

  const argv = await nare.argv()
  expect(await nare.mcpConfigSeen()).toEqual({ explore: { url: url('127.0.0.1:8080/') }, rig: { url: url('127.0.0.1:8081/rig') } })
  expect(argv[argv.indexOf('--tools') + 1]).toBe('explore__observe,rig__power_on')
})

test('a host server under the exploration bridge\'s alias, or one with no tools, is refused before nare starts (#399)', async () => {
  const nare = await fakeNare([ANSWER, result()])
  const runner = new NareAgentRunner({ binary: nare.binary })

  await expect(
    runner.run({
      ...REQUEST,
      tools: { allowlist: ['observe'], endpoint: url('127.0.0.1:8080/') },
      mcp: { servers: [{ alias: 'explore', url: url('127.0.0.1:8081/explore'), tools: ['observe'] }] },
    }),
  ).rejects.toThrow(/alias "explore" twice/)
  await expect(
    runner.run({ ...REQUEST, mcp: { servers: [{ alias: 'rig', url: url('127.0.0.1:8081/rig'), tools: [] }] } }),
  ).rejects.toThrow(/no tools/)
  await expect(runner.run({ ...REQUEST, mcp: { servers: [] } })).rejects.toThrow(/no servers/)
  await expect(nare.argv()).rejects.toThrow()
})

test('a run with no host server and no exploration channel hands nare no MCP config and --tools none (#399)', async () => {
  const nare = await fakeNare([ANSWER, result()])
  await new NareAgentRunner({ binary: nare.binary }).run(REQUEST)
  const argv = await nare.argv()
  expect(argv).not.toContain('--mcp-config')
  expect(argv[argv.indexOf('--tools') + 1]).toBe('none')
  const seen = await nare.envSeen()
  expect(seen.mcpTools).toBeNull()
  expect(seen.mcpEndpoint).toBeNull()
})

test('a run that named no channel gets none, even an ambient one (#87)', async () => {
  const nare = await fakeNare([ANSWER, result()])

  await new NareAgentRunner({
    binary: nare.binary,
    env: {
      QARE_EXPLORATION_TOOLS: 'observe',
      QARE_EXPLORATION_ENDPOINT: url('leak.internal:9090'),
      QARE_MCP_TOOLS: 'rig.power_on',
      QARE_MCP_ENDPOINT: url('leak.internal:9091'),
    },
  }).run(REQUEST)

  const seen = await nare.envSeen()
  expect(seen.tools).toBeNull()
  expect(seen.endpoint).toBeNull()
  expect(seen.mcpTools).toBeNull()
  expect(seen.mcpEndpoint).toBeNull()
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

// #391: nare stops a turn whose context estimate reaches the window with the
// typed stop reason context. It is its own outcome, never flattened into error,
// so the caller can say which window was in force and what sets it.
test('a run stopped at the context window fails closed and says so by its stop reason', async () => {
  const nare = await fakeNare(
    [result({ status: 'error', stop_reason: 'context', output: null, error: 'context estimate 34000 reaches window 32000' })],
    1,
  )

  const run = await new NareAgentRunner({ binary: nare.binary }).run(REQUEST)

  expect(run.status).toBe('failed')
  expect(run.stopReason).toBe('context')
  expect(run.error).toBe('context estimate 34000 reaches window 32000')
})

// #391: the window is nare's to read from NARE_CONTEXT_WINDOW. The runner adds
// no --context-window of its own and drops nothing, so the caller's value is the
// one nare measures against.
test('the context window the caller set reaches nare untouched, and no flag overrides it', async () => {
  const nare = await fakeNare([result()])
  const before = process.env.NARE_CONTEXT_WINDOW
  process.env.NARE_CONTEXT_WINDOW = '200000'
  try {
    await new NareAgentRunner({ binary: nare.binary }).run(REQUEST)
  } finally {
    if (before === undefined) delete process.env.NARE_CONTEXT_WINDOW
    else process.env.NARE_CONTEXT_WINDOW = before
  }

  expect((await nare.envSeen()).contextWindow).toBe('200000')
  expect(await nare.argv()).not.toContain('--context-window')
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

test('a prompt larger than one argument can carry reaches nare intact (#401)', async () => {
  const nare = await fakeNare([ANSWER, result()])
  // Past Linux's 131071 byte cap on one argument, with multibyte text, CRLF and
  // a trailing newline that a lossy route would mangle.
  const prompt = `${'diff line ü ✓\r\n'.repeat(12000)}end\n`
  expect(Buffer.byteLength(prompt, 'utf8')).toBeGreaterThan(131071)

  const run = await new NareAgentRunner({ binary: nare.binary }).run({ ...REQUEST, prompt })

  expect(run.status).toBe('completed')
  expect((await nare.promptSeen()).text).toBe(prompt)
})

test('the prompt file is private to the run and gone once it ends', async () => {
  const nare = await fakeNare([ANSWER, result()])

  await new NareAgentRunner({ binary: nare.binary }).run(REQUEST)
  const seen = await nare.promptSeen()

  expect(seen.mode).toBe(0o600)
  expect(seen.dirMode).toBe(0o700)
  await expect(readFile(seen.path, 'utf8')).rejects.toThrow(/ENOENT/)
})

test.each([
  ['nare exits without a result line', [] as unknown[], 1],
  ['nare never starts', [] as unknown[], 2],
])('the prompt file is removed when the run fails: %s', async (_name, lines, code) => {
  const nare = await fakeNare(lines, code)

  await expect(new NareAgentRunner({ binary: nare.binary }).run(REQUEST)).rejects.toThrow(/nare/)
  const seen = await nare.promptSeen()

  expect(seen.text).toBe('judge this')
  await expect(readFile(seen.path, 'utf8')).rejects.toThrow(/ENOENT/)
})

// An older subprocess cannot be mistaken for the harness qare is written against.
test('a contract 2 result is refused after the contract 3 upgrade', async () => {
  const nare = await fakeNare([ANSWER, result({ contract: 2 })])

  await expect(new NareAgentRunner({ binary: nare.binary }).run(REQUEST)).rejects.toThrow(/contract 2.*reads 3/)
})

test('an empty qare system prompt opts out of nare defaults even with read tools', async () => {
  const nare = await fakeNare([ANSWER, result()])

  await new NareAgentRunner({ binary: nare.binary }).run({ ...REQUEST, system: '', toolPolicy: 'read-only' })

  const argv = await nare.argv()
  expect(argv).toContain('--system')
  expect(argv[argv.indexOf('--system') + 1]).toBe('')
})

// #439: nare reads a screenshot as an image only when the caller declares
// the model can take one, and qare never did, so the verifier saw final.png
// as bytes it could not look at.
test('a runner told its model takes images declares it to nare, and one not told does not (#439)', async () => {
  const told = await fakeNare([ANSWER, result()])
  await new NareAgentRunner({ binary: told.binary, imageInput: true }).run({ ...REQUEST, toolPolicy: 'read-only' })
  expect(await told.argv()).toContain('--image-input')

  const untold = await fakeNare([ANSWER, result()])
  await new NareAgentRunner({ binary: untold.binary }).run({ ...REQUEST, toolPolicy: 'read-only' })
  expect(await untold.argv()).not.toContain('--image-input')
})

test('the verifier declares image input when QARE_VERIFIER_IMAGE_INPUT is on, and the planner never does (#439)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-verifier-images-'))
  const verifier = await fakeNare([ANSWER, result()])
  await nareRunners(verifier.binary, { QARE_VERIFIER_IMAGE_INPUT: 'true' }).verifier(dir).run({ ...REQUEST, toolPolicy: 'read-only' })
  expect(await verifier.argv()).toContain('--image-input')

  const planner = await fakeNare([ANSWER, result()])
  await nareRunners(planner.binary, { QARE_VERIFIER_IMAGE_INPUT: 'true' }).planner.run(REQUEST)
  expect(await planner.argv()).not.toContain('--image-input')

  const off = await fakeNare([ANSWER, result()])
  await nareRunners(off.binary, {}).verifier(dir).run({ ...REQUEST, toolPolicy: 'read-only' })
  expect(await off.argv()).not.toContain('--image-input')
})

// #418: the plan job took 12 to 25 minutes for four criteria and nothing
// said where: nare counts its model turns, and the runner passes them on.
test('the runner carries the model turns nare counted, and none when nare does not say (#418)', async () => {
  const counted = await fakeNare([ANSWER, result({ turns: 4 })])
  expect((await new NareAgentRunner({ binary: counted.binary }).run(REQUEST)).turns).toBe(4)

  const silent = await fakeNare([ANSWER, result({ turns: undefined })])
  expect((await new NareAgentRunner({ binary: silent.binary }).run(REQUEST)).turns).toBeUndefined()
})
