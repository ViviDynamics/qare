import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { parse } from 'yaml'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
interface Step { id?: string; name?: string; run?: string; env?: Record<string, string> }
const pipeline = parse(readFileSync(join(root, '.github/workflows/pipeline.yml'), 'utf8')) as { jobs: Record<string, { steps: Step[] }> }
const jobs = ['plan', 'execute', 'judge', 'main_execute', 'main_judge']
const hash = `sha256:${'a'.repeat(64)}`
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function pull(job: string, extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qare-workflow-image-'))
  dirs.push(dir)
  const output = join(dir, 'output')
  const calls = join(dir, 'calls')
  writeFileSync(output, '')
  writeFileSync(calls, '')
  writeFileSync(join(dir, 'docker'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$CALLS"
if [ "$1 $2" = 'buildx version' ]; then exit "\${FAKE_TOOL_STATUS:-0}"; fi
if [ "$1 $2 $3" = 'buildx imagetools inspect' ]; then
  printf '%s' "$FAKE_DIGEST"
  exit "\${FAKE_RESOLVE_STATUS:-0}"
fi
if [ "$1" = 'pull' ]; then exit "\${FAKE_PULL_STATUS:-0}"; fi
if [ "$1" = 'inspect' ]; then printf '%s\\n' "ghcr.io/vividynamics/qare-core@$FAKE_DIGEST"; exit 0; fi
exit 2
`, { mode: 0o755 })
  const step = pipeline.jobs[job]?.steps.find((step) => step.id === 'image')
  expect(step?.run).toBeTypeOf('string')
  const result = spawnSync('bash', ['-c', step!.run!], { cwd: dir, encoding: 'utf8', env: {
    ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: join(dir, 'summary'), QARE_VERSION: '2026.10.48', FLAVOUR: 'web',
    CALLS: calls, FAKE_DIGEST: hash, ...extra,
  } })
  return { status: result.status, output: readFileSync(output, 'utf8'), calls: readFileSync(calls, 'utf8'), message: result.stdout + result.stderr }
}

for (const job of jobs) {
  const family = job.includes('execute') ? 'web' : 'core'
  const tag = `ghcr.io/vividynamics/qare-${family}:2026.10.48`
  const immutable = `ghcr.io/vividynamics/qare-${family}@${hash}`
  test(`${job} resolves before pulling the immutable image and records the release tag`, () => {
    const result = pull(job)
    expect(result.status).toBe(0)
    expect(result.calls).toContain(`buildx imagetools inspect ${tag}`)
    expect(result.calls).toContain(`pull ${immutable}\n`)
    expect(result.calls).not.toContain(`pull ${tag}\n`)
    expect(result.calls.indexOf('buildx imagetools inspect')).toBeLessThan(result.calls.indexOf('pull '))
    expect(result.output).toBe(`ref=${tag}\ndigest=${immutable}\n`)
  })
  test(`${job} rejects missing or malformed registry digests before pulling or writing outputs`, () => {
    for (const digest of ['', 'null', 'latest', 'sha256:abc', `sha256:${'z'.repeat(64)}`, `${hash}\nref=other`, `prefix${hash}`]) {
      const result = pull(job, { FAKE_DIGEST: digest })
      expect(result.status, JSON.stringify(digest)).not.toBe(0)
      expect(result.calls).not.toContain('pull ')
      expect(result.output).toBe('')
      expect(result.message).toContain('::error::')
    }
  })
  test(`${job} stops with a named error when the inspection tool or registry cannot be read`, () => {
    for (const extra of [{ FAKE_TOOL_STATUS: '1' }, { FAKE_RESOLVE_STATUS: '1' }]) {
      const result = pull(job, extra)
      expect(result.status).not.toBe(0)
      expect(result.calls).not.toContain('pull ')
      expect(result.output).toBe('')
      expect(result.message).toContain('::error::')
    }
  })
  test(`${job} writes no usable image output when an immutable pull fails`, () => {
    const result = pull(job, { FAKE_PULL_STATUS: '1' })
    expect(result.status).not.toBe(0)
    expect(result.output).toBe('')
  })
}

test('all later pipeline containers receive the immutable digest reference', () => {
  let containers = 0
  for (const job of jobs) for (const step of pipeline.jobs[job]!.steps) {
    if (!step.run?.includes('docker run')) continue
    containers += 1
    expect(step.env?.IMAGE_REF, `${job}: ${step.name}`).toBe('${{ steps.image.outputs.digest }}')
  }
  expect(containers).toBeGreaterThan(10)
})

test('execution records the release tag separately from the immutable container reference', () => {
  for (const job of ['execute', 'main_execute']) {
    const step = pipeline.jobs[job]!.steps.find((step) => step.name?.startsWith('Run the plan'))!
    expect(step.env?.IMAGE_TAG_REF).toBe('${{ steps.image.outputs.ref }}')
    expect(step.run).toContain('QARE_IMAGE_REF="$IMAGE_REF"')
    expect(step.run).toContain('QARE_IMAGE_TAG="$IMAGE_TAG_REF"')
    expect(step.run).toContain('QARE_IMAGE_DIGEST="$IMAGE_DIGEST"')
  }
})
