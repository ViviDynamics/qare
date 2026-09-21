import { describe, expect, test } from 'vitest'
import {
  SetSeenShas,
  decideTrigger,
  handleTrigger,
  makeSeenShas,
  parseTrigger,
  type SeenShas,
  type TriggerEvent,
} from '../src/index.js'

const SHA_A = 'abcd1234'
const SHA_B = 'ef567890'

describe('parseTrigger', () => {
  test('accepts a bare /qa comment', () => {
    const parsed = parseTrigger({ kind: 'comment', sha: SHA_A, body: '/qa' })
    expect(parsed).toEqual({ accepted: { kind: 'comment', sha: SHA_A, body: '/qa' } })
  })

  test('accepts a /qa comment with a re-run suffix', () => {
    const parsed = parseTrigger({ kind: 'comment', sha: SHA_A, body: '  /qa re-run  ' })
    expect(parsed).toEqual({ accepted: { kind: 'comment', sha: SHA_A, body: '  /qa re-run  ' } })
  })

  test('rejects a comment that is not a /qa command', () => {
    const parsed = parseTrigger({ kind: 'comment', sha: SHA_A, body: 'please run qa' })
    expect(parsed).toEqual({ rejected: 'not a /qa command' })
  })

  test('rejects a comment with no body', () => {
    const parsed = parseTrigger({ kind: 'comment', sha: SHA_A })
    expect(parsed).toEqual({ rejected: 'not a /qa command' })
  })

  test('accepts the qa label', () => {
    const parsed = parseTrigger({ kind: 'label', sha: SHA_A, label: 'qa' })
    expect(parsed).toEqual({ accepted: { kind: 'label', sha: SHA_A, label: 'qa' } })
  })

  test('rejects a label that is not exactly qa', () => {
    const parsed = parseTrigger({ kind: 'label', sha: SHA_A, label: 'qa-review' })
    expect(parsed).toEqual({ rejected: 'not the qa label' })
  })

  test('accepts a ci event on a non-empty sha', () => {
    const parsed = parseTrigger({ kind: 'ci', sha: SHA_A })
    expect(parsed).toEqual({ accepted: { kind: 'ci', sha: SHA_A } })
  })

  test('rejects an unknown kind', () => {
    expect('rejected' in parseTrigger({ kind: 'push', sha: SHA_A })).toBe(true)
  })

  test('rejects an empty sha', () => {
    expect(parseTrigger({ kind: 'ci', sha: '' })).toEqual({ rejected: 'invalid sha' })
  })

  test('rejects a sha that is too short', () => {
    expect(parseTrigger({ kind: 'ci', sha: 'abc' })).toEqual({ rejected: 'invalid sha' })
  })

  test('rejects a non-hex sha', () => {
    expect(parseTrigger({ kind: 'ci', sha: 'zzzz1234' })).toEqual({ rejected: 'invalid sha' })
  })

  test('rejects a sha longer than 40 chars', () => {
    expect(parseTrigger({ kind: 'ci', sha: 'a'.repeat(41) })).toEqual({ rejected: 'invalid sha' })
  })

  test('rejects a missing sha before kind rules', () => {
    expect(parseTrigger({ kind: 'comment', sha: '' , body: '/qa' })).toEqual({ rejected: 'invalid sha' })
  })
})

describe('decideTrigger', () => {
  test('a new sha runs and is marked', () => {
    const memory = makeSeenShas()
    const event: TriggerEvent = { kind: 'comment', sha: SHA_A, body: '/qa' }
    expect(decideTrigger(event, memory)).toBe('run')
    expect(memory.has(SHA_A)).toBe(true)
  })

  test('the same sha dedups', () => {
    const memory = makeSeenShas()
    memory.mark(SHA_A)
    expect(decideTrigger({ kind: 'comment', sha: SHA_A, body: '/qa' }, memory)).toBe('dedup')
  })

  test('the same sha never runs twice', () => {
    const memory = makeSeenShas()
    const event: TriggerEvent = { kind: 'ci', sha: SHA_A }
    expect(decideTrigger(event, memory)).toBe('run')
    expect(decideTrigger(event, memory)).toBe('dedup')
  })

  test('a different sha on the same PR re-runs', () => {
    const memory = makeSeenShas()
    expect(decideTrigger({ kind: 'ci', sha: SHA_A }, memory)).toBe('run')
    expect(decideTrigger({ kind: 'ci', sha: SHA_B }, memory)).toBe('run')
  })

  test('works with a caller-injected SeenShas', () => {
    const memory = makeMemory()
    expect(decideTrigger({ kind: 'label', sha: SHA_A, label: 'qa' }, memory)).toBe('run')
    expect(decideTrigger({ kind: 'label', sha: SHA_A, label: 'qa' }, memory)).toBe('dedup')
  })
})

describe('handleTrigger', () => {
  test('accepted /qa comment runs once', () => {
    const memory = makeSeenShas()
    expect(handleTrigger({ kind: 'comment', sha: SHA_A, body: '/qa' }, memory)).toEqual({
      decision: 'run',
    })
  })

  test('rejected comment is ignored with the parse reason', () => {
    const memory = makeSeenShas()
    expect(handleTrigger({ kind: 'comment', sha: SHA_A, body: 'hi' }, memory)).toEqual({
      decision: 'ignore',
      reason: 'not a /qa command',
    })
  })

  test('rejected label is ignored with the parse reason', () => {
    const memory = makeSeenShas()
    expect(handleTrigger({ kind: 'label', sha: SHA_A, label: 'nope' }, memory)).toEqual({
      decision: 'ignore',
      reason: 'not the qa label',
    })
  })

  test('rejected sha is ignored with the parse reason', () => {
    const memory = makeSeenShas()
    expect(handleTrigger({ kind: 'ci', sha: 'nope' }, memory)).toEqual({
      decision: 'ignore',
      reason: 'invalid sha',
    })
  })

  test('accepted events dedup on the same sha', () => {
    const memory = makeSeenShas()
    const raw = { kind: 'comment' as const, sha: SHA_A, body: '/qa' }
    expect(handleTrigger(raw, memory).decision).toBe('run')
    expect(handleTrigger(raw, memory).decision).toBe('dedup')
  })
})

describe('SetSeenShas', () => {
  test('starts empty, marks, and reports membership', () => {
    const memory = new SetSeenShas()
    expect(memory.has(SHA_A)).toBe(false)
    memory.mark(SHA_A)
    expect(memory.has(SHA_A)).toBe(true)
    expect(memory.has(SHA_B)).toBe(false)
  })
})

function makeMemory(): SeenShas {
  const seen = new Set<string>()
  return {
    has: (sha) => seen.has(sha),
    mark: (sha) => {
      seen.add(sha)
    },
  }
}
