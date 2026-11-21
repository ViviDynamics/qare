// The example that boots an app from a start command (#379), held together
// without docker: its profile loads as a command boot, and its plan names
// only what the profile carries. The boot itself is CI's compose-boot job,
// which runs scripts/compose-boot.sh against this example.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { commandBootCompose, loadPlan, loadProfile } from '../../packages/core/dist/index.js'

const example = fileURLToPath(new URL('../command-app/', import.meta.url))

test('the command-app profile boots by command in a stock image, with no compose file', async () => {
  const profile = await loadProfile(join(example, '.qa'))
  assert.deepEqual(profile.app.boot, { command: 'httpd -f -p $PORT -h examples/command-app/site', image: 'busybox:1.36', port: 3000 })
  assert.match(profile.app.health.http, /localhost:\{\{run\.app_port\}\}\/up$/)
  assert.deepEqual(profile.stubs, [])
  await assert.rejects(access(join(example, 'compose.yaml')))
  // The project the run writes publishes the port on the run's own.
  const written = JSON.parse(commandBootCompose(profile.app.boot, '/repo'))
  assert.deepEqual(written.services.app.ports, ['127.0.0.1:${QARE_APP_PORT:-3000}:3000'])
})

test('the command-app plan checks the app from beside qare, and its seed and a suite from inside the service', async () => {
  const profile = await loadProfile(join(example, '.qa'))
  const plan = loadPlan(await readFile(join(example, 'plan.json'), 'utf8'))
  const checks = plan.criteria.flatMap((criterion) => criterion.checks)
  assert.match(checks.find((check) => check.kind === 'command').command, /localhost:\{\{run\.app_port\}\}/)
  // The one service is reached by the run's project alone.
  assert.match(profile.app.seed.command, /^docker compose -p qare-\{\{run\.id\}\} exec -T app /)
  for (const flow of checks.filter((check) => check.kind === 'flow')) {
    const suite = profile.suites.find((entry) => entry.name === flow.suite)
    assert.ok(suite, `the plan names a suite the profile carries: ${flow.suite}`)
    assert.match(suite.command, /^docker compose -p qare-\{\{run\.id\}\} exec -T app /)
  }
})
