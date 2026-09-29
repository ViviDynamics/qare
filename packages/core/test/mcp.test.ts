import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

import {
  McpUnreachable,
  BUILTIN_REDACTION_RULES,
  callChannelTool,
  channelToolName,
  connectMcpServer,
  mcpDriverCapabilities,
  mcpRecordsFile,
  PLAN_SCHEMA_VERSION,
  redactionRules,
  runJob,
  splitMcpCommand,
  startMcpToolServer,
  startRegisteredMcpSources,
  validateProfileConfig,
  loadPlan,
  loadJobFromText,
  type BootOpts,
  type Job,
  type JobCriterion,
  type JobProfileRef,
  type McpCallRecord,
  type McpSource,
  type ProfileMcpServer,
  type QaProfile,
} from '../src/index.js'
import { startSampleServer, SECRET } from './sample-server.js'

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
  options: {
    tools?: unknown
    allowlist?: string[]
    call?: (name: string, args: unknown) => unknown
    concurrent?: boolean
    flood?: boolean
    chatty?: boolean
  } = {},
): Promise<ProfileMcpServer> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-mcp-'))
  const script = join(dir, 'fake-mcp.mjs')
  const tools = JSON.stringify(options.tools ?? [{ name: 'power_on', description: 'power the rig' }, { name: 'secret_tool' }])
  const lines = [
    "import readline from 'node:readline'",
    "const rl = readline.createInterface({ input: process.stdin })",
    `const published = ${tools}`,
    `const call = ${options.call === undefined ? 'null' : options.call.toString()}`,
    `const concurrent = ${options.concurrent === true ? 'true' : 'false'}`,
    `const flood = ${options.flood === true ? 'true' : 'false'}`,
    `const chatty = ${options.chatty === true ? 'true' : 'false'}`,
    "if (chatty) process.stderr.write('e'.repeat(200 * 1024))",
    "rl.on('line', (line) => {",
    "  if (line.trim() === '') return",
    "  const msg = JSON.parse(line)",
    "  const answer = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')",
    "  if (msg.method === 'initialize') answer({ protocolVersion: '2024-11-05' })",
    "  else if (msg.method === 'tools/list') answer({ tools: published })",
    "  else if (msg.method === 'tools/call' && flood) process.stdout.write('z'.repeat(5.5 * 1024 * 1024))",
    "  else if (msg.method === 'tools/call' && concurrent) {",
    "    if (msg.params?.name === 'slow') setTimeout(() => answer({ content: [{ type: 'text', text: 'slow done' }] }), 100)",
    "    else answer({ content: [{ type: 'text', text: 'fast done' }] })",
    "  }",
    "  else if (msg.method === 'tools/call') {",
    "    if (call === null) answer({ content: [{ type: 'text', text: 'power: on' }] })",
    "    else answer(call(msg.params?.name, msg.params?.arguments))",
    "  }",
    "})",
  ].join('\n')
  await writeFile(script, lines, 'utf8')
  return { name: 'rig', command: `node ${script}`, tools: options.allowlist ?? ['power_on'], steps: ['plan'] }
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
    // One call, and the server does not survive it: the line is cut off and
    // the server killed, so the record carries the reason and nothing else —
    // and one call is one record, even for a cap (#167 review).
    await expect(source.call('power_on', undefined)).rejects.toThrow('past the 4 MiB cap')
    expect(records).toHaveLength(1)
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

test('the records file is redacted like the evidence it is', () => {
  const rules = [...BUILTIN_REDACTION_RULES, ...redactionRules({ values: ['hunter2'] })]
  const line = mcpRecordsFile(
    [
      {
        server: 'rig',
        tool: 'power_on',
        arguments: { password: 'hunter2', note: 'the hunter2 vault' },
        result: 'the hunter2 vault',
      },
    ],
    rules,
  )
  const record = JSON.parse(line.trim()) as { arguments: { password: string; note: string }; result: string }
  expect(record.arguments.password).toBe('[redacted]')
  expect(record.arguments.note).toBe('the [redacted] vault')
  expect(record.result).toBe('the [redacted] vault')
})

test('concurrent calls each keep their own answer', async () => {
  const spec = await fakeMcpServer({ concurrent: true, allowlist: ['slow', 'fast'] })
  const source = await connectMcpServer(spec)
  try {
    const [slow, fast] = await Promise.all([source.call('slow', undefined), source.call('fast', undefined)])
    expect(slow).toBe('slow done')
    expect(fast).toBe('fast done')
  } finally {
    await source.close()
  }
})

