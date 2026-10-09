import { expect, test } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectRunnerSafety, parseResult, renderComment, runDoctor, runJob, validateProfileConfig } from '../src/index.js'

const safe = {
  readable: () => false,
  reachable: async () => false,
}

test('hosted and local jobs do not run self-hosted probes', async () => {
  for (const env of [{}, { RUNNER_ENVIRONMENT: 'github-hosted' }]) {
    expect(await inspectRunnerSafety(env, { readable: () => { throw new Error('unexpected probe') } })).toBeUndefined()
  }
})

test('each checklist item names what cannot be verified from inside a job', async () => {
  const findings = await inspectRunnerSafety({ RUNNER_ENVIRONMENT: 'self-hosted' }, safe)
  expect(findings?.filter(f => f.status === 'unobservable').map(f => f.checklist)).toEqual([
    'ephemeral', 'docker', 'execute-pool', 'network', 'credentials', 'image-digest',
  ])
  expect(findings?.every(f => f.detail.includes('cannot observe'))).toBe(true)
})

test('mounted tokens and credential environment names are findings without secret values', async () => {
  const env = { QARE_RUNNER_ENVIRONMENT: 'self-hosted', AWS_SECRET_ACCESS_KEY: 'never-publish-me', REGISTRY_PASSWORD: 'also-secret', AWS_WEB_IDENTITY_TOKEN_FILE: '/mounted/cloud-token', KUBECONFIG: '/mounted/kubeconfig' }
  const findings = await inspectRunnerSafety(env, { ...safe, readable: path => ['/var/run/secrets/kubernetes.io/serviceaccount/token', '/mounted/cloud-token', '/mounted/kubeconfig'].includes(path) })
  expect(findings?.filter(f => f.status === 'finding').every(f => f.checklist === 'credentials')).toBe(true)
  expect(JSON.stringify(findings)).toContain('AWS_SECRET_ACCESS_KEY')
  expect(JSON.stringify(findings)).toContain('REGISTRY_PASSWORD')
  expect(JSON.stringify(findings)).toContain('/var/run/secrets/kubernetes.io/serviceaccount/token')
  expect(JSON.stringify(findings)).toContain('AWS_WEB_IDENTITY_TOKEN_FILE')
  expect(JSON.stringify(findings)).toContain('KUBECONFIG')
  expect(JSON.stringify(findings)).not.toContain('never-publish-me')
  expect(JSON.stringify(findings)).not.toContain('also-secret')
})

test('a reachable cluster API and a remote Docker daemon map to their checklist items', async () => {
  const asked: Array<[string, number]> = []
  const findings = await inspectRunnerSafety({ RUNNER_ENVIRONMENT: 'self-hosted', KUBERNETES_SERVICE_HOST: '10.0.0.1', KUBERNETES_SERVICE_PORT: '443', DOCKER_HOST: ['tcp:', '//10.0.0.2:2375'].join('') }, {
    ...safe,
    reachable: async (host, port) => { asked.push([host, port]); return true },
  })
  expect(asked).toEqual([['10.0.0.1', 443], ['10.0.0.2', 2375]])
  expect(findings).toEqual(expect.arrayContaining([
    expect.objectContaining({ checklist: 'network', status: 'finding', detail: expect.stringContaining('cluster API') }),
    expect.objectContaining({ checklist: 'docker', status: 'finding', detail: expect.stringContaining('remote Docker daemon') }),
  ]))
})

test('unreachable endpoints, malformed ports and empty credentials do not create hazards', async () => {
  const findings = await inspectRunnerSafety({ RUNNER_ENVIRONMENT: 'self-hosted', KUBERNETES_SERVICE_HOST: '10.0.0.1', KUBERNETES_SERVICE_PORT: 'not-a-port', AWS_SECRET_ACCESS_KEY: '', DOCKER_HOST: 'invalid' }, safe)
  expect(findings?.filter(f => f.status === 'finding')).toEqual([])
})

test('doctor names checklist findings and unobservable items without declaring readiness unsafe', async () => {
  const report = await runDoctor({ probes: {
    which: name => `/usr/bin/${name}`,
    dockerInfo: async () => ({ ok: true, detail: 'docker reachable' }),
    chromium: async () => ({ ok: true, detail: 'chromium present' }),
    python: async () => ({ version: '3.12', detail: 'python present' }),
    host: { env: { RUNNER_ENVIRONMENT: 'self-hosted', REGISTRY_TOKEN: 'secret' } },
    runnerSafety: safe,
  } })
  expect(report.findings).toEqual(expect.arrayContaining([
    expect.objectContaining({ checklist: 'credentials', status: 'finding', ok: false, required: false }),
    expect.objectContaining({ checklist: 'execute-pool', status: 'unobservable', required: false }),
  ]))
  expect(JSON.stringify(report)).not.toContain('"secret"')
  expect(report.ready).toBe(true)
})

