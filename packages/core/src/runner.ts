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
