import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { parse } from 'yaml'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const workflow = parse(readFileSync(join(root, '.github/workflows/pipeline.yml'), 'utf8')) as { jobs: Record<string, { steps: Array<{ name?: string; uses?: string; run?: string }> }> }

test('both execute jobs inspect their runner before checkout and forward only a sanitized snapshot', () => {
  for (const job of ['execute', 'main_execute']) {
    const steps = workflow.jobs[job]!.steps
    const index = steps.findIndex(step => step.name === 'Inspect self-hosted runner checklist')
    expect(index, job).toBeGreaterThanOrEqual(0)
    expect(index, job).toBeLessThan(steps.findIndex(step => step.uses?.startsWith('actions/checkout')))
    const dir = mkdtempSync(join(tmpdir(), 'qare-runner-snapshot-'))
    try {
      mkdirSync(join(dir, '.docker'))
      writeFileSync(join(dir, '.docker/config.json'), '{"auth":"private-file-content"}')
      const summary = join(dir, 'summary.md')
      const result = spawnSync('bash', ['-e', '-c', steps[index]!.run!], {
        cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: summary, RUNNER_ENVIRONMENT: 'self-hosted', REGISTRY_PASSWORD: 'private-env-value' },
      })
      expect(result.status, result.stderr).toBe(0)
      const snapshot = readFileSync(join(dir, 'qare-runner-safety.json'), 'utf8')
      expect(JSON.parse(snapshot)).toMatchObject({ schemaVersion: '1', credentialVariables: ['REGISTRY_PASSWORD'], credentialFiles: ['HOME/.docker/config.json'] })
      const written = readFileSync(summary, 'utf8')
      expect(written).toContain('credentials: environment variable REGISTRY_PASSWORD')
      expect(written).toContain('cannot observe')
      expect(snapshot + written + result.stdout + result.stderr).not.toContain('private-env-value')
      expect(snapshot + written + result.stdout + result.stderr).not.toContain('private-file-content')
      const run = steps.find(step => step.name === (job === 'execute' ? 'Run the plan' : 'Run the plan on main'))
      expect(run?.run).toContain('QARE_RUNNER_SAFETY_FILE=/tmp/qare-runner-safety.json')
      expect(run?.run).toContain('qare-runner-safety.json:/tmp/qare-runner-safety.json:ro')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
})

test('GitHub-hosted jobs need no safety snapshot or extra setup', () => {
  const step = workflow.jobs.execute!.steps.find(step => step.name === 'Inspect self-hosted runner checklist')
  expect(step).toBeDefined()
  const result = spawnSync('bash', ['-e', '-c', step!.run!], { encoding: 'utf8', env: { PATH: process.env.PATH, RUNNER_ENVIRONMENT: 'github-hosted' } })
  expect(result.status, result.stderr).toBe(0)
})
