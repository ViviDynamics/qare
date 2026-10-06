// How one benchmark criterion is scored (#246). A criterion is known to be
// true (expect "proven") or false (expect "failed"). The verdict is correct
// when it matches, wrong when it is the opposite decision, and undecided when
// the run did not decide: an unverified criterion blocks, but it claims
// nothing false, so it is counted apart from a wrong verdict.
export function scoreOne(expect, outcome) {
  if (outcome === expect) return 'correct'
  if (outcome === 'proven' || outcome === 'failed') return 'wrong'
  return 'undecided'
}

/** The tally and the table for a set of results: [{ id, expect, text, outcome, reason }]. */
export function scoreAll(results) {
  const rows = results.map((result) => ({ ...result, score: scoreOne(result.expect, result.outcome) }))
  const count = (score) => rows.filter((row) => row.score === score).length
  return { rows, correct: count('correct'), wrong: count('wrong'), undecided: count('undecided') }
}

const cell = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 160)

export function renderSummary(scored, model) {
  const lines = [
    `## qare verdict benchmark (${model})`,
    '',
    `${scored.correct} correct, ${scored.wrong} wrong, ${scored.undecided} undecided, of ${scored.rows.length}.`,
    '',
    '| id | expected | outcome | score | reason |',
    '| --- | --- | --- | --- | --- |',
    ...scored.rows.map((row) => `| ${row.id} | ${row.expect} | ${row.outcome} | ${row.score} | ${cell(row.reason)} |`),
  ]
  return `${lines.join('\n')}\n`
}
