import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
  FakeAgentRunner,
  FakeAgentRunnerError,
  NareAgentRunner,
  NotImplemented,
  type AgentRunRequest,
  type AgentRunResult,
} from '../src/index.js'

function request(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    prompt: 'plan the criteria for this repository',
    system: 'you plan QA criteria and answer only with schema-constrained output',
    toolPolicy: 'none',
    outputSchema: 'plan.json',
    budget: { maxOutputTokens: 2048 },
    ...overrides,
  }
}

function result(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    status: 'completed',
    stopReason: 'end_turn',
    usage: { inputTokens: 11, outputTokens: 7 },
    output: { schemaVersion: '1', criteria: [] },
    ...overrides,
  }
}

test('the fake runner returns scripted responses in order and records every request', async () => {
  const completed = result({ output: { schemaVersion: '1', criteria: [] } })
  const truncated = result({
    status: 'failed',
    stopReason: 'max_tokens',
    usage: { inputTokens: 3, outputTokens: 2048 },
    output: null,
  })
  const fake = new FakeAgentRunner([completed, truncated])

  const first = request()
  const second = request({ toolPolicy: 'read-only', outputSchema: 'result.json', budget: { maxOutputTokens: 512 } })
  await expect(fake.run(first)).resolves.toBe(completed)
  await expect(fake.run(second)).resolves.toBe(truncated)
  expect(fake.requests).toEqual([first, second])
})

test('an exhausted fake script fails closed with a named error', async () => {
  const fake = new FakeAgentRunner([result()])
  await fake.run(request())
  await expect(fake.run(request())).rejects.toThrow(FakeAgentRunnerError)
  await expect(fake.run(request())).rejects.toThrow(/exhausted/)
})

test('a scripted failure result is surfaced as-is, not converted to a pass', async () => {
  const failed = result({ status: 'failed', stopReason: 'error', output: null })
  const fake = new FakeAgentRunner([failed])
  await expect(fake.run(request())).resolves.toBe(failed)
})

test('NareAgentRunner throws NotImplemented on construction, pointing at the deferred nare integration', () => {
  expect(() => new NareAgentRunner()).toThrow(NotImplemented)
  try {
    new NareAgentRunner()
  } catch (error) {
    expect(error).toBeInstanceOf(NotImplemented)
    expect(error.name).toBe('NotImplemented')
    expect(error.message).toMatch(/nare/i)
    expect(error.message).toMatch(/not versioned/)
  }
})

test('NareAgentRunner throws NotImplemented on call, even when construction is bypassed', async () => {
  const stub = Object.create(NareAgentRunner.prototype) as NareAgentRunner
  await expect(stub.run()).rejects.toThrow(NotImplemented)
})

const NETWORK_MARKERS = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'axios',
  'undici',
  'node:http',
  'node:https',
  'node:net',
  'node:tls',
  'node:dns',
  'http://',
  'https://',
]

function listTestFiles(root: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    const testDir = join(root, 'packages', entry.name, 'test')
    if (!entry.isDirectory() || !existsSync(testDir)) continue
    for (const file of readdirSync(testDir)) {
      if (file.endsWith('.test.ts')) files.push(join(testDir, file))
    }
  }
  return files
}

test('no test file reaches the network (the scanner exempts itself: it declares the forbidden markers as literals)', () => {
  const root = fileURLToPath(new URL('../../..', import.meta.url))
  const self = fileURLToPath(import.meta.url)
  const files = listTestFiles(root).filter((file) => file !== self)
  expect(files.length).toBeGreaterThan(0)
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const marker of NETWORK_MARKERS) {
      expect(source.includes(marker), `${file} must not contain ${JSON.stringify(marker)}: every test exercises the fake runner, offline`).toBe(false)
    }
  }
})
