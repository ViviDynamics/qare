import { describe, expect, test } from 'vitest'
import {
  consumeVerifierFindings,
  detectRegressions,
  judgeExecuted,
  judgedResult,
  judgeRun,
  prepareVerifierInputs,
  runVerifier,
  toSideResults,
  verdictOf,
  FakeAgentRunner,
  NO_DIFF,
  NARE_CONTRACT,
  RESULT_SCHEMA_VERSION,
  VERSION,
  VERIFIER_OUTPUT_SCHEMA,
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

  test('an unexercised finding downgrades a proven criterion to unverified, not failed (#157)', () => {
    const result = consumeVerifierFindings([proven], [
      {
        criterionId: 'c1',
        problem: 'the evidence is a whole-suite run; the criterion names replay behaviour',
        kind: 'unexercised',
      },
    ])
    expect(result).toEqual([
      {
        criterionId: 'c1',
        outcome: 'unverified',
        regression: false,
        reason: 'verifier: the evidence is a whole-suite run; the criterion names replay behaviour',
      },
    ])
  })

  test('findings naming criterion ids that were not given are dropped', () => {
    const result = consumeVerifierFindings([proven], [{ criterionId: 'ghost', problem: 'not a criterion' }])
    expect(result).toEqual([proven])
  })
})

const proven: CriterionVerdict = { criterionId: 'c1', outcome: 'proven', regression: false, reason: 'proven at head' }

const verifierInputs = (criteria: CriterionVerdict[] = [proven]): VerifierInputs =>
  prepareVerifierInputs({
    criteria,
    texts: { c1: 'The ledger exports to CSV.', c2: 'Totals convert to the viewer currency.' },
    evidence: { c1: ['checks/c1/0/stdout.txt'] },
    diff: 'diff --git a/x b/x',
  })

const scriptedVerifier = (output: string): FakeAgentRunner =>
  new FakeAgentRunner([
    { status: 'completed', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, output },
  ])

describe('runVerifier', () => {
  test('applies findings JSON from the runner as downgrades', async () => {
    const runner = scriptedVerifier(JSON.stringify([{ criterionId: 'c1', problem: 'evidence contradicts the claim' }]))

    const { verdicts, usage } = await runVerifier(runner, verifierInputs())

    expect(verdicts).toEqual([
      { criterionId: 'c1', outcome: 'failed', regression: false, reason: 'verifier: evidence contradicts the claim' },
    ])
    // What the verifier spent is part of the answer (#51), whatever it decided.
    expect(usage).toEqual({ inputTokens: 1, outputTokens: 1 })
  })

  test('puts each proven claim to the model with its text, its evidence and the diff', async () => {
    const runner = scriptedVerifier(JSON.stringify({ findings: [] }))
    const inputs = verifierInputs()

    await runVerifier(runner, inputs)

    const request = runner.requests[0]
    expect(request.prompt).toContain(inputs.instructions)
    expect(request.prompt).toContain('The ledger exports to CSV.')
    expect(request.prompt).toContain('checks/c1/0/stdout.txt')
    expect(request.prompt).toContain('diff --git a/x b/x')
  })

  test('reads evidence with a read-only tool set and answers to a schema', async () => {
    const runner = scriptedVerifier(JSON.stringify({ findings: [] }))

    await runVerifier(runner, verifierInputs())

    const request = runner.requests[0]
    expect(request.toolPolicy).toBe('read-only')
    expect(JSON.parse(request.outputSchema)).toEqual(VERIFIER_OUTPUT_SCHEMA)
    expect(request.budget.maxOutputTokens).toBeGreaterThan(0)
  })

  test('only proven criteria are put to the verifier', async () => {
    const runner = scriptedVerifier(JSON.stringify({ findings: [] }))
    const failed: CriterionVerdict = { criterionId: 'c2', outcome: 'failed', regression: false, reason: 'failed at head' }

    await runVerifier(runner, verifierInputs([proven, failed]))

    expect(runner.requests[0].prompt).not.toContain('Totals convert to the viewer currency.')
  })

  test('with nothing proven there is nothing to downgrade, so no model call is made', async () => {
    const runner = new FakeAgentRunner([])
    const criteria: CriterionVerdict[] = [
      { criterionId: 'c2', outcome: 'failed', regression: false, reason: 'failed at head' },
    ]

    const { verdicts, usage } = await runVerifier(runner, verifierInputs(criteria))

    expect(verdicts).toEqual(criteria)
    expect(runner.requests).toHaveLength(0)
    // No model call, no model cost: the record says so by its absence (#51).
    expect(usage).toBeUndefined()
  })

  test('tolerates a {"findings": [...]} wrapper object', async () => {
    const runner = scriptedVerifier(JSON.stringify({ findings: [{ criterionId: 'c1', problem: 'the claim is unbacked' }] }))

    const { verdicts } = await runVerifier(runner, verifierInputs())

    expect(verdicts).toEqual([
      { criterionId: 'c1', outcome: 'failed', regression: false, reason: 'verifier: the claim is unbacked' },
    ])
  })

  test('an empty findings list leaves a proven criterion proven', async () => {
    const { verdicts } = await runVerifier(scriptedVerifier(JSON.stringify({ findings: [] })), verifierInputs())

    expect(verdicts).toEqual([proven])
  })

  // Fail closed: a verifier that gave no readable answer checked nothing, so a
  // pass must not stand as though it had.
  test('non-JSON output leaves the proven criterion unverified, naming why', async () => {
    const { verdicts } = await runVerifier(scriptedVerifier('I looked at it and everything seems fine'), verifierInputs())

    expect(verdicts).toEqual([
      {
        criterionId: 'c1',
        outcome: 'unverified',
        regression: false,
        reason: 'verifier did not answer: its answer was not a findings list',
      },
    ])
  })

  test('malformed findings JSON leaves the proven criterion unverified', async () => {
    const runner = scriptedVerifier(JSON.stringify({ findings: [{ criterion: 'c1', why: 'no id' }] }))

    const { verdicts } = await runVerifier(runner, verifierInputs())

    expect(verdicts[0]?.outcome).toBe('unverified')
    expect(verdicts[0]?.reason).toContain('verifier did not answer')
  })

  test('a run that did not complete leaves the proven criterion unverified, carrying the runner error', async () => {
    const runner = new FakeAgentRunner([
      {
        status: 'failed',
        stopReason: 'error',
        usage: { inputTokens: 1, outputTokens: 0 },
        output: undefined,
        error: 'HTTP 524',
      },
    ])

    const { verdicts, usage } = await runVerifier(runner, verifierInputs())

    expect(verdicts[0]?.outcome).toBe('unverified')
    expect(verdicts[0]?.reason).toBe('verifier did not answer: the run stopped (error): HTTP 524')
    // An inconclusive verifier still cost what it spent (#51).
    expect(usage).toEqual({ inputTokens: 1, outputTokens: 0 })
  })

  test('a runner that throws leaves the proven criterion unverified, carrying the message', async () => {
    const runner = new FakeAgentRunner([])

    const { verdicts, usage } = await runVerifier(runner, verifierInputs())

    expect(verdicts[0]?.outcome).toBe('unverified')
    expect(verdicts[0]?.reason).toContain('fake runner script is exhausted')
    expect(usage).toBeUndefined()
  })

  test('a verifier that approves everything cannot upgrade a failed criterion', async () => {
    const runner = scriptedVerifier('[]')
    const criteria: CriterionVerdict[] = [
      { criterionId: 'c1', outcome: 'failed', regression: true, reason: 'broke at head' },
    ]

    const { verdicts } = await runVerifier(runner, verifierInputs(criteria))

    expect(verdicts).toEqual(criteria)
  })
})

