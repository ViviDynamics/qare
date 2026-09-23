import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const workflowPath = join(repoRoot, '.github', 'workflows', 'qare.yml')
const workflow = readFileSync(workflowPath, 'utf8')
const lines = workflow.split('\n')

function section(job: string): string {
  const start = lines.indexOf(`  ${job}:`)
  expect(start, `job ${job} is not declared in ${workflowPath}`).toBeGreaterThanOrEqual(0)
  const end = lines.findIndex((line, index) => index > start && /^  \w+:$/.test(line))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

test('the workflow declares collect, plan, execute and judge', () => {
  expect(existsSync(workflowPath)).toBe(true)
  for (const job of ['collect', 'plan', 'execute', 'judge']) expect(lines).toContain(`  ${job}:`)
})

test('the artifact handoff names are pinned', () => {
  for (const name of ['qa-inputs', 'plan.json', 'execute-evidence', 'judge-artifacts'])
    expect(workflow).toContain(`name: ${name}`)
})

test('secret hygiene: the model-key job never holds a GitHub token', () => {
  // The whole point of collect: it reads the issue, so the job that talks to a
  // model needs no token, and the secret map in the header stays true.
  const plan = section('plan')
  expect(plan).toContain('${{ secrets.QARE_PLANNER_KEY }}')
  expect(plan).not.toContain('GITHUB_TOKEN')
  expect(plan).not.toContain('secrets.GITHUB_TOKEN')
})

test('secret hygiene: collect holds the token and no model key', () => {
  const collect = section('collect')
  expect(collect).toContain('${{ secrets.GITHUB_TOKEN }}')
  expect(collect).not.toContain('QARE_PLANNER_KEY')
  expect(collect).not.toContain('QARE_MODEL_KEY')
})

test('secret hygiene: the job that runs pull request code holds nothing', () => {
  expect(section('execute')).not.toContain('secrets.')
})

test('judge holds the model key and the token, and nothing else does', () => {
  const judge = section('judge')
  expect(judge).toContain('${{ secrets.QARE_PLANNER_KEY }}')
  expect(judge).toContain('${{ secrets.GITHUB_TOKEN }}')
})

test('the step that talks to the verifier model holds no GitHub token', () => {
  const judge = section('judge')
  const start = judge.indexOf('- name: Judge the result')
  const step = judge.slice(start, judge.indexOf('- name:', start + 1))
  expect(step).toContain('secrets.QARE_PLANNER_KEY')
  expect(step).not.toContain('GITHUB_TOKEN')
})

test('judge runs the verifier with the criteria text, the diff and the evidence', () => {
  const judge = section('judge')
  for (const flag of ['--plan plan.json', '--diff change.diff', '--result evidence/result.json', '--nare'])
    expect(judge).toContain(flag)
  expect(judge).not.toContain('--runner none')
  // The evidence directory is the verifier's file root, so it must be its own.
  expect(judge).toMatch(/name: execute-evidence\n\s+path: evidence\n/)
})

test('plan and judge install the same pinned nare', () => {
  const pins = [section('plan'), section('judge')].map(
    (job) => job.match(/nare-\d{4}\.\d+\.\d+-py3-none-any\.whl/)?.[0],
  )
  expect(pins[0]).toBeDefined()
  expect(pins[1]).toBe(pins[0])
})

test('a fork pull request skips the model-key job rather than failing', () => {
  // A fork gets no secrets, so the run would fail for a reason that has
  // nothing to do with the change.
  expect(section('plan')).toContain('github.event.pull_request.head.repo.full_name == github.repository')
})

test('collect reads the criteria without a model, and an issue that states none is neutral', () => {
  // A bug report closed by a one-line fix states no criteria. That is nothing
  // to check, decided before a model-key job starts, not a red plan job.
  const collect = section('collect')
  expect(collect).toContain('issue-criteria --out criteria.json')
  expect(collect).toMatch(/if \[ ! -f criteria\.json \]; then\n\s+echo "criteria=none"/)
  expect(section('plan')).toContain('--criteria criteria.json')
  expect(section('plan')).not.toContain('--issue')
})

test('nothing runs when the change states no criteria', () => {
  // Neutral, not red: a chore states no acceptance criteria, and a pipeline
  // that is red by default hides the failure that matters.
  for (const job of ['plan', 'execute'])
    expect(section(job)).toContain("needs.collect.outputs.criteria == 'present'")
})

test('execute runs the plan, with no fallback fixture behind it', () => {
  // The fixture existed only while the plan step could not be produced. A
  // fallback that runs when planning failed would report a pass for checks
  // nobody planned.
  expect(workflow).not.toContain('fallback-job')
  expect(existsSync(join(repoRoot, '.github', 'qare', 'fallback-job.yml'))).toBe(false)
  expect(section('execute')).toContain('--plan plan.json')
  // The run context is the caller's to supply (#105); a plan carries none of it.
  for (const flag of ['--id', '--repo', '--base', '--head', '--profile', '--evidence'])
    expect(section('execute')).toContain(flag)
})

test('a refused run is reported rather than turned into a red pipeline', () => {
  // Refusal is qare saying it cannot check this repository yet (no profile or
  // no stubs). It is an outcome about the repository, not a fault in the
  // change, and the judge still reports it.
  const execute = section('execute')
  expect(execute).toContain('"$code" -eq 3')
  expect(execute).toContain('exit "$code"')
})

test('a refusal must have left its evidence, or exit 3 is not a refusal', () => {
  expect(section('execute')).toContain('evidence/result.json')
})

test('a fork pull request is told why it got no QA, rather than skipping silently', () => {
  expect(section('collect')).toContain('github.event.pull_request.head.repo.full_name != github.repository')
})

test('judge depends on exactly the jobs whose artifacts it consumes', () => {
  expect(section('judge')).toContain('needs: [collect, plan, execute]')
})

test('the nare the plan job installs is pinned to a version', () => {
  expect(workflow).toMatch(/nare-\d{4}\.\d+\.\d+-py3-none-any\.whl/)
})

test('the qare CLI invocations are the repository own build', () => {
  expect(workflow.match(/node packages\/cli\/dist\/index\.js/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
  expect(workflow).toContain('pnpm build')
})

test('judge posts the evidence with the token alone, linking only to the uploaded artifact', () => {
  const judge = section('judge')
  const start = judge.indexOf('- name: Post the evidence')
  const step = judge.slice(start, judge.indexOf('- name:', start + 1))
  expect(step).toContain('post-evidence --result judged-result.json')
  expect(step).toContain('secrets.GITHUB_TOKEN')
  expect(step).not.toContain('QARE_PLANNER_KEY')
  expect(step).toContain('needs.execute.outputs.evidence-url')
  expect(judge).toContain('checks: write')
  expect(section('execute')).toContain('evidence-url: ${{ steps.evidence.outputs.artifact-url }}')
})

test('judge leaves no token in the checkout for the model step to find', () => {
  expect(section('judge')).toMatch(/actions\/checkout@v4\n\s+with:\n\s+persist-credentials: false/)
})

test('stub issues are filed before posting, so a posting failure cannot stop them', () => {
  const judge = section('judge')
  expect(judge.indexOf('- name: File stub issues')).toBeLessThan(judge.indexOf('- name: Post the evidence'))
})
