import { describe, expect, test } from 'vitest'
import { criterionIdFor } from '../src/issue-criteria.js'
import { parseLedgerEntries, type LedgerEntry } from '../src/ledger.js'
import {
  ContradictionClassifierError,
  detectContradictions,
  executedFromResult,
} from '../src/ledger-contradict.js'
import type { AgentRunResult, AgentRunner } from '../src/runner.js'

const link = (host: string, path: string) => ['https:', `//${host}${path}`].join('')

const OLD_WORDS = 'the payouts page shows the 1099 notice for a host paid past the annual threshold'
const NEW_WORDS = 'payouts above the annual threshold are email-only and never produce a paper notice'
const UNRELATED_WORDS = 'the payouts page loads in under two seconds'

const OLD_ID = criterionIdFor(OLD_WORDS)
const NEW_ID = criterionIdFor(NEW_WORDS)
const UNRELATED_ID = criterionIdFor(UNRELATED_WORDS)

function activeEntry(criterion: string, words: string): LedgerEntry {
  return {
    criterion,
    status: 'active',
    source: [link('example.test', '/issues/9')],
    proof: 'command',
    note: words,
  }
}

function completed(output: unknown): AgentRunResult {
  return {
    status: 'completed',
    stopReason: 'end_turn',
    usage: { inputTokens: 1, outputTokens: 1 },
    output: JSON.stringify(output),
  }
}

function classifier(...answers: unknown[]): AgentRunner {
  const script = answers.map((answer) => completed(answer))
  return {
    run: async (): Promise<AgentRunResult> => {
      const next = script.shift()
      if (next === undefined) throw new Error('fake classifier script is exhausted')
      return next
    },
  }
}

