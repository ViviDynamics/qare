import { request } from 'node:http'

// The network client the exploration bridge's tests speak MCP with (#377),
// kept out of the test files themselves as the other socket helpers are.

/** One JSON-RPC message posted the way an MCP Streamable HTTP client posts it. */
export function post(target: string, body: unknown, method = 'POST'): Promise<{ status: number; type: string; body: string }> {
  const parsed = new URL(target)
  const text = body === undefined ? '' : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname,
        method,
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      },
      (incoming) => {
        let raw = ''
        incoming.on('data', (chunk) => (raw += String(chunk)))
        incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, type: String(incoming.headers['content-type'] ?? ''), body: raw }))
      },
    )
    outgoing.on('error', reject)
    outgoing.end(text)
  })
}