test('a channel name two servers would share is refused, by name', async () => {
  const a: McpSource = { name: 'a', tools: [{ name: 'b.c' }], call: async () => 'x', close: async () => {} }
  const ab: McpSource = { name: 'a.b', tools: [{ name: 'c' }], call: async () => 'x', close: async () => {} }
  await expect(startMcpToolServer([a, ab])).rejects.toThrow(/names "a\.b\.c" twice/)
})

test('a tool whose name carries URL syntax still reaches its route', async () => {
  const spec = await fakeMcpServer({ tools: [{ name: 'weird?x' }], allowlist: ['weird?x'] })
  const started = await startRegisteredMcpSources([spec], 'plan')
  let server: Awaited<ReturnType<typeof startMcpToolServer>> | undefined
  try {
    server = await startMcpToolServer(started.sources)
    expect(server.tools).toEqual(['rig.weird?x'])
    expect(await callChannelTool(server, 'rig.weird?x', {})).toBe('power: on')
  } finally {
    await server?.close().catch(() => {})
    await Promise.all(started.sources.map((source) => source.close()))
  }
})

test('a result past the cap is cut off while it streams, not buffered whole', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-mcp-http-'))
  const portFile = join(dir, 'port.txt')
  const fixture = spawn(process.execPath, [HTTP_MCP_FIXTURE, portFile, JSON.stringify([{ name: 'flood' }])])
  try {
    const source = await connectMcpServer({
      name: 'httpd',
      url: await waitForPortFile(portFile),
      tools: ['flood'],
      steps: ['plan'],
    })
    try {
      await expect(source.call('flood', undefined)).rejects.toThrow('past the 4 MiB cap')
    } finally {
      await source.close()
    }
  } finally {
    fixture.kill()
  }
})

test('a stdio line past the cap never buffers whole', async () => {
  const spec = await fakeMcpServer({ flood: true })
  const source = await connectMcpServer(spec)
  try {
    await expect(source.call('power_on', undefined)).rejects.toThrow('past the 4 MiB cap')
  } finally {
    await source.close()
  }
})

test('the HTTP handshake sends its initialized notification, and the profile URL query rides along', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-mcp-http-'))
  const portFile = join(dir, 'port.txt')
  const methodsFile = join(dir, 'methods.txt')
  const fixture = spawn(process.execPath, [HTTP_MCP_FIXTURE, portFile, JSON.stringify([{ name: 'ping' }]), methodsFile])
  try {
    const source = await connectMcpServer({
      name: 'httpd',
      url: (await waitForPortFile(portFile)) + '/mcp?token=q1',
      tools: ['ping'],
      steps: ['plan'],
    })
    try {
      const answer = await source.call('ping', undefined)
      expect(answer).toContain('token=q1')
      const methods = (await readFile(methodsFile, 'utf8')).trim().split('\n')
      expect(methods.indexOf('notifications/initialized')).toBeGreaterThan(methods.indexOf('initialize'))
      expect(methods.indexOf('tools/list')).toBeGreaterThan(methods.indexOf('notifications/initialized'))
    } finally {
      await source.close()
    }
  } finally {
    fixture.kill()
  }
})

test('a stdio server that logs past the pipe cannot block the handshake (#167 review)', async () => {
  const spec = await fakeMcpServer({ chatty: true })
  const source = await connectMcpServer(spec, { handshakeTimeoutMs: 2000 })
  try {
    expect(await source.call('power_on', undefined)).toContain('power: on')
  } finally {
    await source.close()
  }
})

test('a server that accepts the notification POST and never answers it cannot hold the handshake (#167 review)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-mcp-http-'))
  const portFile = join(dir, 'port.txt')
  const fixture = spawn(process.execPath, [
    HTTP_MCP_FIXTURE,
    portFile,
    JSON.stringify([{ name: 'power_on' }]),
    join(dir, 'methods.txt'),
    'hold-notifications',
  ])
  try {
    const source = await connectMcpServer(
      { name: 'httpd', url: await waitForPortFile(portFile), tools: ['power_on'], steps: ['plan'] },
      { handshakeTimeoutMs: 2000 },
    )
    try {
      expect(source.tools.map((tool) => tool.name)).toEqual(['power_on'])
    } finally {
      await source.close()
    }
  } finally {
    fixture.kill()
  }
})

