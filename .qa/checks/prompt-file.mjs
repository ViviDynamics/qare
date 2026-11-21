import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import './source.mjs'

// Executable checks of the prompt reaching nare by file (#401), run against
// the checkout's runner source without a build. Each prints what it observed.
// check=runner hands the runner's prompt to a stand-in nare that records what
// it was given; check=nare hands it to the nare the image installs, with a
// model fixture on loopback. Scratch is restricted to .qa/checks/scratch.

const { NareAgentRunner } = await import('../../packages/core/src/runner.ts')
const scratch = fileURLToPath(new URL('./scratch/', import.meta.url))
mkdirSync(scratch, { recursive: true })

const ARG_MAX = 131071
// Past one argument's limit on Linux, with multibyte text, CRLF and a
// trailing newline that a lossy route would mangle.
const LARGE = `${'diff line ü ✓\r\n'.repeat(12000)}end\n`
const base = {
  prompt: 'Return the fixture verdict.',
  system: 'Use only the supplied evidence.',
  toolPolicy: 'none',
  budget: { maxOutputTokens: 512 },
  outputSchema: JSON.stringify({ type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'], additionalProperties: false }),
}

async function runner() {
  // The runner spawns `node run ...`: node runs the file named run in the
  // working directory, so the stand-in needs no executable bit on scratch.
  const dir = mkdtempSync(join(scratch, 'prompt-file-'))
  const seen = join(dir, 'seen.json')
  writeFileSync(
    join(dir, 'run'),
    [
      // Dynamic imports in a function read the same as CommonJS or as a module.
      "void (async () => {",
      "const { readFileSync, statSync, writeFileSync } = await import('node:fs')",
      "const { basename, dirname } = await import('node:path')",
      // node takes the subcommand, run, as the script it runs: the rest is nare's argv after it.
      "const argv = [basename(process.argv[1]), ...process.argv.slice(2)]",
      "const at = argv.indexOf('--prompt-file')",
      'const path = argv[at + 1]',
      `writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv, path, text: readFileSync(path, 'utf8'), mode: (statSync(path).mode & 0o777).toString(8), dirMode: (statSync(dirname(path)).mode & 0o777).toString(8) }))`,
      "const fail = process.env.STAND_IN_FAIL === '1'",
      "if (!fail) console.log(JSON.stringify({ type: 'output', text: '{\"verdict\":\"seen\"}' }))",
      "console.log(JSON.stringify({ type: 'result', status: fail ? 'error' : 'done', stop_reason: fail ? null : 'end_turn', usage: { input: 1, output: 1 }, contract: 3, output: fail ? null : { verdict: 'seen' }, error: fail ? 'stand-in failure' : null, questions: [] }))",
      'process.exit(fail ? 1 : 0)',
      '})()',
    ].join('\n'),
  )
  const read = () => JSON.parse(readFileSync(seen, 'utf8'))
  try {
    const bytes = Buffer.byteLength(LARGE, 'utf8')
    console.log(`prompt: ${bytes} bytes, over the ${ARG_MAX} one argument carries on Linux: ${bytes > ARG_MAX}`)
    const done = await new NareAgentRunner({ binary: process.execPath, cwd: dir }).run({ ...base, prompt: LARGE })
    const ok = read()
    console.log(`run: status ${done.status}, output ${done.output}`)
    console.log(`argv nare was given (prompt file path shown as <file>): ${ok.argv.map((arg) => (arg === ok.path ? '<file>' : arg.length > 60 ? `<${arg.length} chars>` : arg)).join(' ')}`)
    console.log(`prompt as an argument: ${ok.argv.some((arg) => arg.includes('diff line'))}`)
    console.log(`prompt file text equals the prompt: ${ok.text === LARGE} (${Buffer.byteLength(ok.text, 'utf8')} bytes)`)
    console.log(`prompt file mode ${ok.mode}, its directory mode ${ok.dirMode}`)
    console.log(`prompt file exists after the run: ${existsSync(ok.path)}`)
    assert.equal(done.status, 'completed')
    assert.equal(ok.argv[0], 'run')
    assert.ok(!ok.argv.some((arg) => arg.includes('diff line')))
    assert.equal(ok.text, LARGE)
    assert.equal(ok.mode, '600')
    assert.equal(ok.dirMode, '700')
    assert.equal(existsSync(ok.path), false)

    const failed = await new NareAgentRunner({ binary: process.execPath, cwd: dir, env: { STAND_IN_FAIL: '1' } }).run(base)
    const bad = read()
    console.log(`failed run: status ${failed.status}, error ${failed.error}; prompt file held the prompt: ${bad.text === base.prompt}; exists after the run: ${existsSync(bad.path)}`)
    assert.equal(failed.status, 'failed')
    assert.equal(bad.text, base.prompt)
    assert.equal(existsSync(bad.path), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function nare() {
  const found = spawnSync('nare', ['--version'], { encoding: 'utf8' })
  assert.equal(found.status, 0, 'nare is not installed here, so its real CLI cannot be exercised')
  console.log(`nare: ${found.stdout.trim()}`)
  let replies = []
  let requests = []
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.end(JSON.stringify({ data: [] }))
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks).toString()))
    const reply = replies.shift()
    response.end(JSON.stringify({
      id: 'fixture', object: 'chat.completion', model: 'fixture',
      choices: [{ index: 0, message: { role: 'assistant', content: reply ?? '' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const env = {
    NARE_PROVIDER: 'openai', NARE_MODEL: 'fixture', NARE_STREAM: 'false',
    NARE_BASE_URL: ['http:', '', `127.0.0.1:${server.address().port}`, 'v1'].join('/'),
    OPENAI_API_KEY: 'local-fixture',
  }
  const userText = () => requests[0].messages.find((message) => message.role === 'user').content
  try {
    const wide = new NareAgentRunner({ env: { ...env, NARE_CONTEXT_WINDOW: '1000000' } })
    // nare follows the task with its schema instruction: what it adds to a
    // short prompt is what the large one must carry, and nothing else.
    requests = []
    replies = ['{"verdict":"short"}']
    assert.equal((await wide.run(base)).status, 'completed')
    const suffix = userText().slice(base.prompt.length)
    requests = []
    replies = ['{"verdict":"large"}']
    const big = await wide.run({ ...base, prompt: LARGE })
    console.log(`large prompt (${Buffer.byteLength(LARGE, 'utf8')} bytes), window 1000000: status ${big.status}, output ${big.output}`)
    console.log(`the model received the prompt byte for byte: ${userText() === LARGE + suffix}`)
    assert.equal(big.status, 'completed')
    assert.equal(userText(), LARGE + suffix)

    requests = []
    replies = ['{"verdict":"unreached"}']
    const narrow = await new NareAgentRunner({ env }).run({ ...base, prompt: LARGE })
    console.log(`same prompt, no window set: status ${narrow.status}, stop reason ${narrow.stopReason}, error ${narrow.error}, model calls ${requests.length}`)
    assert.equal(narrow.status, 'failed')
    assert.equal(narrow.stopReason, 'context')
    assert.equal(requests.length, 0)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

const checks = { runner, nare }
const name = process.argv[2]
assert.ok(name in checks, `check is one of ${Object.keys(checks).join(', ')}`)
await checks[name]()
console.log(`PASS ${name}`)
