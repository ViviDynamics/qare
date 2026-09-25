import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { JobCriterion, QaProfile } from '@qare/core'
import { VERSION } from '@qare/core'
import { createMcpServer } from '../src/server.js'
import type { McpServer } from '../src/server.js'

const HEALTH_URL = ['http:', '//localhost:3000/up'].join('')

const INLINE_PROFILE: QaProfile = {
  app: {
    boot: { compose: 'compose.qa.yaml', service: 'admin' },
    health: { http: HEALTH_URL, timeout: '120s' },
    seed: { command: 'bin/rails db:seed:qa' },
    login: { fixture: 'fixtures/users.yml', role: 'admin' },
  },
  stubs: [],
  visual: { widths: [1440], themes: ['light'] },
  suites: [{ name: 'static', command: 'echo ok', kind: 'flow' }],
}

const BOOT = {
  runCompose: async () => ({ code: 0, stdout: 'up out', stderr: 'up err' }),
  probe: async () => ({ ok: true }),
  pollIntervalMs: 1,
}

class FakeClient {
  readonly lines: string[] = []
  readonly server: McpServer

  constructor(boot: unknown = BOOT) {
    this.server = createMcpServer({
      boot: boot as Parameters<typeof createMcpServer>[0]['boot'],
      stdout: (chunk) => this.lines.push(chunk),
    })
  }

  async send(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    const before = this.lines.length
    await this.server.handleLine(`${JSON.stringify(message)}\n`)
    const written = this.lines.slice(before).join('')
    if (written === '') return {}
    return JSON.parse(written) as Record<string, unknown>
  }
}

function commandCriteria(...runs: string[]): JobCriterion[] {
  return runs.map((run, index) => ({
    id: `criterion-${index + 1}`,
    text: `criterion ${index + 1}`,
    checks: [{ kind: 'command', run }],
  }))
}

test('the MCP surface round-trips a full job through submit, result, and evidence', async () => {
  const repoPath = await mkdtemp(join(tmpdir(), 'qare-mcp-'))
  const client = new FakeClient()
  try {
    await client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    expect(JSON.parse(client.lines[0])).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'qare-mcp', version: VERSION },
      },
    })

    await client.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const toolNames = JSON.parse(client.lines[1]).result.tools.map(
      (tool: { name: string }) => tool.name,
    )
    expect(toolNames).toEqual(['check', 'submit_job', 'get_result', 'get_evidence'])

    const evidenceDir = join(repoPath, 'evidence')
    const job = {
      id: 'job-mcp-smoke',
      repoPath,
      baseRef: 'main',
      headRef: 'HEAD~1',
      profile: { inline: INLINE_PROFILE },
      criteria: commandCriteria('echo ok', 'echo ok'),
      evidenceDir,
      post: 'none',
    }
    const submitted = await client.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'submit_job', arguments: { job } },
    })
    expect(submitted.error).toBeUndefined()
    const runResult = JSON.parse(
      (submitted.result as { content: Array<{ text: string }> }).content[0].text,
    )
    expect(runResult).toMatchObject({
      schemaVersion: '1',
      verdict: 'passed',
      job: { id: 'job-mcp-smoke' },
      criteria: [
        { id: 'criterion-1', outcome: 'proven' },
        { id: 'criterion-2', outcome: 'proven' },
      ],
    })

    const loaded = await client.send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'get_result', arguments: { evidenceDir } },
    })
    const persisted = JSON.parse(
      (loaded.result as { content: Array<{ text: string }> }).content[0].text,
    )
    expect(persisted).toEqual(runResult)

    const evidence = await client.send({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'get_evidence', arguments: { evidenceDir } },
    })
    const files = JSON.parse(
      (evidence.result as { content: Array<{ text: string }> }).content[0].text,
    ).files as string[]
    expect(files).toContain('result.json')
    expect(files.some((file) => file.startsWith('checks/criterion-1/0/'))).toBe(true)
    expect(files).toEqual([...files].sort())
  } finally {
    await rm(repoPath, { recursive: true })
  }
})

