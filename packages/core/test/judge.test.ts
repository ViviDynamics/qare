import { describe, expect, test } from 'vitest'
import {
  consumeVerifierFindings,
  detectRegressions,
  judgeRun,
  prepareVerifierInputs,
  runVerifier,
  toSideResults,
  FakeAgentRunner,
  type CriterionOutcome,
  type CriterionVerdict,
  type RunResult,
  type RunVerdict,
  type SideResult,
  type VerifierInputs,
} from '../src/index.js'

const side = (criterionId: string, outcome: CriterionOutcome, detail?: string): SideResult =>
  detail === undefined ? { criterionId, outcome } : { criterionId, outcome, detail }

interface Case {
  name: string
  base: SideResult[]
  head: SideResult[]
  waived?: string[]
  egressVerdict?: 'refused' | 'allowed'
  verdict: RunVerdict
  criteria?: Array<{ criterionId: string; outcome: CriterionOutcome; regression: boolean; reason?: string }>
  regressions?: string[]
}

const cases: Case[] = [
  {
    name: 'all proven -> passed',
    base: [side('c1', 'proven')],
    head: [side('c1', 'proven')],
    verdict: 'passed',
    criteria: [{ criterionId: 'c1', outcome: 'proven', regression: false }],
    regressions: [],
  },
  {
    name: 'head failed with no base record -> failed, not a regression',
    base: [],
    head: [side('c1', 'failed')],
    verdict: 'failed',
    criteria: [{ criterionId: 'c1', outcome: 'failed', regression: false }],
    regressions: [],
  },
  {
    name: 'base proven + head failed -> failed + regression',
    base: [side('c1', 'proven')],
    head: [side('c1', 'failed')],
    verdict: 'failed',
    criteria: [{ criterionId: 'c1', outcome: 'failed', regression: true }],
    regressions: ['c1'],
  },
  {
    name: 'base failed + head failed -> failed, NOT a regression',
    base: [side('c1', 'failed')],
    head: [side('c1', 'failed')],
    verdict: 'failed',
    criteria: [{ criterionId: 'c1', outcome: 'failed', regression: false }],
    regressions: [],
  },
  {
    name: 'head unverified -> blocked',
    base: [],
    head: [side('c1', 'unverified')],
    verdict: 'blocked',
    criteria: [{ criterionId: 'c1', outcome: 'unverified', regression: false }],
    regressions: [],
  },
  {
    name: 'base proven + head unverified -> blocked, not a regression',
    base: [side('c1', 'proven')],
    head: [side('c1', 'unverified')],
    verdict: 'blocked',
    criteria: [{ criterionId: 'c1', outcome: 'unverified', regression: false }],
    regressions: [],
  },
  {
    name: 'base-only criterion missing at head -> unverified, blocked',
    base: [side('c1', 'proven')],
    head: [side('c2', 'proven')],
    verdict: 'blocked',
    criteria: [
      { criterionId: 'c2', outcome: 'proven', regression: false },
      { criterionId: 'c1', outcome: 'unverified', regression: false, reason: 'not executed at head' },
    ],
    regressions: [],
  },
  {
    name: 'waived -> unverified "waived by human", verdict waived when nothing failed',
    base: [],
    head: [side('c1', 'proven')],
    waived: ['c1'],
    verdict: 'waived',
    criteria: [{ criterionId: 'c1', outcome: 'unverified', regression: false, reason: 'waived by human' }],
    regressions: [],
  },
  {
    name: 'waived never rescues a failure',
    base: [],
    head: [side('c1', 'failed'), side('c2', 'proven')],
    waived: ['c2'],
    verdict: 'failed',
    criteria: [
      { criterionId: 'c1', outcome: 'failed', regression: false },
      { criterionId: 'c2', outcome: 'unverified', regression: false, reason: 'waived by human' },
    ],
    regressions: [],
  },
  {
    name: 'egressVerdict refused with all-proven -> refused',
    base: [side('c1', 'proven')],
    head: [side('c1', 'proven')],
    egressVerdict: 'refused',
    verdict: 'refused',
    regressions: [],
  },
]

describe('judgeRun', () => {
  for (const c of cases) {
    test(c.name, () => {
      const result = judgeRun({ base: c.base, head: c.head, waived: c.waived, egressVerdict: c.egressVerdict })
      expect(result.verdict).toBe(c.verdict)
      if (c.criteria !== undefined) {
        expect(result.criteria).toHaveLength(c.criteria.length)
        expect(result.criteria).toMatchObject(c.criteria)
      }
      expect(result.regressions.map((regression) => regression.criterionId)).toEqual(c.regressions ?? [])
    })
  }
})

describe('detectRegressions', () => {
  test('proven at base and failed at head, stable order by first appearance in head', () => {
    const base = [side('a', 'proven'), side('b', 'proven', 'worked at base'), side('c', 'failed')]
    const head = [side('b', 'failed', 'broke at head'), side('a', 'failed'), side('c', 'proven')]
    expect(detectRegressions(base, head)).toEqual([
      {
        criterionId: 'b',
        base: 'proven',
        head: 'failed',
        baseDetail: 'worked at base',
        headDetail: 'broke at head',
      },
      { criterionId: 'a', base: 'proven', head: 'failed' },
    ])
  })

  test('base failed + head failed, and base proven + head unverified, are never regressions', () => {
    const base = [side('a', 'failed'), side('b', 'proven')]
    const head = [side('a', 'failed'), side('b', 'unverified')]
    expect(detectRegressions(base, head)).toEqual([])
  })
})

