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
const root = fileURLToPath(new URL('../../', import.meta.url))
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
      "console.log(JSON.stringify({ type: 'result', status: fail ? 'error' : 'done', stop_reason: fail ? null : 'end_turn', usage: { input: 1, output: 1 }, contract: 4, output: fail ? null : { verdict: 'seen' }, error: fail ? 'stand-in failure' : null, questions: [] }))",
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
  // Which image this is and which nare it ships: the image's own record, and
  // the nare on PATH held to the version the checkout's core image pins.
  const record = '/opt/qare/config/IMAGE.json'
  assert.ok(existsSync(record), `${record} is missing, so this is not a qare image`)
  const image = JSON.parse(readFileSync(record, 'utf8'))
  const pinned = /nare\/releases\/download\/([^/]+)\//.exec(readFileSync(join(root, 'images/core/Dockerfile'), 'utf8'))?.[1]
  const where = spawnSync('sh', ['-c', 'command -v nare'], { encoding: 'utf8' }).stdout.trim()
  console.log(`image record ${record}: ${JSON.stringify({ name: image.name, flavour: image.flavour, qare: image.qare, nare: image.nare })}`)
  console.log(`nare on PATH: ${where}, ${found.stdout.trim()}; images/core/Dockerfile pins ${pinned}; QARE_CONTAINER=${process.env.QARE_CONTAINER}`)
  if (image.flavour !== 'core') console.log(`the ${image.flavour} image is built FROM the core image (images/${image.flavour}/Dockerfile), so its nare is the core image's`)
  assert.equal(image.nare, pinned)
  assert.ok(found.stdout.includes(pinned))
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

async function ci() {
  // CI's images job builds the core image from the checkout and runs
  // scripts/nare-compat.mjs inside it; that script carries the large prompt case.
  const { parse } = await import('yaml')
  const workflow = parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'))
  const steps = workflow.jobs.images.steps
  const build = steps.find((step) => step.name === 'Build the core image')
  const compat = steps.find((step) => step.name === 'Exercise the installed nare through qare')
  console.log(`ci.yml images job: ${build.name}: ${build.run}`)
  console.log(`ci.yml images job: ${compat.name}: ${compat.run}`)
  assert.match(build.run, /docker build -f images\/core\/Dockerfile -t qare-core:ci \./)
  assert.match(compat.run, /docker run --rm -i qare-core:ci node --input-type=module < scripts\/nare-compat\.mjs/)
  assert.ok(steps.indexOf(build) < steps.indexOf(compat))
  const script = readFileSync(join(root, 'scripts/nare-compat.mjs'), 'utf8')
  const lines = script.split('\n').map((line, at) => `${at + 1}: ${line.trim()}`)
  for (const needle of ['> 131071', 'const big = await wide.run', 'assert.equal(userText(), large + suffix)', "assert.equal(narrow.stopReason, 'context')", 'PASS: a prompt past'])
    console.log(`scripts/nare-compat.mjs ${lines.find((line) => line.includes(needle)) ?? `missing: ${needle}`}`)
  for (const needle of ['> 131071', 'assert.equal(userText(), large + suffix)', "assert.equal(narrow.stopReason, 'context')"]) assert.ok(script.includes(needle), needle)
}

async function citations() {
  // No source, workflow, script or doc still cites nare#29 as a limit: every
  // file under these roots is searched, and any hit is printed and fails.
  const { readdirSync, statSync } = await import('node:fs')
  const tag = ['nare', '#29'].join('')
  const self = fileURLToPath(import.meta.url)
  const roots = ['packages', '.github', 'docs', 'scripts', 'images', '.qa', 'README.md', 'AGENTS.md', 'CONSTITUTION.md']
  const files = []
  const walk = (path) => {
    if (/(^|\/)(node_modules|dist|scratch)(\/|$)/.test(path)) return
    if (statSync(path).isDirectory()) for (const entry of readdirSync(path)) walk(join(path, entry))
    else files.push(path)
  }
  for (const r of roots) if (existsSync(join(root, r))) walk(join(root, r))
  const hits = []
  for (const file of files) {
    if (file === self) continue
    readFileSync(file, 'utf8').split('\n').forEach((line, at) => {
      if (line.includes(tag) || /MAX_ARG_BYTES|can carry on Linux|argument budget/.test(line)) hits.push(`${file.slice(root.length)}:${at + 1}: ${line.trim()}`)
    })
  }
  console.log(`searched ${files.length} files under ${roots.join(', ')} for ${tag}, MAX_ARG_BYTES, "can carry on Linux" and "argument budget"`)
  console.log(`hits: ${hits.length}`)
  for (const hit of hits) console.log(hit)
  for (const [file, needle] of [['packages/core/src/runner.ts', '--prompt-file'], ['.github/workflows/pipeline.yml', 'reaches nare by file (#401)'], ['docs/pipeline.md', 'reaches nare by file'], ['docs/images.md', '--prompt-file']]) {
    const line = readFileSync(join(root, file), 'utf8').split('\n').findIndex((text) => text.includes(needle))
    console.log(`${file}:${line + 1} carries "${needle}"`)
    assert.ok(line >= 0)
  }
  assert.equal(hits.length, 0)
}

async function bounds() {
  // Where the checkout states what bounds a prompt now: the context window,
  // not an argument size. Each statement is printed with its file and line.
  const statements = [
    ['packages/core/src/runner.ts', "What still bounds a prompt is the model's context window"],
    ['docs/images.md', "No argument size bounds a prompt now; the model's context window bounds it"],
    ['docs/pipeline.md', "What bounds it is the model's context window (`nare-context-window`)"],
    ['.github/workflows/pipeline.yml', "size bounds it: the model's context window does"],
    ['.github/workflows/qare.yml', 'bounds it; the context window does.'],
  ]
  for (const [file, needle] of statements) {
    const lines = readFileSync(join(root, file), 'utf8').split('\n')
    const at = lines.findIndex((text) => text.includes(needle))
    console.log(at >= 0 ? `${file}:${at + 1}: ${lines[at].trim()}` : `${file}: missing "${needle}"`)
    assert.ok(at >= 0, `${file} does not state the bound`)
  }
}

const checks = { runner, nare, ci, citations, bounds }
const name = process.argv[2]
assert.ok(name in checks, `check is one of ${Object.keys(checks).join(', ')}`)
await checks[name]()
console.log(`PASS ${name}`)
