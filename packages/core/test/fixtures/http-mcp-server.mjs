// A stand-in host MCP server over HTTP: it answers the JSON-RPC handshake and
// tool calls on `/`, publishes the tools it is given, and reports the port it
// bound by writing the URL to a file. Test files never import network clients,
// so this fixture is spawned instead and the test talks to it through the
// client functions the source exports.
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'

const [portFile, toolsJson] = process.argv.slice(2)
const tools = JSON.parse(toolsJson ?? '[]')

const server = createServer((incoming, response) => {
  let body = ''
  incoming.on('data', (chunk) => (body += String(chunk)))
  incoming.on('error', () => {})
  incoming.on('end', () => {
    let message
    try {
      message = JSON.parse(body)
    } catch {
      response.statusCode = 400
      response.end()
      return
    }
    const id = typeof message.id === 'number' ? message.id : undefined
    if (id === undefined) {
      response.end()
      return
    }
    let result = {}
    if (message.method === 'initialize' || message.method === 'tools/list') result = { tools }
    else if (message.method === 'tools/call')
      result = {
        content: [{ type: 'text', text: message.params.name + ' saw ' + JSON.stringify(message.params.arguments ?? {}) }],
      }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
  })
})

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  const url = ['http:', '//127.0.0.1:' + port].join('')
  writeFile(portFile, url, 'utf8').catch(() => {})
})