describe('prepareVerifierInputs', () => {
  test('a proven criterion with no text is left unverified: the verifier cannot check what it cannot read', () => {
    const inputs = prepareVerifierInputs({ criteria: [proven], texts: { c1: '  ' }, evidence: {}, diff: '' })

    expect(inputs.claims).toEqual([])
    expect(inputs.criteria).toEqual([
      {
        criterionId: 'c1',
        outcome: 'unverified',
        regression: false,
        reason: 'verifier could not check it: the plan has no text for this criterion',
      },
    ])
  })

  test('a criterion that is not proven needs no text', () => {
    const failed: CriterionVerdict = { criterionId: 'c9', outcome: 'failed', regression: false, reason: 'failed at head' }

    expect(prepareVerifierInputs({ criteria: [failed], texts: {}, evidence: {}, diff: '' }).claims).toEqual([])
  })
})

describe('verdictOf', () => {
  const unverified = (criterionId: string): CriterionVerdict => ({
    criterionId,
    outcome: 'unverified',
    regression: false,
    reason: 'why',
  })

  test('waived when every unverified criterion was waived', () => {
    expect(verdictOf([unverified('c1')], [], ['c1'])).toBe('waived')
  })

  test('one waiver does not cover a criterion nobody waived: blocked', () => {
    expect(verdictOf([unverified('c1'), unverified('c2')], [], ['c1'])).toBe('blocked')
  })

  // The verifier moves criteria only from proven to failed or unverified, and
  // the verdict follows. Nothing it returns reads better than what it was given.
  test('downgrading a proven criterion never improves the verdict', () => {
    const order: RunVerdict[] = ['passed', 'waived', 'failed', 'blocked']
    const base: CriterionVerdict[] = [proven, unverified('w')]
    const before = verdictOf(base, [], ['w'])
    for (const outcome of ['failed', 'unverified'] as const) {
      const after = verdictOf([{ ...proven, outcome }, unverified('w')], [], ['w'])
      expect(order.indexOf(after)).toBeGreaterThan(order.indexOf(before))
    }
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

// nare refuses to start a run whose schema uses a keyword its validator does
// not support, which would block every verified run. This is nare 2026.9.10's
// list, as its own error message states it.
test('the verifier output schema uses only keywords nare validates', () => {
  const supported = new Set(['$schema', 'additionalProperties', 'description', 'enum', 'items', 'properties', 'required', 'title', 'type'])
  const unsupported: string[] = []
  const walk = (node: unknown, path: string): void => {
    if (typeof node !== 'object' || node === null) return
    for (const [key, value] of Object.entries(node)) {
      if (!supported.has(key)) unsupported.push(`${path}${key}`)
      if (key === 'properties') {
        for (const [name, child] of Object.entries(value as Record<string, unknown>)) walk(child, `${path}properties.${name}.`)
      } else if (key === 'items') walk(value, `${path}items.`)
    }
  }
  walk(VERIFIER_OUTPUT_SCHEMA, '')
  expect(unsupported).toEqual([])
})

test('judgedResult recomputes an app summary the judge downgraded', () => {
  const executed: RunResult = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    verdict: 'passed',
    criteria: [
      { id: 'c1', outcome: 'proven', evidence: ['evidence/c1/stdout.txt'] },
      { id: 'c2', outcome: 'proven', evidence: ['evidence/c2/stdout.txt'] },
    ],
    profiles: [
      { name: 'admin', verdict: 'passed', criteria: ['c1'] },
      { name: 'storefront', verdict: 'refused', criteria: ['c2'] },
    ],
  }
  const result = judgedResult(
    executed,
    'failed',
    [
      { criterionId: 'c1', outcome: 'failed', regression: false, reason: 'the verifier found a problem' },
      { criterionId: 'c2', outcome: 'unverified', regression: false, reason: 'the boot never came up' },
    ],
    new Map(),
  )
  expect(result.profiles?.map((profile) => profile.verdict)).toEqual(['failed', 'refused'])
})

test('a passed app summary downgrades to blocked the way the run verdict does', () => {
  const executed: RunResult = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    verdict: 'passed',
    criteria: [{ id: 'c1', outcome: 'proven', evidence: ['evidence/c1/stdout.txt'] }],
    profiles: [{ name: 'admin', verdict: 'passed', criteria: ['c1'] }],
  }
  const judged = [
    { criterionId: 'c1', outcome: 'unverified' as const, regression: false, reason: 'the judge could not verify it' },
  ]
  const result = judgedResult(executed, 'blocked', judged, new Map())
  expect(result.profiles?.[0]?.verdict).toBe('blocked')
})

test('judgedResult carries the environment through judging', () => {
  const environment = {
    execution: 'native' as const,
    versions: { qare: VERSION, node: process.versions.node, nareContract: NARE_CONTRACT },
  }
  const executed: RunResult = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    verdict: 'passed',
    criteria: [{ id: 'c1', outcome: 'proven', evidence: ['evidence/c1/stdout.txt'] }],
    environment,
  }
  const result = judgedResult(
    executed,
    'passed',
    [{ criterionId: 'c1', outcome: 'proven', regression: false, reason: 'proven at head' }],
    new Map([['c1', ['evidence/c1/stdout.txt']]]),
  )
  expect(result.environment).toEqual(environment)
})

test('a result without an environment judges to one without it', () => {
  const result = judgedResult(
    { schemaVersion: RESULT_SCHEMA_VERSION, verdict: 'passed', criteria: [] },
    'passed',
    [],
    new Map(),
  )
  expect(result.environment).toBeUndefined()
})

test('an executed result judged again keeps its environment record', async () => {
  const executed: RunResult = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    verdict: 'refused',
    criteria: [{ id: 'c1', outcome: 'unverified', reason: 'no qare contract; nare must be installed' }],
    environment: { execution: 'native', versions: { qare: VERSION, node: process.versions.node, nareContract: NARE_CONTRACT } },
  }
  const { result } = await judgeExecuted(executed, { texts: {}, diff: NO_DIFF })
  expect(result.verdict).toBe('refused')
  expect(result.environment?.execution).toBe('native')
})

