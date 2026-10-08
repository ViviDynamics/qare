import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { parse } from 'yaml'
import { INIT_DEFAULT_MODEL, INIT_MODEL_SECRET, PIPELINE_WORKFLOW, VERSION, callerWorkflow } from '@qare/core'

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

// #61: who qare posts as. The caller hands the identity over by name, and
// each secret reaches a posting step under the variable qare-action reads.
const IDENTITY_SECRETS: Record<string, string> = {
  'app-id': 'QARE_APP_ID',
  'app-private-key': 'QARE_APP_PRIVATE_KEY',
  'personal-access-token': 'QARE_GITHUB_TOKEN',
}
const IDENTITY = /secrets\.(app-id|app-private-key|personal-access-token)|QARE_APP_ID|QARE_APP_PRIVATE_KEY|QARE_GITHUB_TOKEN/

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
  for (const job of ['collect', 'plan', 'execute', 'judge', 'report', 'advisory', 'requeue'])
    expect(Object.keys(pipeline.jobs)).toContain(job)
})

// #248: the planner and the verifier run inside a container, so the input has
// to reach the step's environment and then cross into the container by name.
test('nare-stream reaches the planner and the verifier containers, and only when set', () => {
  for (const [job, name] of [['plan', 'Plan the QA run'], ['judge', 'Judge the result']] as const) {
    const step = pipeline.jobs[job]?.steps?.find((candidate) => candidate.name === name)
    expect(step?.env?.NARE_STREAM, name).toBe('${{ inputs.nare-stream }}')
    expect(step?.run?.replace(/\s+/g, ' '), name).toContain('if [ -n "$NARE_STREAM" ]; then model_env+=(-e NARE_STREAM) fi')
  }
})

test('the interface a caller sees: its inputs, their defaults, and its secrets', () => {
  expect(Object.keys(call.inputs).sort()).toEqual([
    'artefacts',
    'execute-runs-on',
    'max-output-tokens',
    'model-key-env',
    'nare-base-url',
    'nare-model',
    'nare-provider',
    'nare-stream',
    'plan-batch-size',
    'planner-diff-exclude',
    'profile',
    'qare-ref',
    'runs-on',
    'self-hosted',
  ])
  for (const [name, input] of Object.entries(call.inputs)) {
    expect(input.type, name).toBe('string')
    expect(input.description, `${name} needs a description: it is the caller's documentation`).toMatch(/\S/)
  }
  // The model is the one thing no default can choose for a repository.
  expect(Object.entries(call.inputs).filter(([, input]) => input.required === true).map(([name]) => name)).toEqual(['nare-model'])
  expect(call.inputs.profile?.default).toBe('.qa')
  expect(call.inputs['nare-provider']?.default).toBe('openai')
  // Streaming stays off unless the caller asks for it: the default is the
  // empty string, which nare treats as false.
  expect(call.inputs['nare-stream']?.default).toBe('')
  expect(call.inputs['model-key-env']?.default).toBe('OPENAI_API_KEY')
  // A JSON string, because an input cannot be a list: one label or several.
  expect(JSON.parse(String(call.inputs['runs-on']?.default))).toBe('ubuntu-latest')
  // The model key and the identity (#61), each by name. A fork pull request
  // has none to pass, so the key is not required at the interface; the steps
  // that need it fail closed instead. The identity is never required: with
  // none, qare posts as the workflow run.
  expect(Object.keys(call.secrets)).toEqual(['model-key', ...Object.keys(IDENTITY_SECRETS)])
  for (const name of Object.keys(call.secrets)) expect(call.secrets[name]?.required, name).not.toBe(true)
})

test('every input the pipeline declares is one it reads', () => {
  const text = readFileSync(join(repoRoot, PIPELINE), 'utf8')
  for (const name of Object.keys(call.inputs)) {
    const read = text.includes(`inputs.${name} `) || text.includes(`inputs.${name})`) || text.includes(`inputs['${name}']`)
    expect(read, `the input ${name} is declared but never read`).toBe(true)
  }
})

test('the streaming choice reaches the plan and judge containers', () => {
  const text = readFileSync(join(repoRoot, PIPELINE), 'utf8')
  // Both model steps map the input into the step environment...
  expect([...text.matchAll(/NARE_STREAM: \$\{\{ inputs\.nare-stream \}\}/g)].length, 'plan and judge both set NARE_STREAM').toBe(2)
  // ...and the docker boundary forwards it, or nare never sees it.
  expect([...text.matchAll(/model_env\+=\(-e NARE_STREAM\)/g)].length, 'plan and judge both forward it into their containers').toBe(2)
})

