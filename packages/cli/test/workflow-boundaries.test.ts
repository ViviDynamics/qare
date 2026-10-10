import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { parse } from 'yaml'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
interface Step { name?: string; run?: string; id?: string; uses?: string; with?: { name?: string; path?: string } }
const pipeline = parse(readFileSync(join(root, '.github/workflows/pipeline.yml'), 'utf8')) as { jobs: Record<string, { steps: Step[] }> }
const dirs: string[] = []
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qare-workflow-boundary-'))
  dirs.push(dir)
  mkdirSync(join(dir, '.qare-pipeline'), { recursive: true })
  mkdirSync(join(dir, 'evidence'), { recursive: true })
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function script(job: string, name: string): string {
  const step = pipeline.jobs[job]?.steps.find((step) => step.name === name)
  expect(step?.run, `${job}: ${name}`).toBeTypeOf('string')
  return step!.run!
}
function run(dir: string, source: string, env: Record<string, string> = {}): { status: number | null; output: string } {
  const output = join(dir, 'output')
  writeFileSync(output, '')
  const result = spawnSync('bash', ['-c', source], { cwd: dir, env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: join(dir, 'summary'), ...env }, encoding: 'utf8' })
  return { status: result.status, output: readFileSync(output, 'utf8') }
}

for (const job of ['collect', 'main_collect']) {
  test(`${job} rejects malformed manifest versions before writing outputs`, () => {
    const dir = fixture()
    const source = script(job, 'Read the version of the pinned qare')
    for (const version of ['', '2026.10.47\nextra=value', '2026.10.47\n', 'latest', 47, null, { version: '2026.10.47' }]) {
      writeFileSync(join(dir, '.qare-pipeline/package.json'), JSON.stringify({ version }))
      const result = run(dir, source, { QARE_REF: 'main' })
      expect(result.status, JSON.stringify(version)).not.toBe(0)
      expect(result.output, JSON.stringify(version)).toBe('')
    }
  })
  test(`${job} rejects unreadable or multiple manifest documents`, () => {
    const dir = fixture()
    const source = script(job, 'Read the version of the pinned qare')
    for (const manifest of ['', 'not json', '{"version":"2026.10.47"}\n{"version":"2026.10.46"}']) {
      writeFileSync(join(dir, '.qare-pipeline/package.json'), manifest)
      expect(run(dir, source, { QARE_REF: 'main' })).toEqual({ status: 1, output: '' })
    }
    rmSync(join(dir, '.qare-pipeline/package.json'))
    expect(run(dir, source, { QARE_REF: 'main' })).toEqual({ status: 1, output: '' })
  })
  test(`${job} accepts a release ref or the pinned manifest version as one line`, () => {
    const dir = fixture()
    writeFileSync(join(dir, '.qare-pipeline/package.json'), JSON.stringify({ version: '2026.10.46' }))
    const source = script(job, 'Read the version of the pinned qare')
    expect(run(dir, source, { QARE_REF: '2026.10.47' })).toEqual({ status: 0, output: 'version=2026.10.47\n' })
    expect(run(dir, source, { QARE_REF: 'main' })).toEqual({ status: 0, output: 'version=2026.10.46\n' })
  })
}
for (const job of ['execute', 'judge', 'main_execute', 'main_judge']) {
  const name = job.includes('execute') ? 'Read the recorded verdict' : 'Read the executed verdict'
  test(`${job} rejects unknown, malformed and missing verdicts before writing outputs`, () => {
    const dir = fixture()
    const source = script(job, name)
    for (const verdict of ['', 'passed\nextra=value', 'passed\n', 'unknown', null, 0, ['passed'], { verdict: 'passed' }]) {
      writeFileSync(join(dir, 'evidence/result.json'), JSON.stringify({ verdict }))
      const result = run(dir, source)
      expect(result.status, JSON.stringify(verdict)).not.toBe(0)
      expect(result.output, JSON.stringify(verdict)).toBe('')
    }
    for (const document of ['', 'not json', '{"verdict":"passed"}\n{"verdict":"blocked"}']) {
      writeFileSync(join(dir, 'evidence/result.json'), document)
      const result = run(dir, source)
      expect(result.status).not.toBe(0)
      expect(result.output).toBe('')
    }
    rmSync(join(dir, 'evidence/result.json'))
    expect(run(dir, source).status).not.toBe(0)
  })
  test(`${job} writes each supported verdict as one output line`, () => {
    const dir = fixture()
    const source = script(job, name)
    for (const verdict of ['passed', 'failed', 'blocked', 'refused', 'waived']) {
      writeFileSync(join(dir, 'evidence/result.json'), JSON.stringify({ verdict }))
      expect(run(dir, source)).toEqual({ status: 0, output: `verdict=${verdict}\n` })
    }
  })
}

