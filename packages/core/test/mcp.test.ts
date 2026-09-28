import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

import {
  McpError,
  McpUnreachable,
  callChannelTool,
  channelToolName,
  connectMcpServer,
  splitMcpCommand,
  startMcpToolServer,
  startRegisteredMcpSources,
  type McpCallRecord,
  type ProfileMcpServer,
} from '../src/index.js'

// The HTTP stand-in lives in a fixture file: test files hold no network
// clients, so the fixture process is spawned and the test talks to it through
// the client functions the source exports.
const HTTP_MCP_FIXTURE = fileURLToPath(new URL('./fixtures/http-mcp-server.mjs', import.meta.url))

/**
 * A stand-in for a host's MCP server: a real process speaking newline-
 * delimited JSON-RPC over stdio, so the client exercises a wire rather than a
 * mock. It publishes the tools it is told to publish — including ones outside
 * any allowlist, which is the point of narrowing — and answers calls in text.
 */
async function fakeMcpServer(
  options: { tools?: unknown; call?: (name: string, args: unknown) => unknown } = {},
): Promise<ProfileMcpServer> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-mcp-'))
  const script = join(dir, 'fake-mcp.mjs')
  const tools = JSON.stringify(options.tools ?? [{ name: 'power_on', description: 'power the rig' }, { name: 'secret_tool' }])
  const lines = [
    "import readline from 'node:readline'",
    "const rl = readline.createInterface({ input: process.stdin })",
    `const published = ${tools}`,
    `const call = ${options.call === undefined ? 'null' : options.call.toString()}`,
    "rl.on('line', (line) => {",
    "  if (line.trim() === '') return",
    "  const msg = JSON.parse(line)",
    "  const answer = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')",
    "  if (msg.method === 'initialize') answer({ protocolVersion: '2024-11-05' })",
    "  else if (msg.method === 'tools/list') answer({ tools: published })",
    "  else if (msg.method === 'tools/call') {",
    "    if (call === null) answer({ content: [{ type: 'text', text: 'power: on' }] })",
    "    else answer(call(msg.params?.name, msg.params?.arguments))",
    "  }",
    "})",
  ].join('\n')
  await writeFile(script, lines, 'utf8')
  return { name: 'rig', command: `node ${script}`, tools: ['power_on'], steps: ['plan'] }
}

test('a command is split on whitespace, with no shell', () => {
  expect(splitMcpCommand('node  /path/to/server.mjs --flag one')).toEqual([
    'node',
    '/path/to/server.mjs',
    '--flag',
    'one',
  ])
  expect(splitMcpCommand('one\ttwo')).toEqual(['one', 'two'])
})

test('a tool is addressed as server.tool, so two servers cannot collide', () => {
  expect(channelToolName('rig', 'power_on')).toBe('rig.power_on')
  expect(channelToolName('rig2', 'power_on')).not.toBe(channelToolName('rig', 'power_on'))
})

test('the handshake answers, and the published tools narrow to the allowlist', async () => {
  const spec = await fakeMcpServer()
  const source = await connectMcpServer(spec)
  try {
    expect(source.name).toBe('rig')
    // secret_tool is published but not allowed, so it never reaches the channel.
    expect(source.tools).toEqual([{ name: 'power_on', description: 'power the rig' }])
  } finally {
    await source.close()
  }
})

test('a call carries its arguments and comes back as text, recorded once', async () => {
  const spec = await fakeMcpServer({
    call: (name, args) => ({ content: [{ type: 'text', text: `${name}: ${JSON.stringify(args)}` }] }),
  })
  const records: McpCallRecord[] = []
  const source = await connectMcpServer(spec, { record: (record) => records.push(record) })
  try {
    const text = await source.call('power_on', { channel: 3 })
    expect(text).toBe('power_on: {"channel":3}')
    expect(records).toEqual([
      { server: 'rig', tool: 'power_on', arguments: { channel: 3 }, result: 'power_on: {"channel":3}' },
    ])
  } finally {
    await source.close()
  }
})

test('a tool the server marks as errored is an error result, never a crash', async () => {
  const spec = await fakeMcpServer({
    call: () => ({ content: [{ type: 'text', text: 'the rig is on fire' }], isError: true }),
  })
  const records: McpCallRecord[] = []
  const source = await connectMcpServer(spec, { record: (record) => records.push(record) })
  try {
    await expect(source.call('power_on', undefined)).rejects.toThrow('the rig is on fire')
    expect(records).toEqual([{ server: 'rig', tool: 'power_on', error: 'the rig is on fire' }])
  } finally {
    await source.close()
  }
})