// #254: the output budget is the caller's to raise, and it has to cross the
// same docker boundary the streaming choice does.
test('the output budget reaches the plan and judge containers, and only when set', () => {
  expect(call.inputs['max-output-tokens']?.default).toBe('')
  const text = readFileSync(join(repoRoot, PIPELINE), 'utf8')
  expect([...text.matchAll(/QARE_MAX_OUTPUT_TOKENS: \$\{\{ inputs\.max-output-tokens \}\}/g)].length, 'plan and judge both set it').toBe(2)
  for (const [job, name] of [['plan', 'Plan the QA run'], ['judge', 'Judge the result']] as const) {
    const step = pipeline.jobs[job]?.steps?.find((candidate) => candidate.name === name)
    expect(step?.run?.replace(/\s+/g, ' '), name).toContain('if [ -n "$QARE_MAX_OUTPUT_TOKENS" ]; then model_env+=(-e QARE_MAX_OUTPUT_TOKENS) fi')
  }
})

// #259: the plan batch size is the caller's to set, and it crosses the docker
// boundary into the one container that plans.
test('the plan batch size reaches the plan container, and only when set', () => {
  expect(call.inputs['plan-batch-size']?.default).toBe('')
  const text = readFileSync(join(repoRoot, PIPELINE), 'utf8')
  expect([...text.matchAll(/QARE_PLAN_BATCH_SIZE: \$\{\{ inputs\.plan-batch-size \}\}/g)].length, 'the plan step alone sets it').toBe(1)
  const plan = pipeline.jobs.plan?.steps?.find((candidate) => candidate.name === 'Plan the QA run')
  expect(plan?.env?.QARE_PLAN_BATCH_SIZE).toBe('${{ inputs.plan-batch-size }}')
  expect(plan?.run?.replace(/\s+/g, ' ')).toContain('if [ -n "$QARE_PLAN_BATCH_SIZE" ]; then model_env+=(-e QARE_PLAN_BATCH_SIZE) fi')
  // The verifier judges every criterion in one turn and plans nothing: the setting is not its to read.
  const judge = pipeline.jobs.judge?.steps?.find((candidate) => candidate.name === 'Judge the result')
  expect(judge?.run).not.toContain('QARE_PLAN_BATCH_SIZE')
  // And the caller's documentation names it, with the default it stands in for.
  const docs = readFileSync(join(repoRoot, 'docs', 'pipeline.md'), 'utf8')
  expect(docs).toMatch(/\| `plan-batch-size` \| empty \| .*default of 1.*`QARE_PLAN_BATCH_SIZE`/)
})

test('the caller chooses the runners for every job', () => {
  for (const [id, job] of Object.entries(pipeline.jobs)) {
    if (id === 'execute') continue
    expect(job['runs-on'], `${id} must run where the caller says`).toBe('${{ fromJSON(inputs.runs-on) }}')
  }
  // Rule 7 is about machines: execute runs pull request code, so a caller
  // whose runners outlive a job can keep it off the ones that hold secrets.
  expect(pipeline.jobs.execute?.['runs-on']).toBe('${{ fromJSON(inputs.execute-runs-on || inputs.runs-on) }}')
  expect(call.inputs['execute-runs-on']?.default).toBe('')
  // And a public repository's execute stays on a hosted runner unless the caller opts in (#76).
  expect(call.inputs['self-hosted']?.default).toBe('')
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
        expect(['model-key', 'GITHUB_TOKEN', ...Object.keys(IDENTITY_SECRETS)], `${id} reads a secret the interface does not declare`).toContain(match[1])
      if (!text.includes('secrets.model-key')) continue
      holders.push(`${id}: ${step.name ?? ''}`)
      // Rule 7: the step that holds the model key holds no GitHub token.
      expect(text, `${id}: ${step.name ?? ''} holds the model key and a token`).not.toMatch(/GITHUB_TOKEN|GH_TOKEN|github\.token/)
      expect(text, `${id}: ${step.name ?? ''} holds the model key and the identity`).not.toMatch(IDENTITY)
    }
  }
  expect(holders).toEqual(['plan: Plan the QA run', 'judge: Judge the result'])
  // The job that runs pull request code holds nothing at all.
  expect(JSON.stringify(pipeline.jobs.execute)).not.toMatch(/secrets\.|github\.token/)
})

