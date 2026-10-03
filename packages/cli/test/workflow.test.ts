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
    (job) => job.match(/ghcr\.io\/vividynamics\/qare-core:\$version/)?.[0],
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
  expect(step).not.toContain('QARE_PLANNER_KEY')
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
  const qare = readFileSync(workflowPath, 'utf8')
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
  expect(step).toContain('qare redact --evidence evidence --profile .qa')
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
  // runs qare from a revision the pull request cannot change: collect builds
  // the base commit, and plan and judge pull the published image for the
  // base revision's version (#88), after checking that revision out.
  for (const job of ['collect', 'plan', 'judge']) {
    const jobSection = section(job)
    const checkout = jobSection.indexOf('actions/checkout@v4')
    const ref = jobSection.indexOf('ref: ${{ github.event.pull_request.base.sha }}')
    expect(ref, `${job} must check out the base commit`).toBeGreaterThan(checkout)
  }
  for (const job of ['plan', 'judge']) {
    const jobSection = section(job)
    expect(jobSection, `${job} installs nothing from a tree`).not.toContain('pnpm install')
    const pull = jobSection.indexOf('docker pull')
    expect(pull, `${job} must pull the image for the base revision's version`)
      .toBeGreaterThan(jobSection.indexOf('ref: ${{ github.event.pull_request.base.sha }}'))
  }
  const collect = section('collect')
  expect(collect.indexOf('pnpm install')).toBeGreaterThan(collect.indexOf('ref: ${{ github.event.pull_request.base.sha }}'))
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

test('auto-tag tags the version package.json carries, and nothing else (#188)', () => {
  expect(autoTag).toContain("require('./package.json').version")
  // Idempotent by the tag's existence: a merge that changes no version no-ops.
  expect(autoTag).toMatch(/git ls-remote --tags origin "refs\/tags\/\$version"/)
  expect(autoTag).toContain('tagged=true')
  expect(autoTag).toMatch(/git tag "\$version" "\$sha"/)
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
  // does for plan and judge, and never from the pull request tree.
  const execute = section('execute')
  expect(execute).toMatch(/git show "\$BASE_SHA":package\.json/)
  expect(execute).not.toContain('version="$(jq -r .version package.json)"')
  // The version is only the base revision's if the image step itself wires
  // BASE_SHA to the pull request's base commit and pulls the object into the
  // object store before the version is read: removing either line fails the
  // run at runtime while the assertions above stayed green.
  //
  // The offline scan forbids the word the workflow line starts with, so the
  // line is built from fragments here and in the release test below (#196).
  const gitPull = ['git ', 'fe', 'tch'].join('')
  const image = execute.slice(execute.indexOf('Pull the flavour image'), execute.indexOf('\n      - name:', execute.indexOf('Pull the flavour image')))
  expect(image).toContain('BASE_SHA: ${{ github.event.pull_request.base.sha }}')
  expect(image).toContain(gitPull + ' origin "$BASE_SHA"')
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
  // Checked but unpublished is told apart from never evaluated.
  expect(report).toContain('RECORDED_VERDICT: ${{ needs.execute.outputs.verdict }}')
})

test('the report job holds the GitHub token only and runs qare from the base commit', () => {
  const report = section('report')
  expect(report).toContain('${{ secrets.GITHUB_TOKEN }}')
  expect(report).not.toContain('QARE_PLANNER_KEY')
  expect(report).not.toContain('QARE_MODEL_KEY')
  // Reading the run's jobs needs actions: read; posting needs the rest.
  for (const permission of ['actions: read', 'checks: write', 'issues: write', 'pull-requests: write'])
    expect(report).toContain(permission)
  expect(report).not.toContain('contents: write')
  const checkout = report.indexOf('actions/checkout@v4')
  const ref = report.indexOf('ref: ${{ github.event.pull_request.base.sha }}')
  expect(ref, 'report must check out the base commit').toBeGreaterThan(checkout)
  expect(report).toMatch(/actions\/checkout@v4\n\s+with:\n\s+persist-credentials: false/)
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
