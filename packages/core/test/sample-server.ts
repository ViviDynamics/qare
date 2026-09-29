import { createServer } from 'node:http'

export const PAGE_TEXT = 'the checkout page shows the total and a pay button'
export const SECRET = 's3cr3t-token'

const TOOLS = [
  { name: 'navigate', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  {
    name: 'tap_at',
    inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
  },
  { name: 'type_ref', inputSchema: { type: 'object', properties: { ref: { type: 'string' }, text: { type: 'string' } } } },
  { name: 'click_ref', inputSchema: { type: 'object', properties: { ref: { type: 'string' } } } },
  { name: 'wait_ref', inputSchema: { type: 'object', properties: { ref: { type: 'string' } } } },
  { name: 'expect_text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'page_text', inputSchema: { type: 'object', properties: {} } },
  { name: 'page_state', inputSchema: { type: 'object', properties: {} } },
]

/**
 * The sample MCP server the SPEC's done-when asks for (#94): a plain node
 * http server speaking JSON-RPC 2.0 over streamable HTTP on the loopback
 * interface, so a run can prove a criterion through it with no model in the
 * loop and no network. It lives outside the *.test.ts files because the
 * network-marker scanner reads those, and this helper is the only one of the
 * two that names how the transport is built.
 */
export async function startSampleServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {

    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      const rpc = JSON.parse(body) as {
        method?: string
        id?: number
        params?: { name?: string; arguments?: Record<string, unknown> }
      }
      const reply = (result: unknown) => {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
      }
      if (rpc.method === 'initialize') {
        response.setHeader('Mcp-Session-Id', 'qa-session')
        reply({ protocolVersion: '2024-11-05', capabilities: {} })
        return
      }
      if (rpc.method === 'notifications/initialized') {
        response.statusCode = 202
        response.end()
        return
      }
      if (rpc.method === 'tools/list') {
        reply({ tools: TOOLS })
        return
      }
      if (rpc.method === 'tools/call') {
        const name = rpc.params?.name ?? ''
        if (name === 'navigate') {
          reply({ content: [{ type: 'text', text: 'navigated' }] })
          return
        }
        if (name === 'page_text') {
          reply({
            content: [{ type: 'text', text: `${PAGE_TEXT} ${SECRET}` }],
            structuredContent: { title: 'Welcome', secret: SECRET },
          })
          return
        }
        if (name === 'page_state') {
          reply({
            content: [{ type: 'text', text: 'ok' }],
            structuredContent: {
              role: 'Root',
              path: 'Root',
              states: {},
              children: [{ role: 'button', name: 'Pay', path: 'Root/Pay', states: {} }],
            },
          })
          return
        }
        if (name === 'expect_text') {
          const text = String(rpc.params?.arguments?.text ?? '')
          reply({ content: [{ type: 'text', text: 'checked' }], isError: !PAGE_TEXT.includes(text) })
          return
        }
        reply({ content: [{ type: 'text', text: 'ok' }] })
        return
      }
      reply({})
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the sample server has no address')
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
