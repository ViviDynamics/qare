import { describe, expect, test } from 'vitest'
import {
  mintCriterionId,
  normalizeWording,
  resolveCriterion,
  type CriterionRevision,
} from '../src/index.js'

describe('mintCriterionId', () => {
  test('minted ids are opaque and unique across calls with an injected counter random', () => {
    let n = 0
    const counter = () => String(n++)
    const first = mintCriterionId(counter)
    const second = mintCriterionId(counter)
    const third = mintCriterionId(counter)
    expect(first).toMatch(/^c-[0-9a-f]{32}$/)
    expect(first).not.toBe(second)
    expect(second).not.toBe(third)
    expect(first).not.toBe(third)
  })

  test('the same injected random yields the same id', () => {
    expect(mintCriterionId(() => 'seed-1')).toBe(mintCriterionId(() => 'seed-1'))
  })
})

describe('normalizeWording', () => {
  test('case is folded to lowercase', () => {
    expect(normalizeWording('Login Works')).toBe('login works')
  })

  test('whitespace runs collapse to a single space', () => {
    expect(normalizeWording('login   works\t  here')).toBe('login works here')
  })

  test('punctuation is stripped', () => {
    expect(normalizeWording('Hello, world!')).toBe('hello world')
  })

  test('newlines collapse to a single space', () => {
    expect(normalizeWording('line one\nline two')).toBe('line one line two')
  })

  test('unicode letters and numbers survive punctuation removal', () => {
    expect(normalizeWording('Résumé — version 2!')).toBe('résumé version 2')
  })

  test('surrounding whitespace is trimmed', () => {
    expect(normalizeWording('  padded text  ')).toBe('padded text')
  })
})

describe('resolveCriterion', () => {
  test('a reworded criterion keeps its id with revision+1 and reworded true', () => {
    const existing: CriterionRevision[] = [{ id: 'c-aaaa', revision: 2, text: 'Login works' }]
    const resolution = resolveCriterion(existing, 'login,  WORKS!', {
      mint: () => 'never-used',
    })
    expect(resolution).toEqual({
      id: 'c-aaaa',
      revision: 3,
      reworded: true,
      matched: 'c-aaaa',
    })
  })

  test('an identical re-proposal keeps the id and revision with reworded false', () => {
    const existing: CriterionRevision[] = [{ id: 'c-bbbb', revision: 7, text: 'Cart totals 10 items' }]
    const resolution = resolveCriterion(existing, 'Cart totals 10 items', {
      mint: () => 'never-used',
    })
    expect(resolution).toEqual({
      id: 'c-bbbb',
      revision: 7,
      reworded: false,
      matched: 'c-bbbb',
    })
  })

  test('a genuinely new criterion gets a fresh id at revision 1', () => {
    let n = 0
    const resolution = resolveCriterion([], 'Brand new criterion', { mint: () => `m${n++}` })
    expect(resolution.reworded).toBe(false)
    expect(resolution.matched).toBeUndefined()
    expect(resolution.revision).toBe(1)
    expect(resolution.id).toMatch(/^c-[0-9a-f]{32}$/)
  })

  test('first match wins when two existing criteria normalize identically', () => {
    const existing: CriterionRevision[] = [
      { id: 'c-first', revision: 1, text: 'Sign in' },
      { id: 'c-second', revision: 4, text: 'Sign, in' },
    ]
    const resolution = resolveCriterion(existing, 'Sign in')
    expect(resolution.id).toBe('c-first')
    expect(resolution.revision).toBe(1)
    expect(resolution.reworded).toBe(false)
    expect(resolution.matched).toBe('c-first')
  })

  test('input array order is the authority for first match', () => {
    const existing: CriterionRevision[] = [
      { id: 'c-later', revision: 1, text: 'Other wording entirely' },
      { id: 'c-earlier', revision: 2, text: 'Logout works' },
    ]
    const resolution = resolveCriterion(existing, 'LOGOUT works!')
    expect(resolution.id).toBe('c-earlier')
    expect(resolution.revision).toBe(3)
    expect(resolution.reworded).toBe(true)
  })
})