describe('toSideResults', () => {
  test('maps executed criteria onto side results, with reason becoming detail', () => {
    const result: RunResult = {
      schemaVersion: '1',
      verdict: 'failed',
      criteria: [
        { id: 'c1', outcome: 'proven', evidence: ['checks/c1/0/stdout.txt'] },
        { id: 'c2', outcome: 'failed', evidence: ['checks/c2/0/stdout.txt'] },
        { id: 'c3', outcome: 'unverified', reason: 'check timed out after 50ms' },
      ],
    }
    expect(toSideResults(result)).toEqual([
      { criterionId: 'c1', outcome: 'proven' },
      { criterionId: 'c2', outcome: 'failed' },
      { criterionId: 'c3', outcome: 'unverified', detail: 'check timed out after 50ms' },
    ])
  })
})

describe('consumeVerifierFindings', () => {
  const proven: CriterionVerdict = { criterionId: 'c1', outcome: 'proven', regression: false, reason: 'proven at head' }
  const failed: CriterionVerdict = { criterionId: 'c2', outcome: 'failed', regression: true, reason: 'broke at head' }
  const unverified: CriterionVerdict = { criterionId: 'c3', outcome: 'unverified', regression: false, reason: 'no checks' }

  test('a finding against a proven criterion downgrades it to failed with a verifier reason', () => {
    const result = consumeVerifierFindings([proven], [{ criterionId: 'c1', problem: 'evidence contradicts the claim' }])
    expect(result).toEqual([
      { criterionId: 'c1', outcome: 'failed', regression: false, reason: 'verifier: evidence contradicts the claim' },
    ])
  })

  test('findings against failed and unverified criteria cannot upgrade or rewrite reasons', () => {
    const result = consumeVerifierFindings([failed, unverified], [
      { criterionId: 'c2', problem: 'actually fine' },
      { criterionId: 'c3', problem: 'actually fine' },
    ])
    expect(result).toEqual([failed, unverified])
  })

  test('findings naming criterion ids that were not given are dropped', () => {
    const result = consumeVerifierFindings([proven], [{ criterionId: 'ghost', problem: 'not a criterion' }])
    expect(result).toEqual([proven])
  })
})

const verifierInputs = (): VerifierInputs =>
  prepareVerifierInputs({
    criteria: [{ criterionId: 'c1', outcome: 'proven', regression: false, reason: 'proven at head' }],
    diff: 'diff --git a/x b/x',
    evidence: ['checks/c1/0/stdout.txt'],
  })

const scriptedVerifier = (output: string): FakeAgentRunner =>
  new FakeAgentRunner([
    { status: 'completed', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, output },
  ])

describe('runVerifier', () => {
  test('applies findings JSON from the runner as downgrades', async () => {
    const runner = scriptedVerifier(JSON.stringify([{ criterionId: 'c1', problem: 'evidence contradicts the claim' }]))
    const inputs = verifierInputs()

    const result = await runVerifier(runner, inputs)

    expect(result).toEqual([
      { criterionId: 'c1', outcome: 'failed', regression: false, reason: 'verifier: evidence contradicts the claim' },
    ])
    const request = runner.requests[0]
    expect(request.prompt).toContain(inputs.instructions)
    expect(request.prompt).toContain('"outcome":"proven"')
    expect(request.prompt).toContain('diff --git a/x b/x')
    expect(request.prompt).toContain('checks/c1/0/stdout.txt')
  })

  test('tolerates a {"findings": [...]} wrapper object', async () => {
    const runner = scriptedVerifier(JSON.stringify({ findings: [{ criterionId: 'c1', problem: 'the claim is unbacked' }] }))

    const result = await runVerifier(runner, verifierInputs())

    expect(result).toEqual([
      { criterionId: 'c1', outcome: 'failed', regression: false, reason: 'verifier: the claim is unbacked' },
    ])
  })

  test('non-JSON output fails closed to unchanged criteria', async () => {
    const runner = scriptedVerifier('I looked at it and everything seems fine')
    const criteria = verifierInputs().criteria

    const result = await runVerifier(runner, verifierInputs())

    expect(result).toEqual(criteria)
  })

  test('malformed findings JSON fails closed to unchanged criteria', async () => {
    const runner = scriptedVerifier(JSON.stringify({ findings: [{ criterion: 'c1', why: 'no id' }] }))
    const criteria = verifierInputs().criteria

    const result = await runVerifier(runner, verifierInputs())

    expect(result).toEqual(criteria)
  })

  test('a verifier that approves everything cannot upgrade a failed criterion', async () => {
    const runner = scriptedVerifier('[]')
    const criteria: CriterionVerdict[] = [
      { criterionId: 'c1', outcome: 'failed', regression: true, reason: 'broke at head' },
    ]

    const result = await runVerifier(runner, prepareVerifierInputs({ criteria, diff: '', evidence: [] }))

    expect(result).toEqual(criteria)
  })
})

test('an empty run fails closed to blocked, never a vacuous pass', () => {
  expect(judgeRun({ base: [], head: [] }).verdict).toBe('blocked')
})

test('waived plus regressed: the regression still fails the run', () => {
  const input = {
    base: [{ criterionId: 'c1', outcome: 'proven' as const }],
    head: [{ criterionId: 'c1', outcome: 'failed' as const }],
    waived: ['c1'],
  }
  const result = judgeRun(input)
  expect(result.regressions).toHaveLength(1)
  expect(result.criteria[0]?.outcome).toBe('unverified')
  expect(result.criteria[0]?.regression).toBe(true)
  expect(result.verdict).toBe('failed')
})