describe('contradiction detection', () => {
  test('a change that replaces an old rule is a supersede, not a regression', async () => {
    const ledger = [activeEntry(OLD_ID, OLD_WORDS)]
    const report = await detectContradictions({
      runId: 'run-9',
      executed: [
        { id: NEW_ID, outcome: 'proven' },
        { id: OLD_ID, outcome: 'failed' },
      ],
      introduced: [{ id: NEW_ID, text: NEW_WORDS }],
      ledger,
      classifier: classifier({
        pairs: [{ criterion: OLD_ID, replacement: NEW_ID, intendsReplacement: true, reason: 'the change retires the notice' }],
      }),
    })
    expect(report.contradictions).toHaveLength(1)
    expect(report.contradictions[0]).toMatchObject({
      criterion: OLD_ID,
      replacement: NEW_ID,
      classification: 'supersede',
      basis: 'executed-evidence',
    })
    expect(report.changes).toHaveLength(1)
    expect(report.changes[0]).toMatchObject({
      criterion: OLD_ID,
      from: 'active',
      to: 'superseded',
      replacement: NEW_ID,
    })
    const folded = parseLedgerEntries(JSON.parse(report.ledgerText))
    expect(folded.find((entry) => entry.criterion === OLD_ID)?.status).toBe('superseded')
  })

  test('a change that breaks an unrelated rule is a regression', async () => {
    const ledger = [activeEntry(UNRELATED_ID, UNRELATED_WORDS)]
    const report = await detectContradictions({
      runId: 'run-9',
      executed: [
        { id: NEW_ID, outcome: 'proven' },
        { id: UNRELATED_ID, outcome: 'failed' },
      ],
      introduced: [{ id: NEW_ID, text: NEW_WORDS }],
      ledger,
      classifier: classifier({ pairs: [] }),
    })
    expect(report.contradictions).toHaveLength(1)
    expect(report.contradictions[0]).toMatchObject({
      criterion: UNRELATED_ID,
      classification: 'regression',
      basis: 'executed-evidence',
    })
    expect(report.changes).toHaveLength(0)
    const folded = parseLedgerEntries(JSON.parse(report.ledgerText))
    expect(folded.find((entry) => entry.criterion === UNRELATED_ID)?.status).toBe('active')
  })

  test('the replacement link lands on the ledger entry the change proposed', async () => {
    const ledger = [
      activeEntry(OLD_ID, OLD_WORDS),
      { criterion: NEW_ID, status: 'proposed', source: [link('example.test', '/issues/41')], proof: 'command', note: NEW_WORDS },
    ]
    const report = await detectContradictions({
      runId: 'run-9',
      executed: [
        { id: NEW_ID, outcome: 'proven' },
        { id: OLD_ID, outcome: 'failed' },
      ],
      introduced: [{ id: NEW_ID, text: NEW_WORDS }],
      ledger,
      classifier: classifier({
        pairs: [{ criterion: OLD_ID, replacement: NEW_ID, intendsReplacement: true, reason: 'email-only' }],
      }),
    })
    const folded = parseLedgerEntries(JSON.parse(report.ledgerText))
    expect(folded.find((entry) => entry.criterion === NEW_ID)?.supersedes).toEqual([OLD_ID])
  })

  test('without a classifier every failure stands as a regression', async () => {
    const report = await detectContradictions({
      runId: 'run-9',
      executed: [
        { id: NEW_ID, outcome: 'proven' },
        { id: OLD_ID, outcome: 'failed' },
      ],
      introduced: [{ id: NEW_ID, text: NEW_WORDS }],
      ledger: [activeEntry(OLD_ID, OLD_WORDS)],
    })
    expect(report.contradictions[0]).toMatchObject({
      criterion: OLD_ID,
      classification: 'regression',
      basis: 'executed-evidence',
    })
  })

  test('the model settles intent only where the evidence is silent', async () => {
    const report = await detectContradictions({
      runId: 'run-9',
      executed: [{ id: OLD_ID, outcome: 'failed' }],
      introduced: [{ id: NEW_ID, text: NEW_WORDS }],
      ledger: [activeEntry(OLD_ID, OLD_WORDS)],
      classifier: classifier({
        pairs: [{ criterion: OLD_ID, replacement: NEW_ID, intendsReplacement: true, reason: 'the change replaces it' }],
      }),
    })
    expect(report.contradictions[0]).toMatchObject({
      criterion: OLD_ID,
      replacement: NEW_ID,
      classification: 'supersede',
      basis: 'model',
    })
  })

  test('a conflict the run did not reach is proposed on the model word alone', async () => {
    const report = await detectContradictions({
      runId: 'run-9',
      executed: [{ id: NEW_ID, outcome: 'proven' }],
      introduced: [{ id: NEW_ID, text: NEW_WORDS }],
      ledger: [activeEntry(OLD_ID, OLD_WORDS)],
      classifier: classifier({
        pairs: [{ criterion: OLD_ID, replacement: NEW_ID, intendsReplacement: true, reason: 'at odds' }],
      }),
    })
    expect(report.contradictions[0]).toMatchObject({
      criterion: OLD_ID,
      classification: 'supersede',
      basis: 'model',
    })
  })

  test('executed evidence reaches a hand-minted entry through its own words', async () => {
    const seen: string[] = []
    const runner: AgentRunner = {
      run: async (request) => {
        seen.push(request.prompt)
        return completed({
          pairs: [{ criterion: 'BIL-014', replacement: NEW_ID, intendsReplacement: true, reason: 'the change retires it' }],
        })
      },
    }
    const report = await detectContradictions({
      runId: 'run-9',
      executed: [
        { id: criterionIdFor(OLD_WORDS), outcome: 'failed' },
        { id: NEW_ID, outcome: 'proven' },
      ],
      introduced: [{ id: NEW_ID, text: NEW_WORDS }],
      ledger: [
        {
          criterion: 'BIL-014',
          status: 'active',
          source: [link('example.test', '/issues/9')],
          proof: 'command',
          note: OLD_WORDS,
        },
      ],
      classifier: runner,
    })
    expect(seen[0]).toMatch(/"id":"BIL-014","words":/)
    expect(seen[0]).toMatch(/"outcome":"failed"/)
    expect(report.contradictions).toHaveLength(1)
    expect(report.contradictions[0]).toMatchObject({
      criterion: 'BIL-014',
      replacement: NEW_ID,
      classification: 'supersede',
      basis: 'executed-evidence',
    })
  })

  test('the model naming a replacement while denying the intent is a regression, not a supersede', async () => {
    const report = await detectContradictions({
      runId: 'run-9',
      executed: [{ id: NEW_ID, outcome: 'proven' }],
      introduced: [{ id: NEW_ID, text: NEW_WORDS }],
      ledger: [activeEntry(OLD_ID, OLD_WORDS)],
      classifier: classifier({
        pairs: [{ criterion: OLD_ID, replacement: NEW_ID, intendsReplacement: false, reason: 'at odds, not replaced' }],
      }),
    })
    expect(report.contradictions).toHaveLength(1)
    expect(report.contradictions[0]).toMatchObject({
      criterion: OLD_ID,
      classification: 'regression',
      basis: 'model',
    })
    expect(report.contradictions[0]?.replacement).toBeUndefined()
    expect(report.changes).toHaveLength(0)
  })

  test('one replacement replacing two old rules links them both in the fold', async () => {
    const SECOND_WORDS = 'the payouts page shows the 1099 notice before the tenth of the month'
    const SECOND_ID = criterionIdFor(SECOND_WORDS)
    const ledger = [
      activeEntry(OLD_ID, OLD_WORDS),
      activeEntry(SECOND_ID, SECOND_WORDS),
      { criterion: NEW_ID, status: 'proposed', source: [link('example.test', '/issues/41')], proof: 'command', note: NEW_WORDS },
    ]
    const report = await detectContradictions({
      runId: 'run-9',
      executed: [
        { id: NEW_ID, outcome: 'proven' },
        { id: OLD_ID, outcome: 'failed' },
        { id: SECOND_ID, outcome: 'failed' },
      ],
      introduced: [{ id: NEW_ID, text: NEW_WORDS }],
      ledger,
      classifier: classifier({
        pairs: [
          { criterion: OLD_ID, replacement: NEW_ID, intendsReplacement: true, reason: 'replaced' },
          { criterion: SECOND_ID, replacement: NEW_ID, intendsReplacement: true, reason: 'replaced too' },
        ],
      }),
    })
    expect(report.changes).toHaveLength(2)
    const folded = parseLedgerEntries(JSON.parse(report.ledgerText))
    expect(folded.find((entry) => entry.criterion === NEW_ID)?.supersedes).toEqual([OLD_ID, SECOND_ID])
  })

  test('a classifier outage is a named failure, not a quiet pass', async () => {
    await expect(
      detectContradictions({
        runId: 'run-9',
        executed: [{ id: OLD_ID, outcome: 'failed' }],
        introduced: [{ id: NEW_ID, text: NEW_WORDS }],
        ledger: [activeEntry(OLD_ID, OLD_WORDS)],
        classifier: {
          run: async () => ({
            status: 'failed',
            stopReason: 'error',
            usage: { inputTokens: 0, outputTokens: 0 },
            output: null,
            error: 'planner outage',
          }),
        },
      }),
    ).rejects.toThrow(ContradictionClassifierError)
  })

  test('one correction round carries the reason, then the classifier raises', async () => {
    const seen: string[] = []
    let calls = 0
    const runner: AgentRunner = {
      run: async (request) => {
        seen.push(request.prompt)
        calls += 1
        return calls === 1
          ? completed({ pairs: [{ criterion: 'c-notinthel', intendsReplacement: true }] })
          : completed({
              pairs: [{ criterion: OLD_ID, replacement: NEW_ID, intendsReplacement: true, reason: 'ok now' }],
            })
      },
    }
    const report = await detectContradictions({
      runId: 'run-9',
      executed: [{ id: OLD_ID, outcome: 'failed' }],
      introduced: [{ id: NEW_ID, text: NEW_WORDS }],
      ledger: [activeEntry(OLD_ID, OLD_WORDS)],
      classifier: runner,
    })
    expect(report.contradictions[0]?.classification).toBe('supersede')
    expect(seen[1]).toMatch(/Your last answer was refused/)
    expect(seen[1]).toMatch(/is not an active ledger criterion/)
  })

  test('a criterion the classifier paired twice is refused, not guessed', async () => {
    await expect(
      detectContradictions({
        runId: 'run-9',
        executed: [{ id: OLD_ID, outcome: 'failed' }],
        introduced: [
          { id: NEW_ID, text: NEW_WORDS },
          { id: UNRELATED_ID, text: UNRELATED_WORDS },
        ],
        ledger: [activeEntry(OLD_ID, OLD_WORDS)],
        classifier: classifier({
          pairs: [
            { criterion: OLD_ID, replacement: NEW_ID, intendsReplacement: true, reason: 'first' },
            { criterion: OLD_ID, replacement: UNRELATED_ID, intendsReplacement: true, reason: 'second' },
          ],
        }),
      }),
    ).rejects.toThrow(/needs review, not a guess/)
  })
})

describe('executedFromResult', () => {
  test('reads the outcomes a judged run recorded', () => {
    const executed = executedFromResult({
      criteria: [{ id: OLD_ID, outcome: 'failed', reason: 'the notice is gone' }],
    })
    expect(executed).toEqual([{ id: OLD_ID, outcome: 'failed', reason: 'the notice is gone' }])
  })

  test('fails named on a shape it cannot read', () => {
    expect(() => executedFromResult({ criteria: [{ id: '', outcome: 'failed' }] })).toThrow(/must be a criterion id/)
    expect(() => executedFromResult({ criteria: [{ id: 'x', outcome: 'nope' }] })).toThrow(
      /is not a run outcome/,
    )
    expect(() => executedFromResult({})).toThrow(/must be an array/)
  })
})
