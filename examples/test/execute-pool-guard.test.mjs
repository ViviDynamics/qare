import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { parse } = createRequire(new URL('../../packages/core/package.json', import.meta.url))('yaml')
const workflow = parse(readFileSync(new URL('../../.github/workflows/pipeline.yml', import.meta.url), 'utf8'))
const shared = {
  RUNNER_ENVIRONMENT: 'self-hosted', QARE_REPOSITORY_VISIBILITY: 'private', QARE_SELF_HOSTED: '',
  QARE_RUNS_ON: '["self-hosted", "trusted"]', QARE_EXECUTE_RUNS_ON: '', QARE_EPHEMERAL_RUNNERS: '',
}

async function beforeCheckout(job, changes = {}) {
  const steps = workflow.jobs[job].steps
  const checkout = steps.findIndex((step) => step.uses?.startsWith('actions/checkout@'))
  assert.ok(checkout >= 0)
  const dir = await mkdtemp(join(tmpdir(), 'qare-execute-pool-'))
  const summary = join(dir, 'summary')
  try {
    const outcome = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', steps.slice(0, checkout).map((step) => step.run ?? '').join('\n')], {
      env: { PATH: process.env.PATH, HOME: dir, RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: summary, ...shared, ...changes }, encoding: 'utf8',
    })
    return { code: outcome.status, stdout: outcome.stdout, summary: await readFile(summary, 'utf8').catch(() => '') }
  } finally { await rm(dir, { recursive: true, force: true }) }
}

for (const job of ['execute', 'main_execute']) {
  test(`${job}: self-hosted shared pools refuse before checkout and name both inputs`, async () => {
    for (const selector of ['', '["self-hosted", "trusted"]', '[ "TRUSTED", "self-hosted", "trusted" ]']) {
      const stopped = await beforeCheckout(job, { QARE_EXECUTE_RUNS_ON: selector })
      assert.equal(stopped.code, 1)
      assert.match(stopped.summary, /execute-runs-on/)
      assert.match(stopped.summary, /ephemeral-runners/)
      assert.match(stopped.stdout, /::error::/)
    }
    assert.equal((await beforeCheckout(job, { QARE_RUNS_ON: '"self-hosted"', QARE_EXECUTE_RUNS_ON: '["self-hosted"]' })).code, 1)
    assert.equal((await beforeCheckout(job, { QARE_REPOSITORY_VISIBILITY: 'public', QARE_SELF_HOSTED: 'allow' })).code, 1)
  })

  test(`${job}: dedicated pool selectors and the exact ephemeral declaration proceed`, async () => {
    assert.equal((await beforeCheckout(job, { QARE_EXECUTE_RUNS_ON: '["self-hosted", "untrusted"]' })).code, 0)
    assert.equal((await beforeCheckout(job, { QARE_EPHEMERAL_RUNNERS: 'true' })).code, 0)
    for (const value of ['false', 'allow', 'TRUE']) assert.equal((await beforeCheckout(job, { QARE_EPHEMERAL_RUNNERS: value })).code, 1)
  })

  test(`${job}: malformed self-hosted selectors fail closed`, async () => {
    for (const selector of ['oops', '{}', '[]', '[1]', 'null']) {
      assert.equal((await beforeCheckout(job, { QARE_EXECUTE_RUNS_ON: selector })).code, 1, selector)
    }
  })

  test(`${job}: GitHub-hosted execution needs neither new input`, async () => {
    const hosted = await beforeCheckout(job, { RUNNER_ENVIRONMENT: 'github-hosted' })
    assert.equal(hosted.code, 0)
    assert.equal(hosted.summary, '')
  })
}
