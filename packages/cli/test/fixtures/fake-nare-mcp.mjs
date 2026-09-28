// A nare stand-in for the MCP-channel test: it reads the environment the
// harness handed it, calls one tool through the channel the way nare's model
// session would, records what it saw, and answers with the plan it is given.
// Test files hold no network clients, so this fixture is a static file the
// test spawns instead.
import { writeFileSync } from 'node:fs'
import { request } from 'node:http'

const [seenPath, planJson] = process.argv.slice(2)
const seen = {
  tools: process.env.QARE_MCP_TOOLS,
  endpoint: process.env.QARE_MCP_ENDPOINT,
  exploration: process.env.QARE_EXPLORATION_TOOLS,
  tool: '',
}

try {
  seen.tool = await probe(process.env.QARE_MCP_ENDPOINT, 'rig.power_on', { volts: 5 })
} catch (problem) {
  seen.tool = 'channel error: ' + problem
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
    contract: 1,
    output: JSON.parse(answer),
    error: null,
  }),
)

function probe(endpoint, path, args) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(args ?? {})
    const target = new URL(endpoint + '/' + path)
    const outgoing = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
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
