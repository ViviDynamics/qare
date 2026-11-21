import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import './source.mjs'

// Executable checks of faster booted runs (#381), run against the checkout
// without a build: the workflow's own step scripts with curl and docker
// stubbed, and the checkout's core source through source.mjs, with compose
// and docker standing in as recorders. Each prints what it observed.
// Scratch is restricted to .qa/checks/scratch.

const core = (file) => import(`../../packages/core/src/${file}`)
// The run module first: it loads the core's modules in the order they expect.
const { runJob, gateOf } = await core('run.ts')
const root = fileURLToPath(new URL('../../', import.meta.url))
const scratch = fileURLToPath(new URL('./scratch/', import.meta.url))
mkdirSync(scratch, { recursive: true })
const { parse } = await import('yaml')
const workflow = parse(readFileSync(join(root, '.github/workflows/pipeline.yml'), 'utf8'))
const stepOf = (job, name) => {
  const found = workflow.jobs[job].steps.find((step) => step.name === name)
  assert.ok(found, `${job} has no step ${name}`)
  return found
}
// The stubs are bash functions handed down in the environment, not files:
// the scratch directory a contained check gets may not be executable.
const stubs = {}
const tool = (name, body) => {
  stubs[`BASH_FUNC_${name}%%`] = `() { ${body}\n}`
}
const runScript = (script, dir, env) =>
  spawnSync('bash', ['-c', script], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: join(dir, 'summary'), ...stubs, ...env } })
const HEALTH = ['http:', '//localhost:3000/up'].join('')
const appProfile = (extra = {}) => ({
  app: { boot: { compose: 'compose.qa.yaml', service: 'web' }, health: { http: HEALTH, timeout: '5s' }, seed: { command: 'true' }, login: { fixture: 'f.yml', role: 'admin' } },
  stubs: [],
  visual: { widths: [], themes: [] },
  suites: [],
  ...extra,
})
const fileCheck = (id, file) => ({ id, text: `${file} is there`, checks: [{ kind: 'command', run: `test -f ${file}` }] })
const BASE = 'a'.repeat(40)

