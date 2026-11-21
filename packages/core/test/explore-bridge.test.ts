import { afterEach, expect, test } from 'vitest'

import {
  EXPLORATION_BRIDGE_TOOLS,
  startExplorationBridge,
  startExplorationServer,
  type ExplorationBridge,
  type ExplorationPage,
  type ExplorationServer,
  type SnapshotNode,
} from '../src/index.js'
import { post } from './mcp-post.js'

const url = (rest: string, scheme = 'http'): string => [scheme, '://', rest].join('')
const APP = url('127.0.0.1:41000')

const tree = (button: string): SnapshotNode => ({
  role: 'document',
  states: {},
  path: 'document',
  children: [
    {
      role: 'main',
      states: {},
      path: 'document/main',
      children: [{ role: 'button', name: button, states: {}, path: `document/main/button ${JSON.stringify(button)}`, children: [] }],
    },
  ],
})

function fakeApp(): { page: ExplorationPage; navigated: string[] } {
  const navigated: string[] = []
  let at = `${APP}/`
  return {
    navigated,
    page: {
      observe: async () => ({ url: at, title: 'App' }),
      snapshot: async () => tree(at.endsWith('/settings') ? 'Save' : 'Sign in'),
      navigate: async (target) => {
        navigated.push(target)
        at = target
      },
      capture: async () => Buffer.from('png'),
    },
  }
}

const open: { close(): Promise<void> }[] = []
afterEach(async () => {
  for (const server of open.splice(0)) await server.close()
})

async function started(): Promise<{ bridge: ExplorationBridge; server: ExplorationServer; navigated: string[] }> {
  const app = fakeApp()
  const server = await startExplorationServer(app.page)
  open.push(server)
  const bridge = await startExplorationBridge(server.url)
  open.push(bridge)
  return { bridge, server, navigated: app.navigated }
}

/** The fields of an MCP answer these tests read. */
interface RpcResult {
  protocolVersion?: string
  capabilities?: unknown
  tools?: { name: string; inputSchema: { type: string } }[]
  content?: { type: string; text: string }[]
  isError?: boolean
}

async function rpc(bridge: ExplorationBridge, method: string, params?: unknown): Promise<{ result?: RpcResult; error?: { code: number; message: string } }> {
  const answer = await post(bridge.url, { jsonrpc: '2.0', id: 7, method, ...(params === undefined ? {} : { params }) })
  expect(answer.status).toBe(200)
  expect(answer.type).toContain('application/json')
  const parsed = JSON.parse(answer.body)
  expect(parsed.id).toBe(7)
  return parsed
}

test('the bridge speaks MCP to the model session: it initializes, accepts notifications and lists the read-only tools (#377)', async () => {
  const { bridge } = await started()
  // A bare address at the root, which is what nare's --mcp-config names.
  expect(new URL(bridge.url).pathname).toBe('/')
  const init = await rpc(bridge, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'nare', version: '1' } })
  expect(init.result.protocolVersion).toBe('2025-06-18')
  expect(init.result.capabilities).toEqual({ tools: {} })
  expect((await post(bridge.url, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202)
  const listed = await rpc(bridge, 'tools/list')
  expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([...EXPLORATION_BRIDGE_TOOLS])
  expect(EXPLORATION_BRIDGE_TOOLS).toEqual(['observe', 'snapshot', 'navigate'])
  for (const tool of listed.result.tools) expect(tool.inputSchema.type).toBe('object')
  // Nothing but POST of a message: no stream, no session to end.
  expect((await post(bridge.url, undefined, 'GET')).status).toBe(405)
  expect((await rpc(bridge, 'resources/list')).error?.code).toBe(-32601)
})

test('every tool result crosses fenced as untrusted data, and a snapshot is recorded with the page it was taken on (#377)', async () => {
  const { bridge, navigated } = await started()
  const observed = await rpc(bridge, 'tools/call', { name: 'observe', arguments: {} })
  expect(observed.result.isError).toBeFalsy()
  const text: string = observed.result.content[0].text
  expect(text).toMatch(/^\[untrusted tool result/)
  expect(text).toContain('"page":"/"')

  const moved = await rpc(bridge, 'tools/call', { name: 'navigate', arguments: { url: '/settings' } })
  expect(moved.result.isError).toBeFalsy()
  // A path resolves on the app the session is exploring, so the server is handed an absolute URL on it.
  expect(navigated).toEqual([`${APP}/settings`])
  const snapped = await rpc(bridge, 'tools/call', { name: 'snapshot', arguments: {} })
  expect(snapped.result.content[0].text).toContain('"page":"/settings"')
  expect(snapped.result.content[0].text).toContain('button \\"Save\\"')
  expect(bridge.explored()).toEqual([
    { page: '/settings', paths: ['document', 'document/main', 'document/main/button "Save"'] },
  ])
})

test('a tool the bridge does not serve, a page elsewhere, and a bad argument come back as tool errors, and nothing is recorded (#377)', async () => {
  const { bridge, navigated } = await started()
  for (const [name, args] of [
    ['capture', {}],
    ['write', { path: '/etc/passwd' }],
    ['navigate', { url: url('169.254.169.254/latest/meta-data') }],
    ['navigate', { url: 7 }],
    ['navigate', {}],
  ] as const) {
    const answer = await rpc(bridge, 'tools/call', { name, arguments: args })
    expect(answer.result.isError, `${name} ${JSON.stringify(args)}`).toBe(true)
  }
  expect(navigated).toEqual([])
  expect(bridge.explored()).toEqual([])
})
