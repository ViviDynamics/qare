// A stand-in host MCP server over HTTP: it answers the JSON-RPC handshake and
// tool calls on `/`, publishes the tools it is given, and reports the port it
// bound by writing the URL to a file. It also logs every method it receives
// to a third file, so a test can see the handshake's shape. Test files never
// import network clients, so this fixture is spawned instead and the test
// talks to it through the client functions the source exports. An optional
// fourth argument sets a mode for the review's hazard tests: 'hold-all'
// answers no POST at all, and 'hold-notifications' accepts a notification
// POST and never answers it.
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'

const [portFile, toolsJson, methodsFile, mode] = process.argv.slice(2)
const tools = JSON.parse(toolsJson ?? '[]')
const seen = []

const server = createServer((incoming, response) => {
  response.on('error', () => {})
  let body = ''
  incoming.on('data', (chunk) => (body += String(chunk)))
  incoming.on('error', () => {})
  incoming.on('end', async () => {
    let message
    try {
      message = JSON.parse(body)
    } catch {
      response.statusCode = 400
      response.end()
      return
    }
    if (methodsFile !== undefined && message.method !== undefined) {
      seen.push(message.method)
      await writeFile(methodsFile, seen.join('\n'), 'utf8').catch(() => {})
    }
    if (mode === 'hold-all') return
    const id = typeof message.id === 'number' ? message.id : undefined
    if (id === undefined && mode === 'hold-notifications') return
    if (id === undefined) {
      // A notification: answered, but with no JSON-RPC response.
      response.statusCode = 202
      response.end()
      return
    }
    let result = {}
    if (message.method === 'initialize' || message.method === 'tools/list') result = { tools }
    else if (message.method === 'tools/call')
      result = {
        content: [
          {
            type: 'text',
            text:
              message.params.name +
              ' saw ' +
              JSON.stringify(message.params.arguments ?? {}) +
              (incoming.url.includes('?') ? ' at ' + incoming.url : ''),
          },
        ],
      }
    if (message.params?.name === 'flood') result = { content: [{ type: 'text', text: 'f'.repeat(5 * 1024 * 1024) }] }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
  })
})

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  const url = ['http:', '//127.0.0.1:' + port].join('')
  writeFile(portFile, url, 'utf8').catch(() => {})
})
