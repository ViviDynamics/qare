import { existsSync } from 'node:fs'
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { main } from '../src/index.js'
import type { Writer } from '../src/index.js'

// #431: the pull request that onboards a repository adds its profile, so the
// base the plan job checks out has none. The head's profile reaches the
// planner as data through --pr-profile: read, never run.

let batchSizeBefore: string | undefined
beforeEach(() => {
  batchSizeBefore = process.env.QARE_PLAN_BATCH_SIZE
  process.env.QARE_PLAN_BATCH_SIZE = '50'
})
afterEach(() => {
  if (batchSizeBefore === undefined) delete process.env.QARE_PLAN_BATCH_SIZE
  else process.env.QARE_PLAN_BATCH_SIZE = batchSizeBefore
})

function capture(): { lines: string[]; writer: Writer; text: () => string } {
  const lines: string[] = []
  return { lines, writer: { write: (chunk) => lines.push(chunk) }, text: () => lines.join('') }
}

const CRITERIA = [{ id: 'c1', text: 'the health endpoint answers 200' }]

const PLAN = {
  schemaVersion: '1',
  criteria: [{ id: 'c1', text: CRITERIA[0]!.text, checks: [{ kind: 'flow', name: 'api', suite: 'api' }] }],
}

/** A nare stand-in that keeps the prompt it was handed, then answers PLAN. */
async function recordingNare(dir: string): Promise<{ binary: string; prompt: () => Promise<string> }> {
  const promptPath = join(dir, 'prompt.txt')
  const binary = join(dir, 'nare')
  const script = [
    '#!/usr/bin/env node',
    `import { readFileSync, writeFileSync } from 'node:fs'`,
    `writeFileSync(${JSON.stringify(promptPath)}, readFileSync(process.argv[process.argv.indexOf('--prompt-file') + 1], 'utf8'))`,
    `const answer = ${JSON.stringify(JSON.stringify(PLAN))}`,
    `console.log(JSON.stringify({ type: 'output', text: answer, detail: {} }))`,
    `console.log(JSON.stringify({ type: 'result', status: 'done', questions: [], usage: { input: 1, output: 1 },`,
    `  stop_reason: 'end_turn', turns: 1, contract: 3, output: JSON.parse(answer), error: null }))`,
  ].join('\n')
  await writeFile(`${binary}.mjs`, script, 'utf8')
  await writeFile(binary, `#!/bin/sh\nexec node ${binary}.mjs "$@"\n`, 'utf8')
  await chmod(binary, 0o755)
  return { binary, prompt: async () => await readFile(promptPath, 'utf8') }
}

/**
 * A target profile with a suite and QA.md, and, when asked, a host MCP server
 * whose command leaves a marker file the moment anything starts it.
 */
