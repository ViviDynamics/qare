import type { IncomingMessage, ServerResponse } from 'node:http'
import { VERSION } from './version.js'

/**
 * The server side of MCP Streamable HTTP, as far as a channel qare serves a
 * model session needs it (#377, #399): initialize, ping, tools/list and
 * tools/call, answered as JSON on POST. It keeps no stream and no session.
 * The exploration bridge and the host tool server both answer through this,
 * so nare's MCP client meets one implementation, checked once.
 */

/** A tool as it is listed to the session: what nare offers the model. */
export interface ServedTool {
  name: string
  description?: string
  inputSchema: unknown
}

/** What a tool call came to: the text the session reads, and whether it is an error result. */
export interface ServedResult {
  text: string
  isError?: boolean
}

export interface McpServing {
  /** The name the server introduces itself by in initialize. */
  serverName: string
  /** Who answers, for the message a method it does not serve carries. */
  label: string
  tools: readonly ServedTool[]
  /** Answer one call. It may throw; the throw becomes an error result. */
  call(name: string, args: Record<string, unknown>): Promise<ServedResult>
}

/** The MCP revisions served: the client's own when it is one of these, else the latest. */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

// A tool call carries its arguments at most; anything larger is refused unread.
const MAX_BODY_BYTES = 64 * 1024

type JsonRpcMessage = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }

/** Answer one HTTP request as an MCP Streamable HTTP endpoint. */
export async function serveMcp(incoming: IncomingMessage, response: ServerResponse, serving: McpServing): Promise<void> {
  // Streamable HTTP lets a client open a stream with GET and end a session
  // with DELETE. Nothing here keeps a stream or a session, and says so.
  if (incoming.method !== 'POST') {
    response.writeHead(405, { allow: 'POST' })
    response.end()
    return
  }
  const body = await readBody(incoming)
  if (body === undefined) {
    respond(response, 413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'the message ran past the 64 KiB cap' } })
    return
  }
  let message: unknown
  try {
    message = JSON.parse(body)
  } catch {
    respond(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'the message is not JSON' } })
    return
  }
  const messages = (Array.isArray(message) ? message : [message]) as JsonRpcMessage[]
  const answers: unknown[] = []
  for (const one of messages) {
    // A notification or a response wants no answer.
    if (one === null || typeof one !== 'object' || one.id === undefined || typeof one.method !== 'string') continue
    answers.push(await answer(one, serving))
  }
  if (answers.length === 0) {
    response.writeHead(202)
    response.end()
    return
  }
  respond(response, 200, Array.isArray(message) ? answers : answers[0])
}

async function answer(message: JsonRpcMessage, serving: McpServing): Promise<unknown> {
  const id = message.id
  const params = (message.params !== null && typeof message.params === 'object' ? message.params : {}) as Record<string, unknown>
  switch (message.method) {
    case 'initialize': {
      const asked = params.protocolVersion
      const protocolVersion = typeof asked === 'string' && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0]
      return { jsonrpc: '2.0', id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: serving.serverName, version: VERSION } } }
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: serving.tools } }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : ''
      const args = (params.arguments !== null && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>
      let result: ServedResult
      try {
        result = await serving.call(name, args)
      } catch (error) {
        result = { text: error instanceof Error ? error.message : String(error), isError: true }
      }
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: result.text }], ...(result.isError === true ? { isError: true } : {}) } }
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `${serving.label} does not answer ${String(message.method)}` } }
  }
}

export function respond(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function readBody(incoming: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    let body = ''
    let bytes = 0
    let over = false
    incoming.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        over = true
        return
      }
      body += String(chunk)
    })
    incoming.on('error', reject)
    incoming.on('end', () => resolve(over ? undefined : body))
  })
}