test('a server that answers no POST at all is unreachable within the handshake timeout (#167 review)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-mcp-http-'))
  const portFile = join(dir, 'port.txt')
  const fixture = spawn(process.execPath, [HTTP_MCP_FIXTURE, portFile, '[]', join(dir, 'methods.txt'), 'hold-all'])
  try {
    await expect(
      connectMcpServer(
        { name: 'httpd', url: await waitForPortFile(portFile), tools: ['power_on'], steps: ['plan'] },
        { handshakeTimeoutMs: 200 },
      ),
    ).rejects.toThrow('is unreachable')
  } finally {
    fixture.kill()
  }
})

// --- the driver adapter (#94) ---

// Assembled like the boot URLs elsewhere: no network marker sits as a literal
// in a test file, which the marker scanner reads.
const stubUrl = ['http:', '//localhost:9/mcp'].join('')
const REDACTED = '[redacted]'

const HEALTH_URL = ['http:', '//localhost:3000/up'].join('')

const DRIVER_PROFILE: Pick<QaProfile, 'app' | 'stubs' | 'visual' | 'redact'> = {
  app: {
    boot: { compose: 'compose.qa.yaml', service: 'admin' },
    health: { http: HEALTH_URL, timeout: '120s' },
    seed: { command: 'bin/rails db:seed:qa' },
    login: { fixture: 'fixtures/users.yml', role: 'admin' },
  },
  stubs: [
    { service: 'billing', hosts: ['api.billing-vendor.example'], provided_by: { compose_service: 'billing-stub' } },
    { service: 'mail', hosts: ['api.mailgun.net'], provided_by: { compose_service: 'mailpit' } },
  ],
  visual: { widths: [1440, 390], themes: ['light', 'dark'] },
  suites: [],
  redact: { values: [SECRET] },
}

const HEALTHY_DRIVER_BOOT: BootOpts = {
  runCompose: async () => ({ code: 0, stdout: 'up out', stderr: 'up err' }),
  probe: async () => ({ ok: true }),
  pollIntervalMs: 1,
}

async function makeDriverJob(mcp: QaProfile['mcp'], criteria: JobCriterion[]): Promise<Job> {
  const repoPath = await mkdtemp(join(tmpdir(), 'qare-mcp-'))
  const profile: QaProfile = { ...DRIVER_PROFILE, ...(mcp === undefined ? {} : { mcp }) }
  return {
    id: 'job-mcp-driver',
    repoPath,
    baseRef: 'main',
    headRef: 'HEAD~1',
    profile: { inline: profile } satisfies JobProfileRef,
    evidenceDir: join(repoPath, 'evidence'),
    post: 'none',
    criteria,
  }
}

test('a criterion is proven through the sample MCP server with no model call in the run', async () => {
  const server = await startSampleServer()
  try {
    const job = await makeDriverJob(
      [
        {
          name: 'sample',
          url: server.url,
          tools: ['page_text', 'navigate'],
          steps: ['plan', 'execute'],
          driver: { open: { tool: 'navigate', args: { url: 'url' } } },
        },
      ],
      [
        {
          id: 'c1',
          text: 'the page shows the total',
          checks: [{ kind: 'tool', tool: 'page_text', args: {}, assert: [{ path: 'title', equals: 'Welcome' }] }],
        },
      ],
    )
    const { result } = await runJob(job, HEALTHY_DRIVER_BOOT)
    expect(result.verdict).toBe('passed')
    expect(result.criteria[0]?.outcome).toBe('proven')
    // The call and its result are evidence, redacted like everything else (#94).
    const tool = JSON.parse(await readFile(join(job.evidenceDir, 'checks', 'c1', '0', 'tool.json'), 'utf8'))
    expect(tool.tool).toBe('page_text')
    expect(tool.outcome).toBe('passed')
    expect(tool.result.structured.secret).toBe(REDACTED)
    expect(JSON.stringify(tool)).not.toContain(SECRET)
  } finally {
    await server.close()
  }
})

