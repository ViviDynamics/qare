// A nare stand-in for the exploration test (#377): it reads the MCP config the
// harness handed it on the command line, speaks MCP to that server the way
// nare's client does (initialize, then tool calls), records what it saw, and
// answers with the plan it is given. Test files hold no network clients, so
// this fixture is a static file the test spawns instead.
import { readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'

const [seenPath, planJson, ...argv] = process.argv.slice(2)
const seen = { argv, calls: [] }
const at = argv.indexOf('--mcp-config')
if (at !== -1) {
  const config = JSON.parse(readFileSync(argv[at + 1], 'utf8'))
  seen.config = config
  const endpoint = config.explore.url
  seen.init = await rpc(endpoint, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-nare', version: '0' } })
  seen.listed = (await rpc(endpoint, 'tools/list')).result.tools.map((tool) => tool.name)
  for (const [name, args] of [['navigate', { url: '/settings' }], ['snapshot', {}]])
    seen.calls.push({ name, result: (await rpc(endpoint, 'tools/call', { name, arguments: args })).result })
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
    contract: 3,
    output: JSON.parse(answer),
    error: null,
  }),
)

function rpc(endpoint, method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
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
