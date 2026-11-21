import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { parse } from 'yaml'

// #381: the opt-in buildx layer cache of execute and main_execute. The
// scope is what keeps it safe: only main_execute, on the default branch,
// saves it; a pull request's execute only restores it, so nothing a pull
// request wrote is read by main or by another pull request. The steps' own
// scripts run here with docker stubbed; they need the bash a runner has
// (mapfile), as the other step tests do.

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
interface Step { name?: string; if?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, string> }
interface Job { if?: string; steps: Step[] }
const workflow = parse(readFileSync(join(root, '.github/workflows/pipeline.yml'), 'utf8')) as {
  on: { workflow_call: { inputs: Record<string, { default?: string; description?: string }> } }
  jobs: Record<string, Job>
}
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const step = (job: string, name: string): Step => {
  const found = workflow.jobs[job]?.steps.find((candidate) => candidate.name === name)
  expect(found, `${job} has a step named ${name}`).toBeDefined()
  return found!
}
const names = (job: string) => workflow.jobs[job]!.steps.map((candidate) => candidate.name ?? candidate.uses ?? '')

test('the build cache is off unless the caller turns it on (#381)', () => {
  expect(workflow.on.workflow_call.inputs['build-cache']?.default).toBe('')
  for (const job of ['execute', 'main_execute'])
    for (const name of ['Restore the build cache', "Make the build cache's builder", "Remove the build cache's builder"])
      expect(step(job, name).if, `${job}: ${name}`).toContain("inputs.build-cache == 'true'")
})

test('only main_execute saves the cache, only on the default branch, and only a job that holds no secret touches it (#381)', () => {
  const savers: string[] = []
  const restorers: string[] = []
  for (const [id, job] of Object.entries(workflow.jobs))
    for (const candidate of job.steps) {
      if (candidate.uses?.startsWith('actions/cache/save@')) savers.push(id)
      if (candidate.uses?.startsWith('actions/cache/restore@')) restorers.push(id)
      // The whole action restores and saves; it is never used.
      expect(candidate.uses ?? '', id).not.toMatch(/^actions\/cache@/)
    }
  expect(savers).toEqual(['main_execute'])
  expect(restorers.sort()).toEqual(['execute', 'main_execute'])
  const save = step('main_execute', 'Save the build cache')
  expect(save.if).toContain("github.event_name != 'pull_request'")
  expect(save.if).toContain("github.ref == format('refs/heads/{0}', github.event.repository.default_branch)")
  // main_execute runs on the default branch alone, as main_collect decides.
  expect(workflow.jobs.main_collect?.if).toContain("github.ref == format('refs/heads/{0}', github.event.repository.default_branch)")
  for (const id of ['execute', 'main_execute']) expect(JSON.stringify(workflow.jobs[id]), id).not.toMatch(/secrets\.|github\.token/)
  // Both restore and save under the one key family, by the runner's OS.
  for (const id of ['execute', 'main_execute']) {
    const restore = step(id, 'Restore the build cache')
    expect(restore.with?.['restore-keys']).toBe('qare-build-cache-${{ runner.os }}-')
    expect(restore.with?.path).toBe('${{ runner.temp }}/qare-build-cache')
  }
  expect(save.with?.path).toBe('${{ runner.temp }}/qare-build-cache-new')
  expect(save.with?.key).toBe('qare-build-cache-${{ runner.os }}-${{ github.run_id }}')
})

test('the cache is restored before the run, the builder made after the docker access, and removed after the teardown (#381)', () => {
  for (const [job, run] of [['execute', 'Run the plan'], ['main_execute', 'Run the plan on main']] as const) {
    const order = names(job)
    expect(order.indexOf('Restore the build cache')).toBeLessThan(order.indexOf(run))
    expect(order.indexOf("Make the build cache's builder")).toBeGreaterThan(order.indexOf("Find the runner's docker"))
    expect(order.indexOf("Make the build cache's builder")).toBeLessThan(order.indexOf(run))
    expect(order.indexOf("Remove the build cache's builder")).toBeGreaterThan(order.indexOf('Tear down what the run booted'))
    expect(step(job, run).env?.BUILD_CACHE).toBe('${{ inputs.build-cache }}')
  }
  expect(names('main_execute').at(-1)).toBe('Save the build cache')
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qare-cache-steps-'))
  dirs.push(dir)
  return dir
}

test('the builder step hands the run its builder, and a builder that will not start leaves the run without a cache (#381)', () => {
  for (const fails of [false, true]) {
    const dir = scratch()
    writeFileSync(join(dir, 'qare-docker-access'), '--network\nhost\n')
    writeFileSync(join(dir, 'docker'), `#!/bin/bash\nprintf '%s\\n' "$BUILDX_CONFIG" "$@" > "$RUNNER_TEMP/calls"\nexit ${fails ? 1 : 0}\n`, { mode: 0o755 })
    const ran = spawnSync('bash', ['-c', step('execute', "Make the build cache's builder").run!], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: `${dir}:${process.env.PATH ?? ''}`, RUNNER_TEMP: dir, GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'execute' },
    })
    expect(ran.status, ran.stderr).toBe(0)
    const calls = readFileSync(join(dir, 'calls'), 'utf8').split('\n')
    expect(calls.slice(0, 7)).toEqual([join(dir, 'qare-buildx'), 'buildx', 'create', '--name', 'qare-cache-42-1-execute', '--driver', 'docker-container'])
    const access = readFileSync(join(dir, 'qare-docker-access'), 'utf8').split('\n').filter((line) => line !== '')
    if (fails) {
      expect(ran.stdout).toContain('::warning::')
      expect(existsSync(join(dir, 'qare-buildx-builder'))).toBe(false)
      expect(access).toEqual(['--network', 'host'])
    } else {
      expect(readFileSync(join(dir, 'qare-buildx-builder'), 'utf8').trim()).toBe('qare-cache-42-1-execute')
      expect(access).toEqual(['--network', 'host', '-e', `BUILDX_CONFIG=${join(dir, 'qare-buildx')}`, '-e', 'BUILDX_BUILDER=qare-cache-42-1-execute', '-v', `${join(dir, 'qare-buildx')}:${join(dir, 'qare-buildx')}`])
    }
  }
})