test('the server fails closed with named errors and no QA behavior', async () => {
  const client = new FakeClient()
  await client.send({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'get_result', arguments: { evidenceDir: '/nonexistent-qare' } },
  })
  const missing = JSON.parse(client.lines[0])
  expect(missing.error).toBeUndefined()
  expect(missing.result.isError).toBe(true)
  expect(missing.result.content[0].text).toContain('ENOENT')

  await client.send({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'nonsense_tool', arguments: {} },
  })
  expect(JSON.parse(client.lines[1]).error).toMatchObject({ code: -32602 })

  await client.send({ jsonrpc: '2.0', id: 8, method: 'resources/list' })
  expect(JSON.parse(client.lines[2]).error).toMatchObject({ code: -32601 })

  await client.send({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'submit_job', arguments: { job: { id: '' } } } })
  expect(JSON.parse(client.lines[3]).result.content[0].text).toContain(
    'id: id must be a non-empty string',
  )

  expect(client.lines).toHaveLength(4)
})

test('notifications are never answered and parse errors answer with -32700', async () => {
  const client = new FakeClient()
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  await client.send({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })
  await client.send({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'get_evidence', arguments: {} } })
  expect(client.lines).toHaveLength(0)
  await client.server.handleLine('not json at all')
  expect(JSON.parse(client.lines[0])).toMatchObject({ id: null, error: { code: -32700 } })
  await client.server.handleLine('42')
  expect(JSON.parse(client.lines[1])).toMatchObject({ id: null, error: { code: -32600 } })
  expect(client.lines).toHaveLength(2)
})

test('check takes criteria in plain words and returns the judged result it wrote, with the evidence directory (#123)', async () => {
  const { mkdir, readFile, writeFile } = await import('node:fs/promises')
  const { FakeAgentRunner } = await import('@qare/core')
  const repo = await mkdtemp(join(tmpdir(), 'qare-mcp-check-'))
  const target = ['https:', '//wiki.example.test'].join('')
  await mkdir(join(repo, '.qa'))
  await writeFile(join(repo, '.qa', 'QA.md'), '# QA\n')
  await writeFile(join(repo, '.qa', 'config.yml'), `target:\n  url: ${target}\n  health: { http: /health, timeout: 1s }\n`)
  const completed = (output: unknown) => ({
    status: 'completed' as const,
    stopReason: 'end_turn' as const,
    usage: { inputTokens: 1, outputTokens: 1 },
    output: JSON.stringify(output),
  })
  const plan = {
    schemaVersion: '1',
    criteria: [{ id: 'check-1', text: 'the article opens', checks: [{ kind: 'command', name: 'ok', command: 'node --version' }] }],
  }
  const planner = new FakeAgentRunner([completed(plan)])
  const verifier = new FakeAgentRunner([completed({ findings: [] })])
  const lines: string[] = []
  const server = createMcpServer({
    boot: BOOT,
    stdout: (chunk) => lines.push(chunk),
    runners: () => ({ planner, verifier: () => verifier }),
  })

  await server.handleLine(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check', arguments: { criteria: ['the article opens'], repoPath: repo, evidenceDir: 'evidence' } } }),
  )

  const response = JSON.parse(lines.join('')) as { result: { content: Array<{ text: string }> } }
  const output = JSON.parse(response.result.content[0]!.text) as { evidenceDir: string; result: unknown; notes: string[] }
  expect(output.notes).toEqual([])
  expect(output.evidenceDir).toBe(join(repo, 'evidence'))
  expect(output.result).toEqual(JSON.parse(await readFile(join(repo, 'evidence', 'judged-result.json'), 'utf8')))
  expect(output.result).toMatchObject({ verdict: 'passed', target: { url: target, comparison: 'none' } })
  expect(planner.requests[0]?.prompt).toContain('the article opens')
  await rm(repo, { recursive: true, force: true })
})

test('check refuses arguments it cannot read, naming the field', async () => {
  const client = new FakeClient()
  for (const [args, field] of [
    [{}, 'criteria'],
    [{ criteria: 'one sentence' }, 'criteria'],
    [{ criteria: [] }, 'criteria'],
    [{ criteria: ['  '] }, 'criteria'],
    [{ criteria: ['x'], runner: 'model' }, 'runner'],
  ] as const) {
    const response = await client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'check', arguments: args } })
    expect((response.error as { code: number; message: string }).code).toBe(-32602)
    expect((response.error as { message: string }).message).toContain(field)
  }
})

test('tools/list offers check alongside the job tools', async () => {
  const client = new FakeClient()
  const response = await client.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
  expect((response.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toContain('check')
})
