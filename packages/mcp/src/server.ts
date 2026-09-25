import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  VERSION,
  checkCriteria,
  defaultCheckEvidenceDir,
  nareCheckRunners,
  loadResult,
  parseJob,
  runJob,
} from '@qare/core'
import type { AgentRunner, BootOpts } from '@qare/core'

const PROTOCOL_VERSION = '2024-11-05'

const TOOLS = [
  {
    name: 'check',
    description:
      'Check criteria stated in plain words: qare plans each one through nare, runs it and judges it, with no issue, diff or ledger. ' +
      'Returns the judged result (the same judged-result.json qare check writes), the evidence directory, and notes on anything the plan could not run.',
    inputSchema: {
      type: 'object',
      properties: {
        criteria: { type: 'array', items: { type: 'string' }, description: 'each criterion in a sentence' },
        profile: { type: 'string', description: 'the .qa/ profile directory (default: .qa under repoPath)' },
        repoPath: { type: 'string', description: 'where command checks run (default: the server working directory)' },
        evidenceDir: { type: 'string', description: 'where evidence is written (default: qare-evidence/check-<time> under repoPath)' },
        runner: { type: 'string', enum: ['nare', 'none'], description: 'none judges from the evidence alone, without the verifier' },
      },
      required: ['criteria'],
    },
  },
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
  /** The model behind check (nare by default); a verifier is confined to the directory it is handed. */
  runners?: () => { planner: AgentRunner; verifier: (evidenceDir: string) => AgentRunner }
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value === '') throw new McpProtocolError(-32602, `${key} must be a non-empty string`)
  return value
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
  if (name === 'check') {
    if (
      !Array.isArray(record.criteria) ||
      record.criteria.length === 0 ||
      !record.criteria.every((entry) => typeof entry === 'string' && entry.trim() !== '')
    )
      throw new McpProtocolError(-32602, 'criteria must be a non-empty array of sentences, one criterion each')
    const runner = optionalString(record, 'runner') ?? 'nare'
    if (runner !== 'nare' && runner !== 'none') throw new McpProtocolError(-32602, 'runner must be "nare" or "none"')
    const repoPath = resolve(optionalString(record, 'repoPath') ?? '.')
    const named = optionalString(record, 'evidenceDir')
    const evidenceDir = named === undefined ? defaultCheckEvidenceDir(repoPath) : resolve(repoPath, named)
    const runners = deps.runners?.() ?? nareCheckRunners()
    const { judged, notes } = await checkCriteria({
      criteria: record.criteria as string[],
      profileDir: resolve(repoPath, optionalString(record, 'profile') ?? '.qa'),
      repoPath,
      evidenceDir,
      planner: runners.planner,
      verifier: runner === 'none' ? 'none' : runners.verifier,
      run: deps.boot ?? {},
    })
    // Notes say what the plan could not run; dropping them here would hide it.
    return { evidenceDir, result: judged, notes }
  }
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

export function createMcpServer(deps: McpServerDeps): McpServer {
  async function handleLine(line: string): Promise<void> {
    if (line.trim() === '') return
    let message: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (!isRecord(parsed)) {
        respond(deps, null, undefined, { code: -32600, message: 'invalid request: not a JSON-RPC request object' })
        return
      }
      message = parsed
    } catch {
      respond(deps, null, undefined, { code: -32700, message: 'parse error: request is not valid JSON' })
      return
    }
    if (!('id' in message)) {
      // JSON-RPC 2.0: notifications are one-way and MUST NOT be answered.
      return
    }
    const id = message.id
    try {
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
      throw new McpProtocolError(-32601, `unknown method ${JSON.stringify(String(method))}`)
    } catch (error) {
      if (error instanceof McpProtocolError) {
        respond(deps, id, undefined, { code: error.code, message: error.message })
        return
      }
      const text = (error instanceof Error ? error : new Error(String(error))).message
      respond(deps, id, { content: [{ type: 'text', text }], isError: true })
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
