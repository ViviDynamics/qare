// A nare stand-in for the host MCP channel test (#93, #399): it reads the MCP
// config the harness handed it on the command line, speaks MCP to the named
// server the way nare's client does (initialize, list, then one tool call),
// records what it saw, and answers with the plan it is given. Test files hold
// no network clients, so this fixture is a static file the test spawns
// instead.
import { readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'

const [seenPath, planJson, alias = 'rig', tool = 'power_on', argsJson = '{"volts":5}', ...argv] = process.argv.slice(2)
const seen = {
  argv,
  // The environment qare once handed the channel in, which no nare reads.
  env: { tools: process.env.QARE_MCP_TOOLS ?? null, endpoint: process.env.QARE_MCP_ENDPOINT ?? null },
  tool: '',
}
const at = argv.indexOf('--mcp-config')
if (at !== -1) {
  try {
    const config = JSON.parse(readFileSync(argv[at + 1], 'utf8'))
    seen.config = config
    const endpoint = config[alias].url
    seen.init = (await rpc(endpoint, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-nare', version: '0' } })).result
    seen.listed = (await rpc(endpoint, 'tools/list')).result.tools.map((listed) => listed.name)
    const called = (await rpc(endpoint, 'tools/call', { name: tool, arguments: JSON.parse(argsJson) })).result
    seen.tool = called.content.map((piece) => piece.text).join('\n')
    seen.isError = called.isError === true
  } catch (problem) {
    seen.tool = 'channel error: ' + problem
  }
}
writeFileSync(seenPath, JSON.stringify(seen))

const answer = JSON.stringify(JSON.parse(planJson))
console.log(JSON.stringify({ type: 'output', text: answer, detail: {} }))
console.log(
  JSON.stringify({
    type: 'result',
    status: 'done',
    questions: [],
    usage: { input: 1, output: 1 },
    stop_reason: 'end_turn',
    turns: 1,
    contract: 4,
    output: JSON.parse(answer),
    error: null,
  }),
)

function rpc(endpoint, method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) })
    const target = new URL(endpoint)
    const outgoing = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      },
      (incoming) => {
        let raw = ''
        incoming.on('data', (chunk) => (raw += String(chunk)))
        incoming.on('error', reject)
        incoming.on('end', () => resolve(JSON.parse(raw)))
      },
    )
    outgoing.on('error', reject)
    outgoing.end(body)
  })
}
