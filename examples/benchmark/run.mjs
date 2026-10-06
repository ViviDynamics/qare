// Runs the benchmark criteria through `qare check` against live Wikipedia and
// scores the verdicts (#246): plan, execute and judge, with a real model.
//
//   node examples/benchmark/run.mjs [--out <dir>] [--only T1,F2]
//
// QARE_BENCH_COMMAND is the command that starts qare, as a JSON array; it
// defaults to this checkout's built CLI. The model is whatever nare reads
// from the environment (NARE_PROVIDER, NARE_MODEL, NARE_BASE_URL and the key).
// Exit 1 on any wrong verdict; undecided criteria are reported, not failed.
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderSummary, scoreAll } from './score.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const args = process.argv.slice(2)
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const outDir = resolve(flag('--out') ?? 'benchmark-out')
const only = flag('--only')?.split(',')
const command = JSON.parse(process.env.QARE_BENCH_COMMAND ?? JSON.stringify(['node', 'packages/cli/dist/index.js']))
const criteria = JSON.parse(readFileSync(join(here, 'criteria.json'), 'utf8')).filter((criterion) => only === undefined || only.includes(criterion.id))

mkdirSync(outDir, { recursive: true })
const results = []
for (const criterion of criteria) {
  const evidence = join(outDir, criterion.id)
  rmSync(evidence, { recursive: true, force: true })
  const run = spawnSync(command[0], [...command.slice(1), 'check', criterion.text, '--profile', 'examples/wikipedia/.qa', '--evidence', evidence], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  writeFileSync(join(outDir, `${criterion.id}.log`), `${run.stdout ?? ''}${run.stderr ?? ''}`)
  let judged
  try {
    judged = JSON.parse(readFileSync(join(evidence, 'judged-result.json'), 'utf8')).criteria[0]
  } catch {
    judged = { outcome: 'none', reason: `qare check left no judged result (exit ${run.status})` }
  }
  results.push({ ...criterion, outcome: judged.outcome, reason: judged.reason ?? '' })
  process.stdout.write(`${criterion.id} expected ${criterion.expect}, got ${judged.outcome}\n`)
}

const scored = scoreAll(results)
const summary = renderSummary(scored, process.env.NARE_MODEL ?? 'unnamed model')
writeFileSync(join(outDir, 'summary.md'), summary)
writeFileSync(join(outDir, 'results.json'), `${JSON.stringify(scored, null, 2)}\n`)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
process.stdout.write(`${scored.correct} correct, ${scored.wrong} wrong, ${scored.undecided} undecided, of ${scored.rows.length}\n`)
process.exitCode = scored.wrong > 0 ? 1 : 0
