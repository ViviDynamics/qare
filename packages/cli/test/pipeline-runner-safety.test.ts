import { execFile, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'
import { parse } from 'yaml'
import { fakeCluster } from './fake-cluster.js'

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

test('the cluster reachability probe neither sends nor logs credentials from a runner curl configuration', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qare-runner-curl-'))
  writeFileSync(join(dir, '.curlrc'), 'header = "Authorization: Bearer private-curl-credential"\ntrace-ascii = "/dev/stderr"\n')
  try {
    for (const job of ['execute', 'main_execute']) {
      const host = job === 'execute' ? '127.0.0.1' : '::1'
      const server = await fakeCluster(dir, host)
      try {
      const step = workflow.jobs[job]!.steps.find(step => step.name === 'Inspect self-hosted runner checklist')!
      const result = await promisify(execFile)('bash', ['-e', '-c', step.run!], { cwd: dir, env: {
        PATH: process.env.PATH, HOME: dir, CURL_HOME: dir, RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: join(dir, 'summary.md'), RUNNER_ENVIRONMENT: 'self-hosted', KUBERNETES_SERVICE_HOST: host, KUBERNETES_SERVICE_PORT: String(server.port),
      } })
      expect(result.stdout + result.stderr).not.toContain('private-curl-credential')
      expect(JSON.parse(readFileSync(join(dir, 'qare-runner-safety.json'), 'utf8')).clusterReachable).toBe(true)
      expect(server.headers).toEqual([undefined])
      } finally { await server.close() }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