test('the wall clock of the run and the spend of the verifier ride the judged result (#51)', async () => {
  const executed: RunResult = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    verdict: 'passed',
    criteria: [{ id: 'c1', outcome: 'proven', evidence: ['checks/c1/0/stdout.txt'] }],
    startedAt: '2026-09-29T10:00:00.000Z',
    finishedAt: '2026-09-29T10:01:00.000Z',
  }
  const { result, judgeUsage } = await judgeExecuted(executed, {
    texts: { c1: 'Totals convert to the viewer currency.' },
    diff: NO_DIFF,
    verifier: scriptedVerifier(JSON.stringify({ findings: [] })),
  })
  expect(result.startedAt).toBe('2026-09-29T10:00:00.000Z')
  expect(result.finishedAt).toBe('2026-09-29T10:01:00.000Z')
  expect(result.judgeUsage).toEqual({ inputTokens: 1, outputTokens: 1 })
  expect(judgeUsage).toEqual({ inputTokens: 1, outputTokens: 1 })
})

test('a result without timestamps judges to one without them: an old artifact still loads and judges the same', async () => {
  const executed: RunResult = { schemaVersion: RESULT_SCHEMA_VERSION, verdict: 'passed', criteria: [] }
  const { result } = await judgeExecuted(executed, { texts: {}, diff: NO_DIFF })
  expect(result.startedAt).toBeUndefined()
  expect(result.finishedAt).toBeUndefined()
  expect(result.judgeUsage).toBeUndefined()
})
