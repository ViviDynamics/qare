import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { parse } from 'yaml'

// #145: the pipeline ships as a reusable workflow, and a repository calls it
// in about ten lines. These tests hold the two sides together: what the
// reusable workflow declares, what qare's own caller passes, and what the
// documentation tells a new repository to write.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const PIPELINE = '.github/workflows/pipeline.yml'

type Permissions = Record<string, string>
interface Step {
  name?: string
  uses?: string
  run?: string
  env?: Record<string, string>
  with?: Record<string, unknown>
}
interface Job {
  name?: string
  'runs-on'?: unknown
  permissions?: Permissions
  steps?: Step[]
  uses?: string
  with?: Record<string, unknown>
  secrets?: unknown
}
interface Input {
  type: string
  required?: boolean
  default?: unknown
  description?: string
}
interface Workflow {
  on: Record<string, unknown>
  permissions?: Permissions
  jobs: Record<string, Job>
}

function load(path: string): Workflow {
  return parse(readFileSync(join(repoRoot, path), 'utf8')) as Workflow
}

const pipeline = load(PIPELINE)
const call = pipeline.on.workflow_call as { inputs: Record<string, Input>; secrets: Record<string, { required?: boolean }> }
const version = (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string }).version

const LEVEL: Record<string, number> = { none: 0, read: 1, write: 2 }

/** Every permission a called job declares must be covered by what the calling job grants. */
function expectCeilingCovers(ceiling: Permissions | undefined, where: string): void {
  expect(ceiling, `${where} grants no permissions, so every called job would run with the repository default`).toBeDefined()
  for (const [id, job] of Object.entries(pipeline.jobs)) {
    for (const [scope, level] of Object.entries(job.permissions ?? pipeline.permissions ?? {})) {
      const granted = LEVEL[ceiling?.[scope] ?? 'none'] ?? 0
      expect(granted, `${where} grants ${scope}: ${ceiling?.[scope] ?? 'none'}, but ${id} needs ${scope}: ${level}; the run would not start`)
        .toBeGreaterThanOrEqual(LEVEL[level] ?? 0)
    }
  }
}

/** A calling job must pass only what is declared, and everything that is required. */
function expectCallFits(job: Job, where: string): void {
  const passed = Object.keys(job.with ?? {})
  for (const name of passed) expect(Object.keys(call.inputs), `${where} passes an input the pipeline does not declare`).toContain(name)
  for (const [name, input] of Object.entries(call.inputs))
    if (input.required === true) expect(passed, `${where} must pass the required input ${name}`).toContain(name)
  // Secrets by name, one at a time: `secrets: inherit` would hand the
  // pipeline every secret the repository holds (rule 7).
  expect(typeof job.secrets, `${where} must pass secrets by name, never inherit them`).toBe('object')
  for (const name of Object.keys(job.secrets as Record<string, string>))
    expect(Object.keys(call.secrets), `${where} passes a secret the pipeline does not declare`).toContain(name)
}

test('the pipeline is a reusable workflow and nothing else triggers it', () => {
  expect(Object.keys(pipeline.on)).toEqual(['workflow_call'])
  for (const job of ['collect', 'plan', 'execute', 'judge', 'report', 'requeue'])
    expect(Object.keys(pipeline.jobs)).toContain(job)
})

test('the interface a caller sees: its inputs, their defaults, and the one secret', () => {
  expect(Object.keys(call.inputs).sort()).toEqual([
    'model-key-env',
    'nare-base-url',
    'nare-model',
    'nare-provider',
    'planner-diff-exclude',
    'profile',
    'qare-ref',
    'runs-on',
  ])
  for (const [name, input] of Object.entries(call.inputs)) {
    expect(input.type, name).toBe('string')
    expect(input.description, `${name} needs a description: it is the caller's documentation`).toMatch(/\S/)
  }
  // The model is the one thing no default can choose for a repository.
  expect(Object.entries(call.inputs).filter(([, input]) => input.required === true).map(([name]) => name)).toEqual(['nare-model'])
  expect(call.inputs.profile?.default).toBe('.qa')
  expect(call.inputs['nare-provider']?.default).toBe('openai')
  expect(call.inputs['model-key-env']?.default).toBe('OPENAI_API_KEY')
  // A JSON string, because an input cannot be a list: one label or several.
  expect(JSON.parse(String(call.inputs['runs-on']?.default))).toBe('ubuntu-latest')
  // One secret, by name. A fork pull request has none to pass, so it is not
  // required at the interface; the steps that need it fail closed instead.
  expect(Object.keys(call.secrets)).toEqual(['model-key'])
  expect(call.secrets['model-key']?.required).not.toBe(true)
})

test('every input the pipeline declares is one it reads', () => {
  const text = readFileSync(join(repoRoot, PIPELINE), 'utf8')
  for (const name of Object.keys(call.inputs)) {
    const read = text.includes(`inputs.${name} `) || text.includes(`inputs.${name})`) || text.includes(`inputs['${name}']`)
    expect(read, `the input ${name} is declared but never read`).toBe(true)
  }
})

test('the caller chooses the runners for every job', () => {
  for (const [id, job] of Object.entries(pipeline.jobs))
    expect(job['runs-on'], `${id} must run where the caller says`).toBe('${{ fromJSON(inputs.runs-on) }}')
})

test('the pipeline pins the release it ships in, so a caller pins one tag', () => {
  // A called workflow cannot learn its own ref, so the release is written
  // into the file: the tag a caller names in `uses:` carries a pipeline whose
  // qare is that same release. scripts/sync-version.mjs stamps it.
  expect(call.inputs['qare-ref']?.default).toBe(version)
  const sync = readFileSync(join(repoRoot, 'scripts', 'sync-version.mjs'), 'utf8')
  expect(sync).toContain(PIPELINE)
})

