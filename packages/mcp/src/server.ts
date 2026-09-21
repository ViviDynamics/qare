import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  JobValidationError,
  ResultValidationError,
  VERSION,
  loadResult,
  parseJob,
  runJob,
} from '@qare/core'
import type { BootOpts } from '@qare/core'

const PROTOCOL_VERSION = '2024-11-05'

const TOOLS = [
  {
    name: 'submit_job',
    description: 'Run a qare job and return its result document.',
    inputSchema: {
      type: 'object',
      properties: { job: { type: 'object', description: 'qare job document' } },
      required: ['job'],
    },
  },
  {
    name: 'get_result',
    description: 'Load and validate the result.json from an evidence directory.',
    inputSchema: {
      type: 'object',
      properties: { evidenceDir: { type: 'string' } },
      required: ['evidenceDir'],
    },
  },
  {
    name: 'get_evidence',
    description: 'List the evidence files under an evidence directory.',
    inputSchema: {
      type: 'object',
      properties: { evidenceDir: { type: 'string' } },
      required: ['evidenceDir'],
    },
  },
]

export interface McpServerDeps {
  boot?: BootOpts
  stdout: (chunk: string) => void
}

export interface McpServer {
  handleLine: (line: string) => Promise<void>
}

class McpProtocolError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toolOutput(value: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

async function listEvidenceFiles(dir: string, prefix: string): Promise<string[]> {
  const names = (await readdir(dir)).sort()
  const files: string[] = []
  for (const name of names) {
    const path = join(dir, name)
    const rel = prefix ? `${prefix}/${name}` : name
    const info = await stat(path)
    if (info.isDirectory()) files.push(...(await listEvidenceFiles(path, rel)))
    else files.push(rel)
  }
  return files.sort()
}

async function dispatchTool(
  deps: McpServerDeps,
  name: unknown,
  args: unknown,
): Promise<unknown> {
  const record = isRecord(args) ? args : {}
  if (name === 'submit_job') {
    const job = parseJob(record.job)
    const { result } = await runJob(job, deps.boot ?? {})
    return result
  }
  if (name === 'get_result') {
    if (typeof record.evidenceDir !== 'string' || record.evidenceDir === '')
      throw new McpProtocolError(-32602, 'evidenceDir must be a non-empty string')
    return loadResult(await readFile(join(record.evidenceDir, 'result.json'), 'utf8'))
  }
  if (name === 'get_evidence') {
    if (typeof record.evidenceDir !== 'string' || record.evidenceDir === '')
      throw new McpProtocolError(-32602, 'evidenceDir must be a non-empty string')
    return { files: await listEvidenceFiles(record.evidenceDir, '') }
  }
  throw new McpProtocolError(-32602, `unknown tool ${JSON.stringify(String(name))}`)
}

function protocolError(error: unknown): McpProtocolError {
  if (error instanceof McpProtocolError) return error
  if (error instanceof JobValidationError || error instanceof ResultValidationError)
    return new McpProtocolError(-32602, error.message)
  return new McpProtocolError(
    -32000,
    `qare mcp: ${(error instanceof Error ? error : new Error(String(error))).message}`,
  )
}

export function createMcpServer(deps: McpServerDeps): McpServer {
  async function handleLine(line: string): Promise<void> {
    if (line.trim() === '') return
    let id: unknown = null
    try {
      const message = JSON.parse(line)
      if (!isRecord(message)) throw new McpProtocolError(-32600, 'request must be a JSON object')
      id = message.id ?? null
      const method = message.method
      if (method === 'initialize') {
        respond(deps, id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'qare-mcp', version: VERSION },
        })
        return
      }
      if (method === 'tools/list') {
        respond(deps, id, { tools: TOOLS })
        return
      }
      if (method === 'tools/call') {
        const params = isRecord(message.params) ? message.params : {}
        const output = await dispatchTool(deps, params.name, params.arguments)
        respond(deps, id, toolOutput(output))
        return
      }
      if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
        if ('id' in message) throw new McpProtocolError(-32601, `unknown method ${JSON.stringify(method)}`)
        return
      }
      throw new McpProtocolError(-32601, `unknown method ${JSON.stringify(String(method))}`)
    } catch (error) {
      const { code, message } = protocolError(error)
      respond(deps, id, undefined, { code, message })
    }
  }
  return { handleLine }
}

function respond(
  deps: McpServerDeps,
  id: unknown,
  result?: unknown,
  error?: { code: number; message: string },
): void {
  const payload: Record<string, unknown> = { jsonrpc: '2.0', id }
  if (error) payload.error = error
  else payload.result = result
  deps.stdout(`${JSON.stringify(payload)}\n`)
}
