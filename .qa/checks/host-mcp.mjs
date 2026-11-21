import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import './source.mjs'

// Executable checks of the host MCP channel reaching nare by --mcp-config
// (#399), run against the checkout's source without a build. Each prints what
// it observed. check=runner hands a run's host servers to a stand-in nare that
// records what it was given; check=nare hands a registered host server to the
// nare the image installs, with a model fixture on loopback; check=profile
// loads profiles whose plan-step names nare cannot carry. Scratch is
// restricted to .qa/checks/scratch.

const { NareAgentRunner } = await import('../../packages/core/src/runner.ts')
const { connectMcpServer, mcpRecordsFile, startMcpToolServer } = await import('../../packages/core/src/mcp.ts')
const root = fileURLToPath(new URL('../../', import.meta.url))
const scratch = fileURLToPath(new URL('./scratch/', import.meta.url))
mkdirSync(scratch, { recursive: true })

const base = {
  prompt: 'Return the fixture verdict.',
  system: 'Use only the supplied evidence.',
  toolPolicy: 'none',
  budget: { maxOutputTokens: 512 },
  outputSchema: JSON.stringify({ type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'], additionalProperties: false }),
}

/** A host MCP server over stdio: it publishes power_on, read_led and wipe, and answers a call with what it saw. */
function hostServer(dir) {
  const script = join(dir, 'host-mcp.mjs')
  writeFileSync(script, [
    "import readline from 'node:readline'",
    'const published = [',
    "  { name: 'power_on', description: 'power the rig', inputSchema: { type: 'object', properties: { volts: { type: 'number' } }, required: ['volts'] } },",
    "  { name: 'read_led', inputSchema: { type: 'object', properties: {} } },",
    "  { name: 'wipe', inputSchema: { type: 'object', properties: {} } },",
    ']',
    "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
    "  if (line.trim() === '') return",
    '  const msg = JSON.parse(line)',
    '  if (msg.id === undefined) return',
    "  const answer = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')",
    "  if (msg.method === 'initialize') answer({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'rig', version: '0' } })",
    "  else if (msg.method === 'tools/list') answer({ tools: published })",
    "  else if (msg.method === 'tools/call') answer({ content: [{ type: 'text', text: msg.params.name + ' saw ' + JSON.stringify(msg.params.arguments) }] })",
    '})',
  ].join('\n'))
  // The profile allows power_on and read_led; wipe is published and not allowed.
  return { name: 'rig', command: `${process.execPath} ${script}`, tools: ['power_on', 'read_led'], steps: ['plan'] }
}

async function runner() {
  // The runner spawns `node run ...`: node runs the file named run in the
  // working directory, so the stand-in needs no executable bit on scratch.
  const dir = mkdtempSync(join(scratch, 'host-mcp-'))
  const seen = join(dir, 'seen.json')
  writeFileSync(
    join(dir, 'run'),
    [
      'void (async () => {',
      "const { readFileSync, writeFileSync } = await import('node:fs')",
      "const { basename } = await import('node:path')",
      'const argv = [basename(process.argv[1]), ...process.argv.slice(2)]',
      "const at = argv.indexOf('--mcp-config')",
      `writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv, config: at === -1 ? null : JSON.parse(readFileSync(argv[at + 1], 'utf8')), env: { QARE_MCP_TOOLS: process.env.QARE_MCP_TOOLS ?? null, QARE_MCP_ENDPOINT: process.env.QARE_MCP_ENDPOINT ?? null } }))`,
      "console.log(JSON.stringify({ type: 'output', text: '{\"verdict\":\"seen\"}' }))",
      "console.log(JSON.stringify({ type: 'result', status: 'done', stop_reason: 'end_turn', usage: { input: 1, output: 1 }, contract: 3, output: { verdict: 'seen' }, error: null, questions: [] }))",
      '})()',
    ].join('\n'),
  )
  const read = () => JSON.parse(readFileSync(seen, 'utf8'))
  const tools = (argv) => argv[argv.indexOf('--tools') + 1]
  try {
    // A stale variable in the ambient environment is cleared, not passed on.
    const stand = new NareAgentRunner({ binary: process.execPath, cwd: dir, env: { QARE_MCP_TOOLS: 'rig.wipe', QARE_MCP_ENDPOINT: 'stale' } })
    const mcp = { servers: [{ alias: 'rig', url: ['http:', '', '127.0.0.1:9', 'rig'].join('/'), tools: ['power_on'] }, { alias: 'sim', url: ['http:', '', '127.0.0.1:9', 'sim'].join('/'), tools: ['tick'] }] }
    await stand.run({ ...base, mcp })
    const hosted = read()
    console.log(`with two host servers: --mcp-config ${JSON.stringify(hosted.config)}`)
    console.log(`with two host servers: --tools ${tools(hosted.argv)} (named ${hosted.argv.filter((arg) => arg === '--tools').length} time)`)
    console.log(`with two host servers: QARE_MCP_TOOLS=${hosted.env.QARE_MCP_TOOLS}, QARE_MCP_ENDPOINT=${hosted.env.QARE_MCP_ENDPOINT}`)
    assert.deepEqual(Object.keys(hosted.config), ['rig', 'sim'])
    assert.equal(tools(hosted.argv), 'rig__power_on,sim__tick')
    assert.deepEqual(hosted.env, { QARE_MCP_TOOLS: null, QARE_MCP_ENDPOINT: null })

    await stand.run({ ...base, mcp, tools: { allowlist: ['observe'], endpoint: ['http:', '', '127.0.0.1:8', ''].join('/') } })
    const both = read()
    console.log(`exploring too: --mcp-config ${JSON.stringify(both.config)}; --tools ${tools(both.argv)}`)
    assert.deepEqual(Object.keys(both.config), ['explore', 'rig', 'sim'])
    assert.equal(tools(both.argv), 'explore__observe,rig__power_on,sim__tick')

    await stand.run(base)
    const none = read()
    console.log(`with no host server and no exploration: --mcp-config given ${none.argv.includes('--mcp-config')}; --tools ${tools(none.argv)}; QARE_MCP_TOOLS=${none.env.QARE_MCP_TOOLS}`)
    assert.equal(none.argv.includes('--mcp-config'), false)
    assert.equal(tools(none.argv), 'none')
    assert.equal(none.env.QARE_MCP_TOOLS, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function nare() {
  const found = spawnSync('nare', ['--version'], { encoding: 'utf8' })
  assert.equal(found.status, 0, 'nare is not installed here, so its real CLI cannot be exercised')
  console.log(`nare on PATH: ${found.stdout.trim()}`)
  let replies = []
  let requests = []
  const model = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.end(JSON.stringify({ data: [] }))
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks).toString()))
    const reply = replies.shift() ?? { message: { role: 'assistant', content: '' }, finish_reason: 'stop' }
    response.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', model: 'fixture', choices: [{ index: 0, ...reply }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
  })
  await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve))
  const env = {
    NARE_PROVIDER: 'openai', NARE_MODEL: 'fixture', NARE_STREAM: 'false',
    NARE_BASE_URL: ['http:', '', `127.0.0.1:${model.address().port}`, 'v1'].join('/'),
    OPENAI_API_KEY: 'local-fixture',
  }
  const dir = mkdtempSync(join(scratch, 'host-mcp-'))
  const records = []
  const source = await connectMcpServer(hostServer(dir), { record: (record) => records.push(record) })
  const host = await startMcpToolServer([source])
  const call = (id, name, args) => ({ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' })
  const answer = (text) => ({ message: { role: 'assistant', content: text }, finish_reason: 'stop' })
  const toolText = (index) => String(requests[index].messages.filter((message) => message.role === 'tool').at(-1)?.content ?? '')
  const offered = () => requests[0].tools.map((tool) => tool.function.name).join(', ')
  try {
    const [rig] = host.servers
    console.log(`the plan step's tool server serves rig at ${rig.url}, listing ${rig.tools.join(', ')} (wipe is published and not allowed)`)
    assert.deepEqual(rig.tools, ['power_on', 'read_led'])
    // The run names power_on alone, so read_led is listed by the server but not offered by nare.
    const mcp = { servers: [{ alias: rig.name, url: rig.url, tools: ['power_on'] }] }
    const runner = new NareAgentRunner({ env })

    requests = []
    replies = [call('power', 'rig__power_on', { volts: 5 }), answer('{"verdict":"powered"}')]
    const powered = await runner.run({ ...base, mcp })
    console.log(`run 1: status ${powered.status}, output ${powered.output}`)
    console.log(`run 1: the model was offered: ${offered()}`)
    console.log(`run 1: the schema offered for rig__power_on requires ${JSON.stringify(requests[0].tools[0].function.parameters.required)}`)
    console.log(`run 1: the tool result the model read: ${JSON.stringify(toolText(1))}`)
    assert.equal(powered.status, 'completed')
    assert.equal(offered(), 'rig__power_on')
    assert.deepEqual(requests[0].tools[0].function.parameters.required, ['volts'])
    assert.ok(toolText(1).includes('power_on saw {"volts":5}'))
    assert.ok(toolText(1).includes('[untrusted tool result: produced by a host tool server.'))

    requests = []
    replies = [call('led', 'rig__read_led', {}), call('wipe', 'rig__wipe', {}), answer('{"verdict":"refused"}')]
    const refused = await runner.run({ ...base, mcp })
    console.log(`run 2: status ${refused.status}; the model was offered: ${offered()}`)
    console.log(`run 2: calling rig__read_led (listed by the server, not named in --tools): ${JSON.stringify(toolText(1))}`)
    console.log(`run 2: calling rig__wipe (published, not allowed by the profile): ${JSON.stringify(toolText(2))}`)
    assert.equal(refused.status, 'completed')
    assert.ok(toolText(1).includes('rig__read_led is not allowed in this session'))
    assert.ok(toolText(2).includes("unknown tool 'rig__wipe'"))

    console.log(`mcp-calls.jsonl as the plan step writes it (${records.length} record):`)
    process.stdout.write(mcpRecordsFile(records, []))
    assert.deepEqual(records, [{ server: 'rig', tool: 'power_on', arguments: { volts: 5 }, result: 'power_on saw {"volts":5}' }])
  } finally {
    await host.close()
    await source.close()
    await new Promise((resolve) => model.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  }
}

async function profile() {
  const { validateProfileConfig } = await import('../../packages/core/src/profile.ts')
  const target = { url: ['https:', '', 'staging.example.test'].join('/'), health: { http: '/health', timeout: '1s' } }
  const server = { name: 'rig', command: 'node rig.mjs', tools: ['power_on'], steps: ['plan'] }
  const cases = [
    ['plan-step server named "device rig"', { ...server, name: 'device rig' }],
    ['plan-step tool named "page.text"', { ...server, tools: ['page.text'] }],
    ['execute-step server "device rig" with tool "page.text"', { ...server, name: 'device rig', tools: ['page.text'], steps: ['execute'] }],
    ['plan-step server "rig" with tool "power_on"', server],
  ]
  const outcomes = []
  for (const [label, entry] of cases) {
    let outcome = 'loads'
    try {
      validateProfileConfig({ target, mcp: [entry] })
    } catch (error) {
      outcome = `refused: ${error.message}`
    }
    console.log(`${label}: ${outcome}`)
    outcomes.push(outcome)
  }
  assert.match(outcomes[0], /refused: .*not one nare can address a server by/)
  assert.match(outcomes[1], /refused: .*not one nare can offer a model/)
  assert.equal(outcomes[2], 'loads')
  assert.equal(outcomes[3], 'loads')
}

async function docs() {
  // Where the checkout records the decision, each statement on one line.
  const statements = [
    ['docs/decisions/adr-0012-host-mcp-servers-reach-nare-by-mcp-config.md', 'The runner hands nare one `--mcp-config` naming the exploration bridge'],
    ['docs/decisions/adr-0012-host-mcp-servers-reach-nare-by-mcp-config.md', '`--tools` is always set when a config is handed over'],
    ['docs/decisions/adr-0012-host-mcp-servers-reach-nare-by-mcp-config.md', 'With no registered server and no exploration, nare is handed no config and `--tools none`'],
    ['docs/decisions/adr-0012-host-mcp-servers-reach-nare-by-mcp-config.md', 'The `QARE_MCP_*` variables are no longer set'],
    ['packages/core/src/runner.ts', 'delete env.QARE_MCP_TOOLS'],
    ['scripts/nare-compat.mjs', 'PASS: a host MCP server reaches real nare through --mcp-config'],
  ]
  for (const [file, needle] of statements) {
    const lines = readFileSync(join(root, file), 'utf8').split('\n')
    const at = lines.findIndex((text) => text.includes(needle))
    console.log(at >= 0 ? `${file}:${at + 1}: ${lines[at].trim()}` : `${file}: missing "${needle}"`)
    assert.ok(at >= 0, `${file} does not carry the statement`)
  }
  const runnerSource = readFileSync(join(root, 'packages/core/src/runner.ts'), 'utf8')
  const sets = runnerSource.split('\n').filter((line) => /env\.QARE_MCP_\w+\s*=/.test(line))
  console.log(`lines in runner.ts that set a QARE_MCP variable: ${sets.length}`)
  assert.equal(sets.length, 0)
}

const checks = { runner, nare, profile, docs }
const name = process.argv[2]
assert.ok(name in checks, `check is one of ${Object.keys(checks).join(', ')}`)
await checks[name]()
console.log(`PASS ${name}`)
