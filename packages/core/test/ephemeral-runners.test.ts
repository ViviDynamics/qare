import { expect, test } from 'vitest'
import { detectHost, parseResult, renderComment, RESULT_SCHEMA_VERSION } from '../src/index.js'

const host = { os: 'linux', arch: 'x64', virtualisation: false, runner: 'self-hosted' }
const result = (ephemeralRunners?: unknown): Record<string, unknown> => ({
  schemaVersion: RESULT_SCHEMA_VERSION, verdict: 'passed', criteria: [],
  environment: {
    execution: 'containerised', versions: { qare: '2026.10.43', node: '24.5.0', nareContract: 1 },
    host: { ...host, ...(ephemeralRunners === undefined ? {} : { ephemeralRunners }) },
  },
})

test('self-hosted evidence records only the exact caller ephemeral-runners declaration (#308)', () => {
  const probes = { platform: 'linux', arch: 'x64', virtualisation: () => 'none' }
  expect(detectHost({ ...probes, env: { QARE_RUNNER_ENVIRONMENT: 'self-hosted', QARE_EPHEMERAL_RUNNERS: 'true' } })).toEqual({ ...host, ephemeralRunners: true })
  for (const value of ['', 'false', 'allow', 'TRUE']) {
    expect(detectHost({ ...probes, env: { QARE_RUNNER_ENVIRONMENT: 'self-hosted', QARE_EPHEMERAL_RUNNERS: value } })).toEqual(host)
  }
  expect(detectHost({ ...probes, env: { QARE_RUNNER_ENVIRONMENT: 'github-hosted', QARE_EPHEMERAL_RUNNERS: 'true' } })).toEqual({ ...host, runner: 'github-hosted' })
})

test('result loading preserves the declaration and posted evidence attributes it to the caller (#308)', () => {
  const loaded = parseResult(result(true))
  expect(loaded.environment?.host).toEqual({ ...host, ephemeralRunners: true })
  expect(renderComment(loaded)).toContain("The caller declared ephemeral-runners: 'true': each job gets a fresh machine and docker daemon destroyed afterwards, with no volume or cache shared between jobs. qare has not verified that declaration.")
  expect(renderComment(parseResult(result()))).not.toContain('declared ephemeral-runners')
})

test('malformed declarations are refused by name instead of being silently lost (#308)', () => {
  for (const value of ['true', false, 1, null]) {
    expect(() => parseResult(result(value))).toThrow(/environment.host.ephemeralRunners/)
  }
})
