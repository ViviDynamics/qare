import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, test } from 'vitest'
import { parse } from 'yaml'
import { serializeLedger } from '@qare/core'

// #294: the main lane. A run against the default branch boots the app, runs
// the suites the ledger records for its active criteria, judges them, and
// hands the judged result to `qare-action main-findings` (#154). These tests
// hold what makes it safe to ship: it is off unless a caller turns it on, it
// is a dry run unless a caller says otherwise in one exact word, and the job
// that runs the repository's code holds no secret (rule 7).

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const PIPELINE = join(repoRoot, '.github', 'workflows', 'pipeline.yml')

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
  steps?: Step[]
}
interface Input {
  type: string
  default?: unknown
  description?: string
}

const text = readFileSync(PIPELINE, 'utf8')
const pipeline = parse(text) as { on: { workflow_call: { inputs: Record<string, Input> } }; jobs: Record<string, Job> }
const inputs = pipeline.on.workflow_call.inputs
const MAIN_JOBS = ['main_collect', 'main_execute', 'main_judge']
const IDENTITY = /secrets\.(app-id|app-private-key|personal-access-token)|QARE_APP_ID|QARE_APP_PRIVATE_KEY|QARE_GITHUB_TOKEN|GITHUB_TOKEN|GH_TOKEN|github\.token/

function job(id: string): Job {
  const found = pipeline.jobs[id]
  expect(found, `the pipeline declares no job named ${id}`).toBeDefined()
  return found as Job
}

function step(id: string, name: string): Step {
  const found = job(id).steps?.find((candidate) => candidate.name === name)
  expect(found, `${id} has no step named ${JSON.stringify(name)}`).toBeDefined()
  return found as Step
}

const needsOf = (id: string): string[] => [job(id).needs ?? []].flat()
// A script as one line: its line continuations folded away, so a command reads as it runs.
const oneLine = (value: string | undefined): string => (value ?? '').replace(/\\\n/g, ' ').replace(/\s+/g, ' ').trim()

test('the lane is three jobs in the shape of the pull request lane, named so the job sections stay readable', () => {
  for (const id of MAIN_JOBS) expect(Object.keys(pipeline.jobs)).toContain(id)
  // No model plans on main: the plan is read out of the ledger in main_collect.
  expect(Object.keys(pipeline.jobs).filter((id) => id.startsWith('main'))).toEqual(MAIN_JOBS)
  expect(needsOf('main_execute')).toEqual(['main_collect'])
  expect(needsOf('main_judge')).toEqual(['main_collect', 'main_execute'])
})

test('the lane is off by default: main-lane is an input with an empty default, and every main job hangs on it', () => {
  expect(inputs['main-lane']?.type).toBe('string')
  expect(inputs['main-lane']?.default).toBe('')
  expect(inputs['main-lane']?.description).toMatch(/\S/)
  // main_collect reads the input itself. The two after it run only on what
  // it produced, so a lane that is off starts none of them.
  expect(oneLine(job('main_collect').if)).toContain("inputs.main-lane == 'true' &&")
  expect(oneLine(job('main_execute').if)).toBe("needs.main_collect.outputs.criteria == 'present'")
  expect(oneLine(job('main_judge').if)).toBe("always() && needs.main_execute.outputs.verdict != ''")
  // The verdict main_judge waits on is one only main_execute's own step can set.
  expect(text).toContain('      verdict: ${{ steps.recorded.outputs.verdict }}\n')
})

test('the lane starts on a push, a schedule or a manual run alone, so a pull request and a comment start none of it', () => {
  const condition = oneLine(job('main_collect').if)
  // An allowlist, not a list of what to leave out: an event nobody thought of starts nothing.
  expect(condition).toContain(`contains(fromJSON('["push", "schedule", "workflow_dispatch"]'), github.event_name)`)
  expect(condition).not.toContain('pull_request')
  // Every condition is joined with &&: none of them can let the run in without the others.
  expect(condition).not.toContain('||')
})

test('the lane runs for the default branch alone', () => {
  expect(oneLine(job('main_collect').if)).toContain("github.ref == format('refs/heads/{0}', github.event.repository.default_branch)")
})