test('the identity reaches the steps that post, and nothing else', () => {
  const holders: string[] = []
  for (const [id, job] of Object.entries(pipeline.jobs)) {
    for (const step of job.steps ?? []) {
      const text = JSON.stringify(step)
      if (!IDENTITY.test(text)) continue
      holders.push(`${id}: ${step.name ?? ''}`)
      // All of it or none: the choice between the App and a token is made by
      // which of the caller's secrets are set, never by which step runs.
      for (const [secret, variable] of Object.entries(IDENTITY_SECRETS))
        expect(step.env?.[variable], `${id}: ${step.name ?? ''} must read ${secret} as ${variable}`).toBe(`\${{ secrets.${secret} }}`)
      // The Actions token stays beside it: it is the identity when the caller
      // configured none, and the one token that may write a check run when
      // the caller's identity is a personal access token.
      expect(step.env?.GITHUB_TOKEN, `${id}: ${step.name ?? ''}`).toBe('${{ secrets.GITHUB_TOKEN }}')
      // A step that runs qare in the image hands each variable on by name.
      // Its value is never written on a command line.
      const run = step.run ?? ''
      if (run.includes('docker run'))
        for (const variable of Object.values(IDENTITY_SECRETS)) expect(run, `${id}: ${step.name ?? ''}`).toContain(`-e ${variable} `)
      expect(run, `${id}: ${step.name ?? ''}`).not.toMatch(/\$\{?QARE_(APP_ID|APP_PRIVATE_KEY|GITHUB_TOKEN)/)
    }
  }
  // The steps that write to GitHub: the replies to advisory findings (#150),
  // the stub issues and the verdict in judge, the failure report, the
  // advisory job a reply starts, and the /qa comments of requeue. collect
  // only reads, so it keeps the Actions token and never holds a key that can
  // post.
  expect(holders).toEqual([
    'judge: Carry out the advisory replies',
    'judge: File stub issues (refused runs only)',
    'judge: Post the evidence on the pull request',
    'report: Report the failure on the pull request',
    'advisory: Carry out the advisory replies',
    'requeue: Re-queue refused PRs unblocked by the merged stubs',
  ])
  // Rule 7: the identity exists where qare posts, never where the pull
  // request's code runs, and never beside the planner.
  for (const id of ['collect', 'plan', 'execute']) expect(JSON.stringify(pipeline.jobs[id]), id).not.toMatch(IDENTITY)
})

test('the sweep posts as the same identity, in its publishing step alone', () => {
  const sweep = load('.github/workflows/sweep.yml')
  const holders: string[] = []
  for (const step of sweep.jobs.sweep?.steps ?? []) {
    if (!/QARE_APP_ID|QARE_APP_PRIVATE_KEY|QARE_GITHUB_TOKEN/.test(JSON.stringify(step))) continue
    holders.push(step.name ?? '')
    for (const variable of Object.values(IDENTITY_SECRETS)) expect(step.env?.[variable]).toBe(`\${{ secrets.${variable} }}`)
    expect(step.env?.GITHUB_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}')
  }
  expect(holders).toEqual(['Publish the standing report and file findings'])
})

test('a missing model key stops the run by name rather than reaching the model without one', () => {
  for (const [id, name] of [['plan', 'Plan the QA run'], ['judge', 'Judge the result']] as const) {
    const step = pipeline.jobs[id]?.steps?.find((candidate) => candidate.name === name)
    expect(step?.run, `${id} must fail closed without a key`).toMatch(/if \[ -z "\$MODEL_KEY" \]; then\n(?:.*\n)*?\s*exit 1\n/)
    expect(step?.run).toContain('model-key')
  }
})

test('the model key never becomes a variable of the step that passes it on', () => {
  // The caller names the variable the provider reads. Exported into the
  // step's own shell, a name like IMAGE_REF would put the key where an image
  // name is expected. It goes to the container in a file outside the
  // workspace, and the shell's own variables stay what they were.
  for (const [id, name] of [['plan', 'Plan the QA run'], ['judge', 'Judge the result']] as const) {
    const run = pipeline.jobs[id]?.steps?.find((candidate) => candidate.name === name)?.run ?? ''
    expect(run, id).not.toMatch(/export "\$MODEL_KEY_ENV/)
    expect(run, id).toContain('key_file="$(mktemp "$RUNNER_TEMP/model-key.XXXXXX")"')
    expect(run, id).toContain(`trap 'rm -f "$key_file"' EXIT`)
    expect(run, id).toContain('--env-file "$key_file"')
    expect(run, id).toMatch(/\[\[ ! "\$MODEL_KEY_ENV" =~ \^\[A-Za-z_\]\[A-Za-z0-9_\]\*\$ \]\]/)
    // Never as an argument either: the key's value is not on a command line.
    expect(run, id).not.toMatch(/-e "?\$MODEL_KEY/)
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
  // issue_comment is the reply to an advisory finding (#150): it runs the
  // advisory job alone.
  expect(Object.keys(caller.on).sort()).toEqual(['issue_comment', 'pull_request', 'push', 'workflow_dispatch'])
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
  // The identity (#61), by the names #155 stores the App under: until those
  // secrets exist each is empty and qare posts as the workflow run, and
  // setting them is the whole switch.
  for (const [secret, variable] of Object.entries(IDENTITY_SECRETS))
    expect((job.secrets as Record<string, string>)[secret]).toBe(`\${{ secrets.${variable} }}`)
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
  // Every input and every secret is documented by name.
  for (const name of [...Object.keys(call.inputs), ...Object.keys(call.secrets)]) expect(doc).toContain(`\`${name}\``)
})

test('the documentation says what each identity needs', () => {
  const doc = readFileSync(join(repoRoot, 'docs', 'pipeline.md'), 'utf8')
  const start = doc.indexOf('\n## GitHub identity\n')
  expect(start, 'docs/pipeline.md has no "GitHub identity" section').toBeGreaterThan(-1)
  const section = doc.slice(start, doc.indexOf('\n## ', start + 1))
  // The App's repository permissions, as #155 creates it.
  for (const permission of ['Contents', 'Issues', 'Pull requests', 'Checks', 'Metadata']) expect(section).toContain(`| ${permission} |`)
  // A documented caller passes the App, so the section is not prose alone.
  const callers = [...doc.matchAll(/```yaml\n([\s\S]*?)```/g)]
    .map((match) => match[1] ?? '')
    .filter((block) => block.includes(`uses: ViviDynamics/qare/${PIPELINE}@`))
  const passed = callers.flatMap((block) => Object.keys(((parse(block) as Workflow).jobs.qare?.secrets ?? {}) as Record<string, string>))
  for (const secret of Object.keys(IDENTITY_SECRETS)) expect(passed, `no documented caller passes ${secret}`).toContain(secret)
  // The two things a person choosing has to know.
  expect(section).toMatch(/triggers? no workflows/)
  expect(section).toMatch(/only a GitHub App (may|can) write a check run/i)
})

test('the caller qare init writes fits the interface, pins the current release, and is the documented one', () => {
  // #146: init writes the caller, so it is a third copy of the interface,
  // held to the pipeline the same way qare's own caller and the documented
  // one are. A new required input, a renamed secret or a permission a job
  // starts to need fails here, not in the first repository that runs init.
  const generated = {
    'for a target profile': callerWorkflow({ model: INIT_DEFAULT_MODEL }),
    'for a booted profile': callerWorkflow({ model: INIT_DEFAULT_MODEL, requeue: { branch: 'main' } }),
  }
  for (const [where, text] of Object.entries(generated)) {
    const caller = parse(text) as Workflow
    expect(Object.keys(caller.jobs), where).toEqual(['qare'])
    const job = caller.jobs.qare as Job
    expect(job.uses, where).toBe(`ViviDynamics/qare/${PIPELINE}@${version}`)
    expect(job.uses, where).toBe(`${PIPELINE_WORKFLOW}@${VERSION}`)
    expectCallFits(job, `the caller init writes ${where}`)
    expectCeilingCovers(job.permissions, `the caller init writes ${where}`)
    expect(Object.keys(job.with ?? {}), where).not.toContain('qare-ref')
    expect(Object.keys(caller.on), where).toContain('pull_request')
    // The secret init tells the person to add is the one the workflow reads,
    // and the variable the pipeline hands it to the provider in by default.
    expect((job.secrets as Record<string, string>)['model-key'], where).toBe(`\${{ secrets.${INIT_MODEL_SECRET} }}`)
    expect(call.inputs['model-key-env']?.default, where).toBe(INIT_MODEL_SECRET)
  }
  // Re-queueing runs on a push to the default branch that touches the
  // profile, which is where the pipeline's `profile` input points by default.
  const push = (parse(generated['for a booted profile']) as Workflow).on.push as { branches: string[]; paths: string[] }
  expect(push).toEqual({ branches: ['main'], paths: [`${String(call.inputs.profile?.default)}/**`] })

  // The smallest caller the documentation shows is, byte for byte, what
  // init writes: the two cannot tell a new repository different things.
  const doc = readFileSync(join(repoRoot, 'docs', 'pipeline.md'), 'utf8')
  const documented = [...doc.matchAll(/```yaml\n([\s\S]*?)```/g)].map((match) => match[1] ?? '')
  expect(documented).toContain(generated['for a target profile'])

  // The pin is the build's VERSION, which the release stamps from
  // package.json: the generator carries no release of its own to forget.
  const source = readFileSync(join(repoRoot, 'packages', 'core', 'src', 'init.ts'), 'utf8')
  expect(source).not.toMatch(/20\d{2}\.\d+\.\d+/)
  expect(source).toContain('`    uses: ${PIPELINE_WORKFLOW}@${VERSION}`')
  expect(VERSION).toBe(version)
  expect(readFileSync(join(repoRoot, 'scripts', 'sync-version.mjs'), 'utf8')).toContain("'packages', 'core', 'src', 'version.ts'")
})
