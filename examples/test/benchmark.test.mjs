import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

// The runner itself, with a stand-in for qare that writes the judged result
// it is told to: what is held is the exit code and the summary on disk.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
function runWith(outcome, only) {
  const dir = mkdtempSync(join(tmpdir(), 'qare-benchmark-'))
  const fake = join(dir, 'fake-qare.mjs')
  writeFileSync(
    fake,
    `import { mkdirSync, writeFileSync } from 'node:fs'
const evidence = process.argv[process.argv.indexOf('--evidence') + 1]
mkdirSync(evidence, { recursive: true })
writeFileSync(evidence + '/judged-result.json', JSON.stringify({ criteria: [{ outcome: ${JSON.stringify(outcome)}, reason: 'stand-in' }] }))
`,
  )
  const run = spawnSync(process.execPath, ['examples/benchmark/run.mjs', '--out', join(dir, 'out'), '--only', only], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, QARE_BENCH_COMMAND: JSON.stringify([process.execPath, fake]), GITHUB_STEP_SUMMARY: '' },
  })
  return { run, out: join(dir, 'out') }
}

test('the runner exits 1 on a wrong verdict, 0 on an undecided one, and writes the summary either way', () => {
  const wrong = runWith('failed', 'T1')
  assert.equal(wrong.run.status, 1)
  assert.match(readFileSync(join(wrong.out, 'summary.md'), 'utf8'), /0 correct, 1 wrong, 0 undecided, of 1\./)

  const undecided = runWith('unverified', 'T1')
  assert.equal(undecided.run.status, 0)
  assert.match(readFileSync(join(undecided.out, 'summary.md'), 'utf8'), /0 correct, 0 wrong, 1 undecided, of 1\./)

  assert.equal(runWith('proven', 'T1').run.status, 0)
})

test('a selection that names no criterion is refused by name, not scored as 0 of 0', () => {
  const typo = runWith('proven', 'T7')
  assert.equal(typo.run.status, 2)
  assert.match(typo.run.stderr, /--only names no criterion of the benchmark: T7/)
})
