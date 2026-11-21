import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { ExplorationError, isExplorableUrl, requestExplorationTool, untrustedToolResult } from './explore.js'
import type { SnapshotNode } from './snapshot.js'
import { VERSION } from './version.js'

/**
 * The exploration channel as nare reaches it (#377). nare connects a session
 * to tools through its general MCP client (`--mcp-config`, Streamable HTTP),
 * and the exploration server (#87) speaks its own four routes, so this bridge
 * stands between them, on loopback inside the plan step's own process: the
 * model session calls a tool here, the bridge makes the same call across the
 * channel with the channel's own client, and hands the result back fenced as
 * the untrusted data it is. Nothing crosses the channel that did not before.
 *
 * The bridge is also where the plan step learns what the session saw: every
 * snapshot is recorded with the page it was taken on, so the elements a plan
 * names can be held, in code, to pages that were actually explored.
 *
 * `capture` is left out. nare hands an MCP result to the model as text, never
 * as an image, so a screenshot would arrive as a page-sized base64 string.
 */
export const EXPLORATION_BRIDGE_TOOLS = ['observe', 'snapshot', 'navigate'] as const

/** The alias the bridge is configured under for nare, so the model calls `explore__snapshot`. */
export const EXPLORATION_BRIDGE_ALIAS = 'explore'

/** A page the session snapshotted: its path on the app, and every node path the snapshot held. */
export interface ExploredPage {
  page: string
  paths: string[]
}

export interface ExplorationBridge {
  /** The bare address nare's MCP client connects to. */
  url: string
  tools: readonly string[]
  /** The pages snapshotted so far, latest snapshot of each page, in the order first seen. */
  explored(): ExploredPage[]
  close(): Promise<void>
}

/** The MCP revisions the bridge answers in: the client's own when it is one of these, else the latest. */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

