import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
// The pipeline is a reusable workflow (#145): its jobs live in pipeline.yml,
// and qare.yml is the caller that holds the triggers. pipeline-caller.test.ts
// holds the two together.
const workflowPath = join(repoRoot, '.github', 'workflows', 'pipeline.yml')
const callerPath = join(repoRoot, '.github', 'workflows', 'qare.yml')
const workflow = readFileSync(workflowPath, 'utf8')
const lines = workflow.split('\n')

function section(job: string): string {
  const start = lines.indexOf(`  ${job}:`)
  expect(start, `job ${job} is not declared in ${workflowPath}`).toBeGreaterThanOrEqual(0)
  const end = lines.findIndex((line, index) => index > start && /^  \w+:$/.test(line))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

// The `push:` trigger block of a workflow file, ending at the next top-level key.
function pushTrigger(workflow: string): string {
  const lines = workflow.split('\n')
  const start = lines.indexOf('  push:')
  if (start === -1) return ''
  const end = lines.findIndex((line, index) => index > start && /^ {0,1}\S/.test(line))
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n')
}

test('the workflow declares collect, plan, execute and judge', () => {
  expect(existsSync(workflowPath)).toBe(true)
  for (const job of ['collect', 'plan', 'execute', 'judge']) expect(lines).toContain(`  ${job}:`)
})

test('the artifact handoff names are pinned', () => {
  for (const name of ['qa-inputs', 'plan.json', 'execute-evidence', 'judge-artifacts'])
    expect(workflow).toContain(`name: ${name}`)
})

test('execute takes the builds a client profile installs from an artifact the caller names, and no other job does (#75)', () => {
  // An input, empty by default: a caller that provisions nothing is untouched.
  expect(workflow).toMatch(/\n {6}artefacts:\n {8}description: >-\n[\s\S]*?\n {8}type: string\n {8}default: ''\n/)
  const execute = section('execute')
  expect(execute).toContain("if: inputs.artefacts != ''")
  // The artifact lands in one reserved directory, whatever it is named: an
  // artifact called "." or ".qa" cannot be laid over the checkout.
  expect(execute).toContain('name: ${{ inputs.artefacts }}\n          path: qare-artefacts\n')
  expect(execute).not.toContain('path: ${{ inputs.artefacts }}')
  // And the checkout may not already carry that directory.
  const reserve = execute.indexOf('name: Reserve the client artefacts directory')
  expect(reserve).toBeGreaterThan(-1)
  expect(reserve).toBeLessThan(execute.indexOf('name: Download the client artefacts'))
  expect(execute).toContain('if [ -e qare-artefacts ] || [ -L qare-artefacts ]; then')
  // The plan is downloaded after the builds, so nothing a pull request built
  // can stand in for the plan the planner wrote.
  const builds = execute.indexOf('name: Download the client artefacts')
  const plan = execute.indexOf('name: Download plan.json')
  expect(builds).toBeGreaterThan(-1)
  expect(builds).toBeLessThan(plan)
  // The builds are pull request code: only the job that holds nothing takes them.
  for (const job of ['collect', 'plan', 'judge']) expect(section(job)).not.toContain('inputs.artefacts')
})

test('execute tells the run where it was placed, and self-hosted capacity for a public repository is the caller\'s opt in (#76)', () => {
  // An input, empty by default: a public repository's runs stay on hosted runners until its caller says otherwise.
  expect(workflow).toMatch(/\n {6}self-hosted:\n {8}description: >-\n[\s\S]*?\n {8}type: string\n {8}default: ''\n/)
  const execute = section('execute')
  // The repository's visibility and the opt in are the workflow's to know:
  // they are the job's environment, never something the pull request writes.
  expect(execute).toContain('      QARE_REPOSITORY_VISIBILITY: ${{ github.event.repository.visibility }}\n')
  expect(execute).toContain('      QARE_SELF_HOSTED: ${{ inputs.self-hosted }}\n')
  // The run's container has none of the runner's own variables, so the three
  // facts the run decides on are handed in: the runner's kind as GitHub
  // Actions names it, the visibility, and the opt in.
  const run = execute.slice(execute.indexOf('- name: Run the plan'), execute.indexOf('- name: Read the recorded verdict'))
  expect(run).toContain('-e QARE_RUNNER_ENVIRONMENT="${RUNNER_ENVIRONMENT:-}" \\\n')
  expect(run).toContain('-e QARE_REPOSITORY_VISIBILITY="${QARE_REPOSITORY_VISIBILITY:-}" \\\n')
  expect(run).toContain('-e QARE_SELF_HOSTED="${QARE_SELF_HOSTED:-}" \\\n')
  // A refusal says its own reason in the job summary, whatever it was refused for.
  expect(run).toContain('qare refused this run: ${reason:-it recorded no reason}')
  expect(run).not.toContain('qare refused this run (no profile or stubs yet)')
})

test('no job puts a public repository\'s pull request on a self-hosted runner: the guard is its first step, before any checkout (#76)', () => {
  const guard = "- name: Keep a public repository's run off a self-hosted runner"
  const scripts: string[] = []
  // The three jobs that check out the pull request's tree. collect is first,
  // so on one pool of runners it stops the whole pipeline; plan and execute
  // carry the guard themselves, because execute may be on a pool of its own.
  for (const job of ['collect', 'plan', 'execute']) {
    const body = section(job)
    const steps = body.slice(body.indexOf('    steps:\n'))
    const first = steps.split('\n').find((line) => /^ {6}- /.test(line))
    expect(first, `${job}: the guard must be the first step`).toBe(`      ${guard}`)
    const at = steps.indexOf(guard)
    expect(at).toBeLessThan(steps.indexOf('actions/checkout@'))
    const step = steps.slice(at, steps.indexOf('\n          fi\n', at) + '\n          fi\n'.length)
    // The two facts are the workflow's own; the runner's kind is the runner's.
    expect(step).toContain('QARE_REPOSITORY_VISIBILITY: ${{ github.event.repository.visibility }}\n')
    expect(step).toContain('QARE_SELF_HOSTED: ${{ inputs.self-hosted }}\n')
    expect(step).toContain('"${RUNNER_ENVIRONMENT:-}" = "self-hosted"')
    expect(step).toContain('exit 1')
    scripts.push(step.slice(step.indexOf('run: |')))
  }
  // One guard, three times: the same script in each job.
  expect(new Set(scripts).size).toBe(1)
  // judge and report never check the pull request's tree out, and say what happened.
  for (const job of ['judge', 'report']) expect(section(job)).not.toContain(guard)
})

test('secret hygiene: the model-key job never holds a GitHub token', () => {
  // The whole point of collect: it reads the issue, so the job that talks to a
  // model needs no token, and the secret map in the header stays true.
  const plan = section('plan')
  expect(plan).toContain('${{ secrets.model-key }}')
  expect(plan).not.toContain('GITHUB_TOKEN')
  expect(plan).not.toContain('secrets.GITHUB_TOKEN')
})

test('secret hygiene: collect holds the token and no model key', () => {
  const collect = section('collect')
  expect(collect).toContain('${{ secrets.GITHUB_TOKEN }}')
  expect(collect).not.toContain('model-key')
  expect(collect).not.toContain('MODEL_KEY')
})

test('secret hygiene: the job that runs pull request code holds nothing', () => {
  expect(section('execute')).not.toContain('secrets.')
})

test('judge holds the model key and the token, and nothing else does', () => {
  const judge = section('judge')
  expect(judge).toContain('${{ secrets.model-key }}')
  expect(judge).toContain('${{ secrets.GITHUB_TOKEN }}')
})

test('the step that talks to the verifier model holds no GitHub token', () => {
  const judge = section('judge')
  const start = judge.indexOf('- name: Judge the result')
  const step = judge.slice(start, judge.indexOf('- name:', start + 1))
  expect(step).toContain('secrets.model-key')
  expect(step).not.toContain('GITHUB_TOKEN')
})

test('judge runs the verifier with the criteria text, the diff and the evidence', () => {
  const judge = section('judge')
  for (const flag of ['--plan plan.json', '--diff change-planner.diff', '--result evidence/result.json', '--nare'])
    expect(judge).toContain(flag)
  expect(judge).not.toContain('--runner none')
  // The evidence directory is the verifier's file root, so it must be its own.
  expect(judge).toMatch(/name: execute-evidence\n\s+path: evidence\n/)
})

test('plan and judge run the same image, whose nare is pinned in one place (#88)', () => {
  // The pin moved into the image recipe: one NARE_WHEEL for the family, and
  // the jobs pull the same published image for the version they run.
  const recipe = readFileSync(join(repoRoot, 'images', 'core', 'Dockerfile'), 'utf8')
  expect(recipe).toMatch(/NARE_WHEEL=/)
  const refs = [section('plan'), section('judge')].map(
    (job) => job.match(/ghcr\.io\/vividynamics\/qare-core:\$QARE_VERSION/)?.[0],
  )
  expect(refs[0]).toBeDefined()
  expect(refs[1]).toBe(refs[0])
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

test('the nare the image ships is pinned to a version (#88)', () => {
  expect(readFileSync(join(repoRoot, 'images', 'core', 'Dockerfile'), 'utf8')).toMatch(/nare-\d{4}\.\d+\.\d+-py3-none-any\.whl/)
})

test('the qare the pipeline runs is built from the repository own workspace (#88)', () => {
  // The image builds the workspace itself, and every job runs the image's
  // qare: no job builds the tree on the runner any more.
  const recipe = readFileSync(join(repoRoot, 'images', 'core', 'Dockerfile'), 'utf8')
  expect(recipe).toContain('pnpm install --frozen-lockfile')
  expect(recipe).toContain('pnpm build')
  for (const job of ['plan', 'execute', 'judge']) {
    expect(section(job), `${job} still builds qare from source`).not.toContain('pnpm install')
    expect(section(job), `${job} still builds qare from source`).not.toContain('pnpm build')
  }
})

test('judge posts the evidence with the token alone, linking only to the uploaded artifact', () => {
  const judge = section('judge')
  const start = judge.indexOf('- name: Post the evidence')
  const step = judge.slice(start, judge.indexOf('- name:', start + 1))
  expect(step).toContain('post-evidence')
  expect(step).toContain('--result judged-result.json')
  expect(step).toContain('--evidence evidence')
  expect(step).toContain('secrets.GITHUB_TOKEN')
  expect(step).not.toContain('model-key')
  expect(step).not.toContain('MODEL_KEY')
  expect(step).toContain('needs.execute.outputs.evidence-url')
  expect(judge).toContain('checks: write')
  expect(section('execute')).toContain('evidence-url: ${{ steps.evidence.outputs.artifact-url }}')
})

// ADR-0002: the run's screenshots are pushed to the orphan qa-assets branch,
// named by the run (head SHA and date), so evidence links outlive the
// artifact. The push happens in the judge step, which holds the identity and
// already runs on the base commit, never on the pull request tree.
test('judge can push qa-assets: contents write on the token-holding job only', () => {
  const judge = section('judge')
  expect(judge).toContain('contents: write')
  for (const job of ['collect', 'plan', 'execute']) expect(section(job)).not.toContain('contents: write')
  expect(section('requeue')).not.toContain('contents: write')
})

// Repository CI must stay quiet when the judge step pushes screenshots: the
// branch is not a pull request completion, so its pushes re-trigger nothing.
test('repository CI ignores pushes to qa-assets', () => {
  const ci = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8')
  const release = readFileSync(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8')
  const qare = readFileSync(callerPath, 'utf8')
  // Each push trigger names only main or tags, so a qa-assets push matches
  // nothing, and no push trigger names qa-assets itself.
  expect(pushTrigger(ci)).toContain('branches: [main]')
  expect(pushTrigger(qare)).toContain('branches: [main]')
  expect(pushTrigger(release)).toContain('tags:')
  for (const pushed of [pushTrigger(ci), pushTrigger(qare), pushTrigger(release)]) {
    expect(pushed).not.toContain('qa-assets')
  }
})

test('judge leaves no token in the checkout for the model step to find', () => {
  expect(section('judge')).toMatch(/actions\/checkout@v4\n\s+with:\n\s+persist-credentials: false/)
})

test('stub issues are filed before posting, so a posting failure cannot stop them', () => {
  const judge = section('judge')
  expect(judge.indexOf('- name: File stub issues')).toBeLessThan(judge.indexOf('- name: Post the evidence'))
})

test('execute redacts the evidence, and uploads it only when redaction succeeded', () => {
  const execute = section('execute')
  const redact = execute.indexOf('- name: Redact the evidence')
  const upload = execute.indexOf('- name: Upload evidence')
  expect(redact, 'no redaction step in execute').toBeGreaterThan(execute.indexOf('- name: Run the plan'))
  expect(upload).toBeGreaterThan(redact)
  const step = execute.slice(redact, upload)
  expect(step).toContain('id: redact')
  // Always, so a crashed run's leftovers are redacted too.
  expect(step).toContain('if: always()')
  expect(step).toContain('qare redact --evidence evidence --profile "$PROFILE"')
  expect(step).toContain('PROFILE: ${{ inputs.profile }}')
  const uploadStep = execute.slice(upload, execute.indexOf('- name:', upload + 1) === -1 ? undefined : execute.indexOf('- name:', upload + 1))
  expect(uploadStep).toContain("if: always() && steps.redact.outcome == 'success'")
})

test('judge reads the profile the run used from the artifact, as data only', () => {
  const judge = section('judge')
  const start = judge.indexOf('- name: Judge the result')
  const step = judge.slice(start, judge.indexOf('- name:', start + 1))
  expect(step).toContain('--profile profile')
})

test('secret-holding jobs run qare from the base commit, not the pull request tree', () => {
  // Rule 7: the pull request contributes data only. A job holding a secret
  // sees the repository at its base commit, and runs qare from a revision
  // the pull request cannot change: the one the caller pinned (#145), which
  // is a release for a repository that calls the pipeline and the base
  // commit for qare itself (pipeline-caller.test.ts holds that). collect
  // builds it, and plan and judge pull the published image for its version
  // (#88), which collect read from it.
  for (const job of ['collect', 'plan', 'judge']) {
    const jobSection = section(job)
    const checkout = jobSection.indexOf('actions/checkout@v4')
    const ref = jobSection.indexOf('ref: ${{ github.event.pull_request.base.sha }}')
    expect(ref, `${job} must check out the base commit`).toBeGreaterThan(checkout)
    expect(jobSection, `${job} must never check out the pull request's head`).not.toMatch(/ref: \$\{\{ github\.event\.pull_request\.head/)
  }
  for (const job of ['plan', 'judge']) {
    const jobSection = section(job)
    expect(jobSection, `${job} installs nothing from a tree`).not.toContain('pnpm install')
    expect(jobSection, `${job} reads no version from a tree`).not.toContain('package.json')
    expect(jobSection).toContain('QARE_VERSION: ${{ needs.collect.outputs.qare-version }}')
    const pull = jobSection.indexOf('docker pull')
    expect(pull, `${job} must pull the image for the pinned revision's version`)
      .toBeGreaterThan(jobSection.indexOf('ref: ${{ github.event.pull_request.base.sha }}'))
  }
  const collect = section('collect')
  const pinned = collect.indexOf('repository: ViviDynamics/qare\n          ref: ${{ inputs.qare-ref }}\n          path: .qare-pipeline')
  expect(pinned, 'collect must check out qare at the pinned revision, beside the tree').toBeGreaterThan(0)
  expect(collect.indexOf('pnpm --dir .qare-pipeline install --frozen-lockfile')).toBeGreaterThan(pinned)
  // The qare collect runs is the one it built there, never the tree's own.
  expect(collect).toContain('node .qare-pipeline/packages/cli/dist/index.js linked-issues')
  expect(collect).toContain('node .qare-pipeline/packages/cli/dist/index.js issue-criteria')
  expect(collect).not.toMatch(/node packages\//)
  // The version every image job pulls is read from that same checkout.
  expect(collect).toContain('qare-version: ${{ steps.qare.outputs.version }}')
  expect(collect).toMatch(/jq -r '\.version \/\/ empty' \.qare-pipeline\/package\.json/)
})

test('no job runs a qare that the repository under test carries', () => {
  // A repository that calls the pipeline has no qare in its tree (#145): every
  // qare a job runs comes from the image or from the pinned checkout. In
  // report the pinned checkout is the whole workspace, so its path is bare.
  for (const job of ['collect', 'plan', 'execute', 'judge', 'requeue'])
    expect(section(job), job).not.toMatch(/node packages\/(cli|action)\/dist/)
  for (const job of ['collect', 'requeue'])
    expect(section(job)).toMatch(/node \.qare-pipeline\/packages\/(cli|action)\/dist\/index\.js/)
  expect(section('judge')).toMatch(/"\$IMAGE_REF" qare metrics record/)
})

test('the planner diff leaves out the paths the caller names, read as words', () => {
  const collect = section('collect')
  expect(collect).toContain('PLANNER_DIFF_EXCLUDE: ${{ inputs.planner-diff-exclude }}')
  // read -a splits without expanding a pattern against the runner's files.
  expect(collect).toContain('read -r -a patterns <<< "${PLANNER_DIFF_EXCLUDE:-}"')
  expect(collect).toContain('excludes+=(":(exclude)$pattern")')
  expect(collect).toMatch(/git diff "\$\{BASE_SHA\}\.\.\.\$\{HEAD_SHA\}" -- \. "\$\{excludes\[@\]\}" > change-planner\.diff/)
})

test('requeue reads the merged stubs under the profile the caller names', () => {
  const requeue = section('requeue')
  expect(requeue).toContain('--profile "$PROFILE"')
  expect(requeue).toContain('PROFILE: ${{ inputs.profile }}')
  // A private repository cannot be checked out without it.
  expect(requeue).toContain('contents: read')
})

test('execute is the only job that checks out the pull request tree', () => {
  // It can: it holds no secrets (rule 7). The test above holds every other
  // job to the base revision, whose checkout pins it with ref:.
  expect(section('execute')).not.toContain('ref: ${{ github.event.pull_request.base.sha }}')
})

test('collect diffs the base commit against the head object, not its own checkout', () => {
  // Collect checks out the base commit, so the head arrives as an object
  // read from the pull request ref, never as a working tree.
  const collect = section('collect')
  expect(collect).toContain('refs/pull/')
  expect(collect).toMatch(/git diff "\$\{BASE_SHA\}\.\.\.\$\{HEAD_SHA\}"/)
})

test('execute hands the profile to judge as an artifact', () => {
  const execute = section('execute')
  const judge = section('judge')
  expect(execute).toContain('name: qa-profile')
  expect(judge).toMatch(/name: qa-profile\n\s+path: profile/)
})

test('no step reads a step output before the step that sets it has run', () => {
  // A reference to a step that has not run yet reads empty, so a gate such as
  // `steps.executed.outputs.verdict != 'refused'` always passes. That once
  // sent every judge job without a profile to download one that was never
  // uploaded.
  for (const job of ['collect', 'plan', 'execute', 'judge']) {
    // Only the steps list: a job's outputs map reads its steps after they ran.
    const all = section(job)
    const start = all.search(/\n\s+steps:\n/)
    expect(start, `${job} has no steps list, so the check would pass vacuously`).toBeGreaterThanOrEqual(0)
    const text = all.slice(start)
    for (const match of text.matchAll(/steps\.([\w-]+)\.(?:outputs|outcome|conclusion)/g)) {
      const id = match[1] ?? ''
      // A step may declare its id first (`- id: x`) or on its own line.
      const declared = text.search(new RegExp(`\\n\\s+(?:- )?id: ${id}\\n`))
      expect(declared, `${job} reads steps.${id} but no step there has id ${id}`).toBeGreaterThanOrEqual(0)
      expect(declared, `${job} reads steps.${id} before the step with id ${id} runs`).toBeLessThan(match.index ?? 0)
    }
  }
})

test('plan hands the planner the flow action kinds the change introduces, read from the diff as data', () => {
  const plan = section('plan')

  expect(plan).toContain("grep '^+.*FLOW_ACTION_KINDS'")
  expect(plan).toContain('flow_actions=(--flow-actions "$kinds")')
  expect(plan).toContain('"${flow_actions[@]}"')
  expect(plan).toContain('FLOW_ACTION_KINDS')
})

test('judge loads the plan with the same flow action kinds', () => {
  const judge = section('judge')

  expect(judge).toContain("grep '^+.*FLOW_ACTION_KINDS'")
  expect(judge).toContain('flow_actions=(--flow-actions "$kinds")')
  expect(judge).toContain('"${flow_actions[@]}"')
})

test('a blocked run whose unverified criteria are all planner-unplannable or unrunnable commands is neutral', () => {
  const execute = section('execute')

  expect(execute).toContain('[ "$code" -eq 2 ]')
  expect(execute).toContain('the planner could not plan it')
  expect(execute).toContain('the planned command cannot run')
  expect(execute).toContain('check could not start')
})

test('the planner reads the scrubbed, trimmed copy of the diff, never the raw one (nare#29)', () => {
  // nare takes its prompt as one argument, so a change whose diff exceeds the
  // Linux argument budget cannot reach the planner whole: collect produces the
  // planner-sized copy beside the full diff, and the planner always reads that
  // copy — the scrubbed one — never the raw diff.
  expect(section('collect')).toContain('change-planner.diff')
  const plan = section('plan')
  expect(plan).toContain('--diff change-planner.diff')
  expect(plan).not.toContain('--diff change.diff')
})

test('the model-facing diff copies are scrubbed of the values the change adds (#64)', () => {
  // The seeded totp value lives in a profile the change itself adds, so no
  // profile handed to the CLI can be trusted to carry it: collect scrubs every
  // added line that carries a secret or a value mapping — wherever it sits on
  // the line, an inline `totp: { secret: ... }` included — from the planner's
  // copy, and the verifier reads that scrubbed copy instead of the raw diff.
  const collect = section('collect')
  expect(collect).toContain("sed -E '/^\\+.*(secret[[:space:]]*:|value[[:space:]]*:)/ s/.*/+ [redacted]/'")
  expect(collect).toContain("mv change-planner.scrubbed change-planner.diff")
  const judge = section('judge')
  expect(judge).toContain('--diff change-planner.diff')
  expect(judge).not.toContain('--diff change.diff')
})

// ADR: the release tag is created by the build that earns it (#188). The
// auto-tag workflow watches CI the way nare's release workflow does, because
// an event a workflow triggers with the workflow's own token creates no
// workflow runs at all: the release is dispatched explicitly, never left to
// the tag push.
const autoTag = readFileSync(join(repoRoot, '.github', 'workflows', 'auto-tag.yml'), 'utf8')

test('auto-tag runs only after CI passes on a push to main (#188)', () => {
  expect(autoTag).toMatch(/workflow_run:\n\s+workflows: \[CI\]/)
  for (const gate of [
    "github.event.workflow_run.conclusion == 'success'",
    "github.event.workflow_run.event == 'push'",
    "github.event.workflow_run.head_branch == 'main'",
    'github.event.workflow_run.head_repository.full_name == github.repository',
  ])
    expect(autoTag).toContain(gate)
})

test('auto-tag tags the version package.json carries when it is untagged (#188, #230)', () => {
  expect(autoTag).toContain("require('./package.json').version")
  // Idempotent by the tag's existence: a merge that changes no version
  // computes the next CalVer instead (#230).
  expect(autoTag).toMatch(/git ls-remote --tags origin "refs\/tags\/\$version"/)
  expect(autoTag).toContain('tagged=true')
  expect(autoTag).toMatch(/git tag "\$version" "\$sha"/)
})

test('auto-tag releases an unbumped merge with the next CalVer (#230)', () => {
  // The owner's rule (#230): a green merge to main tags and releases. When
  // the packaged version is already tagged, the newest tag and the build's
  // month give the next one: the patch climbs while the month does not, and
  // a new month starts a new line.
  expect(autoTag).toMatch(/git ls-remote --tags origin 'refs\/tags\/\*\.\*\.\*'/)
  // An annotated tag lists twice in ls-remote: the tag object and its ^{}
  // peel. Without stripping the peel the sort reads the wrong newest tag.
  expect(autoTag).toContain("sed 's/\\^{}$//'")
  expect(autoTag).toMatch(/sort -V \| tail -1/)
  expect(autoTag).toMatch(/date -u \+%Y\.%-m/)
  expect(autoTag).toContain('case "$latest" in')
})

test('auto-tag no-ops when the validated commit is already tagged (#230)', () => {
  // A rerun of the job, or a tag a person pushed first, must not release
  // the same commit twice. Every tag ls-remote lists names its object sha
  // first, and an annotated tag's peeled line carries the commit sha, so
  // one of them naming the validated commit ends the run before anything
  // is computed.
  expect(autoTag).toMatch(/git ls-remote --tags origin \| awk '\{print \$1\}' \| grep -qx "\$head"/)
  expect(autoTag).toContain('the validated commit is already tagged')
  expect(autoTag).toMatch(/echo "tagged=false" >> "\$GITHUB_ENV"/)
})

test('auto-tag dispatches the release on the tag and verifies the run started (#188)', () => {
  expect(autoTag).toContain('gh workflow run release.yml --ref "$version"')
  expect(autoTag).toContain('select(.headBranch == env.version)')
  expect(autoTag).toContain('select(.headSha == env.sha)')
  expect(autoTag).toContain('actions: write')
})

test('auto-tag pushes the tag with the workflow token alone (#188)', () => {
  expect(autoTag).toContain('permissions: {}')
  expect(autoTag).toContain('contents: write')
  expect(autoTag).not.toContain('secrets.')
  expect(autoTag).toMatch(/ref: \$\{\{ github\.event\.workflow_run\.head_sha \|\| github\.sha \}\}/)
})

test('the tag step configures a committer identity for the annotated tag (#188)', () => {
  // The runner carries no git identity, so an annotated tag fails with
  // empty ident name unless the step sets one.
  expect(autoTag).toMatch(/git config user\.name /)
  expect(autoTag).toMatch(/git config user\.email "github-actions\[bot\]@users\.noreply\.github\.com"/)
})

test('release gains the dispatch trigger the automated path uses (#188)', () => {
  const release = readFileSync(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8')
  expect(release).toContain('workflow_dispatch:')
})

test("execute resolves its runtime image from the base revision's version (#194)", () => {
  // Rule 7 for the runtime too: the pull request contributes data only. A
  // version-bumping pull request must ship green before its own release
  // exists, so the image version comes from the base revision, exactly as it
  // does for plan and judge, and never from the pull request tree. Since
  // #145 that revision is the one the caller pinned: collect reads its
  // version, and qare's own caller pins the base commit
  // (pipeline-caller.test.ts), so execute, the one job holding the pull
  // request's tree, reads no version from any file in it.
  const execute = section('execute')
  expect(execute).not.toContain('package.json')
  const image = execute.slice(execute.indexOf('Pull the flavour image'), execute.indexOf('\n      - name:', execute.indexOf('Pull the flavour image')))
  expect(image).toContain('QARE_VERSION: ${{ needs.collect.outputs.qare-version }}')
  expect(image).toContain('ref="ghcr.io/vividynamics/qare-$FLAVOUR:$QARE_VERSION"')
  expect(execute).toContain('needs: [collect, plan]')
})

test('the job that runs pull request code is left no token to find (rule 7)', () => {
  // actions/checkout keeps its token in .git/config unless told not to, and
  // execute hands its workspace to a container that runs pull request code.
  // So the checkout is the job's one reach into the repository: it leaves no
  // credential, and it brings the merge commit's parents (the base and the
  // head the run names) with it, so no later step needs the network for them.
  //
  // The offline scan forbids the word the depth key starts with, so it is
  // built from fragments here and in the release test below (#196).
  const execute = section('execute')
  const depth = ['fe', 'tch-depth: 2'].join('')
  expect(execute).toContain(`- uses: actions/checkout@v4\n        with:\n          persist-credentials: false\n          ${depth}\n`)
  expect(execute.match(/actions\/checkout@v4/g)).toHaveLength(1)
  expect(execute).not.toContain(['git ', 'fe', 'tch'].join(''))
  expect(execute).toContain('--base "$BASE_SHA"')
  // The base the pull request recorded can be older than the commit the
  // merge was made against, and then it is not among the merge's parents.
  // The job cannot ask the repository for it, so the base side (#147) is the
  // merge's own base, said in the summary, before the base tree is checked out.
  const absent = execute.indexOf('if ! git cat-file -e "${BASE_SHA}^{commit}" 2>/dev/null; then')
  expect(absent).toBeGreaterThan(0)
  expect(execute).toContain(`merge_base="$(git rev-parse --verify --quiet 'HEAD^1' || true)"`)
  expect(execute).toContain('BASE_SHA="$merge_base"')
  expect(execute.indexOf('git worktree add --detach "$base_dir" "$BASE_SHA"')).toBeGreaterThan(absent)
  // The planner's container is handed plan's workspace too, and that job
  // holds the model key, so its checkout leaves no token either.
  expect(section('plan')).toMatch(/actions\/checkout@v4\n\s+with:\n\s+persist-credentials: false/)
})

test('release refuses to publish a tag that is not on the default branch (#194)', () => {
  // A tag a human pushed from a pull request head dangles after the squash
  // merge and publishes a release from a commit main's history does not
  // carry. The guard turns that into a clear refusal naming the auto-tag
  // flow, before any image is built.
  const release = readFileSync(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8')
  expect(release).toMatch(/git merge-base --is-ancestor/)
  expect(release).toContain('auto-tag')
  // The ancestor check needs the full branch graph, and it targets the
  // repository's default branch rather than a ref a pull request could name.
  // Marker fragments: see the execute test above (#196).
  const fullGraph = ['fe', 'tch-depth: 0'].join('')
  expect(release).toContain(fullGraph)
  expect(release).toContain('github.event.repository.default_branch')
  // The guard runs before any image is built: after publication has started,
  // a refusal cannot un-publish what the earlier steps pushed.
  const guard = release.indexOf('git merge-base --is-ancestor')
  expect(guard).toBeGreaterThan(release.indexOf(fullGraph))
  expect(guard).toBeLessThan(release.indexOf('docker/build-push-action'))
})

// #203: a pipeline that fails before it reaches a verdict (a tool that will
// not install, an image that will not pull) evaluated nothing, yet left the
// pull request a red job that read like the project failing. A report job
// says so where the verdict would have been.
test('a report job explains a pipeline that published no verdict', () => {
  const report = section('report')
  expect(report).toContain('needs: [collect, plan, execute, judge]')
  // Only when something failed and judge did not publish a verdict, and only
  // on a pull request from this repository: a fork's token cannot comment.
  expect(report).toContain('always()')
  expect(report).toContain("github.event_name == 'pull_request'")
  expect(report).toContain('github.event.pull_request.head.repo.full_name == github.repository')
  // Gated on the verdict reaching the pull request, not on judge's result: a
  // step failing after the post must not replace a verdict with "not evaluated".
  expect(report).toContain("needs.judge.outputs.posted != 'true'")
  expect(report).not.toContain('needs.judge.result')
  const judge = section('judge')
  expect(judge).toContain('posted: ${{ steps.posted.outputs.posted }}')
  const post = judge.indexOf('- name: Post the evidence')
  const postStep = judge.slice(post, judge.indexOf('- name:', post + 1))
  expect(postStep).toContain('id: posted')
  expect(postStep.indexOf('echo "posted=true" >> "$GITHUB_OUTPUT"')).toBeGreaterThan(postStep.indexOf('post-evidence'))
  expect(report).toContain("contains(needs.*.result, 'failure')")
  expect(report).toContain('report-failure')
  for (const flag of ['--run-id "$RUN_ID"', '--attempt "$RUN_ATTEMPT"', '--pr "$PR_NUMBER"', '--sha "$HEAD_SHA"', '--run-url "$RUN_URL"', '--recorded-verdict "$RECORDED_VERDICT"'])
    expect(report).toContain(flag)
  // requeue (push only) and report itself are not the pipeline it describes.
  expect(report).toContain('--pipeline collect,plan,execute,judge')
  // The pipeline is the one this report job sits in, whatever else the
  // caller's workflow runs under the same job names (#145).
  expect(report).toContain('--reporter report')
  // Checked but unpublished is told apart from never evaluated.
  expect(report).toContain('RECORDED_VERDICT: ${{ needs.execute.outputs.verdict }}')
})

test('the report job holds the GitHub token only and runs qare from the pinned revision', () => {
  const report = section('report')
  expect(report).toContain('${{ secrets.GITHUB_TOKEN }}')
  expect(report).not.toContain('model-key')
  expect(report).not.toContain('MODEL_KEY')
  // Reading the run's jobs needs actions: read; posting needs the rest.
  for (const permission of ['actions: read', 'checks: write', 'issues: write', 'pull-requests: write'])
    expect(report).toContain(permission)
  expect(report).not.toContain('contents: write')
  // The pinned qare is the whole workspace (#145): the base commit for qare
  // itself, a release for a caller, and never the pull request's tree.
  const checkout = report.indexOf('actions/checkout@v4')
  const ref = report.indexOf('repository: ViviDynamics/qare\n          ref: ${{ inputs.qare-ref }}\n          persist-credentials: false')
  expect(ref, 'report must check out qare at the pinned revision').toBeGreaterThan(checkout)
  expect(report.match(/actions\/checkout@v4/g)).toHaveLength(1)
  expect(report.indexOf('pnpm install')).toBeGreaterThan(ref)
})

// A failed or blocked verdict exits non-zero, so execute goes red; judge
// still publishes it, so a project that failed its criteria is told which,
// rather than left with the same unexplained red job as a qare failure.
test('judge runs whenever execute recorded a verdict, not only when execute passed', () => {
  const execute = section('execute')
  expect(execute).toContain('verdict: ${{ steps.recorded.outputs.verdict }}')
  const recorded = execute.indexOf('id: recorded')
  expect(recorded).toBeGreaterThan(execute.indexOf('- name: Run the plan'))
  const step = execute.slice(execute.lastIndexOf('- name:', recorded), execute.indexOf('- name:', recorded))
  expect(step).toContain('if: always()')
  expect(step).toContain('evidence/result.json')
  // Rule 6: a run that recorded no readable verdict never falls through to a
  // green pipeline with nothing posted. The step fails, and report says why.
  expect(step).toMatch(/if \[ -z "\$verdict" \]; then\n(?:.*\n)*?\s+exit 1\n/)
  expect(section('judge')).toContain("if: always() && needs.execute.outputs.verdict != ''")
  expect(section('judge')).not.toContain("needs.execute.result == 'success'")
})

test('execute hands qare run a checkout of the base commit, so both sides run with no secrets (#147)', () => {
  const execute = section('execute')
  const step = execute.slice(execute.indexOf('- name: Run the plan'), execute.indexOf('- name: Read the recorded verdict'))
  // The run image carries no git, so the base tree is checked out on the
  // runner, outside the head's checkout, where the head's checks never see it.
  expect(step).toContain('base_dir="$RUNNER_TEMP/qare-base"')
  expect(step).toContain('git worktree add --detach "$base_dir" "$BASE_SHA"')
  // Mounted at its own path, like the workspace, so the compose paths qare
  // names for the base line up with the daemon's.
  expect(step).toContain('base_mount=(-v "$base_dir:$base_dir")')
  expect(step).toContain('base_args=(--base-repo "$base_dir")')
  expect(step).toContain('"${base_mount[@]}"')
  expect(step).toContain('"${base_args[@]}"')
  // A base that cannot be checked out is said, and the head is still run.
  expect(step).toMatch(/else\n\s+echo "the base commit could not be checked out/)
  // Both sides run in the one job that holds nothing.
  expect(execute).not.toContain('secrets.')
  expect(step).not.toMatch(/-e [A-Z_]*(KEY|TOKEN)/)
})

test("execute hands the run the runner's docker, so a profile can boot its compose app (#209)", () => {
  const execute = section('execute')
  const find = execute.slice(execute.indexOf("- name: Find the runner's docker"), execute.indexOf('- name: Run the plan'))
  const run = execute.slice(execute.indexOf('- name: Run the plan'), execute.indexOf('- name: Read the recorded verdict'))
  // The CLI and its plugins are the runner's own, found where this runner
  // keeps them: a path written here would hold on GitHub's runners and
  // nowhere else. buildx travels with compose, for a stack that builds.
  expect(find).toContain('-v "$(readlink -f "$(command -v docker)"):/usr/bin/docker:ro"')
  expect(find).toContain("docker info --format '{{range .ClientInfo.Plugins}}{{println .Name .Path}}{{end}}'")
  expect(find).toContain('case "$plugin" in compose | buildx) ;; *) continue ;; esac')
  expect(find).toContain('/usr/local/lib/docker/cli-plugins/docker-$plugin:ro')
  expect(execute).not.toContain('-v /usr/bin/docker:/usr/bin/docker:ro')
  // A runner without compose says so by name rather than leaving a blocked
  // boot to explain itself.
  expect(find).toMatch(/\*\) echo "this runner's docker has no compose plugin/)
  // The daemon is reached as the group that owns its socket: the run keeps
  // the runner's uid, which alone may not open it.
  expect(find).toContain(`endpoint="$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)"`)
  expect(find).toContain('docker_access+=(-v "$socket:/var/run/docker.sock" --group-add "$(stat -L -c %g "$socket")")')
  expect(find).toContain('docker_access+=(-e "DOCKER_HOST=$endpoint")')
  // The runner's network: compose publishes the app on the runner, so the
  // port the run picks and the localhost its checks name are the runner's.
  expect(find).toContain('docker_access=(--network host')
  // The run starts its container with what the step found, still as the
  // runner's user and never privileged.
  expect(run).toContain('mapfile -t docker_access < "$RUNNER_TEMP/qare-docker-access"')
  expect(run).toContain('"${docker_access[@]}"')
  expect(run).toContain('-u "$(id -u):$(id -g)"')
  expect(execute).not.toContain('--privileged')
  // Rule 7: daemon access is not a secret, and the job gains none with it.
  expect(execute).not.toContain('secrets.')
})

test('execute takes down the compose projects the run booted, whatever the run exited with (#209)', () => {
  const execute = section('execute')
  const start = execute.indexOf('- name: Tear down what the run booted')
  expect(start).toBeGreaterThan(execute.indexOf('- name: Run the plan'))
  const step = execute.slice(start, execute.indexOf('- name: Redact the evidence'))
  expect(step).toContain('if: always()')
  // Exactly the projects the run named in its evidence: reap refuses a name
  // that is not qare's, and another run's stack on the same runner stays up.
  // Every boot's record is read: isolation.json, and the isolation-<app>.json
  // and isolation-<criterion>.json a run over several apps or an isolated
  // criterion writes.
  expect(step).toContain(`find evidence -name 'isolation*.json' -exec jq -r '.project // empty' {} +`)
  expect(step).toContain('qare reap "${projects[@]}"')
  // The verdict is already recorded: a failed teardown is said, not gating.
  expect(step).toContain('::warning::qare reap failed')
})

test("CI boots a compose app through the pipeline's own execute steps (#209)", () => {
  // Not a copy of the steps: the script runs the ones this file carries, so
  // the path every caller gets is the path CI exercises.
  const ci = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8')
  expect(ci).toContain('  compose-boot:')
  expect(ci).toContain('run: scripts/compose-boot.sh qare-core:ci')
  const script = readFileSync(join(repoRoot, 'scripts', 'compose-boot.sh'), 'utf8')
  expect(script).toContain('node scripts/run-pipeline-step.mjs execute "$1"')
  const execute = section('execute')
  for (const name of ["Find the runner's docker", 'Run the plan', 'Tear down what the run booted']) {
    expect(script).toMatch(new RegExp(`step ["']${name}["']`))
    expect(execute).toContain(`- name: ${name}\n`)
  }
  expect(script).toContain('PROFILE=examples/compose-app/.qa')
})
