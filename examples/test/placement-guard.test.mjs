// The pipeline's own guard against running a public repository's pull
// request on a self-hosted runner (#76), run for real: the step is the bash
// the workflow carries, executed here with the environment a runner gives it.
// It is the first step of every job that puts the pull request's tree on a
// machine, so it stops before any checkout.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipelineStep } from '../../scripts/run-pipeline-step.mjs'
import { placementProblem } from '../../packages/core/dist/index.js'

const GUARD = "Keep a public repository's run off a self-hosted runner"

async function guard(job, env) {
  const step = pipelineStep(job, GUARD)
  const dir = await mkdtemp(join(tmpdir(), 'qare-placement-guard-'))
  const summary = join(dir, 'summary.md')
  const outcome = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run], {
    env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summary, ...env },
    encoding: 'utf8',
  })
  return { code: outcome.status, stdout: outcome.stdout, summary: await readFile(summary, 'utf8').catch(() => '') }
}

const PUBLIC_SELF_HOSTED = { RUNNER_ENVIRONMENT: 'self-hosted', QARE_REPOSITORY_VISIBILITY: 'public', QARE_SELF_HOSTED: '' }

for (const job of ['collect', 'plan', 'execute']) {
  test(`${job}: a public repository's run on a self-hosted runner stops before anything is checked out, by name`, async () => {
    const stopped = await guard(job, PUBLIC_SELF_HOSTED)
    assert.equal(stopped.code, 1)
    // The reason is the one qare run gives, word for word: one rule, said once.
    const reason = placementProblem({ os: 'linux', arch: 'x64', virtualisation: false, runner: 'self-hosted' }, { QARE_REPOSITORY_VISIBILITY: 'public' })
    assert.equal(stopped.summary.trim(), reason)
    assert.match(stopped.stdout, /^::error::this repository is public and the run landed on a self-hosted runner/m)
  })

  test(`${job}: the opt in, a hosted runner and a private repository all go ahead`, async () => {
    for (const env of [
      { ...PUBLIC_SELF_HOSTED, QARE_SELF_HOSTED: 'allow' },
      { ...PUBLIC_SELF_HOSTED, RUNNER_ENVIRONMENT: 'github-hosted' },
      { ...PUBLIC_SELF_HOSTED, QARE_REPOSITORY_VISIBILITY: 'private' },
      { ...PUBLIC_SELF_HOSTED, QARE_REPOSITORY_VISIBILITY: 'internal' },
      // Outside a workflow run nothing names a runner.
      { QARE_REPOSITORY_VISIBILITY: 'public', QARE_SELF_HOSTED: '' },
    ]) {
      const went = await guard(job, env)
      assert.equal(went.code, 0, JSON.stringify(env))
      assert.equal(went.summary, '')
    }
    // Only the one word opts in.
    assert.equal((await guard(job, { ...PUBLIC_SELF_HOSTED, QARE_SELF_HOSTED: 'true' })).code, 1)
  })
}
