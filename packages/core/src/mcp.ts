import { spawn } from 'node:child_process'
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { redactValue, type RedactionRule } from './redact.js'
import type { FlowDriverCapabilities, FlowPage } from './flow.js'
import type { ToolAssertion } from './plan.js'
import type { ProfileMcpServer, ProfileMcpToolMap, McpStep } from './profile.js'
import type { SnapshotNode } from './snapshot.js'

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
  inputSchema?: unknown
}

/**
 * A tool call the way a tool check judges it (#94): the text content joined,
 * any image content pieces (base64), and the structured content the server
 * answered with, plus whether the server itself marked the call errored.
 */
export interface McpToolResult {
  text: string
  images?: string[]
  structured?: unknown
  isError: boolean
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

/**
 * The records as they are written to mcp-calls.jsonl: one JSON line each,
 * redacted with the profile's rules and the built-in ones first. Tool
 * arguments and results are evidence, and evidence is published, so a secret
 * a tool carried is redacted out before the file is written anywhere (#52).
 */
export function mcpRecordsFile(records: readonly McpCallRecord[], rules: readonly RedactionRule[]): string {
  return `${records.map((record) => JSON.stringify(redactValue(record, rules))).join('\n')}\n`
}

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
  /**
   * Call one tool and return the result the way a tool check judges it
   * (#94): an answer the server marks errored comes back as data, not a
   * thrown error, so the plan's matchers decide what it means.
   */
  callResult(tool: string, args: unknown): Promise<McpToolResult>
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
  const wire = spec.command !== undefined ? stdioWire(spec) : await httpWire(spec)
  let listed: unknown
  try {
    await wire.request(
      {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'qare', version: '1' },
        },
      },
      handshakeTimeoutMs,
    )
    await wire.notify({ jsonrpc: '2.0', method: 'notifications/initialized' }, handshakeTimeoutMs)
    listed = await wire.request({ jsonrpc: '2.0', method: 'tools/list' }, handshakeTimeoutMs)
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
    callResult: (tool, args) => callMcpResult(wire, spec.name, tool, args, callTimeoutMs, options.record),
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
    const inputSchema = (tool as { inputSchema?: unknown }).inputSchema
    return [
      {
        name,
        ...(typeof description === 'string' ? { description } : {}),
        ...(inputSchema !== undefined && inputSchema !== null && typeof inputSchema === 'object' ? { inputSchema } : {}),
      },
    ]
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
        method: 'tools/call',
        params: { name: tool, ...(args === undefined ? {} : { arguments: args }) },
      },
      callTimeoutMs,
    )
    const text = mcpResultText(answer)
    if (Buffer.byteLength(text) > MAX_RESULT_BYTES) {
      // The throw is recorded once, by the catch below: recording here too
      // would write a second entry for the same call (#167 review).
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
 * A tools/call answer the way a tool check judges it (#94): the text and
 * image content pieces, the structured content the server answered with,
 * and whether the server marked the call errored. Unlike `call`, an answer
 * the server marks errored is data here, not a thrown error: the plan's
 * matchers decide what the result means, and the assertion outcomes are the
 * evidence. Transport failures and results past the cap still throw.
 */
async function callMcpResult(
  wire: McpWire,
  server: string,
  tool: string,
  args: unknown,
  callTimeoutMs: number,
  record: McpRecorder | undefined,
): Promise<McpToolResult> {
  let answer: unknown
  try {
    answer = await wire.request(
      {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: tool, ...(args === undefined ? {} : { arguments: args }) },
      },
      callTimeoutMs,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    record?.({ server, tool, arguments: args, error: message })
    throw new McpError(`host mcp server ${JSON.stringify(server)} failed tool ${JSON.stringify(tool)}: ${message}`)
  }
  const shaped = answer === null || typeof answer !== 'object' ? {} : (answer as Record<string, unknown>)
  const pieces = Array.isArray(shaped.content) ? shaped.content : []
  const textPieces: string[] = []
  const images: string[] = []
  for (const piece of pieces) {
    if (piece === null || typeof piece !== 'object') continue
    const one = piece as { type?: unknown; text?: unknown; data?: unknown }
    if (one.type === 'image' && typeof one.data === 'string') images.push(one.data)
    else if (typeof one.text === 'string') textPieces.push(one.text)
  }
  const structured = shaped.structuredContent
  const text = textPieces.join('\n')
  const result: McpToolResult = {
    isError: shaped.isError === true,
    ...(text === '' && images.length === 0 && structured !== undefined ? { text: JSON.stringify(structured) } : { text }),
    ...(images.length > 0 ? { images } : {}),
    ...(structured !== undefined && structured !== null && typeof structured === 'object' ? { structured } : {}),
  }
  if (Buffer.byteLength(result.text) > MAX_RESULT_BYTES) {
    // The throw is recorded once, by the catch below: recording here too
    // would write a second entry for the same call (#167 review).
    throw new McpError(`tool ${JSON.stringify(tool)} returned a result past the 4 MiB cap`)
  }
  record?.({ server, tool, arguments: args, result: result.text })
  return result
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
  notify(payload: JsonRpcPayload, timeoutMs: number): Promise<void>
  close(): Promise<void>
}

/** One JSON-RPC round trip over the server's stdio, one JSON per line. */
function stdioWire(spec: ProfileMcpServer): McpWire {
  const command = splitMcpCommand(spec.command!)
  const executable = command[0]
  let child: ReturnType<typeof spawn> | undefined
  let stdin: NodeJS.WritableStream | undefined
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  let nextId = 1
  let buffer = ''
  return {
    request(payload, timeoutMs) {
      return new Promise((resolve, reject) => {
        // The id is the wire's, not the payload's: concurrent calls to the
        // same server must not overwrite one another's answer.
        const id = nextId++
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
            stream.write(`${JSON.stringify({ ...payload, id })}\n`)
          })
          .catch((error: Error) => reject(error))
      })
    },
    // A notification over stdio has no answer by construction: the line is
    // written and the handshake moves on. The timeout parameter is accepted
    // for the shared wire shape and does not apply here (#167 review).
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
      // The child's stderr is ignored: nothing reads it, and a server that
      // logs enough to fill the pipe would block before answering the
      // handshake and look unreachable (#167 review).
      const spawned = spawn(executable, command.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] })
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
        // A result past the cap is refused before the process buffers it
        // whole: a line this long never terminates into a JSON-RPC answer,
        // so the pending request fails named and the server is killed.
        if (Buffer.byteLength(buffer) > MAX_RESULT_BYTES) {
          buffer = ''
          child?.kill()
          failAll('the server sent a line past the 4 MiB cap')
          return
        }
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
async function httpWire(spec: ProfileMcpServer): Promise<McpWire> {
  const target = new URL(spec.url!)
  // The profile's URL is the server's: https is reached with the TLS client,
  // and a query the profile carries (a token, say) reaches the server.
  const transport = (await import(target.protocol === 'https:' ? 'node:https' : 'node:http')) as typeof import('node:http')
  const path = `${target.pathname}${target.search}`
  let nextId = 1
  return {
    request(payload, timeoutMs) {
      return new Promise((resolve, reject) => {
        const body = JSON.stringify({ ...payload, id: nextId++ })
        let settled = false
        let raw = ''
        const finish = (failure: McpError | undefined, answer?: unknown) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (failure === undefined) resolve(answer)
          else reject(failure)
        }
        const timer = setTimeout(() => {
          outgoing.destroy()
          finish(new McpError(`no answer within ${Math.round(timeoutMs / 1000)}s`))
        }, timeoutMs)
        const outgoing = transport.request(
          {
            hostname: target.hostname,
            ...(target.port === '' ? {} : { port: Number(target.port) }),
            path,
            method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
          },
          (incoming) => {
            let bytes = 0
            incoming.on('data', (chunk) => {
              // The cap holds while the response streams, not after it has
              // been buffered whole: a server that answers huge never gets
              // the chance to exhaust the process.
              bytes += chunk.length
              if (bytes <= MAX_RESULT_BYTES) {
                raw += String(chunk)
                return
              }
              outgoing.destroy()
              finish(new McpError('the result is past the 4 MiB cap'))
            })
            incoming.on('error', (error) => finish(new McpError(error.message)))
            incoming.on('end', () => {
              if (incoming.statusCode !== 200) {
                finish(new McpError(`the server answered ${incoming.statusCode}`))
                return
              }
              let parsed: JsonRpcResponse
              try {
                parsed = JSON.parse(raw)
              } catch {
                finish(new McpError('the server answered with something that is not a JSON-RPC response'))
                return
              }
              if (parsed.error !== undefined) {
                finish(new McpError(parsed.error.message || 'the server refused the request'))
                return
              }
              finish(undefined, parsed.result)
            })
          },
        )
        outgoing.on('error', (error) => finish(new McpError(error.message)))
        outgoing.end(body)
      })
    },
    // A notification has no answer, so it is bounded, not awaited: the POST
    // is written and the handshake moves on, but an endpoint that accepts the
    // POST and never answers cannot hold the run hostage past the handshake
    // timeout (#167 review).
    notify(payload, timeoutMs) {
      return new Promise((resolve) => {
        const body = JSON.stringify(payload)
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(() => {
          outgoing.destroy()
          finish()
        }, timeoutMs)
        const outgoing = transport.request(
          {
            hostname: target.hostname,
            ...(target.port === '' ? {} : { port: Number(target.port) }),
            path,
            method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
          },
          (incoming) => {
            incoming.resume()
            finish()
          },
        )
        outgoing.on('error', () => finish())
        outgoing.end(body)
      })
    },
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
    // The tool's name is encoded, so a name carrying URL syntax (?, #, a
    // space) still addresses its route and nothing else.
    const target = new URL(`${server.url}/${encodeURIComponent(name)}`)
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
export async function startMcpToolServer(
  sources: readonly McpSource[],
  options: { host?: string; port?: number; advertise?: string } = {},
): Promise<McpToolServer> {
  const { host = '127.0.0.1', port = 0 } = options
  const routed = new Map<string, { source: McpSource; tool: string }>()
  for (const source of sources)
    for (const tool of source.tools) {
      // Two valid names can still build the same channel name (server "a"
      // with tool "b.c" against server "a.b" with tool "c"): a route that
      // would be ambiguous is refused, not silently overwritten.
      const name = channelToolName(source.name, tool.name)
      const existing = routed.get(name)
      if (existing !== undefined)
        throw new McpError(
          `the channel names ${JSON.stringify(name)} twice: server ${JSON.stringify(existing.source.name)} tool ${JSON.stringify(existing.tool)} and server ${JSON.stringify(source.name)} tool ${JSON.stringify(tool.name)} both want it, so rename a server or a tool`,
        )
      routed.set(name, { source, tool: tool.name })
    }
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
  // The caller addresses a tool by its raw name, URL-encoded; a tool name may
  // carry any characters the server publishes, so the route is decoded first.
  let routeName = url.slice(1)
  try {
    routeName = decodeURIComponent(routeName)
  } catch {}
  const route = routed.get(routeName)
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

/**
 * The mapping is the driver's capability declaration (#94): the intents it
 * maps are the actions the driver declares, so a plan asking for an unmapped
 * intent is rejected at plan time, where nothing has run yet. The entry that
 * carries the mapping is the profile's driver.
 */
export function mcpDriverServer(mcp: ProfileMcpServer[] | undefined): ProfileMcpServer | undefined {
  return mcp?.find((entry) => entry.driver !== undefined)
}

export function mcpDriverCapabilities(mcp: ProfileMcpServer[] | undefined): FlowDriverCapabilities | undefined {
  const entry = mcpDriverServer(mcp)
  const driver = entry?.driver
  if (driver === undefined) return undefined
  return {
    name: entry!.name,
    actions: Object.keys(driver).filter((intent) => intent !== 'snapshot'),
    evidence: ['action-log', ...(driver.capture === undefined ? [] : ['screenshot']), ...(driver.snapshot === undefined ? [] : ['snapshot'])],
  }
}

export interface McpDriverCall {
  intent: string
  tool: string
  args: Record<string, unknown>
  outcome: 'ok' | 'error'
  result: { text: string; structured?: unknown }
}

export interface McpDriverSession {
  capabilities: FlowDriverCapabilities
  page: FlowPage
  dispose: () => Promise<void>
}

/**
 * A driver session over the host's tools. Before any call, the mapping is
 * held against what the server actually declares: a mapped tool the server
 * does not expose, and a tool that can only act on coordinates, are both
 * refused here, with the reason named (#94). The refusal throws, so the flow
 * that would have used the driver reports unverified instead of half-running.
 */
export async function connectMcpDriver(
  entry: ProfileMcpServer,
  opts: {
    /** How long one tool call may run; the check's deadline bounds the driver. */
    callTimeoutMs?: number
    /** Applied to the call record before it is written: tool arguments carry user-authored strings (#94). */
    redact?: (value: unknown) => unknown
    /** Receives the calls made so far, after each one, for the run to persist as evidence. */
    record?: (calls: McpDriverCall[]) => Promise<void>
  } = {},
): Promise<McpDriverSession> {
  const driver = entry.driver ?? {}
  const source = await connectMcpServer(entry, { callTimeoutMs: opts.callTimeoutMs })
  const declared = source.tools
  for (const [intent, map] of Object.entries(driver)) {
    const tool = declared.find((one) => one.name === map.tool)
    if (tool === undefined)
      throw refusal(`the server exposes no tool named ${JSON.stringify(map.tool)}, which the ${intent} mapping drives`)
    const elementArg = elementSlotArgument(map)
    if (elementArg !== undefined) {
      const properties = (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties
      if (properties !== undefined) {
        if (!(elementArg in properties))
          throw refusal(
            `the tool ${JSON.stringify(map.tool)} declares no argument named ${JSON.stringify(elementArg)}, which the ${intent} mapping binds the element reference to`,
          )
        const type = (properties[elementArg] as { type?: unknown } | undefined)?.type
        if (type === 'number' || type === 'integer')
          throw refusal(
            `the tool ${JSON.stringify(map.tool)} only acts on coordinates: its ${JSON.stringify(elementArg)} argument is a ${String(type)}, ` +
              'and a driver resolves semantic references, not coordinates; a tool that can only act on coordinates cannot be a driver',
          )
      }
    }
  }
  const calls: McpDriverCall[] = []
  const runTool = async (intent: string, map: ProfileMcpToolMap, payload: Record<string, unknown>): Promise<McpToolResult> => {
    const args: Record<string, unknown> = {}
    for (const [argName, slot] of Object.entries(map.args ?? {})) {
      const value = payload[slot]
      if (value === undefined) throw refusal(`the ${intent} mapping binds ${JSON.stringify(argName)} to the ${slot} slot, but the action carries no ${slot}`)
      args[argName] = value
    }
    const result = await source.callResult(map.tool, args)
    calls.push({
      intent,
      tool: map.tool,
      args,
      outcome: result.isError ? 'error' : 'ok',
      result: { text: result.text, ...(result.structured === undefined ? {} : { structured: result.structured }) },
    })
    // Every call and result is recorded as it happened, so a flow that stops
    // halfway still leaves the calls it made as evidence (#94).
    if (opts.record !== undefined) await opts.record(calls.map((call) => (opts.redact === undefined ? call : opts.redact(call))) as McpDriverCall[])
    return result
  }
  const orThrow = (intent: string, result: McpToolResult): McpToolResult => {
    if (result.isError) throw new Error(`the ${intent} tool reported an error: ${result.text}`)
    return result
  }
  const page: FlowPage = {
    open: async (url) => {
      orThrow('open', await runTool('open', requiredDriver(driver, 'open'), { url }))
    },
    click: async (element) => {
      orThrow('click', await runTool('click', requiredDriver(driver, 'click'), { element }))
    },
    type: async (element, value) => {
      orThrow('type', await runTool('type', requiredDriver(driver, 'type'), { element, value }))
    },
    choose: async (element, value) => {
      orThrow('choose', await runTool('choose', requiredDriver(driver, 'choose'), { element, value }))
    },
    waitFor: async (element) => {
      orThrow('waitFor', await runTool('waitFor', requiredDriver(driver, 'waitFor'), { element }))
    },
    assertText: async (text) => {
      orThrow('assertText', await runTool('assertText', requiredDriver(driver, 'assertText'), { text }))
    },
    assertElement: async (element) => {
      orThrow('assertElement', await runTool('assertElement', requiredDriver(driver, 'assertElement'), { element }))
    },
    screenshot: async (path) => {
      const result = orThrow('capture', await runTool('capture', requiredDriver(driver, 'capture'), {}))
      const png = result.images?.[0]
      if (png === undefined) throw new Error(`the capture tool returned no image content${result.text === '' ? '' : `: ${result.text}`}`)
      const { writeFile } = await import('node:fs/promises')
      await writeFile(path, Buffer.from(png, 'base64'))
    },
  }
  if (driver.snapshot !== undefined) {
    page.snapshot = async (): Promise<SnapshotNode> => {
      const result = orThrow('snapshot', await runTool('snapshot', requiredDriver(driver, 'snapshot'), {}))
      return asSnapshot(result.structured ?? jsonOrText(result.text))
    }
  }
  return {
    capabilities: mcpDriverCapabilities([entry])!,
    page,
    dispose: async () => {
      await source.close()
    },
  }
}

function refusal(reason: string): McpError {
  return new McpError(reason)
}

function requiredDriver(driver: Record<string, ProfileMcpToolMap>, intent: string): ProfileMcpToolMap {
  const map = driver[intent]
  if (map === undefined) throw refusal(`the ${intent} mapping is not in the profile's driver mapping`)
  return map
}

/**
 * Judge a tool result the plan's way: only on the matchers it named, against
 * the structured result for paths and the free text otherwise (#94). Nothing
 * here hands a result to a model; every matcher is decided in code, and a
 * failure comes back as the reason the check did not pass.
 */
export function evaluateToolAssertions(asserts: readonly ToolAssertion[], result: McpToolResult): string[] {
  return asserts.flatMap((assertion, index) => {
    if (judgeToolAssertion(assertion, result)) return []
    const at = assertion.path === undefined ? '' : ` at ${JSON.stringify(assertion.path)}`
    const matcher =
      assertion.contains !== undefined
        ? `contains ${JSON.stringify(assertion.contains)}`
        : assertion.matches !== undefined
          ? `matches ${JSON.stringify(assertion.matches)}`
          : assertion.exists !== undefined
            ? `exists ${String(assertion.exists)}`
            : `equals ${JSON.stringify(assertion.equals)}`
    return [`assertion ${index}${at} ${matcher} did not hold on the tool's result`]
  })
}

function judgeToolAssertion(assertion: ToolAssertion, result: McpToolResult): boolean {
  if (assertion.path === undefined) {
    if (assertion.equals !== undefined) return typeof assertion.equals === 'string' && result.text === assertion.equals
    if (assertion.contains !== undefined) return result.text.includes(assertion.contains)
    if (assertion.matches !== undefined) {
      try {
        return new RegExp(assertion.matches).test(result.text)
      } catch {
        return false
      }
    }
    return assertion.exists === true ? result.text !== '' : assertion.exists === false && result.text === ''
  }
  const resolved = resolvePath(result.structured, assertion.path)
  if (!resolved.ok) return assertion.exists === false
  const value = resolved.value
  if (assertion.exists !== undefined) return assertion.exists
  if (assertion.equals !== undefined) return deepEqual(value, assertion.equals)
  if (assertion.contains !== undefined)
    return typeof value === 'string' ? value.includes(assertion.contains) : Array.isArray(value) && value.some((entry) => deepEqual(entry, assertion.contains))
  if (assertion.matches !== undefined) {
    if (typeof value !== 'string') return false
    try {
      return new RegExp(assertion.matches).test(value)
    } catch {
      return false
    }
  }
  return false
}

function resolvePath(value: unknown, path: string): { ok: true; value: unknown } | { ok: false } {
  let current = value
  for (const segment of path.split('.')) {
    if (current === undefined || current === null || typeof current !== 'object') return { ok: false }
    const shaped = current as Record<string, unknown>
    if (!(segment in shaped)) return { ok: false }
    current = shaped[segment]
  }
  return { ok: true, value: current }
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => deepEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]))
}

function elementSlotArgument(map: ProfileMcpToolMap): string | undefined {
  return Object.entries(map.args ?? {}).find(([, slot]) => slot === 'element')?.[0]
}

function jsonOrText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

/**
 * The snapshot tool answers in the normalised schema (#82), or the driver has
 * no snapshot seam: a tree that is not the schema is a failed snapshot, never
 * a guess at one.
 */
function asSnapshot(value: unknown): SnapshotNode {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('the snapshot tool returned no accessibility snapshot')
  const shaped = value as { role?: unknown; name?: unknown; path?: unknown; states?: unknown; children?: unknown }
  if (typeof shaped.role !== 'string' || typeof shaped.path !== 'string')
    throw new Error('the snapshot tool returned a tree that is not the normalised accessibility snapshot')
  return {
    role: shaped.role,
    ...(typeof shaped.name === 'string' ? { name: shaped.name } : {}),
    ...(shaped.states !== undefined && shaped.states !== null && typeof shaped.states === 'object' && !Array.isArray(shaped.states)
      ? { states: shaped.states as Record<string, boolean | number | string> }
      : { states: {} }),
    path: shaped.path,
    ...(Array.isArray(shaped.children) ? { children: shaped.children.map(asSnapshot) } : { children: [] }),
  }
}
