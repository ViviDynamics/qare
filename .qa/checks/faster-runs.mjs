import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import './source.mjs'

// Its compose is a stand-in, so the stack is booted uncontained: containment
// is exercised by stack-egress.mjs (#382), and the run's image is not named here.
delete process.env.QARE_IMAGE_REF

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
    // publish's own step, run as it runs: the Actions API asked for this run
    // attempt's jobs, and the record judge wrote extended with them.
    const ran = runScript(step.run, dir, { GH_TOKEN: 'token', GITHUB_API_URL: 'api.github.test', GITHUB_REPOSITORY: 'acme/app', RUN_ID: '42', RUN_ATTEMPT: '1' })
    assert.equal(ran.status, 0, ran.stderr)
    assert.ok(!ran.stdout.includes('::warning::'), ran.stdout)
    const asked = readFileSync(join(dir, 'calls'), 'utf8').split('\n').find((arg) => arg.includes('/actions/runs/'))
    assert.equal(asked, 'api.github.test/repos/acme/app/actions/runs/42/attempts/1/jobs?per_page=100')
    const record = JSON.parse(readFileSync(join(dir, 'judged/metrics.json'), 'utf8'))
    assert.equal(record.runId, 'pr-1')
    // A skipped job ran nothing and publish is still running: neither is a wall clock.
    assert.deepEqual(record.jobs.map((job) => [job.name, job.wallMs]), [['collect (GitHub token only)', 18000], ['execute (no secrets)', 51000]])
    // The standing report's lines from twelve such records: the latest ten beside the two before.
    const { summarizeMetrics, metricsSummaryLines } = await core('metrics.ts')
    const runs = Array.from({ length: 12 }, (_, index) => {
      const at = new Date(Date.parse('2026-11-01T00:00:00Z') + index * 3_600_000).toISOString()
      return { schemaVersion: 'qare.metrics.v1', runId: `r${index}`, recordedAt: at, startedAt: at, finishedAt: at, wallMs: 0, verdict: 'passed', criteria: { selected: [], counts: {} }, jobs: [{ name: 'collect (GitHub token only)', startedAt: at, completedAt: at, wallMs: index < 2 ? 24000 : 18000 }] }
    })
    const lines = metricsSummaryLines(summarizeMetrics({ runs, notes: [], malformed: 0 })).filter((line) => line.startsWith('job wall clock'))
    assert.deepEqual(lines, ['job wall clock, collect (GitHub token only): median 18s over the latest 10 runs, 24s over the 2 before'])
    // The report reads what the sweep joins from qa-assets: this record, as a line of the store.
    const { readMetricsStore } = await core('metrics.ts')
    const store = join(dir, 'store')
    mkdirSync(store)
    const at = record.jobs[0].startedAt
    writeFileSync(join(store, 'runs.jsonl'), `${JSON.stringify({ ...record, recordedAt: at, startedAt: at, finishedAt: at, wallMs: 0, criteria: { selected: [], counts: {} } })}\n`)
    const fromRecord = metricsSummaryLines(summarizeMetrics(await readMetricsStore(store))).filter((line) => line.startsWith('job wall clock'))
    assert.deepEqual(fromRecord, ['job wall clock, collect (GitHub token only): median 18s over 1 run', 'job wall clock, execute (no secrets): median 51s over 1 run'])
    console.log(JSON.stringify({ check, apiAsked: asked, recordedJobs: record.jobs, reportLinesFromThatRecord: fromRecord, reportLinesOverTwelveRuns: lines }))
  } else if (check === 'collect') {
    // collect and main_collect run the published core image, never a source build.
    const out = {}
    for (const job of ['collect', 'main_collect']) {
      const names = workflow.jobs[job].steps.map((step) => step.name ?? step.uses)
      const text = JSON.stringify(workflow.jobs[job].steps)
      assert.ok(!/pnpm install|pnpm build|corepack/.test(text), `${job} builds qare from source`)
      out[job] = { steps: names }
    }
    // collect's own pull step, run: the version's tag resolved to its registry digest, and that digest pulled.
    const DIGEST = `sha256:${'e'.repeat(64)}`
    tool('docker', `printf '%s\\n' "$*" >> "$RUNNER_TEMP/docker-calls"; case "$1 $2" in "buildx version") return 0 ;; "buildx imagetools") echo "${DIGEST}" ;; esac; return 0`)
    const output = join(dir, 'output')
    writeFileSync(output, '')
    const pulled = runScript(stepOf('collect', 'Pull the core image').run, dir, { QARE_VERSION: '2026.11.17', GITHUB_OUTPUT: output })
    assert.equal(pulled.status, 0, pulled.stderr)
    const imageRef = `ghcr.io/vividynamics/qare-core@${DIGEST}`
    assert.equal(readFileSync(output, 'utf8').trim(), `digest=${imageRef}`)
    const pullCalls = readFileSync(join(dir, 'docker-calls'), 'utf8').trim().split('\n')
    assert.deepEqual(pullCalls.slice(-2), [`buildx imagetools inspect ghcr.io/vividynamics/qare-core:2026.11.17 --format {{.Manifest.Digest}}`, `pull ${imageRef}`])
    // collect's own inputs step, run: qare is the image's, run with no network, on the pull request body as a file.
    rmSync(join(dir, 'docker-calls'))
    const ran = runScript(stepOf('collect', 'Read the linked issue and the diff').run, dir, { IMAGE_REF: imageRef, GH_TOKEN: 'token', PR_BODY: 'No issue here.', BASE_SHA: BASE, HEAD_SHA: 'b'.repeat(40), PR_NUMBER: '1', GITHUB_OUTPUT: output })
    assert.equal(ran.status, 0, ran.stderr)
    const qareCall = readFileSync(join(dir, 'docker-calls'), 'utf8').trim()
    assert.match(qareCall, /^run --rm -u \S+ -e HOME=\/tmp --network none -v \S+ -w \S+ ghcr\.io\/vividynamics\/qare-core@sha256:e{64} qare linked-issues --body pr-body\.md$/)
    assert.ok(!qareCall.includes('token'), 'the image is handed no token to read the body')
    console.log(JSON.stringify({ check, ...out, pullStepCalls: pullCalls, imageOutput: readFileSync(output, 'utf8').trim().split('\n')[0], linkedIssuesCall: qareCall }))
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
      const docker = []
      const { result } = await runJob(
        { id: 'base-image', repoPath: head, baseRef: BASE, headRef: 'b'.repeat(40), post: 'none', evidenceDir: join(head, 'evidence'), profile: { inline: appProfile({ base: { criteria: 'all', image: 'ghcr.io/acme/app:{base}' } }) }, criteria: [fileCheck('kept', 'old.txt')] },
        {
          runCompose: async (args) => {
            calls.push(args.filter((arg) => arg !== '-p' && !arg.startsWith('qare-')))
            return { code: 0, stdout: '', stderr: '' }
          },
          runDocker: async (args) => (docker.push(args.join(' ')), args[0] === 'pull' ? { code: 0, stdout: '', stderr: '' } : { code: 0, stdout: JSON.stringify([{ RepoDigests: [`ghcr.io/acme/app@sha256:${'c'.repeat(64)}`], Config: { Labels: { 'org.opencontainers.image.revision': revision } } }]), stderr: '' }),
          probe: async () => ({ ok: true }),
          pollIntervalMs: 1,
          execution: 'native',
          base: { repoPath: repo('base') },
        },
      )
      const ups = calls.filter((args) => args.includes('up'))
      const builds = calls.filter((args) => args.includes('build'))
      observed[label] = {
        dockerCalls: docker,
        // The base's build is asked for the service's dependencies only, through an override whose build is reset; the head builds as before.
        baseBuild: builds[0],
        headBuild: builds[1],
        baseImages: result.base.images, baseUpUsesOverride: ups[0].some((arg) => arg.endsWith('.base-image.yml')), headUpUsesOverride: ups[1].some((arg) => arg.endsWith('.base-image.yml')) }
    }
    assert.deepEqual(observed.matching.dockerCalls, [`pull -- ghcr.io/acme/app:${BASE}`, `image inspect -- ghcr.io/acme/app:${BASE}`])
    assert.ok(observed.matching.baseBuild.some((arg) => arg.endsWith('.base-image.yml')))
    assert.ok(!observed.matching.headBuild.some((arg) => arg.endsWith('.base-image.yml')))
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
    // No secret can reach the cache: the jobs that write and read it are handed none, and neither is the run's container or the build.
    const handedSecrets = {}
    for (const id of ['execute', 'main_execute']) {
      const job = JSON.stringify(workflow.jobs[id])
      handedSecrets[id] = { secretsReferenced: (job.match(/secrets\.[\w-]+/g) ?? []), tokensReferenced: (job.match(/github\.token|GITHUB_TOKEN|GH_TOKEN|QARE_APP_TOKEN|MODEL_KEY/g) ?? []), permissions: workflow.jobs[id].permissions ?? 'the workflow default: contents: read' }
      assert.deepEqual(handedSecrets[id].secretsReferenced, [], `${id} references a secret`)
      assert.deepEqual(handedSecrets[id].tokensReferenced, [], `${id} references a token`)
    }
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
      // Every variable the run's container is handed, by name: none is a credential.
      const containerEnv = args.flatMap((arg, index) => (args[index - 1] === '-e' ? [arg.split('=')[0]] : []))
      assert.ok(!containerEnv.some((name) => /TOKEN|SECRET|KEY|PASSWORD/i.test(name)), `${job} hands its container ${containerEnv.join(', ')}`)
      handed[job] = { reads: args.includes('--build-cache-from'), writes: args.includes('--build-cache-to'), containerEnv }
    }
    assert.deepEqual(Object.fromEntries(Object.entries(handed).map(([job, { reads, writes }]) => [job, { reads, writes }])), { execute: { reads: true, writes: false }, main_execute: { reads: true, writes: true } })
    // The boot's override, from the services compose says build.
    const { bootApp, stopApp } = await core('boot.ts')
    const isolation = { runId: 'faster-cache', project: 'qare-faster-cache', startedAt: new Date().toISOString(), port: 41300 }
    let override
    const runCompose = async (args, _timeoutMs, env) => {
      if (args.includes('config')) return { code: 0, stdout: JSON.stringify({ services: { web: { build: { context: '.' } }, db: { image: 'postgres:16' } } }), stderr: '' }
      const file = args.find((arg) => arg.endsWith('.build-cache.json'))
      if (args.includes('build') && file !== undefined) override = { file: JSON.parse(readFileSync(file, 'utf8')), buildEnv: Object.keys(env ?? {}).sort() }
      return { code: 0, stdout: '', stderr: '' }
    }
    const cacheTo = join(dir, 'cache-new')
    await bootApp(appProfile(), { runCompose, probe: async () => ({ ok: true }), pollIntervalMs: 1, isolation, buildCache: { from: join(dir, 'cache'), to: cacheTo } })
    await stopApp(appProfile(), { runCompose, isolation })
    assert.deepEqual(Object.keys(override.file.services), ['web'])
    // The override adds cache locations and nothing else: no build args, no secrets, no ssh.
    assert.deepEqual(Object.keys(override.file.services.web.build), ['cache_to'])
    assert.deepEqual(override.buildEnv, ['BUILDX_BAKE_ENTITLEMENTS_FS', 'QARE_APP_PORT', 'QARE_RUN_ID'])
    assert.ok(existsSync(scratch))
    console.log(JSON.stringify({ check, saves: savers, handedSecrets, handed, bootOverride: override }))
  } else {
    throw new Error(`unknown check ${check}: jobs, collect, base-image, ledger-default or build-cache`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
