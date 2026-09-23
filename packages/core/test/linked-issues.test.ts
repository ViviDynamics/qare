import { expect, test } from 'vitest'

import { linkedIssues } from '../src/index.js'

test('a closing keyword links an issue', () => {
  expect(linkedIssues('Some change.\n\nCloses #9.')).toEqual([9])
})

test('every closing keyword GitHub honours is read', () => {
  const body = 'Fixes #1\nResolves #2\nClose #3\nFixed #4\nresolved #5\ncloses #6'

  expect(linkedIssues(body)).toEqual([1, 2, 3, 4, 5, 6])
})

test('several links are all read, because criteria may live in more than one issue', () => {
  expect(linkedIssues('Closes #9 and closes #10.')).toEqual([9, 10])
})

test('the same issue linked twice is one issue', () => {
  expect(linkedIssues('Closes #9.\n\nAlso closes #9 for the other half.')).toEqual([9])
})

test('a bare issue reference is not a link', () => {
  // "#12" alone is a mention, not a promise to close it, and QA reading a
  // mentioned issue's criteria would check the wrong thing.
  expect(linkedIssues('Related to #12, following the shape of #13.')).toEqual([])
})

test('a link in another repository is not read', () => {
  // Its criteria are not this change's to satisfy, and the job reads issues
  // from the repository it runs in.
  expect(linkedIssues('Closes ViviDynamics/nare#7.')).toEqual([])
})

test('a body with no links yields none rather than raising', () => {
  // A chore states no criteria, and that is a neutral outcome for the caller
  // to decide about, not an error here.
  expect(linkedIssues('Bumps a dependency.')).toEqual([])
})

test('an empty or missing body is safe', () => {
  expect(linkedIssues('')).toEqual([])
  expect(linkedIssues(undefined as unknown as string)).toEqual([])
})

test('a keyword inside a word does not link', () => {
  expect(linkedIssues('Discloses #9 in the changelog.')).toEqual([])
})
