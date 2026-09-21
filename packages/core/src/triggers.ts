export type TriggerEvent = {
  kind: 'comment' | 'label' | 'ci'
  sha: string
  body?: string
  label?: string
}

export type TriggerDecision = 'run' | 'dedup' | 'ignore'

export interface SeenShas {
  has(sha: string): boolean
  mark(sha: string): void
}

export type TriggerInput = {
  kind: string
  sha: string
  body?: string
  label?: string
}

export type ParsedTrigger = { accepted: TriggerEvent } | { rejected: string }

const SHA_PATTERN = /^[0-9a-fA-F]{4,40}$/

export function parseTrigger(input: TriggerInput): ParsedTrigger {
  const sha = typeof input.sha === 'string' ? input.sha.toLowerCase() : ''
  if (!SHA_PATTERN.test(sha)) {
    return { rejected: 'invalid sha' }
  }
  switch (input.kind) {
    case 'comment': {
      const body = typeof input.body === 'string' ? input.body : ''
      // word boundary: '/qa' alone or '/qa ' with args — '/qa-bot' is not a command
      if (!/^\/qa(?:\s|$)/.test(body.trim())) return { rejected: 'not a /qa command' }
      return { accepted: { kind: 'comment', sha, body } }
    }
    case 'label': {
      if (input.label !== 'qa') return { rejected: 'not the qa label' }
      return { accepted: { kind: 'label', sha, label: 'qa' } }
    }
    case 'ci': {
      return { accepted: { kind: 'ci', sha } }
    }
    default:
      return { rejected: 'unknown trigger kind' }
  }
}

export function decideTrigger(event: TriggerEvent, memory: SeenShas): TriggerDecision {
  if (memory.has(event.sha)) return 'dedup'
  memory.mark(event.sha)
  return 'run'
}

export function handleTrigger(
  raw: TriggerInput,
  memory: SeenShas,
): { decision: TriggerDecision; reason?: string } {
  const parsed = parseTrigger(raw)
  if ('rejected' in parsed) return { decision: 'ignore', reason: parsed.rejected }
  return { decision: decideTrigger(parsed.accepted, memory) }
}

export class SetSeenShas implements SeenShas {
  private readonly seen = new Set<string>()

  has(sha: string): boolean {
    return this.seen.has(sha)
  }

  mark(sha: string): void {
    this.seen.add(sha)
  }
}

export function makeSeenShas(): SeenShas {
  return new SetSeenShas()
}
