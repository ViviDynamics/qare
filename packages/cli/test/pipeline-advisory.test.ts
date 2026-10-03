import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { parse } from 'yaml'

// #150: the pipeline's part in the advisory UX review. The review itself is
// inside `qare judge`, in the step that already holds the model key. What the
// workflow adds is the carrying out of replies (/qa-dismiss, /qa-promote),
// with the GitHub identity alone, and the handing of the dismissed list to
// judge. None of it can fail a run.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

interface Step {
  name?: string
  id?: string
  if?: string
  uses?: string
  run?: string
  env?: Record<string, string>
  with?: Record<string, unknown>
}
interface Job {
  name?: string
  if?: string
  needs?: string | string[]
  'runs-on'?: unknown
  permissions?: Record<string, string>
  concurrency?: unknown
  steps?: Step[]
}
interface Workflow {
  on: Record<string, unknown>
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean }
  jobs: Record<string, Job>
}

function load(path: string): Workflow {
  return parse(readFileSync(join(repoRoot, path), 'utf8')) as Workflow
}

const pipeline = load('.github/workflows/pipeline.yml')
const judge = pipeline.jobs.judge?.steps ?? []
const stepNamed = (steps: Step[], name: string): Step => {
  const step = steps.find((candidate) => candidate.name === name)
  expect(step, `no step named ${JSON.stringify(name)}`).toBeDefined()
  return step as Step
}
const IDENTITY_ENV = {
  GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
  QARE_APP_ID: '${{ secrets.app-id }}',
  QARE_APP_PRIVATE_KEY: '${{ secrets.app-private-key }}',
  QARE_GITHUB_TOKEN: '${{ secrets.personal-access-token }}',
}

test('judge carries out the advisory replies before it asks the model, with the identity and no model key', () => {
  const replies = stepNamed(judge, 'Carry out the advisory replies')
  const names = judge.map((step) => step.name)
  expect(names.indexOf('Carry out the advisory replies')).toBeLessThan(names.indexOf('Judge the result'))
  // After the evidence is downloaded: the checkout cleaned the workspace, so
  // the list judge reads is this run's or none.
  expect(names.indexOf('Carry out the advisory replies')).toBeGreaterThan(names.indexOf('Download execute evidence'))
  expect(replies.if).toBe("github.event_name == 'pull_request'")
  expect(replies.env).toMatchObject(IDENTITY_ENV)
  // Rule 7: the identity and the model key never share a step.
  expect(JSON.stringify(replies)).not.toMatch(/model-key|MODEL_KEY/)
  const run = replies.run ?? ''
  expect(run).toContain('advisory-replies')
  expect(run).toContain('--pr "$PR_NUMBER"')
  expect(run).toContain('--out advisory-dismissed.json')
  // The image's own qare-action, as the posting steps run it.
  expect(run).toContain('/opt/qare/lib/packages/action/dist/index.js')
  for (const variable of ['GITHUB_TOKEN', 'QARE_APP_ID', 'QARE_APP_PRIVATE_KEY', 'QARE_GITHUB_TOKEN', 'GITHUB_REPOSITORY']) expect(run).toContain(`-e ${variable} `)
})

