import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { renderSummary, scoreAll, scoreOne } from '../benchmark/score.mjs'

// The benchmark (#246) scores a verdict against a known answer. Its model
// runs are on demand; what is held here is the scoring and the file's shape.

test('a matching verdict is correct, the opposite decision is wrong, and anything undecided is neither', () => {
  assert.equal(scoreOne('proven', 'proven'), 'correct')
  assert.equal(scoreOne('failed', 'failed'), 'correct')
  assert.equal(scoreOne('proven', 'failed'), 'wrong')
  assert.equal(scoreOne('failed', 'proven'), 'wrong')
  assert.equal(scoreOne('proven', 'unverified'), 'undecided')
  assert.equal(scoreOne('failed', 'none'), 'undecided')
})

test('the tally counts each score and the summary shows every row', () => {
  const scored = scoreAll([
    { id: 'T1', expect: 'proven', text: 'a', outcome: 'proven', reason: '' },
    { id: 'T2', expect: 'proven', text: 'b', outcome: 'failed', reason: 'verifier: thin | evidence' },
    { id: 'F1', expect: 'failed', text: 'c', outcome: 'unverified', reason: 'the planner could not plan it' },
  ])
  assert.deepEqual([scored.correct, scored.wrong, scored.undecided], [1, 1, 1])
  const summary = renderSummary(scored, 'a-model')
  assert.match(summary, /1 correct, 1 wrong, 1 undecided, of 3\./)
  assert.match(summary, /\| T2 \| proven \| failed \| wrong \| verifier: thin \\\| evidence \|/)
})

test('the criteria file holds true and false criteria in equal number, each with a known answer', () => {
  const criteria = JSON.parse(readFileSync(new URL('../benchmark/criteria.json', import.meta.url), 'utf8'))
  assert.ok(criteria.length >= 12)
  assert.equal(new Set(criteria.map((criterion) => criterion.id)).size, criteria.length)
  for (const criterion of criteria) assert.ok(['proven', 'failed'].includes(criterion.expect) && criterion.text.length > 0)
  assert.equal(criteria.filter((c) => c.expect === 'proven').length, criteria.filter((c) => c.expect === 'failed').length)
})
