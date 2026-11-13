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
function temporary(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
function fixture(): string {
  const dir = temporary('qare-workflow-boundary-')
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

// The version step asks GitHub which releases are published and which of them
// the pinned revision contains (#360). A fake gh answers from the environment:
// FAKE_RELEASES lists the published tags, FAKE_CONTAINED the ones the pinned
// revision contains, FAKE_IDENTICAL the one it is, and FAKE_GH_FAIL refuses.
const FAKE_GH = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
[ "\${FAKE_GH_FAIL:-}" = 1 ] && exit 1
case "$2" in
  repos/ViviDynamics/qare/releases*) printf '%s' "\${FAKE_RELEASES:-}" ;;
  repos/ViviDynamics/qare/compare/*)
    spec="\${2#repos/ViviDynamics/qare/compare/}"
    tag="\${spec%%...*}"
    if [ "$tag" = "\${FAKE_IDENTICAL:-}" ]; then echo identical
    elif printf '%s\\n' \${FAKE_CONTAINED:-} | grep -qx -- "$tag"; then echo ahead
    else echo behind; fi ;;
  *) exit 2 ;;
esac
`
function versionFixture(): { dir: string; sha: string; env: Record<string, string> } {
  const dir = fixture()
  const pinned = join(dir, '.qare-pipeline')
  const git = (...args: string[]): string => spawnSync('git', ['-C', pinned, ...args], { encoding: 'utf8' }).stdout.trim()
  git('init', '-q')
  git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'pinned')
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'gh'), FAKE_GH, { mode: 0o755 })
  return { dir, sha: git('rev-parse', 'HEAD'), env: { PATH: `${bin}:${process.env.PATH ?? ''}`, FAKE_GH_LOG: join(dir, 'gh.log'), FAKE_RELEASES: '' } }
}
function summary(dir: string): string {
  try { return readFileSync(join(dir, 'summary'), 'utf8') } catch { return '' }
}

for (const job of ['collect', 'main_collect']) {
  test(`${job} rejects malformed manifest versions before writing outputs`, () => {
    const { dir, env } = versionFixture()
    const source = script(job, 'Read the version of the pinned qare')
    for (const version of ['', '2026.10.47\nextra=value', '2026.10.47\n', 'latest', 47, null, { version: '2026.10.47' }]) {
      writeFileSync(join(dir, '.qare-pipeline/package.json'), JSON.stringify({ version }))
      const result = run(dir, source, { ...env, QARE_REF: 'main' })
      expect(result.status, JSON.stringify(version)).not.toBe(0)
      expect(result.output, JSON.stringify(version)).toBe('')
    }
  })
  test(`${job} rejects unreadable or multiple manifest documents`, () => {
    const { dir, env } = versionFixture()
    const source = script(job, 'Read the version of the pinned qare')
    for (const manifest of ['', 'not json', '{"version":"2026.10.47"}\n{"version":"2026.10.46"}']) {
      writeFileSync(join(dir, '.qare-pipeline/package.json'), manifest)
      expect(run(dir, source, { ...env, QARE_REF: 'main' })).toEqual({ status: 1, output: '' })
    }
    rmSync(join(dir, '.qare-pipeline/package.json'))
    expect(run(dir, source, { ...env, QARE_REF: 'main' })).toEqual({ status: 1, output: '' })
  })
  test(`${job} accepts a release ref, or the pinned manifest version when no published release is contained, as one line`, () => {
    const { dir, env } = versionFixture()
    writeFileSync(join(dir, '.qare-pipeline/package.json'), JSON.stringify({ version: '2026.10.46' }))
    const source = script(job, 'Read the version of the pinned qare')
    expect(run(dir, source, { ...env, QARE_REF: '2026.10.47' })).toEqual({ status: 0, output: 'version=2026.10.47\n' })
    expect(run(dir, source, { ...env, QARE_REF: 'main' })).toEqual({ status: 0, output: 'version=2026.10.46\n' })
  })
  test(`${job} runs a revision with the newest published release it contains, not the version main's manifest was last stamped with`, () => {
    const { dir, sha, env } = versionFixture()
    writeFileSync(join(dir, '.qare-pipeline/package.json'), JSON.stringify({ version: '2026.10.53' }))
    const source = script(job, 'Read the version of the pinned qare')
    const releases = '2026.10.53\n2026.11.10\n2026.11.9\n2026.11.2\n'
    expect(run(dir, source, { ...env, QARE_REF: sha, FAKE_RELEASES: releases, FAKE_CONTAINED: '2026.10.53 2026.11.2 2026.11.9' }))
      .toEqual({ status: 0, output: 'version=2026.11.9\n' })
    // Newest first, by number rather than by text, and each compared with the pinned revision.
    const asked = readFileSync(env.FAKE_GH_LOG!, 'utf8').split('\n').filter((line) => line.includes('/compare/'))
    expect(asked.map((line) => line.split(' ')[1])).toEqual([`repos/ViviDynamics/qare/compare/2026.11.10...${sha}`, `repos/ViviDynamics/qare/compare/2026.11.9...${sha}`])
    expect(summary(dir)).toContain('qare 2026.11.9, older than the latest release 2026.11.10')
  })
  test(`${job} says nothing is stale when the pinned revision is the latest release`, () => {
    const { dir, sha, env } = versionFixture()
    writeFileSync(join(dir, '.qare-pipeline/package.json'), JSON.stringify({ version: '2026.10.53' }))
    const source = script(job, 'Read the version of the pinned qare')
    expect(run(dir, source, { ...env, QARE_REF: sha, FAKE_RELEASES: '2026.11.3\n2026.11.2\n', FAKE_IDENTICAL: '2026.11.3' }))
      .toEqual({ status: 0, output: 'version=2026.11.3\n' })
    expect(summary(dir)).toContain('qare 2026.11.3')
    expect(summary(dir)).not.toContain('older than')
  })
  test(`${job} names a pinned release older than the latest one`, () => {
    const { dir, env } = versionFixture()
    const source = script(job, 'Read the version of the pinned qare')
    expect(run(dir, source, { ...env, QARE_REF: '2026.11.2', FAKE_RELEASES: '2026.11.3\n2026.11.2\n' }))
      .toEqual({ status: 0, output: 'version=2026.11.2\n' })
    expect(summary(dir)).toContain('qare 2026.11.2, older than the latest release 2026.11.3')
  })
  test(`${job} ignores release tags that are not CalVer, so none reaches the output`, () => {
    const { dir, sha, env } = versionFixture()
    writeFileSync(join(dir, '.qare-pipeline/package.json'), JSON.stringify({ version: '2026.10.53' }))
    const source = script(job, 'Read the version of the pinned qare')
    const releases = 'latest\nv2026.12.0\n2026.12.0-rc.1\n2026.11.3\n'
    expect(run(dir, source, { ...env, QARE_REF: sha, FAKE_RELEASES: releases, FAKE_CONTAINED: 'latest v2026.12.0 2026.12.0-rc.1 2026.11.3' }))
      .toEqual({ status: 0, output: 'version=2026.11.3\n' })
    expect(summary(dir)).not.toContain('older than')
  })
  test(`${job} falls back to the manifest version and says so when the releases cannot be read`, () => {
    const { dir, sha, env } = versionFixture()
    writeFileSync(join(dir, '.qare-pipeline/package.json'), JSON.stringify({ version: '2026.10.53' }))
    const source = script(job, 'Read the version of the pinned qare')
    expect(run(dir, source, { ...env, QARE_REF: sha, FAKE_GH_FAIL: '1' })).toEqual({ status: 0, output: 'version=2026.10.53\n' })
    expect(summary(dir)).toContain('could not read the published releases')
    expect(summary(dir)).toContain('qare 2026.10.53')
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
      PROFILE: '.qa', QARE_ARGS_FILE: argsFile, JUDGE_OUTPUT: temporary('qare-judge-output-'),
    })
    expect(result.status).toBe(0)
    const args = readFileSync(argsFile, 'utf8').split('\0')
    expect(args[args.indexOf('--plan') + 1]).toBe(plan)
    if (job === 'judge') expect(args[args.indexOf('--diff') + 1]).toBe('qa-inputs/change-planner.diff')
    expect(readFileSync(join(dir, plan), 'utf8')).toBe('{}')
  })
}
