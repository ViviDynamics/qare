import { spawn } from 'node:child_process'
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import type { ProfileMcpServer, McpStep } from './profile.js'

/**
 * The host's registered MCP servers (#93). A profile registers them with how
 * to start or reach each one and which of its tools are allowed; the plan
 * step's model session reaches the allowed tools the way it reaches every
 * other model tool: over a channel that carries tool calls and their results,
 * and nothing else. This module is the client side of MCP (the server side is
 * the host's) and the tool server the model session connects to.
 */

export interface McpTool {
  name: string
  description?: string
}

/**
 * One call the harness served, published with the run's evidence (#93): the
 * server, the tool, the arguments that crossed and what came back, so the
 * planner's look through a host tool is recorded like any other model tool
 * call. An unreachable server is recorded with no tool, naming the reason.
 */
export interface McpCallRecord {
  server: string
  tool?: string
  arguments?: unknown
  result?: string
  error?: string
}

export type McpRecorder = (record: McpCallRecord) => void

export class McpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpError'
  }
}

/**
 * A registered server that could not be started or reached (#93). It is
 * reported, never silently skipped: the caller records the reason and the run
 * continues with the servers that did answer.
 */
export class McpUnreachable extends McpError {
  readonly server: string

  constructor(server: string, reason: string) {
    super(`host mcp server ${JSON.stringify(server)} is unreachable: ${reason}`)
    this.name = 'McpUnreachable'
    this.server = server
  }
}

export interface McpSource {
  /** The server's registered name. */
  name: string
  /** The server's published tools, narrowed to the profile's allowlist. */
  tools: readonly McpTool[]
  /** Call one tool with the given arguments, and record the round trip. */
  call(tool: string, args: unknown): Promise<string>
  /** Stop the server (or the connection to it) and release what it holds. */
  close(): Promise<void>
}

export interface ConnectOptions {
  /** Written for every call and every connection failure, when given. */
  record?: McpRecorder
  /** How long the MCP handshake may take before the server is unreachable. */
  handshakeTimeoutMs?: number
  /** How long one tool call may run. Host tools can be slow, so this is long. */
  callTimeoutMs?: number
}

const HANDSHAKE_TIMEOUT_MS = 10_000
const CALL_TIMEOUT_MS = 120_000

/**
 * The command the profile starts the server with, split the way command
 * checks are: on whitespace, with no shell, each token one argument.
 */
export function splitMcpCommand(command: string): string[] {
  return command.split(/\s+/).filter((token) => token !== '')
}

interface JsonRpcPayload {
  jsonrpc: '2.0'
  id?: number
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | null
  result?: unknown
  error?: { code: number; message: string }
}

/**
 * Connect to one registered server: start it (a command) or reach it (a URL),
 * speak the MCP handshake, and list its tools narrowed to the profile's
 * allowlist. A server that cannot be started or reached raises
 * `McpUnreachable`, carrying the reason — the caller reports it and goes on.
 */
export async function connectMcpServer(spec: ProfileMcpServer, options: ConnectOptions = {}): Promise<McpSource> {
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS
  const callTimeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS
  const wire = spec.command !== undefined ? stdioWire(spec) : httpWire(spec)
  let listed: unknown
  try {
    await wire.request(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'qare', version: '1' },
        },
      },
      handshakeTimeoutMs,
    )
    await wire.notify({ jsonrpc: '2.0', method: 'notifications/initialized' })
    listed = await wire.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, handshakeTimeoutMs)
  } catch (error) {
    await wire.close().catch(() => {})
    const reason = error instanceof Error ? error.message : String(error)
    options.record?.({ server: spec.name, error: `unreachable: ${reason}` })
    throw new McpUnreachable(spec.name, reason)
  }
  return {
    name: spec.name,
    tools: mcpTools(listed, spec),
    call: (tool, args) => callMcpTool(wire, spec.name, tool, args, callTimeoutMs, options.record),
    close: () => wire.close(),
  }
}

/** The tools a tools/list answer published, narrowed to the profile's allowlist. */
function mcpTools(answer: unknown, spec: ProfileMcpServer): McpTool[] {
  const allowed = new Set(spec.tools)
  if (answer === null || typeof answer !== 'object') return []
  const tools = (answer as { tools?: unknown }).tools
  if (!Array.isArray(tools)) return []
  return tools.flatMap((tool) => {
    if (tool === null || typeof tool !== 'object') return []
    const name = (tool as { name?: unknown }).name
    if (typeof name !== 'string' || !allowed.has(name)) return []
    const description = (tool as { description?: unknown }).description
    return [{ name, ...(typeof description === 'string' ? { description } : {}) }]
  })
}