const check = process.argv[2]
const dir = mkdtempSync(join(scratch, `faster-${check}-`))
try {
  if (check === 'jobs') {
    // publish adds each completed job of the run to the metrics record.
    const step = stepOf('publish', "Add each job's wall clock to the run's metrics")
    assert.equal(workflow.jobs.publish.permissions.actions, 'read')
    const api = {
      jobs: [
        { name: 'qare / collect (GitHub token only)', status: 'completed', conclusion: 'success', started_at: '2026-11-21T10:00:00Z', completed_at: '2026-11-21T10:00:18Z' },
        { name: 'qare / execute (no secrets)', status: 'completed', conclusion: 'success', started_at: '2026-11-21T10:01:00Z', completed_at: '2026-11-21T10:01:51Z' },
        { name: 'qare / requeue (GitHub token only)', status: 'completed', conclusion: 'skipped', started_at: '2026-11-21T10:00:00Z', completed_at: '2026-11-21T10:00:00Z' },
        { name: 'qare / publish (GitHub token only)', status: 'in_progress', conclusion: null, started_at: '2026-11-21T10:02:00Z', completed_at: null },
      ],
    }
    writeFileSync(join(dir, 'api.json'), JSON.stringify(api))
    mkdirSync(join(dir, 'judged'))
    writeFileSync(join(dir, 'judged/metrics.json'), JSON.stringify({ schemaVersion: 'qare.metrics.v1', runId: 'pr-1', verdict: 'passed' }))
    tool('curl', `printf '%s\\n' "$@" > "$RUNNER_TEMP/calls"; cat "$RUNNER_TEMP/api.json"`)
    // The step needs jq, which every runner has and the image does not: it
    // runs where jq is, and the cli suite runs it on every change
    // (pipeline-job-timings.test.ts).
    let record = { jobs: 'not run here: this image has no jq' }
    if (spawnSync('jq', ['--version']).status === 0) {
      const ran = runScript(step.run, dir, { GH_TOKEN: 'token', GITHUB_API_URL: 'api.github.test', GITHUB_REPOSITORY: 'acme/app', RUN_ID: '42', RUN_ATTEMPT: '1' })
      assert.equal(ran.status, 0, ran.stderr)
      record = JSON.parse(readFileSync(join(dir, 'judged/metrics.json'), 'utf8'))
      assert.deepEqual(record.jobs.map((job) => [job.name, job.wallMs]), [['collect (GitHub token only)', 18000], ['execute (no secrets)', 51000]])
    }
    assert.match(step.run, /actions\/runs\/\$RUN_ID\/attempts\/\$RUN_ATTEMPT\/jobs/)
    // The standing report's lines from twelve such records: the latest ten beside the two before.
    const { summarizeMetrics, metricsSummaryLines } = await core('metrics.ts')
    const runs = Array.from({ length: 12 }, (_, index) => {
      const at = new Date(Date.parse('2026-11-01T00:00:00Z') + index * 3_600_000).toISOString()
      return { schemaVersion: 'qare.metrics.v1', runId: `r${index}`, recordedAt: at, startedAt: at, finishedAt: at, wallMs: 0, verdict: 'passed', criteria: { selected: [], counts: {} }, jobs: [{ name: 'collect (GitHub token only)', startedAt: at, completedAt: at, wallMs: index < 2 ? 24000 : 18000 }] }
    })
    const lines = metricsSummaryLines(summarizeMetrics({ runs, notes: [], malformed: 0 })).filter((line) => line.startsWith('job wall clock'))
    assert.deepEqual(lines, ['job wall clock, collect (GitHub token only): median 18s over the latest 10 runs, 24s over the 2 before'])
    console.log(JSON.stringify({ check, recordedJobs: record.jobs, reportLines: lines }))
  } else if (check === 'collect') {
    // collect and main_collect run the published core image, never a source build.
    const out = {}
    for (const job of ['collect', 'main_collect']) {
      const steps = workflow.jobs[job].steps
      const text = JSON.stringify(steps)
      assert.ok(!/pnpm install|pnpm build/.test(text), `${job} builds qare from source`)
      const pull = stepOf(job, 'Pull the core image').run
      assert.match(pull, /ref="ghcr\.io\/vividynamics\/qare-core:\$QARE_VERSION"/)
      assert.match(pull, /docker pull "\$immutable"/)
      const uses = steps.filter((step) => /"\$IMAGE_REF"/.test(step.run ?? '')).map((step) => step.name)
      out[job] = { pullsByDigest: true, stepsRunningTheImage: uses, sourceBuild: false }
    }
    // The tokens never reach the commands that only read files.
    assert.match(stepOf('collect', 'Read the linked issue and the diff').run, /--network none/)
    console.log(JSON.stringify({ check, ...out }))
  } else if (check === 'base-image') {
    // The base side pulls the profile's image and runs it only when it is the base commit's.
    const repo = (name) => {
      const path = mkdtempSync(join(dir, `${name}-`))
      writeFileSync(join(path, 'old.txt'), 'x\n')
      return path
    }
    const observed = {}
    for (const [label, revision] of [['matching', BASE], ['another commit', 'd'.repeat(40)]]) {
      const head = repo('head')
      const calls = []
      const { result } = await runJob(
        { id: 'base-image', repoPath: head, baseRef: BASE, headRef: 'b'.repeat(40), post: 'none', evidenceDir: join(head, 'evidence'), profile: { inline: appProfile({ base: { criteria: 'all', image: 'ghcr.io/acme/app:{base}' } }) }, criteria: [fileCheck('kept', 'old.txt')] },
        {
          runCompose: async (args) => {
            calls.push(args.filter((arg) => arg !== '-p' && !arg.startsWith('qare-')))
            return { code: 0, stdout: '', stderr: '' }
          },
          runDocker: async (args) => (args[0] === 'pull' ? { code: 0, stdout: '', stderr: '' } : { code: 0, stdout: JSON.stringify([{ RepoDigests: [`ghcr.io/acme/app@sha256:${'c'.repeat(64)}`], Config: { Labels: { 'org.opencontainers.image.revision': revision } } }]), stderr: '' }),
          probe: async () => ({ ok: true }),
          pollIntervalMs: 1,
          execution: 'native',
          base: { repoPath: repo('base') },
        },
      )
      const ups = calls.filter((args) => args.includes('up'))
      observed[label] = { baseImages: result.base.images, baseUpUsesOverride: ups[0].some((arg) => arg.endsWith('.base-image.yml')), headUpUsesOverride: ups[1].some((arg) => arg.endsWith('.base-image.yml')) }
    }
    assert.equal(observed.matching.baseImages[0].used, true)
    assert.equal(observed.matching.baseUpUsesOverride, true)
    assert.equal(observed.matching.headUpUsesOverride, false)
    assert.equal(observed['another commit'].baseImages[0].used, false)
    assert.equal(observed['another commit'].baseUpUsesOverride, false)
    // Both boot forms: the compose override and the command boot's project.
    const { baseImageOverride, commandBootCompose } = await core('boot.ts')
    const command = JSON.parse(commandBootCompose({ command: 'npm start', image: 'node:22', port: 3000, prebuilt: 'ghcr.io/acme/app@sha256:c' }, '/repo'))
    assert.equal(command.services.app.image, 'ghcr.io/acme/app@sha256:c')
    assert.equal(command.services.app.build, undefined)
    console.log(JSON.stringify({ check, ...observed, composeOverride: baseImageOverride('web', 'ghcr.io/acme/app@sha256:c'), commandBootService: command.services.app }))
  } else if (check === 'ledger-default') {
    // base.criteria defaults to ledger; criteria decided against the base still run there.
    const { validateProfileConfig } = await core('profile.ts')
    const loaded = validateProfileConfig({ ...appProfile(), base: undefined })
    assert.equal(loaded.base, undefined)
    const head = mkdtempSync(join(dir, 'head-'))
    const base = mkdtempSync(join(dir, 'base-'))
    writeFileSync(join(base, 'old.txt'), 'x\n')
    const { FileLedgerStore } = await core('ledger.ts')
    await new FileLedgerStore(join(base, '.qa')).save([{ criterion: 'LED-1', status: 'active', source: ['#1'], proof: 'command' }])
    const { result } = await runJob(
      { id: 'ledger-default', repoPath: head, baseRef: 'main', headRef: 'HEAD', post: 'none', evidenceDir: join(head, 'evidence'), profile: { inline: appProfile() }, criteria: [fileCheck('LED-1', 'old.txt'), fileCheck('issue-9-1', 'old.txt')] },
      { runCompose: async () => ({ code: 0, stdout: '', stderr: '' }), probe: async () => ({ ok: true }), pollIntervalMs: 1, execution: 'native', base: { repoPath: base } },
    )
    const byId = Object.fromEntries(result.criteria.map((criterion) => [criterion.id, { outcome: criterion.outcome, regression: criterion.regression, base: criterion.base }]))
    assert.equal(byId['LED-1'].base.outcome, 'proven')
    assert.equal(byId['issue-9-1'].base.outcome, 'not-compared')
    assert.match(byId['issue-9-1'].base.reason, /base\.criteria: ledger, the default/)
    const visual = { id: 'v', text: 'looks the same', checks: [{ kind: 'visual', path: '/' }] }
    const keeps = { visualUnderDefault: gateOf(appProfile(), new Set(), visual), visualUnderExplicitLedger: gateOf(appProfile({ base: { criteria: 'ledger' } }), new Set(), visual), clientDefault: gateOf({ ...appProfile(), app: undefined, client: { driver: 'electron' } }, new Set(), fileCheck('x', 'y')) }
    assert.deepEqual(keeps, { visualUnderDefault: true, visualUnderExplicitLedger: false, clientDefault: true })
    console.log(JSON.stringify({ check, criteria: byId, keeps }))
  } else if (check === 'build-cache') {
    // The opt-in cache: off by default, saved only by main_execute on the default branch.
    assert.equal(workflow.on.workflow_call.inputs['build-cache'].default, '')
    const savers = []
    for (const [id, job] of Object.entries(workflow.jobs)) for (const step of job.steps) if ((step.uses ?? '').startsWith('actions/cache/save@')) savers.push(id)
    assert.deepEqual(savers, ['main_execute'])
    const save = stepOf('main_execute', 'Save the build cache')
    assert.match(save.if, /github\.event_name != 'pull_request'/)
    for (const id of ['execute', 'main_execute']) assert.ok(!/secrets\.|github\.token/.test(JSON.stringify(workflow.jobs[id])), `${id} holds a secret`)
    // A pull request's execute step reads the cache and never writes it.
    tool('docker', 'printf "%s\\n" "$@" > "$RUNNER_TEMP/calls"; mkdir -p evidence; echo "{\\"verdict\\":\\"passed\\",\\"criteria\\":[]}" > evidence/result.json')
    tool('git', 'if [ "$1" = worktree ]; then mkdir -p "$4"; fi; return 0')
    const handed = {}
    for (const [job, name] of [['execute', 'Run the plan'], ['main_execute', 'Run the plan on main']]) {
      const at = mkdtempSync(join(dir, `${job}-`))
      writeFileSync(join(at, 'qare-docker-access'), '')
      writeFileSync(join(at, 'qare-buildx-builder'), 'qare-cache-1\n')
      mkdirSync(join(at, '.qa'))
      const ran = runScript(stepOf(job, name).run, at, { IMAGE_REF: 'image', IMAGE_DIGEST: 'image', IMAGE_TAG_REF: 'tag', BASE_SHA: BASE, HEAD_SHA: 'b'.repeat(40), PR_NUMBER: '1', PROFILE: '.qa', RUN_ID: '1', RUN_ATTEMPT: '1', FLAKE_ATTEMPTS: '1', QUARANTINE: '', BUILD_CACHE: 'true' })
      assert.equal(ran.status, 0, ran.stderr)
      const args = readFileSync(join(at, 'calls'), 'utf8').split('\n')
      handed[job] = { reads: args.includes('--build-cache-from'), writes: args.includes('--build-cache-to') }
    }
    assert.deepEqual(handed, { execute: { reads: true, writes: false }, main_execute: { reads: true, writes: true } })
    // The boot's override, from the services compose says build.
    const { bootApp, stopApp } = await core('boot.ts')
    const isolation = { runId: 'faster-cache', project: 'qare-faster-cache', startedAt: new Date().toISOString(), port: 41300 }
    let override
    const runCompose = async (args, _timeoutMs, env) => {
      if (args.includes('config')) return { code: 0, stdout: JSON.stringify({ services: { web: { build: { context: '.' } }, db: { image: 'postgres:16' } } }), stderr: '' }
      const file = args.find((arg) => arg.endsWith('.build-cache.json'))
      if (args.includes('build') && file !== undefined) override = { file: JSON.parse(readFileSync(file, 'utf8')), entitlement: env?.BUILDX_BAKE_ENTITLEMENTS_FS }
      return { code: 0, stdout: '', stderr: '' }
    }
    const cacheTo = join(dir, 'cache-new')
    await bootApp(appProfile(), { runCompose, probe: async () => ({ ok: true }), pollIntervalMs: 1, isolation, buildCache: { from: join(dir, 'cache'), to: cacheTo } })
    await stopApp(appProfile(), { runCompose, isolation })
    assert.deepEqual(Object.keys(override.file.services), ['web'])
    assert.ok(existsSync(scratch))
    console.log(JSON.stringify({ check, saves: savers, handed, bootOverride: override }))
  } else {
    throw new Error(`unknown check ${check}: jobs, collect, base-image, ledger-default or build-cache`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
