import { describe, expect, test } from 'vitest'
import { detectRegressions, judgeRun, type CriterionOutcome, type RunVerdict, type SideResult } from '../src/index.js'

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
