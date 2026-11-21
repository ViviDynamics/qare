import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { parse } from 'yaml'

// Exploration in the plan job (#377): the steps that boot and serve the base
// app hold nothing, the plan step holds what it held, and a profile that does
// not explore gets the plan step it had before.

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
interface Step { name?: string; id?: string; if?: string; run?: string; uses?: string; env?: Record<string, string>; with?: Record<string, string> }
const pipeline = parse(readFileSync(join(root, '.github/workflows/pipeline.yml'), 'utf8')) as { jobs: Record<string, { steps: Step[] }> }
const steps = pipeline.jobs.plan!.steps
const step = (name: string): Step => {
  const found = steps.find((candidate) => candidate.name === name)
  expect(found, name).toBeDefined()
  return found!
}

const EXPLORE_STEPS = [
  'Pull the web image for exploration',
  "Find the runner's docker for exploration",
  'Boot the base app for the planner',
  'Serve the base app to the planner',
  'Tear down the explored app',
  'Upload the exploration logs',
]

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function temporary(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qare-pipeline-explore-'))
  dirs.push(dir)
  return dir
}
function run(dir: string, source: string, env: Record<string, string>): { status: number | null; output: string; stderr: string } {
  const output = join(dir, 'output')
  writeFileSync(output, '')
  const result = spawnSync('bash', ['-c', source], { cwd: dir, env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: join(dir, 'summary'), ...env }, encoding: 'utf8' })
  return { status: result.status, output: readFileSync(output, 'utf8'), stderr: result.stderr }
}

test('only a profile that says explore: base turns the exploration steps on (#377)', () => {
  const read = step('Read whether the profile explores')
  for (const [config, expected] of [
    ['explore: base\n', 'explore=base'],
    ['explore: base # the base app\n', 'explore=base'],
    ['flavour: web\n', 'explore=off'],
    ['explore: off\n', 'explore=off'],
    ['explore: head\n', 'explore=off'],
    [undefined, 'explore=off'],
  ] as const) {
    const dir = temporary()
    if (config !== undefined) {
      mkdirSync(join(dir, '.qa'))
      writeFileSync(join(dir, '.qa', 'config.yml'), `app: {}\n${config}`)
    }
    const result = run(dir, read.run!, { PROFILE: '.qa' })
    expect(result.status, String(config)).toBe(0)
    expect(result.output.trim(), String(config)).toBe(expected)
  }
  for (const name of EXPLORE_STEPS) expect(step(name).if, name).toContain("steps.explore.outputs.explore == 'base'")
})

test('the exploration steps hold no model key, no GitHub token and no secret, and run before the key is written (#377)', () => {
  const planIndex = steps.findIndex((candidate) => candidate.name === 'Plan the QA run')
  for (const name of ['Read whether the profile explores', ...EXPLORE_STEPS]) {
    const text = JSON.stringify(step(name))
    expect(text, name).not.toMatch(/secrets\.|GITHUB_TOKEN|GH_TOKEN|MODEL_KEY|model-key|--env-file|github\.token/)
  }
  for (const name of ["Find the runner's docker for exploration", 'Boot the base app for the planner', 'Serve the base app to the planner'])
    expect(steps.findIndex((candidate) => candidate.name === name), name).toBeLessThan(planIndex)
  // The key is written in the plan step alone, as before.
  const keyed = steps.filter((candidate) => (candidate.run ?? '').includes('key_file') || JSON.stringify(candidate.env ?? {}).includes('secrets.'))
  expect(keyed.map((candidate) => candidate.name)).toEqual(['Plan the QA run'])
})

test('the serve step is handed no docker access, and the boot step is the only exploration step that is (#377)', () => {
  const serve = step('Serve the base app to the planner').run!
  expect(serve).not.toContain('docker-access')
  expect(serve).not.toContain('docker.sock')
  expect(serve).not.toContain('DOCKER_HOST')
  // Nothing of the workspace is mounted beside the browser: only the ready file's directory.
  expect(serve.match(/-v "[^"]*"/g)).toEqual(['-v "$dir:$dir"'])
  expect(step('Boot the base app for the planner').run).toContain('qare-explore-docker-access')
  // The prebuilt base image is never what exploration boots.
  for (const name of EXPLORE_STEPS) expect(step(name).run ?? '', name).not.toMatch(/base-image|build-cache/)
})

function planStepEnv(dir: string, endpoint: string): Record<string, string> {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'docker'), `#!/bin/bash\nprintf '%s\\0' "$@" > "$QARE_ARGS_FILE"\n`, { mode: 0o755 })
  writeFileSync(join(dir, 'change.diff'), '')
  writeFileSync(join(dir, 'change-planner.diff'), '')
  return {
    PATH: `${bin}:${process.env.PATH ?? ''}`, RUNNER_TEMP: dir, IMAGE_REF: 'fixture-image',
    MODEL_KEY: 'test-only', MODEL_KEY_ENV: 'MODEL_TEST_KEY', NARE_PROVIDER: '', NARE_MODEL: '',
    NARE_STREAM: '', NARE_BASE_URL: '', NARE_CONTEXT_WINDOW: '', QARE_MAX_OUTPUT_TOKENS: '',
    QARE_PLAN_BATCH_SIZE: '', QARE_PLAN_CONCURRENCY: '', PROFILE: '.qa', EXPLORE_ENDPOINT: endpoint,
    QARE_ARGS_FILE: join(dir, 'docker-args'),
  }
}

test('with exploration off the plan step runs the container it ran before; on, it adds the endpoint and the loopback and nothing else (#377)', () => {
  const plan = step('Plan the QA run')
  expect(plan.env?.EXPLORE_ENDPOINT).toBe('${{ steps.serve.outputs.endpoint }}')
  const off = temporary()
  expect(run(off, plan.run!, planStepEnv(off, '')).status).toBe(0)
  const offArgs = readFileSync(join(off, 'docker-args'), 'utf8').split('\0').filter(Boolean)
  expect(offArgs).not.toContain('--explore')
  expect(offArgs).not.toContain('--network')
  expect(offArgs.slice(offArgs.indexOf('fixture-image'))).toEqual([
    'fixture-image', 'qare', 'plan', '--criteria', 'criteria.json', '--diff', 'change-planner.diff', '--out', 'plan.json',
    '--nare', '/usr/local/bin/nare', '--profile', '.qa',
  ])

  const on = temporary()
  const endpoint = ['http:', '//127.0.0.1:47001'].join('')
  expect(run(on, plan.run!, planStepEnv(on, endpoint)).status).toBe(0)
  const onArgs = readFileSync(join(on, 'docker-args'), 'utf8').split('\0').filter(Boolean)
  expect(onArgs.slice(onArgs.indexOf('fixture-image'))).toEqual([...offArgs.slice(offArgs.indexOf('fixture-image')), '--explore', endpoint])
  // The key file is minted fresh each run; past it, the only difference is the loopback.
  const keyless = (args: string[], dir: string): string[] =>
    args.map((arg, at) => (args[at - 1] === '--env-file' ? '<key file>' : arg.replaceAll(dir, '<workspace>')))
  const before = keyless(onArgs.slice(0, onArgs.indexOf('fixture-image')), on)
  const network = before.indexOf('--network')
  expect(before.slice(network, network + 2)).toEqual(['--network', 'host'])
  expect([...before.slice(0, network), ...before.slice(network + 2)]).toEqual(keyless(offArgs.slice(0, offArgs.indexOf('fixture-image')), off))
})