async function callMcpTool(
  wire: McpWire,
  server: string,
  tool: string,
  args: unknown,
  callTimeoutMs: number,
  record: McpRecorder | undefined,
): Promise<string> {
  try {
    const answer = await wire.request(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: tool, ...(args === undefined ? {} : { arguments: args }) },
      },
      callTimeoutMs,
    )
    const text = mcpResultText(answer)
    if (Buffer.byteLength(text) > MAX_RESULT_BYTES) {
      record?.({ server, tool, arguments: args, error: 'the result is past the 4 MiB cap' })
      throw new McpError(`tool ${JSON.stringify(tool)} returned a result past the 4 MiB cap`)
    }
    record?.({ server, tool, arguments: args, result: text })
    return text
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    record?.({ server, tool, arguments: args, error: message })
    throw new McpError(`host mcp server ${JSON.stringify(server)} failed tool ${JSON.stringify(tool)}: ${message}`)
  }
}

/**
 * A tools/call answer carries content pieces; the session reads text. A call
 * the server marks as errored is an ordinary error result, never a crash.
 */
function mcpResultText(answer: unknown): string {
  if (answer === null || typeof answer !== 'object') return JSON.stringify(answer) ?? ''
  const shaped = answer as { isError?: unknown; content?: unknown }
  if (shaped.isError === true) {
    const message = Array.isArray(shaped.content)
      ? shaped.content
          .flatMap((piece) =>
            piece !== null && typeof piece === 'object' && (piece as { text?: unknown }).text !== undefined
              ? [String((piece as { text: unknown }).text)]
              : [],
          )
          .join('\n')
      : undefined
    throw new McpError(message === undefined ? 'the tool reported an error with no text' : message)
  }
  if (!Array.isArray(shaped.content)) return JSON.stringify(answer) ?? ''
  const text = shaped.content
    .flatMap((piece) =>
      piece !== null && typeof piece === 'object' && (piece as { type?: unknown }).type === 'text' &&
      typeof (piece as { text?: unknown }).text === 'string'
        ? [(piece as { text: string }).text]
        : [],
    )
    .join('\n')
  return text === '' ? JSON.stringify(answer) ?? '' : text
}

interface McpWire {
  request(payload: JsonRpcPayload, timeoutMs: number): Promise<unknown>
  notify(payload: JsonRpcPayload): Promise<void>
  close(): Promise<void>
}

/** One JSON-RPC round trip over the server's stdio, one JSON per line. */
function stdioWire(spec: ProfileMcpServer): McpWire {
  const command = splitMcpCommand(spec.command!)
  const executable = command[0]
  let child: ReturnType<typeof spawn> | undefined
  let stdin: NodeJS.WritableStream | undefined
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  let buffer = ''
  return {
    request(payload, timeoutMs) {
      return new Promise((resolve, reject) => {
        const id = payload.id
        if (typeof id !== 'number') {
          reject(new McpError('a request without an id cannot be answered'))
          return
        }
        started()
          .then((stream) => {
            const timer = setTimeout(() => {
              const entry = pending.get(id)
              if (entry !== undefined) {
                pending.delete(id)
                reject(new McpError(`no answer within ${Math.round(timeoutMs / 1000)}s`))
              }
            }, timeoutMs)
            pending.set(id, {
              resolve: (value) => {
                clearTimeout(timer)
                resolve(value)
              },
              reject: (error) => {
                clearTimeout(timer)
                reject(error)
              },
            })
            stream.write(`${JSON.stringify(payload)}\n`)
          })
          .catch((error: Error) => reject(error))
      })
    },
    async notify(payload) {
      const stream = await started()
      stream.write(`${JSON.stringify(payload)}\n`)
    },
    close: () => closeChild(child),
  }
  function started(): Promise<NodeJS.WritableStream> {
    if (stdin) return Promise.resolve(stdin)
    return new Promise((resolve, reject) => {
      if (executable === undefined) {
        reject(new McpError('the command names no executable'))
        return
      }
      const spawned = spawn(executable, command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })
      child = spawned
      stdin = spawned.stdin!
      spawned.on('error', (error) => {
        reject(new McpError(`could not start the server (${executable}): ${error.message}`))
        failAll(`the server could not start: ${error.message}`)
      })
      spawned.on('close', (code) => {
        failAll(`the server closed with exit code ${code ?? 'none'} before answering`)
      })
      spawned.stdout!.on('data', (chunk) => {
        buffer += String(chunk)
        for (;;) {
          const at = buffer.indexOf('\n')
          if (at === -1) break
          const line = buffer.slice(0, at)
          buffer = buffer.slice(at + 1)
          if (line.trim() === '') continue
          let parsed: JsonRpcResponse
          try {
            parsed = JSON.parse(line)
          } catch {
            continue
          }
          if (typeof parsed.id === 'number' && pending.has(parsed.id)) {
            const entry = pending.get(parsed.id)!
            pending.delete(parsed.id)
            if (parsed.error !== undefined)
              entry.reject(new McpError(parsed.error.message || 'the server refused the request'))
            else entry.resolve(parsed.result)
          }
        }
      })
      // The process exists and its pipes are live: a handshake written before
      // the server reads buffers, and a child that dies answers nothing, which
      // the close handler and the timeout both name.
      resolve(stdin)
    })
  }
  function failAll(reason: string): void {
    for (const [id, entry] of [...pending]) {
      entry.reject(new McpError(`${reason} (request ${id})`))
      pending.delete(id)
    }
  }
}

