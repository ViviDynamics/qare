import { expect, test } from 'vitest'
import { inspectRunnerSafety, runDoctor } from '../src/index.js'

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