test('the pull request lane is untouched by the events the main lane runs on', () => {
  expect(job('collect').if).toBe("github.event_name == 'pull_request'")
  for (const id of ['plan', 'execute', 'judge']) expect(needsOf(id), id).not.toEqual(expect.arrayContaining(MAIN_JOBS))
})

test('main_execute runs the repository\'s code and holds nothing: no secret, no token, no credential left in the checkout', () => {
  const execute = job('main_execute')
  expect(JSON.stringify(execute)).not.toMatch(/secrets\.|github\.token|GITHUB_TOKEN|GH_TOKEN|MODEL_KEY/)
  expect(execute.permissions).toBeUndefined()
  const checkouts = (execute.steps ?? []).filter((candidate) => candidate.uses?.startsWith('actions/checkout@'))
  expect(checkouts).toHaveLength(1)
  expect(checkouts[0]?.with?.['persist-credentials']).toBe(false)
  // Its own runners when the caller names them, as execute.
  expect(execute['runs-on']).toBe('${{ fromJSON(inputs.execute-runs-on || inputs.runs-on) }}')
})

test('main_collect holds no model key and no identity, and leaves no credential in either checkout', () => {
  const collect = job('main_collect')
  expect(JSON.stringify(collect)).not.toMatch(/secrets\.|MODEL_KEY|QARE_APP_ID|QARE_APP_PRIVATE_KEY|QARE_GITHUB_TOKEN/)
  expect(collect.permissions).toEqual({ contents: 'read' })
  const checkouts = (collect.steps ?? []).filter((candidate) => candidate.uses?.startsWith('actions/checkout@'))
  expect(checkouts).toHaveLength(2)
  for (const checkout of checkouts) expect(checkout.with?.['persist-credentials']).toBe(false)
})

test('in main_judge no step holds both the model key and a GitHub identity, and the checkout leaves no token behind', () => {
  const judge = job('main_judge')
  const keyHolders: string[] = []
  const identityHolders: string[] = []
  for (const candidate of judge.steps ?? []) {
    const body = JSON.stringify(candidate)
    const key = body.includes('secrets.model-key')
    const identity = IDENTITY.test(body)
    expect(key && identity, `main_judge: ${candidate.name ?? ''} holds the model key and an identity`).toBe(false)
    if (key) keyHolders.push(candidate.name ?? '')
    if (identity) identityHolders.push(candidate.name ?? '')
  }
  expect(keyHolders).toEqual(['Judge the result on main'])
  expect(identityHolders).toEqual(['File what the run on main found'])
  const checkouts = (judge.steps ?? []).filter((candidate) => candidate.uses?.startsWith('actions/checkout@'))
  expect(checkouts).toHaveLength(1)
  expect(checkouts[0]?.with?.['persist-credentials']).toBe(false)
  // What filing needs, and what recording a pass needs (#295): contents: write
  // is for the push to the qa-assets branch, which is where a pass is
  // recorded. The lane never writes the default branch.
  expect(judge.permissions).toEqual({ contents: 'write', issues: 'write', 'pull-requests': 'read' })
})