/** One JSON-RPC request answered over the server's HTTP endpoint. */
function httpWire(spec: ProfileMcpServer): McpWire {
  const target = new URL(spec.url!)
  return {
    request(payload, timeoutMs) {
      return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload)
        const timer = setTimeout(() => {
          outgoing.destroy()
          reject(new McpError(`no answer within ${Math.round(timeoutMs / 1000)}s`))
        }, timeoutMs)
        const outgoing = request(
          {
            hostname: target.hostname,
            ...(target.port === '' ? {} : { port: Number(target.port) }),
            path: target.pathname,
            method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
          },
          (incoming) => {
            let raw = ''
            incoming.on('data', (chunk) => (raw += String(chunk)))
            incoming.on('error', (error) => {
              clearTimeout(timer)
              reject(new McpError(error.message))
            })
            incoming.on('end', () => {
              clearTimeout(timer)
              if (incoming.statusCode !== 200) {
                reject(new McpError(`the server answered ${incoming.statusCode}`))
                return
              }
              let parsed: JsonRpcResponse
              try {
                parsed = JSON.parse(raw)
              } catch {
                reject(new McpError('the server answered with something that is not a JSON-RPC response'))
                return
              }
              if (parsed.error !== undefined) {
                reject(new McpError(parsed.error.message || 'the server refused the request'))
                return
              }
              resolve(parsed.result)
            })
          },
        )
        outgoing.on('error', (error) => {
          clearTimeout(timer)
          reject(new McpError(error.message))
        })
        outgoing.end(body)
      })
    },
    async notify() {},
    close: async () => {},
  }
}

function closeChild(child: ReturnType<typeof spawn> | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (child === undefined || child.exitCode !== null) {
      resolve()
      return
    }
    child.once('close', () => resolve())
    child.kill()
  })
}

/**
 * The name one registered tool answers under on the channel (#93): the
 * server's name and the tool's, so two servers' tools cannot collide.
 */
export function channelToolName(server: string, tool: string): string {
  return `${server}.${tool}`
}

export interface McpToolServer {
  /** The port the server answers on. */
  port: number
  /** The URL the model session connects to. */
  url: string
  /** The namespaced tools this server serves, across every source. */
  tools: readonly string[]
  /** Stop answering and release the port. */
  close(): Promise<void>
}

// Tool arguments are bounded like the exploration channel's bodies: the
// channel carries a call, and a payload past the cap is refused rather than
// buffered whole inside the process serving it.
const MAX_BODY_BYTES = 64 * 1024

// A result past the cap is refused before the process serving the channel
// buffers it whole: the session reads text, and no look through a host tool
// needs four mebibytes of it.
const MAX_RESULT_BYTES = 4 * 1024 * 1024

/**
 * Call one channel tool the way the model session does (#93): a POST of the
 * JSON arguments, answered with the tool's result. This is the client seam of
 * the channel, so callers — and the tests — exercise it through its real path
 * rather than by opening sockets of their own.
 */
