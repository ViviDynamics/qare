import { createServer } from 'node:http'
import { ExplorationError, isExplorableUrl, requestExplorationTool, untrustedToolResult } from './explore.js'
import { respond, serveMcp, type McpServing } from './mcp-serve.js'
import type { SnapshotNode } from './snapshot.js'

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

  const serving: McpServing = {
    serverName: 'qare-explore',
    label: 'the exploration bridge',
    tools: TOOL_LIST,
    call: async (name, args) => {
      try {
        return { text: untrustedToolResult(JSON.stringify(await call(name, args))) }
      } catch (error) {
        // A failed call is a tool result the model can adapt to, and its words
        // came from beside the app, so they are fenced like any other result.
        const said = error instanceof Error ? error.message : String(error)
        return { text: said.startsWith('[untrusted tool result') ? said : untrustedToolResult(said), isError: true }
      }
    },
  }

  return new Promise((resolve, reject) => {
    const server = createServer((incoming, response) => {
      response.on('error', () => {})
      serveMcp(incoming, response, serving).catch((error) => {
        respond(response, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: String(error instanceof Error ? error.message : error) } })
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