async function setup(opts: { mcp?: boolean } = {}): Promise<{ dir: string; profile: string; marker: string; args: string[]; nare: Awaited<ReturnType<typeof recordingNare>> }> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-plan-pr-profile-'))
  const profile = join(dir, '.qa')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'QA.md'), '# QA\n\nThe API answers on /healthz.\n', 'utf8')
  const marker = join(dir, 'started')
  const starter = join(dir, 'starter.mjs')
  await writeFile(starter, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'started')\n`, 'utf8')
  const targetUrl = ['http:', '//127.0.0.1:3000'].join('')
  await writeFile(
    join(profile, 'config.yml'),
    [
      'target:',
      `  url: ${targetUrl}`,
      '  health: { http: /healthz, timeout: 5s }',
      'flavour: core',
      'suites:',
      '  - { name: api, command: "pytest tests/api", kind: flow }',
      ...(opts.mcp === true
        ? ['mcp:', '  - name: rig', `    command: node ${starter}`, '    tools: [power_on]', '    steps: [plan]']
        : []),
      '',
    ].join('\n'),
    'utf8',
  )
  const criteriaPath = join(dir, 'criteria.json')
  const diffPath = join(dir, 'change.diff')
  await writeFile(criteriaPath, JSON.stringify(CRITERIA), 'utf8')
  await writeFile(diffPath, 'diff --git a/app.py b/app.py', 'utf8')
  const nare = await recordingNare(dir)
  return { dir, profile, marker, nare, args: ['plan', '--criteria', criteriaPath, '--diff', diffPath, '--out', join(dir, 'plan.json'), '--nare', nare.binary] }
}

async function planOf(dir: string): Promise<{ profileSource?: string }> {
  return JSON.parse(await readFile(join(dir, 'plan.json'), 'utf8')) as { profileSource?: string }
}

test("--pr-profile hands the planner the pull request's suites, address and QA.md, and the plan records it read them as data (#431)", async () => {
  const { dir, profile, nare, args } = await setup()
  const out = capture()

  const code = await main([...args, '--pr-profile', profile], out.writer, capture().writer)

  expect(code).toBe(0)
  const prompt = await nare.prompt()
  expect(prompt).toContain('- api (a flow suite)')
  expect(prompt).toContain('The API answers on /healthz.')
  expect(prompt).toContain('127.0.0.1:3000')
  expect((await planOf(dir)).profileSource).toBe('pull-request')
  expect(out.text()).toContain("planning with the pull request's profile at")
  expect(out.text()).toContain('read as data')
})

test("--pr-profile starts none of the profile's host MCP servers, and says so (#431)", async () => {
  const { dir, profile, marker, args } = await setup({ mcp: true })
  const out = capture()

  const code = await main([...args, '--pr-profile', profile], out.writer, capture().writer)

  expect(code).toBe(0)
  expect(existsSync(marker)).toBe(false)
  expect(out.text()).toContain("host MCP server 'rig' is not started")
  expect((await planOf(dir)).profileSource).toBe('pull-request')
})

test('the same profile through --profile does start its host MCP server: the marker proves the test above could fail (#431)', async () => {
  const { profile, marker, args } = await setup({ mcp: true })

  await main([...args, '--profile', profile], capture().writer, capture().writer)

  expect(existsSync(marker)).toBe(true)
})

test('--pr-profile is refused beside --profile or --explore, before any model call (#431)', async () => {
  const { dir, profile, args } = await setup()
  const endpoint = ['http:', '//127.0.0.1:1'].join('')
  for (const extra of [['--profile', profile], ['--explore', endpoint]]) {
    const err = capture()
    const code = await main([...args, '--pr-profile', profile, ...extra], capture().writer, err.writer)
    expect(code, extra[0]).toBe(4)
    expect(err.text(), extra[0]).toContain('--pr-profile')
    expect(existsSync(join(dir, 'prompt.txt')), extra[0]).toBe(false)
  }
})

test('--profile records the checkout, and a profile flag that names nothing usable records none (#431)', async () => {
  const { dir, profile, args } = await setup()

  expect(await main([...args, '--profile', profile], capture().writer, capture().writer)).toBe(0)
  expect((await planOf(dir)).profileSource).toBe('checkout')

  const missing = join(dir, 'absent')
  expect(await main([...args, '--profile', missing], capture().writer, capture().writer)).toBe(0)
  expect((await planOf(dir)).profileSource).toBe('none')

  const out = capture()
  expect(await main([...args, '--pr-profile', missing], out.writer, capture().writer)).toBe(0)
  expect((await planOf(dir)).profileSource).toBe('none')
  expect(out.text()).toContain(`no usable .qa/ profile at ${missing}`)
})

test('a plan made with no profile flag records nothing about a profile (#431)', async () => {
  const { dir, args } = await setup()

  expect(await main(args, capture().writer, capture().writer)).toBe(0)
  expect((await planOf(dir)).profileSource).toBeUndefined()
})

// #413: the plan job reads explore from the base checkout, so on the pull
// request that adds a profile asking for `explore: base` exploration was
// silently off. The plan now records that it did not run, and why.
async function exploringProfile(profile: string): Promise<void> {
  await writeFile(
    join(profile, 'config.yml'),
    [
      'app:',
      '  boot: { compose: compose.qa.yaml, service: web }',
      `  health: { http: "${['http:', '//localhost:3000/up'].join('')}", timeout: 30s }`,
      '  seed: { command: "true" }',
      'flavour: web',
      'explore: base',
      'stubs: []',
      'visual: { widths: [1280], themes: [light] }',
      'suites:',
      '  - { name: api, command: "pytest tests/api", kind: flow }',
      '',
    ].join('\n'),
    'utf8',
  )
}

test("a pull request's profile that asks to explore the base records that exploration did not run, and why (#413)", async () => {
  const { dir, profile, args } = await setup()
  await exploringProfile(profile)
  const out = capture()

  const code = await main([...args, '--pr-profile', profile], out.writer, capture().writer)

  expect(code).toBe(0)
  const plan = (await planOf(dir)) as { profileSource?: string; exploreSkipped?: boolean }
  expect(plan.profileSource).toBe('pull-request')
  expect(plan.exploreSkipped).toBe(true)
  expect(out.text()).toContain('explore: base did not run: the base revision has no profile, so there was no base app to explore')
})

test('the base revision\'s own profile records nothing about exploration: the plan job explores it when it says so (#413)', async () => {
  const { dir, profile, args } = await setup()
  await exploringProfile(profile)

  await main([...args, '--profile', profile], capture().writer, capture().writer)

  expect('exploreSkipped' in (await planOf(dir))).toBe(false)
})