export function callChannelTool(server: McpToolServer, name: string, args?: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(args ?? {})
    const target = new URL(`${server.url}/${name}`)
    const outgoing = request(
      {
        hostname: target.hostname,
        ...(target.port === '' ? {} : { port: Number(target.port) }),
        path: target.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (incoming) => {
        let raw = ''
        incoming.on('data', (chunk) => (raw += String(chunk)))
        incoming.on('error', (error) => reject(new McpError(error.message)))
        incoming.on('end', () => {
          if (incoming.statusCode !== 200) {
            let message = raw
            try {
              message = String(JSON.parse(raw).error ?? raw)
            } catch {}
            reject(new McpError(message))
            return
          }
          try {
            resolve(JSON.parse(raw))
          } catch {
            reject(new McpError('the tool channel answered with something that is not the tool result'))
          }
        })
      },
    )
    outgoing.on('error', (error) => reject(new McpError(error.message)))
    outgoing.end(body)
  })
}

/**
 * Serve the registered servers' tools to the model session (#93): one HTTP
 * server answering `POST /<server>.<tool>` with the tool's result, the way
 * the exploration channel serves its own tools (#87). The servers are the
 * host's, so this side runs where they run, and the only traffic that
 * crosses is a tool call and its result.
 */
export function startMcpToolServer(
  sources: readonly McpSource[],
  options: { host?: string; port?: number; advertise?: string } = {},
): Promise<McpToolServer> {
  const { host = '127.0.0.1', port = 0 } = options
  const routed = new Map<string, { source: McpSource; tool: string }>()
  for (const source of sources)
    for (const tool of source.tools) routed.set(channelToolName(source.name, tool.name), { source, tool: tool.name })
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      response.on('error', () => {})
      handle(request, response, routed).catch((error) => {
        refuse(response, 500, error instanceof Error ? error.message : String(error))
      })
    })
    server.on('error', reject)
    server.listen(port, host, () => {
      const address = server.address()
      const bound = typeof address === 'object' && address !== null ? address.port : undefined
      if (bound === undefined) {
        server.close()
        reject(new McpError('the OS reported no port for the tool server'))
        return
      }
      resolve({
        port: bound,
        url: options.advertise ?? `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${bound}`,
        tools: [...routed.keys()],
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => (error === undefined ? closeResolve() : closeReject(error)))
          }),
      })
    })
  })
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  routed: Map<string, { source: McpSource; tool: string }>,
): Promise<void> {
  const url = (request.url ?? '/').split('?')[0] ?? '/'
  if (request.method !== 'POST') {
    refuse(response, 404, `the tool channel serves the registered tools over POST, and ${url} is not one of them`)
    return
  }
  const route = routed.get(url.slice(1))
  if (route === undefined) {
    refuse(response, 404, `the channel serves ${[...routed.keys()].join(', ') || 'nothing'}; ${url} registers no tool`)
    return
  }
  const { body, over } = await readBody(request)
  if (over) {
    refuse(response, 413, 'the tool call carried a body past the 64 KiB cap')
    return
  }
  let args: unknown
  try {
    args = body.trim() === '' ? undefined : JSON.parse(body)
  } catch {
    refuse(response, 400, 'the tool call arguments are not JSON')
    return
  }
  reply(response, await route.source.call(route.tool, args))
}

function readBody(request: IncomingMessage): Promise<{ body: string; over: boolean }> {
  return new Promise((resolve) => {
    let body = ''
    let bytes = 0
    let over = false
    request.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        over = true
        return
      }
      body += String(chunk)
    })
    request.on('error', () => {})
    request.on('end', () => resolve({ body, over }))
  })
}

function reply(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function refuse(response: ServerResponse, status: number, message: string): void {
  if (response.writableEnded) return
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ error: message }))
}

/**
 * Start the registered servers a step looks through (#93): every one whose
 * declared steps name the step, connected or reported. Sources come back
 * ready for the channel, failures are returned named, and the caller closes
 * what started. A server that is registered but unreachable is reported, not
 * silently skipped.
 */
export async function startRegisteredMcpSources(
  registered: readonly ProfileMcpServer[],
  step: McpStep,
  options: ConnectOptions = {},
): Promise<{ sources: McpSource[]; failures: { server: string; reason: string }[] }> {
  const sources: McpSource[] = []
  const failures: { server: string; reason: string }[] = []
  for (const spec of registered.filter((server) => server.steps.includes(step))) {
    try {
      sources.push(await connectMcpServer(spec, options))
    } catch (error) {
      failures.push({ server: spec.name, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { sources, failures }
}
