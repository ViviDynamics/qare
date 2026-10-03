// The example that boots a compose app (#209), held together without docker:
// its profile loads, its plan loads and names only what the profile carries,
// and the pipeline steps CI runs against it can be read out of the workflow
// as plain scripts. The boot itself is CI's compose-boot job, which needs a
// docker daemon this suite must not.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPlan, loadProfile } from '../../packages/core/dist/index.js'
import { pipelineStep } from '../../scripts/run-pipeline-step.mjs'

const example = fileURLToPath(new URL('../compose-app/', import.meta.url))

test('the compose-app profile boots its app with compose, on the port the run publishes', async () => {
  const profile = await loadProfile(join(example, '.qa'))
  assert.equal(profile.target, undefined)
  // The compose path is read from the repository root, where the pipeline runs.
  assert.deepEqual(profile.app.boot, { compose: 'examples/compose-app/compose.yaml', service: 'web' })
  assert.match(profile.app.health.http, /localhost:\{\{run\.app_port\}\}\/up$/)
  const compose = await readFile(join(example, 'compose.yaml'), 'utf8')
  assert.match(compose, /\$\{QARE_APP_PORT:-3000\}:3000/)
  // Built from the tree, so the boot goes through the runner's builder too.
  assert.match(compose, /build: \./)
})

test('the compose-app plan checks the app from beside qare and from inside the booted service', async () => {
  const profile = await loadProfile(join(example, '.qa'))
  const plan = loadPlan(await readFile(join(example, 'plan.json'), 'utf8'))
  const checks = plan.criteria.flatMap((criterion) => criterion.checks)
  const command = checks.find((check) => check.kind === 'command')
  assert.match(command.command, /localhost:\{\{run\.app_port\}\}/)
  const flow = checks.find((check) => check.kind === 'flow')
  const suite = profile.suites.find((entry) => entry.name === flow.suite)
  assert.ok(suite, 'the plan names a suite the profile carries')
  // The run's compose project is qare-<run id>, so a suite reaches the
  // service the run booted and no other run's.
  assert.match(suite.command, /^docker compose -p qare-\{\{run\.id\}\} -f examples\/compose-app\/compose\.yaml exec -T web /)
})

test('the execute steps CI runs are scripts the pipeline carries', () => {
  const find = pipelineStep('execute', "Find the runner's docker")
  assert.match(find.run, /qare-docker-access/)
  assert.deepEqual(find.env, [])
  const run = pipelineStep('execute', 'Run the plan')
  assert.match(run.run, /qare run --plan plan\.json/)
  assert.deepEqual(run.env, ['IMAGE_REF', 'IMAGE_DIGEST', 'BASE_SHA', 'HEAD_SHA', 'PR_NUMBER', 'PROFILE'])
  const down = pipelineStep('execute', 'Tear down what the run booted')
  assert.match(down.run, /qare reap/)
})

test('a step that cannot run outside a workflow is refused by name', async () => {
  assert.throws(() => pipelineStep('execute', 'No such step'), /has no step named "No such step"/)
  assert.throws(() => pipelineStep('nowhere', 'Run the plan'), /no job named nowhere/)
  assert.throws(() => pipelineStep('execute', 'Download plan.json'), /runs an action, not a script/)
  const dir = await mkdtemp(join(tmpdir(), 'qare-pipeline-step-'))
  const path = join(dir, 'workflow.yml')
  await writeFile(path, 'jobs:\n  a:\n    steps:\n      - name: b\n        run: echo ${{ github.sha }}\n')
  assert.throws(() => pipelineStep('a', 'b', path), /carries a workflow expression/)
})
