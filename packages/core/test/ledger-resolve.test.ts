import { describe, expect, test } from 'vitest'
import {
  affectedBy,
  holdForQuestions,
  questionIdFor,
  questionMarker,
  renderQuestion,
  resolveContradictions,
  type ResolutionQuestion,
} from '../src/ledger-resolve.js'
import type { Contradiction } from '../src/ledger-contradict.js'
import type { RunResult } from '../src/result.js'
import type { LedgerEntry } from '../src/ledger.js'

function contradiction(overrides: Partial<Contradiction> = {}): Contradiction {
  return {
    criterion: 'spec-up-200',
    classification: 'supersede',
    basis: 'model',
    reason: 'the model read the diff as retiring the old rule',
    ...overrides,
  }
}

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    criterion: 'spec-up-200',
    status: 'active',
    source: ['run:spec-up-200/0'],
    proof: 'command',
    ...overrides,
  }
}

function result(overrides: Partial<RunResult> = {}): RunResult {
  return {
    schemaVersion: '1',
    verdict: 'passed',
    criteria: [{ id: 'spec-up-200', outcome: 'proven', evidence: ['evidence/a.txt'] }],
    ...overrides,
  }
}

const pr: ResolutionQuestion['source'] = { kind: 'pull-request' }

describe('resolution order', () => {
  test('a conflict the executed evidence settled asks no question', () => {
    const report = resolveContradictions(
      [contradiction({ basis: 'executed-evidence', replacement: 'spec-up-201' })],
      [],
      pr,
    )
    expect(report.questions).toEqual([])
    expect(report.settled).toEqual([
      { criterion: 'spec-up-200', replacement: 'spec-up-201', classification: 'supersede', basis: 'executed-evidence' },
    ])
  })

  test("the ledger's own recorded answer settles the next conflict over the same pair", () => {
    const ledger = [
      entry({
        criterion: 'spec-up-201',
        resolution: { question: questionIdFor('spec-up-200', 'spec-up-201'), classification: 'supersede', by: 'jason', why: 'intended' },
      }),
    ]
    const report = resolveContradictions(
      [contradiction({ replacement: 'spec-up-201', classification: 'supersede', reason: 'the model would call it a supersede' })],
      ledger,
      pr,
    )
    expect(report.questions).toEqual([])
    expect(report.settled).toEqual([
      {
        criterion: 'spec-up-200',
        replacement: 'spec-up-201',
        classification: 'supersede',
        basis: 'ledger-history',
        by: 'jason',
        why: 'intended',
      },
    ])
  })

  test("a recorded answer wins over the model's recommendation, and says who decided", () => {
    const ledger = [
      entry({
        resolution: { question: questionIdFor('spec-up-200'), classification: 'regression', by: 'jason', why: 'a bug, not a plan' },
      }),
    ]
    const report = resolveContradictions(
      [contradiction({ classification: 'supersede', reason: 'the model would call it a supersede' })],
      ledger,
      pr,
    )
    expect(report.questions).toEqual([])
    expect(report.settled[0]).toMatchObject({ classification: 'regression', basis: 'ledger-history', by: 'jason', why: 'a bug, not a plan' })
  })

  test('an unresolved conflict becomes one question, with the recommendation attached', () => {
    const report = resolveContradictions(
      [contradiction({ replacement: 'spec-up-201', classification: 'supersede' })],
      [],
      pr,
    )
    expect(report.settled).toEqual([])
    expect(report.questions).toHaveLength(1)
    expect(report.questions[0]).toMatchObject({
      id: questionIdFor('spec-up-200', 'spec-up-201'),
      criterion: 'spec-up-200',
      replacement: 'spec-up-201',
      recommendation: 'supersede',
      source: pr,
    })
  })

  test('the same pair is the same question, asked once; a different pair is a different question', () => {
    const report = resolveContradictions(
      [contradiction({ replacement: 'spec-up-201' }), contradiction({ replacement: 'spec-up-201', reason: 'again' })],
      [],
      pr,
    )
    expect(report.questions).toHaveLength(1)
    const both = resolveContradictions(
      [contradiction({ replacement: 'spec-up-201' }), contradiction({ classification: 'regression' })],
      [],
      pr,
    )
    expect(both.questions).toHaveLength(2)
    expect(both.questions[0].id).not.toBe(both.questions[1].id)
  })

  test("a question's id travels with the pair, never with the run", () => {
    expect(questionIdFor('spec-up-200', 'spec-up-201')).toBe(questionIdFor('spec-up-200', 'spec-up-201'))
    expect(questionIdFor('spec-up-200')).not.toBe(questionIdFor('spec-up-200', 'spec-up-201'))
  })
})