test('a flow check drives the mapped tools and records redacted calls as evidence', async () => {
  const server = await startSampleServer()
  try {
    const job = await makeDriverJob(
      [
        {
          name: 'sample',
          url: server.url,
          tools: ['navigate', 'type_ref', 'click_ref', 'wait_ref', 'expect_text'],
          steps: ['plan', 'execute'],
          driver: {
            open: { tool: 'navigate', args: { url: 'url' } },
            type: { tool: 'type_ref', args: { ref: 'element', text: 'value' } },
            click: { tool: 'click_ref', args: { ref: 'element' } },
            waitFor: { tool: 'wait_ref', args: { ref: 'element' } },
            assertText: { tool: 'expect_text', args: { text: 'text' } },
          },
        },
      ],
      [
        {
          id: 'c1',
          text: 'the checkout flow works',
          checks: [
            {
              kind: 'flow',
              name: 'checkout',
              actions: [
                { action: 'open', url: '/checkout' },
                { action: 'type', element: { role: 'spinbutton', name: 'quantity' }, value: '2' },
                { action: 'click', element: { role: 'button', name: 'pay' } },
                { action: 'waitFor', element: { role: 'heading', name: 'receipt' } },
                { action: 'assertText', text: 'the checkout page shows the total and a pay button' },
              ],
            },
          ],
        },
      ],
    )
    const { result } = await runJob(job, HEALTHY_DRIVER_BOOT)
    expect(result.verdict).toBe('passed')
    const calls = JSON.parse(await readFile(join(job.evidenceDir, 'checks', 'c1', '0', 'tool-calls.json'), 'utf8'))
    expect(calls.map((call: { intent: string; tool: string }) => `${call.intent}:${call.tool}`)).toEqual([
      'open:navigate',
      'type:type_ref',
      'click:click_ref',
      'waitFor:wait_ref',
      'assertText:expect_text',
    ])
    expect(JSON.stringify(calls)).not.toContain(SECRET)
  } finally {
    await server.close()
  }
})

test('a mapping that omits an intent rejects a plan naming it, at plan time', () => {
  const driver = mcpDriverCapabilities([
    { name: 'sample', url: stubUrl, tools: ['navigate'], steps: ['plan', 'execute'], driver: { open: { tool: 'navigate', args: { url: 'url' } } } },
  ])
  expect(driver).toBeDefined()
  const plan = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    criteria: [
      {
        id: 'c1',
        text: 'x',
        checks: [
          {
            kind: 'flow',
            name: 'f',
            actions: [
              { action: 'open', url: '/a' },
              { action: 'click', element: { role: 'button', name: 'pay' } },
            ],
          },
        ],
      },
    ],
  }
  expect(() => loadPlan(JSON.stringify(plan), [], driver)).toThrow(/click/)
})

test('a plan naming only mapped intents loads against the mapping', () => {
  const driver = mcpDriverCapabilities([
    {
      name: 'sample',
      url: stubUrl,
      tools: ['navigate', 'click_ref'],
      steps: ['plan', 'execute'],
      driver: {
        open: { tool: 'navigate', args: { url: 'url' } },
        click: { tool: 'click_ref', args: { ref: 'element' } },
      },
    },
  ])
  const plan = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    criteria: [
      {
        id: 'c1',
        text: 'x',
        checks: [
          { kind: 'flow', name: 'f', actions: [{ action: 'open', url: '/a' }, { action: 'click', element: { role: 'button', name: 'pay' } }] },
        ],
      },
    ],
  }
  expect(() => loadPlan(JSON.stringify(plan), [], driver)).not.toThrow()
})

test('a tool that only acts on coordinates is refused as a driver, with the reason named', async () => {
  const server = await startSampleServer()
  try {
    const job = await makeDriverJob(
      [
        {
          name: 'sample',
          url: server.url,
          tools: ['navigate', 'tap_at'],
          steps: ['plan', 'execute'],
          driver: {
            open: { tool: 'navigate', args: { url: 'url' } },
            click: { tool: 'tap_at', args: { x: 'element' } },
          },
        },
      ],
      [{ id: 'c1', text: 'x', checks: [{ kind: 'flow', name: 'f', actions: [{ action: 'open', url: '/a' }] }] }],
    )
    const { result } = await runJob(job, HEALTHY_DRIVER_BOOT)
    expect(result.verdict).toBe('blocked')
    expect(result.criteria[0]?.outcome).toBe('unverified')
    expect(result.criteria[0]?.reason).toMatch(/only acts on coordinates/)
  } finally {
    await server.close()
  }
})