// #295: a run on the default branch records what it proved, so the next
// failure is a regression against that pass. Off unless the caller asks, and
// written by the judge side alone.
test('recording a pass is off by default, only the exact word true turns it on, and only the filing step can do it', () => {
  expect(inputs['main-lane-record-passes']?.type).toBe('string')
  expect(inputs['main-lane-record-passes']?.default).toBe('')
  expect(inputs['main-lane-record-passes']?.description).toMatch(/qa-assets/)
  const file = step('main_judge', 'File what the run on main found')
  expect(file.env?.MAIN_LANE_RECORD_PASSES).toBe('${{ inputs.main-lane-record-passes }}')
  // No other step of the lane reads the input, and the job that runs the
  // repository's code has no token to write anything with.
  for (const id of MAIN_JOBS)
    for (const candidate of job(id).steps ?? [])
      if (candidate.name !== 'File what the run on main found') expect(JSON.stringify(candidate), `${id}: ${candidate.name ?? ''}`).not.toContain('record-passes')
  expect(JSON.stringify(job('main_execute'))).not.toMatch(/secrets\.|github\.token|GITHUB_TOKEN|GH_TOKEN/)
  expect(job('main_execute').permissions).toBeUndefined()
  expect(job('main_collect').permissions).toEqual({ contents: 'read' })

  const dir = mkdtempSync(join(tmpdir(), 'qare-main-record-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\necho "docker $*"\n')
  chmodSync(join(bin, 'docker'), 0o755)
  writeFileSync(join(dir, 'judged-result.json'), JSON.stringify({ schemaVersion: '1', verdict: 'passed', criteria: [{ id: 'sign-in', outcome: 'proven', evidence: [] }] }))
  const asked = (value: string | undefined, dryRun: string): { record: string; dry: string } => {
    const env: Record<string, string> = {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      IMAGE_REF: 'image',
      HEAD_SHA: 'c0ffee0123456789c0ffee0123456789c0ffee01',
      RUN_URL: 'run',
      EVIDENCE_URL: 'evidence',
      PROFILE: '.qa',
      MAIN_LANE_DRY_RUN: dryRun,
      GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
    }
    if (value !== undefined) env.MAIN_LANE_RECORD_PASSES = value
    const outcome = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', file.run ?? ''], { cwd: dir, env, encoding: 'utf8' })
    expect(outcome.status, outcome.stderr).toBe(0)
    const printed = readFileSync(join(dir, 'main-findings.txt'), 'utf8')
    return { record: /--record-passes (\S+)/.exec(printed)?.[1] ?? '', dry: /--dry-run (\S+)/.exec(printed)?.[1] ?? '' }
  }
  for (const value of [undefined, '', 'false', 'TRUE', 'True', ' true', 'true ', 'yes', '1', 'on']) expect(asked(value, 'false').record, JSON.stringify(value)).toBe('false')
  expect(asked('true', 'false')).toEqual({ record: 'true', dry: 'false' })
  // On a dry run the command is still told, so it can say what it would record; it writes nothing (held in the action's tests).
  expect(asked('true', 'true')).toEqual({ record: 'true', dry: 'true' })
})

test('the placement guard is the first step of the two main jobs that check the tree out, and it is the one guard', () => {
  const guard = "Keep a public repository's run off a self-hosted runner"
  const original = step('collect', guard).run
  for (const id of ['main_collect', 'main_execute']) {
    expect(job(id).steps?.[0]?.name, id).toBe(guard)
    expect(step(id, guard).run, id).toBe(original)
    expect(step(id, guard).env, id).toEqual(step('collect', guard).env)
  }
})

test('the steps the two lanes share are the same scripts, so a fix to one is a fix the other needs', () => {
  for (const name of ["Read the profile's flavour", "Find the runner's docker", 'Read the recorded verdict', 'Tear down what the run booted', 'Redact the evidence'])
    expect(step('main_execute', name).run, name).toBe(step('execute', name).run)
  expect(step('main_collect', 'Read the version of the pinned qare').run).toBe(step('collect', 'Read the version of the pinned qare').run)
  expect(step('main_judge', 'Read the executed verdict').run).toBe(step('judge', 'Read the executed verdict').run)
  // The images are the pinned qare's, read by main_collect.
  expect(step('main_execute', 'Pull the flavour image').env?.QARE_VERSION).toBe('${{ needs.main_collect.outputs.qare-version }}')
  expect(step('main_judge', 'Pull the core image').env?.QARE_VERSION).toBe('${{ needs.main_collect.outputs.qare-version }}')
})

test('the artifacts of the main lane have names of their own, so one workflow run can carry both lanes', () => {
  const names = (id: string): string[] =>
    (job(id).steps ?? []).filter((candidate) => candidate.uses?.startsWith('actions/upload-artifact@')).map((candidate) => String(candidate.with?.name))
  expect(names('main_collect')).toEqual(['main-inputs'])
  expect(names('main_execute')).toEqual(['main-evidence'])
  expect(names('main_judge')).toEqual(['main-judge-artifacts'])
  const pullRequestLane = ['collect', 'plan', 'execute', 'judge'].flatMap(names)
  for (const name of ['main-inputs', 'main-evidence', 'main-judge-artifacts']) expect(pullRequestLane).not.toContain(name)
})

test('main_execute runs the plan the ledger wrote, against the one revision the run was started for', () => {
  const run = step('main_execute', 'Run the plan on main')
  expect(run.env?.HEAD_SHA).toBe('${{ github.sha }}')
  const script = oneLine(run.run)
  expect(script).toContain('qare run --plan plan.json')
  expect(script).toContain('--base "$HEAD_SHA" --head "$HEAD_SHA"')
  // Named for the workflow run, so two runs on one runner never share a compose project.
  expect(script).toContain('--id "main-${RUN_ID}-${RUN_ATTEMPT}"')
  // The script is plain bash: nothing of the event is pasted into it.
  expect(run.run).not.toContain('${{')
})

test('main_judge asks the verifier with no diff, and files from the judged result, the ledger and the profile', () => {
  const judged = step('main_judge', 'Judge the result on main')
  expect(oneLine(judged.run)).toContain('qare judge --result evidence/result.json --outDir . --plan plan.json --no-diff --no-advisory --nare /usr/local/bin/nare --profile "$PROFILE"')
  // Fail closed without a key, and the key travels in a file, as in judge.
  expect(judged.run).toMatch(/if \[ -z "\$MODEL_KEY" \]; then\n(?:.*\n)*?\s*exit 1\n/)
  expect(judged.run).toContain('--env-file "$key_file"')
  expect(judged.run).not.toMatch(/-e "?\$MODEL_KEY/)
  const file = step('main_judge', 'File what the run on main found')
  expect(oneLine(file.run)).toContain('main-findings --result judged-result.json --ledger "$PROFILE" --profile "$PROFILE" --sha "$HEAD_SHA" --run-url "$RUN_URL" --artifact-url "$EVIDENCE_URL" --dry-run "$dry" --record-passes "$record" --passes-profile "$PROFILE"')
  expect(file.env?.HEAD_SHA).toBe('${{ github.sha }}')
  expect(file.env?.EVIDENCE_URL).toBe('${{ needs.main_execute.outputs.evidence-url }}')
  expect(file.run).not.toContain('${{')
})

test('a dry run is the default, and only the exact word false turns filing on', () => {
  expect(inputs['main-lane-dry-run']?.type).toBe('string')
  expect(inputs['main-lane-dry-run']?.default).toBe('true')
  const file = step('main_judge', 'File what the run on main found')
  expect(file.env?.MAIN_LANE_DRY_RUN).toBe('${{ inputs.main-lane-dry-run }}')
  // The step is run for real, with a docker that prints what it was asked
  // to run: what reaches main-findings is what the shell decided.
  const dir = mkdtempSync(join(tmpdir(), 'qare-main-dry-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\necho "docker $*"\n')
  chmodSync(join(bin, 'docker'), 0o755)
  writeFileSync(join(dir, 'judged-result.json'), JSON.stringify({ schemaVersion: '1', verdict: 'passed', criteria: [{ id: 'sign-in', outcome: 'proven', evidence: [] }] }))
  const asked = (value: string | undefined): string => {
    const summary = join(dir, `summary-${String(value)}.md`)
    const env: Record<string, string> = {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      IMAGE_REF: 'image',
      HEAD_SHA: 'c0ffee0123456789c0ffee0123456789c0ffee01',
      RUN_URL: 'run',
      EVIDENCE_URL: 'evidence',
      PROFILE: '.qa',
      GITHUB_STEP_SUMMARY: summary,
    }
    if (value !== undefined) env.MAIN_LANE_DRY_RUN = value
    const outcome = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', file.run ?? ''], { cwd: dir, env, encoding: 'utf8' })
    expect(outcome.status, outcome.stderr).toBe(0)
    const printed = readFileSync(join(dir, 'main-findings.txt'), 'utf8')
    const flag = /--dry-run (\S+)/.exec(printed)?.[1] ?? ''
    // The summary says which it was, in words.
    expect(readFileSync(summary, 'utf8')).toContain(flag === 'true' ? 'Nothing was filed and nobody was mentioned.' : '### Findings on main\n')
    expect(outcome.stdout).toMatch(/^::stop-commands::[0-9a-f]{32}\n/)
    return flag
  }
  for (const value of [undefined, '', 'true', 'TRUE', 'False', 'FALSE', ' false', 'false ', 'no', '0', 'off']) expect(asked(value), JSON.stringify(value)).toBe('true')
  expect(asked('false')).toBe('false')
})

test('the filing step says what the run amounted to before it says what it files, so nothing to file never reads as all passed', () => {
  const file = step('main_judge', 'File what the run on main found')
  const dir = mkdtempSync(join(tmpdir(), 'qare-main-amount-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  // main-findings, for a run in which nothing failed: it has nothing to file.
  // Its last two lines are what an issue body could carry: a fence, and a line shaped like a workflow command.
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\necho "dry run: nothing is written"\necho "no finding on main to file, update or close"\necho \'````\'\necho "::warning::from an issue body"\n')
  chmodSync(join(bin, 'docker'), 0o755)
  writeFileSync(
    join(dir, 'judged-result.json'),
    JSON.stringify({
      schemaVersion: '1',
      verdict: 'blocked',
      criteria: [
        { id: 'sign-in', outcome: 'proven', evidence: ['checks/sign-in/0/stdout.txt'] },
        { id: 'receipts', outcome: 'unverified', reason: 'the planner could not plan it: its ledger checks name no suite, so the runner has nothing to execute for it' },
        { id: 'exports', outcome: 'unverified', reason: 'verifier gave no readable answer' },
        { id: 'hostile', outcome: 'unverified', reason: 'verifier said\r\n::error::fake\nand more' },
      ],
    }),
  )
  const summary = join(dir, 'summary.md')
  const outcome = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', file.run ?? ''], {
    cwd: dir,
    env: { PATH: `${bin}:${process.env.PATH ?? ''}`, IMAGE_REF: 'image', HEAD_SHA: 'c0ffee0123456789c0ffee0123456789c0ffee01', RUN_URL: 'run', EVIDENCE_URL: '', PROFILE: '.qa', GITHUB_STEP_SUMMARY: summary },
    encoding: 'utf8',
  })
  expect(outcome.status, outcome.stderr).toBe(0)
  const expected = [
    'the run on main: verdict blocked; 1 proven, 0 failed, 3 unverified',
    '  unverified receipts: the planner could not plan it: its ledger checks name no suite, so the runner has nothing to execute for it',
    '  unverified exports: verifier gave no readable answer',
    // A reason is model text: its line breaks are folded, so no line of it can start a workflow command.
    '  unverified hostile: verifier said ::error::fake and more',
    'dry run: nothing is written',
    'no finding on main to file, update or close',
    '````',
    '::warning::from an issue body',
    '',
  ].join('\n')
  expect(readFileSync(join(dir, 'main-findings.txt'), 'utf8')).toBe(expected)
  // In the log the text sits between a stop-commands marker and its token,
  // so no line of it is read as a workflow command, whatever it says.
  const token = /^::stop-commands::([0-9a-f]{32})$/m.exec(outcome.stdout)?.[1]
  expect(token, outcome.stdout).toBeDefined()
  expect(outcome.stdout).toBe(`::stop-commands::${token}\n${expected}::${token}::\n`)
  // The job summary carries it as an indented block, which nothing in the
  // text can close: every line is indented, so nothing renders or mentions.
  const written = readFileSync(summary, 'utf8')
  expect(written).toContain(`\n${expected.split('\n').slice(0, -1).map((line) => `    ${line}`).join('\n')}\n`)
  expect(written.split('\n').filter((line) => line.startsWith('`'))).toEqual([])

  // A judged result that cannot be read stops the step: nothing is filed from a guess.
  writeFileSync(join(dir, 'judged-result.json'), '{"verdict":')
  const broken = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', file.run ?? ''], {
    cwd: dir,
    env: { PATH: `${bin}:${process.env.PATH ?? ''}`, IMAGE_REF: 'image', HEAD_SHA: 'c0ffee0123456789c0ffee0123456789c0ffee01', RUN_URL: 'run', EVIDENCE_URL: '', PROFILE: '.qa', GITHUB_STEP_SUMMARY: summary },
    encoding: 'utf8',
  })
  expect(broken.status).not.toBe(0)
})

