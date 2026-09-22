export type ToolPolicy = 'none' | 'read-only'

export interface AgentBudget {
  maxOutputTokens: number
}

export interface AgentRunRequest {
  prompt: string
  system: string
  toolPolicy: ToolPolicy
  outputSchema: string
  budget: AgentBudget
}

export type AgentRunStatus = 'completed' | 'failed'

export type AgentStopReason = 'end_turn' | 'max_tokens' | 'cancelled' | 'error'

export interface AgentUsage {
  inputTokens: number
  outputTokens: number
}

export interface AgentRunResult {
  status: AgentRunStatus
  stopReason: AgentStopReason
  usage: AgentUsage
  output: unknown
}

export interface AgentRunner {
  run(request: AgentRunRequest): Promise<AgentRunResult>
}

export class FakeAgentRunnerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FakeAgentRunnerError'
  }
}

export class FakeAgentRunner implements AgentRunner {
  private script: AgentRunResult[]
  private seen: AgentRunRequest[] = []

  constructor(script: AgentRunResult[]) {
    this.script = [...script]
  }

  get requests(): readonly AgentRunRequest[] {
    return this.seen
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    this.seen.push(request)
    if (this.script.length === 0)
      throw new FakeAgentRunnerError(
        'fake runner script is exhausted: every call must be scripted, and nothing falls through to a pass',
      )
    return this.script.shift()!
  }
}

export class NotImplemented extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotImplemented'
  }
}

/** The nare machine contract this runner is written against (nare docs/contract.md). */
export const NARE_CONTRACT = 1

/** Exit 2 from nare: the run never started, so there is no result line. */
const NEVER_STARTED = 2

export class NareRunnerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NareRunnerError'
  }
}

export interface NareAgentRunnerOptions {
  /** The nare executable. Defaults to `nare` on PATH. */
  binary?: string
  /** Working directory for the run. Defaults to the current one. */
  cwd?: string
  /** Confine nare's file tools to this directory (nare's `--root`). */
  root?: string
  /** Extra environment for the child, merged over the current one. */
  env?: Record<string, string>
}

/** nare's terminal stop reasons, narrowed to the ones this interface names. */
const STOP_REASONS: Record<string, AgentStopReason> = {
  end_turn: 'end_turn',
  tool_use: 'end_turn',
  stop_sequence: 'end_turn',
  max_tokens: 'max_tokens',
}

interface NareEvent {
  type: string
  text: string
}

interface NareResult {
  type: string
  status: string
  stop_reason: string | null
  usage: { input: number; output: number }
  output: unknown
  contract: number
  error: string | null
  questions: string[]
}

function toolFlag(policy: ToolPolicy): string {
  // read-only is nare's `read` tool alone: no write, no edit, no bash, and no
  // ask, because a blocked run is a failure here rather than a conversation.
  return policy === 'read-only' ? 'read' : 'none'
}

/**
 * Model access through nare (qare #34), the constitution's single seam.
 *
 * nare is a separate process. This runner hands it flags, reads its typed JSONL
 * and its exit code, and parses no prose: the final `result` line carries the
 * status, stop reason, usage and the schema-validated output.
 *
 * Everything that is not a completed run fails closed. A blocked run (nare's
 * `ask`) is a failure here and not a question relayed onward: qare's verifier
 * has nobody to ask, and an unanswered question must never read as an answer.
 */
export class NareAgentRunner implements AgentRunner {
  private readonly options: NareAgentRunnerOptions

  constructor(options: NareAgentRunnerOptions = {}) {
    this.options = options
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const workDir = await mkdtemp(join(tmpdir(), 'qare-nare-'))
    try {
      const argv = ['run', request.prompt, '--yes', '--jsonl', '--contract', String(NARE_CONTRACT)]
      argv.push('--tools', toolFlag(request.toolPolicy))
      if (request.system) argv.push('--system', request.system)
      if (request.budget.maxOutputTokens > 0) argv.push('--max-tokens', String(request.budget.maxOutputTokens))
      if (this.options.root) argv.push('--root', this.options.root)
      if (request.outputSchema) {
        const schemaPath = join(workDir, 'schema.json')
        await writeFile(schemaPath, request.outputSchema, 'utf8')
        argv.push('--schema', schemaPath)
      }
      const { code, stdout } = await this.spawn(argv)
      return this.readOutcome(code, stdout)
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  }

  private async spawn(argv: string[]): Promise<{ code: number; stdout: string }> {
    const { spawn } = await import('node:child_process')
    const binary = this.options.binary ?? 'nare'
    return await new Promise((resolve, reject) => {
      const child = spawn(binary, argv, {
        cwd: this.options.cwd,
        env: { ...process.env, ...this.options.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => (stdout += String(chunk)))
      child.stderr.on('data', (chunk) => (stderr += String(chunk)))
      child.on('error', (error) =>
        reject(new NareRunnerError(`could not run nare (${binary}): ${error.message}`)),
      )
      child.on('close', (code) => {
        if (code === NEVER_STARTED) {
          reject(
            new NareRunnerError(
              `nare exited 2: the run never started, so nothing was judged. ${stderr.trim() || 'no reason on stderr'}`,
            ),
          )
          return
        }
        resolve({ code: code ?? 1, stdout })
      })
    })
  }

  private readOutcome(code: number, stdout: string): AgentRunResult {
    const lines = stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        try {
          return JSON.parse(line) as NareEvent | NareResult
        } catch {
          // A run killed mid-write, or anything that put a stray line on
          // stdout. Failing closed means the caller sees this as nare's
          // outcome being unreadable, not as a parser error from a parser it
          // never called.
          throw new NareRunnerError(
            `nare wrote a line that is not JSON, so its output cannot be read as an outcome: ${line.slice(0, 120)}`,
          )
        }
      })
    const last = lines.length > 0 ? (lines[lines.length - 1] as NareResult) : undefined
    if (!last || last.type !== 'result') {
      throw new NareRunnerError(
        `nare exited ${code} without a result line; its output cannot be read as an outcome`,
      )
    }
    if (last.contract !== NARE_CONTRACT) {
      throw new NareRunnerError(
        `nare speaks contract ${last.contract} and this runner reads ${NARE_CONTRACT}; refusing to parse shapes it does not define`,
      )
    }
    // The answer is the last output event's TEXT, which is what qare's parsers
    // consume. When a schema was set, nare has already proven that text parses
    // and satisfies it, so validation is not repeated here.
    const answer = lines
      .filter((line): line is NareEvent => line.type === 'output')
      .map((event) => event.text)
      .pop()

    // Only a completed run yields an answer. blocked and error both fail
    // closed, and a stop reason outside the mapped set is reported as an error
    // rather than flattened into end_turn, which would read as finished.
    const completed = last.status === 'done'
    if (completed && answer === undefined) {
      // nare emits an output event on every done run, so a done result without
      // one means the contract was broken. Reporting completed with no answer
      // would hand the caller a pass carrying nothing.
      throw new NareRunnerError(
        'nare reported a completed run with no output event, so there is no answer to read',
      )
    }
    return {
      status: completed ? 'completed' : 'failed',
      stopReason: STOP_REASONS[last.stop_reason ?? ''] ?? 'error',
      usage: { inputTokens: last.usage.input, outputTokens: last.usage.output },
      output: completed ? answer : undefined,
    }
  }
}