function runStep(job: 'execute' | 'main_execute', env: Record<string, string>, builder: boolean) {
  const dir = scratch()
  writeFileSync(join(dir, 'qare-docker-access'), '')
  if (builder) writeFileSync(join(dir, 'qare-buildx-builder'), 'qare-cache-1\n')
  mkdirSync(join(dir, '.qa'))
  writeFileSync(join(dir, 'docker'), '#!/bin/bash\nprintf \'%s\\n\' "$@" > "$CALLS"\nmkdir -p evidence\nprintf \'{"verdict":"passed","criteria":[]}\' > evidence/result.json\n', { mode: 0o755 })
  writeFileSync(join(dir, 'git'), '#!/bin/bash\nif [ "$1" = worktree ]; then mkdir -p "$4"; fi\nexit 0\n', { mode: 0o755 })
  const run = step(job, job === 'execute' ? 'Run the plan' : 'Run the plan on main').run!
  const calls = join(dir, 'calls')
  const ran = spawnSync('bash', ['-c', run], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: `${dir}:${process.env.PATH ?? ''}`, CALLS: calls, RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: join(dir, 'summary'),
      IMAGE_REF: 'image', IMAGE_DIGEST: 'image', IMAGE_TAG_REF: 'tag', BASE_SHA: 'a'.repeat(40), HEAD_SHA: 'b'.repeat(40),
      PR_NUMBER: '1', PROFILE: '.qa', RUN_ID: '1', RUN_ATTEMPT: '1', FLAKE_ATTEMPTS: '1', QUARANTINE: '',
      ...env,
    },
  })
  return { dir, ran, args: existsSync(calls) ? readFileSync(calls, 'utf8').split('\n') : [] }
}

test('a pull request\'s run reads the cache and never writes it; main reads it and writes the next (#381)', () => {
  const pr = runStep('execute', { BUILD_CACHE: 'true' }, true)
  expect(pr.ran.status, pr.ran.stderr).toBe(0)
  expect(pr.args).toContain('--build-cache-from')
  expect(pr.args[pr.args.indexOf('--build-cache-from') + 1]).toBe(join(pr.dir, 'qare-build-cache'))
  expect(pr.args).not.toContain('--build-cache-to')
  expect(pr.args).toContain(`${join(pr.dir, 'qare-build-cache')}:${join(pr.dir, 'qare-build-cache')}`)

  const main = runStep('main_execute', { BUILD_CACHE: 'true' }, true)
  expect(main.ran.status, main.ran.stderr).toBe(0)
  expect(main.args[main.args.indexOf('--build-cache-from') + 1]).toBe(join(main.dir, 'qare-build-cache'))
  expect(main.args[main.args.indexOf('--build-cache-to') + 1]).toBe(join(main.dir, 'qare-build-cache-new'))
  expect(main.args).toContain(`${join(main.dir, 'qare-build-cache-new')}:${join(main.dir, 'qare-build-cache-new')}`)
})

test('with the cache off, or no builder to use it, the run is handed no cache (#381)', () => {
  for (const job of ['execute', 'main_execute'] as const)
    for (const [env, builder] of [[{ BUILD_CACHE: '' }, true], [{ BUILD_CACHE: 'true' }, false]] as const) {
      const { ran, args } = runStep(job, env, builder)
      expect(ran.status, ran.stderr).toBe(0)
      expect(args.some((arg) => arg.startsWith('--build-cache')), `${job} ${JSON.stringify(env)} ${builder}`).toBe(false)
    }
})