test('a result past the cap is refused named, not buffered whole', async () => {
  const spec = await fakeMcpServer({
    call: () => ({ content: [{ type: 'text', text: 'x'.repeat(5 * 1024 * 1024) }] }),
  })
  const records: McpCallRecord[] = []
  const source = await connectMcpServer(spec, { record: (record) => records.push(record) })
  try {
    await expect(source.call('power_on', undefined)).rejects.toThrow(McpError)
    await expect(source.call('power_on', undefined)).rejects.toThrow('past the 4 MiB cap')
    expect(records[0]?.error).toContain('4 MiB cap')
  } finally {
    await source.close()
  }
})

test('a server that cannot be started is reported, never silently skipped', async () => {
  const records: McpCallRecord[] = []
  await expect(
    connectMcpServer({ name: 'ghost', command: 'qare-no-such-executable-here', tools: ['power_on'], steps: ['plan'] }, {
      record: (record) => records.push(record),
    }),
  ).rejects.toThrow(McpUnreachable)
  expect(records[0]?.server).toBe('ghost')
  expect(records[0]?.error).toContain('unreachable:')
})

test('a server reachable over HTTP speaks the same JSON-RPC', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-mcp-http-'))
  const portFile = join(dir, 'port.txt')
  const fixture = spawn(process.execPath, [HTTP_MCP_FIXTURE, portFile, JSON.stringify([{ name: 'ping' }])])
  try {
    const source = await connectMcpServer({
      name: 'httpd',
      url: await waitForPortFile(portFile),
      tools: ['ping'],
      steps: ['plan'],
    })
    try {
      expect(source.tools).toEqual([{ name: 'ping' }])
      expect(await source.call('ping', undefined)).toBe('ping saw {}')
    } finally {
      await source.close()
    }
  } finally {
    fixture.kill()
  }
})

async function waitForPortFile(portFile: string): Promise<string> {
  for (let waited = 0; waited < 5000; waited += 50) {
    try {
      return await readFile(portFile, 'utf8')
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw new Error('the fixture server wrote no port to read')
}

test('the channel serves the allowed tools as server.tool and nothing else', async () => {
  const spec = await fakeMcpServer({
    call: (name, args) => ({ content: [{ type: 'text', text: `${name} saw ${JSON.stringify(args)}` }] }),
  })
  const started = await startRegisteredMcpSources([spec], 'plan')
  let server: Awaited<ReturnType<typeof startMcpToolServer>> | undefined
  try {
    server = await startMcpToolServer(started.sources)
    expect(server.tools).toEqual(['rig.power_on'])

    const answer = await callChannelTool(server, 'rig.power_on', { volts: 5 })
    expect(answer).toBe('power_on saw {"volts":5}')
    // secret_tool is published but not allowed, so the channel does not name it.
    await expect(callChannelTool(server, 'rig.secret_tool', {})).rejects.toThrow(/registers no tool/)
    await expect(callChannelTool(server, 'ghost.power_on', {})).rejects.toThrow(/registers no tool/)
  } finally {
    await server?.close().catch(() => {})
    await Promise.all(started.sources.map((source) => source.close()))
  }
})

test('a registered server that is unreachable is reported while the rest serve', async () => {
  const ghost: ProfileMcpServer = { name: 'ghost', command: 'qare-no-such-executable-here', tools: ['x'], steps: ['plan'] }
  const spec = await fakeMcpServer()
  const records: McpCallRecord[] = []
  const started = await startRegisteredMcpSources([ghost, spec], 'plan', { record: (record) => records.push(record) })
  try {
    expect(started.sources.map((source) => source.name)).toEqual(['rig'])
    expect(started.failures).toEqual([{ server: 'ghost', reason: expect.stringContaining('unreachable:') }])
    expect(records).toEqual([{ server: 'ghost', error: expect.stringContaining('unreachable:') }])
  } finally {
    await Promise.all(started.sources.map((source) => source.close()))
  }
})

test('a server that names no step this run may not run in is never started', async () => {
  const spec = await fakeMcpServer()
  const executeOnly: ProfileMcpServer = { ...spec, name: 'later', steps: ['execute'] }
  const started = await startRegisteredMcpSources([executeOnly], 'plan')
  expect(started.sources).toEqual([])
  expect(started.failures).toEqual([])
})

test('the channel refuses a body past its cap, and tools it does not register', async () => {
  const spec = await fakeMcpServer()
  const started = await startRegisteredMcpSources([spec], 'plan')
  let server: Awaited<ReturnType<typeof startMcpToolServer>> | undefined
  try {
    server = await startMcpToolServer(started.sources)
    await expect(callChannelTool(server, 'ghost.power_on', {})).rejects.toThrow(/registers no tool/)
    await expect(callChannelTool(server, 'rig.power_on', { blob: 'x'.repeat(65 * 1024) })).rejects.toThrow(
      /past the 64 KiB cap/,
    )
  } finally {
    await server?.close().catch(() => {})
    await Promise.all(started.sources.map((source) => source.close()))
  }
})
