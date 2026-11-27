import { expect, test } from 'vitest'
import { RESULT_SCHEMA_VERSION, parsePlan, parseResult, renderComment, type RunResult } from '../src/index.js'

// #413: on the pull request that adds a profile asking for `explore: base`,
// the base has no profile and no app to explore, and the run said nothing.

const RESULT = { schemaVersion: RESULT_SCHEMA_VERSION, verdict: 'passed', criteria: [] } as unknown as RunResult

test('a plan may record that exploration did not run, and nothing else for it (#413)', () => {
  const plan = parsePlan({ schemaVersion: '1', criteria: [{ id: 'c1', text: 'x', unplannable: 'no' }], exploreSkipped: true })
  expect(plan.exploreSkipped).toBe(true)
  expect(() => parsePlan({ schemaVersion: '1', criteria: [{ id: 'c1', text: 'x', unplannable: 'no' }], exploreSkipped: 'yes' })).toThrow(/exploreSkipped/)
})

test('a result carries it, and refuses anything but true (#413)', () => {
  expect(parseResult({ ...RESULT, planExploreSkipped: true }).planExploreSkipped).toBe(true)
  expect(() => parseResult({ ...RESULT, planExploreSkipped: false })).toThrow(/planExploreSkipped/)
})

test('the comment says exploration did not run and when it will (#413)', () => {
  const comment = renderComment({ ...RESULT, planProfile: 'pull-request', planExploreSkipped: true })
  expect(comment).toContain(
    'Exploration: the profile says explore: base, but the base revision has no profile, so there was no base app to explore and flows were planned from the diff. It starts with the first pull request after the profile lands on the base.',
  )
  expect(renderComment(RESULT)).not.toContain('Exploration:')
})