test('execute captures runner findings before a command and preserves them in evidence and its comment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-safety-run-'))
  try {
    const tokenFile = join(dir, 'cloud-token')
    await writeFile(tokenFile, 'private-file-content')
    await writeFile(join(dir, 'check.mjs'), 'console.log("checked")\n')
    const outcome = await runJob({
      id: 'safety-run', repoPath: dir, baseRef: 'main', headRef: 'HEAD', post: 'none', evidenceDir: join(dir, 'evidence'),
      profile: { inline: validateProfileConfig({ target: { url: ['https:', '//app.example.test'].join(''), health: { http: '/health', timeout: '1s' } } }) },
      criteria: [{ id: 'works', text: 'works', checks: [{ kind: 'command', run: 'node check.mjs', expect: { exit: 0 } }] }],
    }, {
      execution: 'native',
      host: { env: { RUNNER_ENVIRONMENT: 'self-hosted', QARE_REPOSITORY_VISIBILITY: 'private', REGISTRY_PASSWORD: 'private-env-value', AWS_WEB_IDENTITY_TOKEN_FILE: tokenFile } },
      runnerSafety: { reachable: async () => false },
      probe: async () => ({ ok: true }),
    })
    expect(outcome.result.verdict).toBe('passed')
    const recorded = await readFile(join(dir, 'evidence/result.json'), 'utf8')
    const loaded = parseResult(JSON.parse(recorded))
    expect(loaded.environment?.runnerSafety).toEqual(outcome.result.environment?.runnerSafety)
    expect(loaded.environment?.runnerSafety).toEqual(expect.arrayContaining([
      expect.objectContaining({ checklist: 'credentials', status: 'finding', detail: expect.stringContaining('REGISTRY_PASSWORD') }),
      expect.objectContaining({ checklist: 'credentials', status: 'finding', detail: expect.stringContaining('AWS_WEB_IDENTITY_TOKEN_FILE') }),
    ]))
    expect(recorded).not.toContain('private-file-content')
    expect(recorded).not.toContain('private-env-value')
    const comment = renderComment(loaded)
    expect(comment).toContain('Self-hosted runner checklist')
    expect(comment).toContain('REGISTRY_PASSWORD')
    expect(comment).toContain('cannot observe pool membership')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('loading a result rejects malformed safety records and keeps old results compatible', () => {
  const result = {
    schemaVersion: '1', verdict: 'passed', criteria: [],
    environment: { execution: 'native', versions: { qare: '1', node: '22', nareContract: 1 } },
  }
  expect(parseResult(result).environment?.runnerSafety).toBeUndefined()
  for (const runnerSafety of ['unsafe', [{ checklist: 'unknown', status: 'finding', detail: 'a hazard' }], [{ checklist: 'docker', status: 'safe', detail: 'a hazard' }], [{ checklist: 'docker', status: 'finding', detail: '' }]]) {
    expect(() => parseResult({ ...result, environment: { ...result.environment, runnerSafety } })).toThrow(/runnerSafety/)
  }
})

test('sanitized runner snapshot finds hazards hidden by the execute container and rejects malformed snapshots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-safety-snapshot-'))
  const file = join(dir, 'snapshot.json')
  const env = { RUNNER_ENVIRONMENT: 'self-hosted', QARE_RUNNER_SAFETY_FILE: file }
  try {
    await writeFile(file, JSON.stringify({ schemaVersion: '1', credentialVariables: ['REGISTRY_PASSWORD'], credentialFiles: ['service-account-token', 'AWS_WEB_IDENTITY_TOKEN_FILE'], clusterReachable: true, remoteDocker: true }))
    const findings = await inspectRunnerSafety(env, safe)
    expect(findings?.filter(f => f.status === 'finding').map(f => f.checklist)).toEqual(['credentials', 'credentials', 'credentials', 'network', 'docker'])
    expect(JSON.stringify(findings)).toContain('REGISTRY_PASSWORD')
    for (const content of ['{}', JSON.stringify({ schemaVersion: '1', credentialVariables: ['unvalidated secret text'], credentialFiles: [], clusterReachable: false, remoteDocker: false })]) {
      await writeFile(file, content)
      await expect(inspectRunnerSafety(env, safe)).rejects.toThrow(/runner safety snapshot/)
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