for (const job of ['judge', 'main_judge']) {
  test(`${job} keeps each input download in its own directory away from trusted scripts`, () => {
    const dir = fixture()
    const trusted = join(dir, '.qare-pipeline/owned-script')
    writeFileSync(trusted, 'trusted')
    const downloads = pipeline.jobs[job]!.steps.filter((step) => step.uses?.startsWith('actions/download-artifact@') === true)
    expect(downloads.length).toBeGreaterThan(1)
    const destinations = new Set<string>()
    for (const step of downloads) {
      const destination = step.with?.path
      expect(destination, step.with?.name).toMatch(/^[a-z][a-z-]+$/)
      expect(destination).not.toBe('.qare-pipeline')
      expect(destinations.has(destination!)).toBe(false)
      destinations.add(destination!)
      // Simulate a file with the same relative name as the pinned trusted script.
      const artifactFile = join(dir, destination!, '.qare-pipeline/owned-script')
      mkdirSync(dirname(artifactFile), { recursive: true })
      writeFileSync(artifactFile, 'artifact data')
      expect(readFileSync(trusted, 'utf8')).toBe('trusted')
    }
  })
}

for (const job of ['judge', 'main_judge']) {
  test(`${job} reads the downloaded plan and diff from their isolated directories`, () => {
    const dir = fixture()
    const plan = job === 'judge' ? 'qa-plan/plan.json' : 'qa-inputs/plan.json'
    mkdirSync(join(dir, dirname(plan)), { recursive: true })
    mkdirSync(join(dir, 'qa-inputs'), { recursive: true })
    writeFileSync(join(dir, plan), '{}')
    writeFileSync(join(dir, 'qa-inputs/change.diff'), '')
    writeFileSync(join(dir, 'qa-inputs/change-planner.diff'), '')
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'docker'), `#!/bin/bash
set -euo pipefail
printf '%s\\0' "$@" > "$QARE_ARGS_FILE"
previous=''
for argument in "$@"; do
  if [[ "$previous" == --plan || "$previous" == --diff ]]; then
    [[ -f "$argument" ]] || exit 66
  fi
  previous="$argument"
done
`, { mode: 0o755 })
    const argsFile = join(dir, 'docker-args')
    const result = run(dir, script(job, job === 'judge' ? 'Judge the result' : 'Judge the result on main'), {
      PATH: `${bin}:${process.env.PATH ?? ''}`, RUNNER_TEMP: dir, IMAGE_REF: 'fixture-image',
      MODEL_KEY: 'test-only', MODEL_KEY_ENV: 'MODEL_TEST_KEY', NARE_PROVIDER: '', NARE_MODEL: '',
      NARE_STREAM: '', NARE_BASE_URL: '', QARE_MAX_OUTPUT_TOKENS: '', QARE_VERIFY_BATCH_SIZE: '',
      PROFILE: '.qa', QARE_ARGS_FILE: argsFile, JUDGE_OUTPUT: mkdtempSync(join(tmpdir(), 'qare-judge-output-')),
    })
    expect(result.status).toBe(0)
    const args = readFileSync(argsFile, 'utf8').split('\0')
    expect(args[args.indexOf('--plan') + 1]).toBe(plan)
    if (job === 'judge') expect(args[args.indexOf('--diff') + 1]).toBe('qa-inputs/change-planner.diff')
    expect(readFileSync(join(dir, plan), 'utf8')).toBe('{}')
  })
}