test('main_collect plans from the ledger without a model: criteria present with an active criterion, none without, red when the ledger will not load', () => {
  const plan = step('main_collect', 'Plan from the checks the ledger records')
  expect(plan.id).toBe('inputs')
  expect(plan.env).toEqual({ PROFILE: '${{ inputs.profile }}' })
  expect(plan.run).not.toContain('${{')
  expect(existsSync(join(repoRoot, 'packages', 'cli', 'dist', 'index.js')), 'build before testing: the step runs the built CLI').toBe(true)
  const link = ['https:', '//example.test/pr/1'].join('')
  const collect = (ledger: string | undefined): { status: number | null; output: string; summary: string; plan: boolean } => {
    const dir = mkdtempSync(join(tmpdir(), 'qare-main-collect-'))
    // The pinned qare the job checked out, standing in as a file that runs
    // this tree's built CLI: a symlink would not do, because the CLI runs
    // only as the file node was asked for.
    mkdirSync(join(dir, '.qare-pipeline', 'packages', 'cli', 'dist'), { recursive: true })
    writeFileSync(
      join(dir, '.qare-pipeline', 'packages', 'cli', 'dist', 'index.js'),
      `import { main } from ${JSON.stringify(pathToFileURL(join(repoRoot, 'packages', 'cli', 'dist', 'index.js')).href)}\nprocess.exitCode = await main(process.argv.slice(2))\n`,
    )
    writeFileSync(join(dir, '.qare-pipeline', 'package.json'), '{"type":"module"}')
    mkdirSync(join(dir, '.qa'))
    if (ledger !== undefined) writeFileSync(join(dir, '.qa', 'ledger.json'), ledger)
    // A plan left by an earlier run on a runner that outlives its jobs.
    writeFileSync(join(dir, 'plan.json'), '{"stale":true}')
    const output = join(dir, 'output')
    const summary = join(dir, 'summary')
    writeFileSync(output, '')
    writeFileSync(summary, '')
    const outcome = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', plan.run ?? ''], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? '', PROFILE: '.qa', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
      encoding: 'utf8',
    })
    const written = existsSync(join(dir, 'plan.json')) && !readFileSync(join(dir, 'plan.json'), 'utf8').includes('stale')
    return { status: outcome.status, output: readFileSync(output, 'utf8'), summary: readFileSync(summary, 'utf8'), plan: written }
  }

  const active = collect(serializeLedger([{ criterion: 'sign-in', status: 'active', source: [link], proof: 'flow', text: 'A person signs in.', checks: ['suite:sign-in'] }]))
  expect(active.status).toBe(0)
  expect(active.output).toBe('criteria=present\n')
  expect(active.plan).toBe(true)
  expect(active.summary).toContain('1 active criteria (0 with no suite to run)')

  // Nothing active, and no ledger at all: said in the summary, and the later jobs skip.
  for (const ledger of [serializeLedger([{ criterion: 'sign-in', status: 'proposed', source: [link], proof: 'flow', checks: ['suite:sign-in'] }]), undefined]) {
    const none = collect(ledger)
    expect(none.status).toBe(0)
    expect(none.output).toBe('criteria=none\n')
    expect(none.plan).toBe(false)
    expect(none.summary).toContain('the ledger at .qa holds no active criterion, so there is nothing to run')
  }

  // A ledger that cannot be read is not "nothing to run" (rule 6).
  const broken = collect('{"entries": [], "schemaVersion": "1", "integrity": "sha256:nope"}')
  expect(broken.status).not.toBe(0)
  expect(broken.output).toBe('')
  expect(broken.plan).toBe(false)
})

test('the documentation shows a caller that turns the lane on as a dry run, and says what the ledger must hold', () => {
  const docs = readFileSync(join(repoRoot, 'docs', 'pipeline.md'), 'utf8')
  expect(docs).toContain("main-lane: 'true'")
  expect(docs).toMatch(/\| `main-lane` \| empty \|/)
  expect(docs).toMatch(/\| `main-lane-dry-run` \| `true` \|/)
  // #295: what a repository sets to get regressions, and where a pass is kept.
  expect(docs).toMatch(/\| `main-lane-record-passes` \| empty \|/)
  expect(docs).toContain("main-lane-record-passes: 'true'")
  expect(docs).toContain('passes/main.json')
  // What a repository's ledger must hold for the lane to have something to run.
  expect(docs).toContain('ledger.json')
  expect(docs).toMatch(/`active`/)
  expect(docs).toMatch(/`suite:<name>`/)
  const spec = readFileSync(join(repoRoot, 'docs', 'SPEC.md'), 'utf8')
  const findings = spec.slice(spec.indexOf('### Findings on main'), spec.indexOf('## GitHub identity'))
  expect(findings).toContain('main lane')
  expect(findings).toContain('main-lane-dry-run')
})