const TOOL_LIST = [
  {
    name: 'observe',
    description: 'Where the page stands: its path on the app, its URL and its title.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'snapshot',
    description:
      'The page as a normalised accessibility snapshot: every node with its role, accessible name and path. Elements a flow names are read from here.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'navigate',
    description: 'Open a page of the app, by path (/settings) or by an absolute URL on the app.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'a path on the app, or an absolute URL on it' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
]

// A tool call carries a path at most; anything larger is refused unread.
const MAX_BODY_BYTES = 64 * 1024

/**
 * Start the bridge in front of the exploration server at `endpoint` (#377).
 * It answers on loopback by default, because the session that calls it runs
 * in the same container.
 */
export function startExplorationBridge(
  endpoint: string,
  options: { host?: string; port?: number } = {},
): Promise<ExplorationBridge> {
  if (!isExplorableUrl(endpoint)) return Promise.reject(new ExplorationError('the exploration endpoint must be an absolute http URL'))
  const { host = '127.0.0.1', port = 0 } = options
  const explored = new Map<string, string[]>()
  let origin: string | undefined

  // Where the app is: the origin the page stood on when the bridge first
  // asked. The serve side opens the app before it answers, so that is the
  // app itself, and every path the session names resolves on it.
  const observe = async (): Promise<{ page?: string; url: string; title: string }> => {
    const answer = (await requestExplorationTool(endpoint, 'observe')) as { url?: unknown; title?: unknown }
    const at = typeof answer?.url === 'string' ? answer.url : ''
    const title = typeof answer?.title === 'string' ? answer.title : ''
    let parsed: URL | undefined
    try {
      parsed = new URL(at)
    } catch {
      parsed = undefined
    }
    if (origin === undefined && parsed !== undefined && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) origin = parsed.origin
    const page = parsed !== undefined && parsed.origin === origin ? `${parsed.pathname}${parsed.search}` : undefined
    return { ...(page === undefined ? {} : { page }), url: at, title }
  }

  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (name) {
      case 'observe':
        return observe()
      case 'snapshot': {
        const where = await observe()
        const snapshot = (await requestExplorationTool(endpoint, 'snapshot')) as SnapshotNode
        // Only a page of the app is a page a plan may name.
        if (where.page !== undefined) {
          explored.delete(where.page)
          explored.set(where.page, pathsOf(snapshot))
        }
        return { ...(where.page === undefined ? {} : { page: where.page }), snapshot }
      }
      case 'navigate': {
        const target = args.url
        if (typeof target !== 'string' || target === '') throw new ExplorationError('navigate takes a url: a path on the app, or an absolute URL on it')
        if (origin === undefined) await observe()
        if (origin === undefined) throw new ExplorationError('the page stands on no http origin, so there is no app to navigate on')
        let resolved: URL
        try {
          resolved = new URL(target, `${origin}/`)
        } catch {
          throw new ExplorationError('navigate takes a path on the app, or an absolute URL on it')
        }
        if (resolved.origin !== origin) throw new ExplorationError(`navigate stays on the app being explored, ${origin}: ${resolved.origin} is not it`)
        await requestExplorationTool(endpoint, 'navigate', { url: resolved.href })
        return { page: `${resolved.pathname}${resolved.search}` }
      }
      default:
        throw new ExplorationError(`the exploration channel serves ${EXPLORATION_BRIDGE_TOOLS.join(', ')}, and not ${JSON.stringify(name)}`)
    }
  }

  return new Promise((resolve, reject) => {
    const server = createServer((incoming, response) => {
      response.on('error', () => {})
      handle(incoming, response, call).catch((error) => {
        if (response.writableEnded) return
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: String(error instanceof Error ? error.message : error) } }))
      })
    })
    server.on('error', reject)
    server.listen(port, host, () => {
      const address = server.address()
      const bound = typeof address === 'object' && address !== null ? address.port : undefined
      if (bound === undefined) {
        server.close()
        reject(new ExplorationError('the OS reported no port for the exploration bridge'))
        return
      }
      resolve({
        url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${bound}/`,
        tools: [...EXPLORATION_BRIDGE_TOOLS],
        explored: () => [...explored].map(([page, paths]) => ({ page, paths: [...paths] })),
        close: () =>
          new Promise<void>((done, failed) => {
            server.closeAllConnections?.()
            server.close((error) => (error === undefined ? done() : failed(error)))
          }),
      })
    })
  })
}

/** Every node path a snapshot holds, root first, in document order. */
function pathsOf(node: SnapshotNode): string[] {
  const paths: string[] = []
  const walk = (at: SnapshotNode): void => {
    if (typeof at?.path === 'string') paths.push(at.path)
    for (const child of Array.isArray(at?.children) ? at.children : []) walk(child)
  }
  walk(node)
  return paths
}

type JsonRpcMessage = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }

async function handle(
  incoming: IncomingMessage,
  response: ServerResponse,
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
  // Streamable HTTP lets a client open a stream with GET and end a session
  // with DELETE. The bridge keeps no stream and no session, and says so.
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
    answers.push(await answer(one, call))
  }
  if (answers.length === 0) {
    response.writeHead(202)
    response.end()
    return
  }
  respond(response, 200, Array.isArray(message) ? answers : answers[0])
}

async function answer(message: JsonRpcMessage, call: (name: string, args: Record<string, unknown>) => Promise<unknown>): Promise<unknown> {
  const id = message.id
  const params = (message.params !== null && typeof message.params === 'object' ? message.params : {}) as Record<string, unknown>
  switch (message.method) {
    case 'initialize': {
      const asked = params.protocolVersion
      const protocolVersion = typeof asked === 'string' && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0]
      return { jsonrpc: '2.0', id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'qare-explore', version: VERSION } } }
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOL_LIST } }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : ''
      const args = (params.arguments !== null && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>
      try {
        const result = await call(name, args)
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: untrustedToolResult(JSON.stringify(result)) }] } }
      } catch (error) {
        // A failed call is a tool result the model can adapt to, and its words
        // came from beside the app, so they are fenced like any other result.
        const said = error instanceof Error ? error.message : String(error)
        const text = said.startsWith('[untrusted tool result') ? said : untrustedToolResult(said)
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } }
      }
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `the exploration bridge does not answer ${String(message.method)}` } }
  }
}

function respond(response: ServerResponse, status: number, body: unknown): void {
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
