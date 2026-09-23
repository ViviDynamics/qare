import { expect, test } from 'vitest'

import { IssueCriteriaError, criteriaFromIssue, criteriaFromIssues, criterionIdFor } from '../src/index.js'

const ISSUE = `## Problem

Something is wrong.

## Acceptance criteria

- [ ] the login form rejects an empty password
- [x] the dashboard renders on a phone

## Out of scope

- [ ] anything else
`

test('criteria come from the acceptance criteria section only', () => {
  const criteria = criteriaFromIssue(ISSUE)

  expect(criteria.map((criterion) => criterion.text)).toEqual([
    'the login form rejects an empty password',
    'the dashboard renders on a phone',
  ])
})

test('a checked box is still a criterion', () => {
  // Checking it off records that somebody believes it holds. Whether it does
  // is what the run is for.
  expect(criteriaFromIssue(ISSUE)).toHaveLength(2)
})

test('the house "Done when" heading is read the same way', () => {
  const issue = `## Scope\n\n- [ ] not a criterion\n\n## Done when\n\n- [ ] the ledger records the run\n`

  expect(criteriaFromIssue(issue).map((criterion) => criterion.text)).toEqual([
    'the ledger records the run',
  ])
})

test('ids are stable across runs, because a rerun must mean the same criteria', () => {
  const first = criteriaFromIssue(ISSUE)
  const again = criteriaFromIssue(ISSUE)

  expect(first.map((criterion) => criterion.id)).toEqual(again.map((criterion) => criterion.id))
  expect(first[0].id).toMatch(/^c-[0-9a-f]{16}$/)
})

test('an id survives punctuation and case, so a tidy-up is not a new criterion', () => {
  expect(criterionIdFor('The login form rejects an empty password.')).toBe(
    criterionIdFor('the login form rejects an empty password'),
  )
})

test('different criteria get different ids', () => {
  expect(criterionIdFor('a')).not.toBe(criterionIdFor('b'))
})

test('the same criterion written twice appears once', () => {
  const issue = `## Acceptance criteria\n\n- [ ] one thing\n- [ ] one thing\n`

  expect(criteriaFromIssue(issue)).toHaveLength(1)
})

test('an issue with no criteria section is refused', () => {
  expect(() => criteriaFromIssue('## Problem\n\nno criteria here\n')).toThrow(IssueCriteriaError)
})

test('a criteria section with no items is refused', () => {
  expect(() => criteriaFromIssue('## Acceptance criteria\n\nnothing yet.\n')).toThrow(/no criteria/i)
})

test('an empty body is refused rather than treated as nothing to check', () => {
  // Fail closed: zero criteria would make every run vacuously green.
  expect(() => criteriaFromIssue('')).toThrow(IssueCriteriaError)
})

test('the section ends at the next heading of any level', () => {
  const issue = `## Acceptance criteria\n\n- [ ] first\n\n### A sub heading\n\n- [ ] not a criterion\n`

  expect(criteriaFromIssue(issue).map((criterion) => criterion.text)).toEqual(['first'])
})

test('markdown in a criterion is kept as written', () => {
  const issue = '## Acceptance criteria\n\n- [ ] `qare plan` writes **plan.json**\n'

  expect(criteriaFromIssue(issue)[0].text).toBe('`qare plan` writes **plan.json**')
})

test('the error says whether the section is absent or empty', () => {
  const problem = (body: string): string | undefined => {
    try {
      criteriaFromIssue(body)
    } catch (error) {
      return (error as IssueCriteriaError).problem
    }
    return undefined
  }
  expect(problem('## Problem\n\nno criteria here\n')).toBe('none-stated')
  expect(problem('## Acceptance criteria\n\nnothing yet.\n')).toBe('empty-section')
})

test('criteriaFromIssues skips issues that state none, and is empty when none do', () => {
  expect(criteriaFromIssues([{ name: 'a', body: '## Bug\n' }, { name: 'b', body: ISSUE }])).toEqual(criteriaFromIssue(ISSUE))
  expect(criteriaFromIssues([{ name: 'a', body: '## Bug\n' }])).toEqual([])
})

test('criteriaFromIssues fails on an empty criteria section, naming the issue', () => {
  expect(() => criteriaFromIssues([{ name: 'issue-11.md', body: '## Done when\n\nTBD\n' }])).toThrow(/^issue-11\.md: /)
})