test('advisory work gates nothing: a failed sweep is a warning, and judge then treats nothing as dismissed', () => {
  const run = stepNamed(judge, 'Carry out the advisory replies').run ?? ''
  // A pinned qare older than the command answers "unknown command": that is
  // "no dismissals", said, and never a red run. The step still may not be
  // marked allowed to fail (rule 6): the shell handles the one case.
  expect(run).toMatch(/if ! docker run[\s\S]*advisory-replies[\s\S]*; then\n\s+rm -f advisory-dismissed\.json\n\s+echo "::warning::/)
  expect(JSON.stringify(pipeline)).not.toContain('continue-on-error')
})

test('judge hands the reviewer the dismissed list when there is one, and the model step still holds no token', () => {
  const step = stepNamed(judge, 'Judge the result')
  const run = step.run ?? ''
  expect(run).toMatch(/if \[ -f advisory-dismissed\.json \]; then\n\s+dismissed=\(--dismissed advisory-dismissed\.json\)\n\s*fi/)
  expect(run).toContain('"${dismissed[@]}"')
  expect(JSON.stringify(step)).not.toMatch(/GITHUB_TOKEN|GH_TOKEN|github\.token|QARE_APP_ID|QARE_APP_PRIVATE_KEY|QARE_GITHUB_TOKEN/)
})

test('a reply on a pull request starts the advisory job, which holds the identity only and reads no pull request code', () => {
  const advisory = pipeline.jobs.advisory
  expect(advisory, 'pipeline.yml has no advisory job').toBeDefined()
  // Only a comment on a pull request that opens with one of the two commands.
  expect(advisory?.if?.replace(/\s+/g, ' ')).toBe(
    "github.event_name == 'issue_comment' && github.event.issue.pull_request && (startsWith(github.event.comment.body, '/qa-dismiss') || startsWith(github.event.comment.body, '/qa-promote'))",
  )
  expect(advisory?.needs).toBeUndefined()
  expect(advisory?.['runs-on']).toBe('${{ fromJSON(inputs.runs-on) }}')
  expect(advisory?.permissions).toEqual({ contents: 'read', issues: 'write', 'pull-requests': 'write' })
  // Two replies in a row are carried out one after the other, never at once:
  // the sweep finds what was already answered by reading what was written.
  expect(advisory?.concurrency).toEqual({ group: 'qare-advisory-${{ github.event.issue.number }}', 'cancel-in-progress': false })
  const text = JSON.stringify(advisory)
  expect(text).not.toMatch(/model-key|MODEL_KEY/)
  const steps = advisory?.steps ?? []
  // The pinned qare is the whole workspace, as in report: nothing of the
  // pull request is checked out, installed or run.
  const checkouts = steps.filter((step) => step.uses?.startsWith('actions/checkout@'))
  expect(checkouts).toHaveLength(1)
  expect(checkouts[0]?.with).toEqual({ repository: 'ViviDynamics/qare', ref: '${{ inputs.qare-ref }}', 'persist-credentials': false })
  const sweep = stepNamed(steps, 'Carry out the advisory replies')
  expect(sweep.env).toMatchObject({ ...IDENTITY_ENV, PR_NUMBER: '${{ github.event.issue.number }}' })
  expect(sweep.run).toContain('node packages/action/dist/index.js advisory-replies --pr "$PR_NUMBER"')
})

test('what a commenter wrote never reaches a shell: the reply is read through the API, by qare', () => {
  for (const [id, job] of Object.entries(pipeline.jobs))
    for (const step of job.steps ?? []) {
      expect(step.run ?? '', `${id}: ${step.name ?? ''}`).not.toContain('github.event.comment')
      expect(JSON.stringify(step.env ?? {}), `${id}: ${step.name ?? ''}`).not.toContain('github.event.comment')
    }
})

test('a comment starts nothing but the advisory job', () => {
  expect(pipeline.jobs.collect?.if).toBe("github.event_name == 'pull_request'")
  expect(pipeline.jobs.requeue?.if).toBe("github.event_name == 'push'")
  expect(pipeline.jobs.report?.if).toContain("github.event_name == 'pull_request'")
  // plan, execute and judge need collect's output, which a comment never sets.
  for (const id of ['plan', 'execute', 'judge']) expect([pipeline.jobs[id]?.needs].flat()).toContain('collect')
  expect(pipeline.jobs.plan?.if).toContain("needs.collect.outputs.criteria == 'present'")
  expect(pipeline.jobs.judge?.if).toContain("needs.execute.outputs.verdict != ''")
})

test("qare's own caller listens for replies, and a comment's run never cancels another run", () => {
  const caller = load('.github/workflows/qare.yml')
  expect(caller.on.issue_comment).toEqual({ types: ['created'] })
  // On a comment github.ref is the default branch: sharing its group would
  // let a comment cancel the requeue of a push to main, and the next comment
  // cancel this one.
  expect(caller.concurrency?.group).toBe('qare-${{ github.event.comment.id || github.ref }}')
})

test('the guide says how a finding is dismissed and promoted, and which trigger acts on a reply at once', () => {
  const doc = readFileSync(join(repoRoot, 'docs', 'pipeline.md'), 'utf8')
  const start = doc.indexOf('\n## Advisory UX review\n')
  expect(start, 'docs/pipeline.md has no "Advisory UX review" section').toBeGreaterThan(-1)
  const section = doc.slice(start, doc.indexOf('\n## ', start + 1))
  for (const text of ['`/qa-dismiss', '`/qa-promote', 'issue_comment', 'types: [created]', 'review: false', 'never part of the verdict']) expect(section).toContain(text)
  expect(section).toMatch(/owner, a member or a collaborator/)
})