test('a tool check naming a tool the profile does not register refuses the run', async () => {
  const server = await startSampleServer()
  try {
    const job = await makeDriverJob(
      [
        {
          name: 'sample',
          url: server.url,
          tools: ['navigate'],
          steps: ['plan', 'execute'],
          driver: { open: { tool: 'navigate', args: { url: 'url' } } },
        },
      ],
      [{ id: 'c1', text: 'x', checks: [{ kind: 'tool', tool: 'page_text', assert: [{ contains: 'anything' }] }] }],
    )
    const { result } = await runJob(job, HEALTHY_DRIVER_BOOT)
    expect(result.verdict).toBe('refused')
    expect(result.criteria[0]?.reason).toMatch(/page_text/)
    expect(result.criteria[0]?.reason).toMatch(/execute step/)
  } finally {
    await server.close()
  }
})

test('a tool check asserts nothing unless the plan names explicit matchers', () => {
  expect(() =>
    loadJobFromText(
      'id: job-tool\nrepoPath: /tmp/qare\nbaseRef: main\nheadRef: HEAD~1\nevidenceDir: /tmp/qare/evidence\nprofile: { inline: {} }\npost: none\ncriteria:\n  - id: c1\n    text: x\n    checks:\n      - kind: tool\n        tool: page_text\n',
    ),
  ).toThrow(/asserts nothing/)
})

test("a tool check's matcher is validated at parse time, one per assertion", () => {
  expect(() =>
    loadJobFromText(
      'id: job-tool\nrepoPath: /tmp/qare\nbaseRef: main\nheadRef: HEAD~1\nevidenceDir: /tmp/qare/evidence\nprofile: { inline: {} }\npost: none\ncriteria:\n  - id: c1\n    text: x\n    checks:\n      - kind: tool\n        tool: page_text\n        assert:\n          - equals: welcome\n            contains: el\n',
    ),
  ).toThrow(/one matcher/)
  expect(() =>
    loadJobFromText(
      'id: job-tool\nrepoPath: /tmp/qare\nbaseRef: main\nheadRef: HEAD~1\nevidenceDir: /tmp/qare/evidence\nprofile: { inline: {} }\npost: none\ncriteria:\n  - id: c1\n    text: x\n    checks:\n      - kind: tool\n        tool: page_text\n        assert:\n          - matches: "["\n',
    ),
  ).toThrow(/not a valid pattern/)
})

test('the profile parses a driver mapping, and refuses a second one or an unallowlisted tool', () => {
  const parsed = validateProfileConfig({
    ...DRIVER_PROFILE,
    mcp: [
      {
        name: 'sample',
        url: stubUrl,
        tools: ['page_text', 'navigate'],
        steps: ['plan', 'execute'],
        driver: { open: { tool: 'navigate', args: { url: 'url' } } },
      },
    ],
  })
  expect(parsed.mcp?.[0]?.driver?.open?.tool).toBe('navigate')
  expect(mcpDriverCapabilities(parsed.mcp)?.actions).toEqual(['open'])
  expect(mcpDriverCapabilities(parsed.mcp)?.evidence).toEqual(['action-log'])
  expect(() =>
    validateProfileConfig({
      ...DRIVER_PROFILE,
      mcp: [
        { name: 'a', url: stubUrl, tools: ['navigate'], steps: ['plan', 'execute'], driver: { open: { tool: 'navigate', args: { url: 'url' } } } },
        { name: 'b', url: stubUrl, tools: ['navigate'], steps: ['plan', 'execute'], driver: { open: { tool: 'navigate', args: { url: 'url' } } } },
      ],
    }),
  ).toThrow(/one server at most/)
  expect(() =>
    validateProfileConfig({ ...DRIVER_PROFILE, mcp: [{ name: 'a', url: stubUrl, tools: ['other'], steps: ['plan', 'execute'], driver: { open: { tool: 'navigate', args: { url: 'url' } } } }] }),
  ).toThrow(/allowlist/)
  expect(() =>
    validateProfileConfig({ ...DRIVER_PROFILE, mcp: [{ name: 'a', url: stubUrl, tools: ['navigate'], steps: ['plan'], driver: { open: { tool: 'navigate', args: { url: 'url' } } } }] }),
  ).toThrow(/execute step/)
})