test('the model key reaches the planner and the verifier steps, and nothing else', () => {
  const holders: string[] = []
  for (const [id, job] of Object.entries(pipeline.jobs)) {
    for (const step of job.steps ?? []) {
      const text = JSON.stringify(step)
      for (const match of text.matchAll(/secrets\.([\w-]+)/g))
        expect(['model-key', 'GITHUB_TOKEN'], `${id} reads a secret the interface does not declare`).toContain(match[1])
      if (!text.includes('secrets.model-key')) continue
      holders.push(`${id}: ${step.name ?? ''}`)
      // Rule 7: the step that holds the model key holds no GitHub token.
      expect(text, `${id}: ${step.name ?? ''} holds the model key and a token`).not.toMatch(/GITHUB_TOKEN|GH_TOKEN|github\.token/)
    }
  }
  expect(holders).toEqual(['plan: Plan the QA run', 'judge: Judge the result'])
  // The job that runs pull request code holds nothing at all.
  expect(JSON.stringify(pipeline.jobs.execute)).not.toMatch(/secrets\.|github\.token/)
})

test('a missing model key stops the run by name rather than reaching the model without one', () => {
  for (const [id, name] of [['plan', 'Plan the QA run'], ['judge', 'Judge the result']] as const) {
    const step = pipeline.jobs[id]?.steps?.find((candidate) => candidate.name === name)
    expect(step?.run, `${id} must fail closed without a key`).toMatch(/if \[ -z "\$MODEL_KEY" \]; then\n(?:.*\n)*?\s*exit 1\n/)
    expect(step?.run).toContain('model-key')
  }
})

test('nothing in the pipeline may fail without failing the run', () => {
  // Rule 6: a step that is allowed to fail lets a failed plan read as a pass.
  for (const path of [PIPELINE, '.github/workflows/qare.yml']) {
    for (const [id, job] of Object.entries(load(path).jobs)) {
      expect(Object.keys(job), `${path} ${id}`).not.toContain('continue-on-error')
      for (const step of job.steps ?? []) expect(Object.keys(step), `${path} ${id}: ${step.name ?? step.uses ?? ''}`).not.toContain('continue-on-error')
    }
  }
})

test("qare's own workflow calls the pipeline it ships", () => {
  const caller = load('.github/workflows/qare.yml')
  expect(Object.keys(caller.on).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch'])
  const jobs = Object.entries(caller.jobs)
  expect(jobs).toHaveLength(1)
  const [, job] = jobs[0] as [string, Job]
  // The file in this tree, so a change to the pipeline is checked by its own
  // pull request rather than by the next release.
  expect(job.uses).toBe(`./${PIPELINE}`)
  expect(job.steps, 'a calling job has no steps of its own').toBeUndefined()
  expectCallFits(job, 'qare.yml')
  expectCeilingCovers(job.permissions, 'qare.yml')
  // Rule 7 for qare itself: token-holding jobs run qare from the base commit
  // of a pull request, a revision the pull request cannot change, and from
  // the pushed revision on a push.
  expect(job.with?.['qare-ref']).toBe('${{ github.event.pull_request.base.sha || github.sha }}')
  expect((job.secrets as Record<string, string>)['model-key']).toBe('${{ secrets.QARE_PLANNER_KEY }}')
  // qare is public: its own jobs stay on the default, GitHub-hosted runners.
  expect(Object.keys(job.with ?? {})).not.toContain('runs-on')
  expect(readFileSync(join(repoRoot, '.github/workflows/qare.yml'), 'utf8')).not.toContain('self-hosted')
})

test('the documented caller fits the interface and pins the current release', () => {
  const doc = readFileSync(join(repoRoot, 'docs', 'pipeline.md'), 'utf8')
  const blocks = [...doc.matchAll(/```yaml\n([\s\S]*?)```/g)].map((match) => match[1] ?? '')
  const callers = blocks.filter((block) => block.includes(`uses: ViviDynamics/qare/${PIPELINE}@`))
  expect(callers.length, 'docs/pipeline.md shows no caller workflow').toBeGreaterThan(0)
  for (const block of callers) {
    const caller = parse(block) as Workflow
    const [id, job] = Object.entries(caller.jobs)[0] as [string, Job]
    // A release tag, never a commit or a branch: upgrading is this one line.
    expect(job.uses).toBe(`ViviDynamics/qare/${PIPELINE}@${version}`)
    expectCallFits(job, 'the documented caller')
    expectCeilingCovers(job.permissions, 'the documented caller')
    // The release is pinned once, in `uses:`.
    expect(Object.keys(job.with ?? {})).not.toContain('qare-ref')
    expect(Object.keys(caller.on)).toContain('pull_request')
    expect(id).toBe('qare')
  }
  // The promise the issue makes is the smallest caller: a calling job of
  // about ten lines, in a workflow file a little longer.
  const sizes = callers.map((block) => {
    const lines = block.split('\n').filter((line) => line.trim() !== '')
    return { file: lines.length, job: lines.length - lines.indexOf('  qare:') }
  })
  expect(Math.min(...sizes.map((size) => size.job))).toBeLessThanOrEqual(12)
  expect(Math.min(...sizes.map((size) => size.file))).toBeLessThanOrEqual(16)
  // Every input and the secret are documented by name.
  for (const name of [...Object.keys(call.inputs), ...Object.keys(call.secrets)]) expect(doc).toContain(`\`${name}\``)
})