describe('holding the affected criteria', () => {
  const question: ResolutionQuestion = {
    id: questionIdFor('spec-up-200', 'spec-up-201'),
    criterion: 'spec-up-200',
    replacement: 'spec-up-201',
    recommendation: 'supersede',
    reason: 'the model read the diff as retiring the old rule',
    source: pr,
  }

  test('a failed criterion is held unverified with the question named', () => {
    const held = holdForQuestions(
      result({
        verdict: 'failed',
        criteria: [
          { id: 'spec-up-200', outcome: 'failed', evidence: ['evidence/a.txt'] },
          { id: 'spec-up-201', outcome: 'proven', evidence: ['evidence/b.txt'] },
        ],
      }),
      [question],
    )
    expect(held.criteria.find((criterion) => criterion.id === 'spec-up-200')).toMatchObject({
      outcome: 'unverified',
      reason: `held for an open question (${question.id}) — ${question.reason}`,
    })
    // The replacement proved, so evidence settled it and no hold touches it.
    expect(held.criteria.find((criterion) => criterion.id === 'spec-up-201')?.outcome).toBe('proven')
    expect(held.verdict).toBe('blocked')
  })

  test('only the affected criteria are held; the rest of the run reports normally', () => {
    const held = holdForQuestions(
      result({
        verdict: 'failed',
        criteria: [
          { id: 'spec-up-200', outcome: 'failed', evidence: ['evidence/a.txt'] },
          { id: 'other-criterion', outcome: 'failed', evidence: ['evidence/c.txt'] },
        ],
      }),
      [question],
    )
    expect(held.criteria.find((criterion) => criterion.id === 'other-criterion')?.outcome).toBe('failed')
    expect(held.verdict).toBe('failed')
  })

  test('a proven criterion is never held, and a refused run stays refused', () => {
    const proven = holdForQuestions(
      result({
        verdict: 'refused',
        criteria: [{ id: 'spec-up-200', outcome: 'proven', evidence: ['evidence/a.txt'] }],
      }),
      [question],
    )
    expect(proven.criteria[0].outcome).toBe('proven')
    expect(proven.verdict).toBe('refused')
  })

  test('a per-app summary is recomputed from the held criteria, so it cannot contradict the table', () => {
    const held = holdForQuestions(
      result({
        verdict: 'failed',
        criteria: [{ id: 'spec-up-200', outcome: 'failed', evidence: ['evidence/a.txt'] }],
        profiles: [{ name: 'app', verdict: 'failed', criteria: ['spec-up-200'] }],
      }),
      [question],
    )
    expect(held.profiles?.[0].verdict).toBe('blocked')
  })

  test('nothing to ask, nothing held', () => {
    const untouched = result({ verdict: 'failed' })
    expect(holdForQuestions(untouched, [])).toBe(untouched)
  })
})

describe('the question as it is asked', () => {
  const question: ResolutionQuestion = {
    id: questionIdFor('spec-up-200'),
    criterion: 'spec-up-200',
    recommendation: 'regression',
    reason: 'the diff broke the old rule without meaning to',
    source: { kind: 'criteria-issue', issue: 154, author: 'jason' },
  }

  test('the marker carries the id, so an asked question is found again', () => {
    expect(questionMarker(question.id)).toBe(`<!-- qare:question ${question.id} -->`)
    expect(renderQuestion(question).startsWith(questionMarker(question.id))).toBe(true)
  })

  test('the body names the recommendation, the reason and the hold as the default', () => {
    const body = renderQuestion(question)
    expect(body).toContain('unintended regression')
    expect(body).toContain(question.reason)
    expect(body).toContain('held as `unverified`')
  })

  test('the affected criteria are the pair: the conflicted rule and its replacement', () => {
    expect(affectedBy(question)).toEqual(['spec-up-200'])
    expect(affectedBy({ ...question, replacement: 'spec-up-201' })).toEqual(['spec-up-200', 'spec-up-201'])
  })
})
