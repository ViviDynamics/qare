import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parse } from 'yaml'
import { afterEach, expect, test } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
interface Step { name?: string; id?: string; if?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown>; uses?: string }
interface Job { needs?: string[]; if?: string; permissions?: Record<string, string>; outputs?: Record<string, string>; steps: Step[] }
const jobs = (parse(readFileSync(join(root, '.github/workflows/pipeline.yml'), 'utf8')) as { jobs: Record<string, Job> }).jobs

const dirs: string[] = []
function fixture(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(directory)
  return directory
}
afterEach(() => { for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true }) })

for (const [judgeId, publishId] of [['judge', 'publish'], ['main_judge', 'main_publish']] as const) {
  test(`${judgeId} holds the model key without an App key or write permission`, () => {
    const judge = jobs[judgeId] as Job
    expect(JSON.stringify(judge)).toContain('secrets.model-key')
    expect(JSON.stringify(judge)).not.toMatch(/app-private-key|secrets.personal-access-token|QARE_APP_TOKEN/)
    expect(Object.values(judge.permissions ?? {})).not.toContain('write')
    expect(judge.outputs?.ready).toBe('${{ steps.recorded.outputs.ready }}')
    expect(judge.outputs?.verdict).toBe('${{ steps.recorded.outputs.verdict }}')
    expect(judge.outputs?.['image-digest']).toBe('${{ steps.image.outputs.digest }}')
  })

  test(`${publishId} starts after judging, mints fresh before any downloaded data and uses the judged image`, () => {
    const publish = jobs[publishId]
    expect(publish, 'a separate publishing runner is required').toBeDefined()
    expect(publish?.needs).toContain(judgeId)
    expect(publish?.if).toBe(`always() && needs.${judgeId}.outputs.ready == 'true'`)
    expect(JSON.stringify(publish)).not.toMatch(/model-key|MODEL_KEY/)
    const steps = publish?.steps ?? []
    const mint = steps.findIndex((step) => step.id === 'app')
    expect(mint).toBeGreaterThan(-1)
    expect(steps.slice(0, mint).every((step) => !step.run && /^actions\/(checkout|setup-node)@/.test(step.uses ?? ''))).toBe(true)
    const pull = steps.find((step) => step.id === 'image')
    expect(pull?.env?.IMAGE_REF).toBe(`\${{ needs.${judgeId}.outputs.image-digest }}`)
    expect(pull?.run).toContain('docker pull "$IMAGE_REF"')
    expect(pull?.run).not.toContain('imagetools inspect')
    for (const step of steps.filter((step) => step.uses?.startsWith('actions/download-artifact@'))) expect(step.with?.path).toBeTruthy()
  })

  for (const verdict of ['passed', 'failed', 'blocked', 'refused', 'waived']) {
    test(`${judgeId} exposes recorded ${verdict} even when judging exits nonzero`, () => {
      const step = jobs[judgeId]?.steps.find((entry) => entry.name === 'Read the judged verdict')
      expect(step?.if).toBe('always()')
      const cwd = fixture('qare-judged-ready-')
      writeFileSync(join(cwd, 'judged-result.json'), JSON.stringify({ verdict }))
      writeFileSync(join(cwd, 'output'), '')
      const result = spawnSync('bash', ['-eo', 'pipefail', '-c', step?.run ?? 'exit 99'], { cwd, env: { PATH: process.env.PATH, GITHUB_OUTPUT: join(cwd, 'output'), JUDGE_OUTPUT: cwd }, encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(join(cwd, 'output'), 'utf8')).toBe(`verdict=${verdict}\nready=true\n`)
      const upload = jobs[judgeId]?.steps.find((entry) => entry.with?.name === (judgeId === 'judge' ? 'judge-artifacts' : 'main-judge-artifacts'))
      expect(upload?.if).toBe("always() && steps.workspace.outputs.path != ''")
    })
  }

  test(`${judgeId} refuses a stale tracked result when judging failed before producing output`, () => {
    const cwd = fixture('qare-stale-judged-')
    const fresh = fixture('qare-fresh-judged-')
    writeFileSync(join(cwd, 'judged-result.json'), JSON.stringify({ verdict: 'passed' }))
    writeFileSync(join(cwd, 'output'), '')
    const step = jobs[judgeId]?.steps.find((entry) => entry.name === 'Read the judged verdict')
    const result = spawnSync('bash', ['-eo', 'pipefail', '-c', step?.run ?? 'exit 99'], { cwd, env: { PATH: process.env.PATH, JUDGE_OUTPUT: fresh, GITHUB_OUTPUT: join(cwd, 'output') }, encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(readFileSync(join(cwd, 'output'), 'utf8')).toBe('')
    const setup = jobs[judgeId]?.steps.find((entry) => entry.name === 'Create a fresh judge output directory')
    expect(setup?.run).toContain('mktemp -d "$RUNNER_TEMP/qare-judge.XXXXXX"')
    const judge = jobs[judgeId]?.steps.find((entry) => entry.name?.startsWith('Judge the result'))
    expect(judge?.run).toContain('--outDir "$JUDGE_OUTPUT"')
  })

  for (const data of ['', '{}', '{"verdict":"passed\\nready=true"}', '{"verdict":"passed"}\n{"verdict":"failed"}']) {
    test(`${judgeId} never authorizes publishing with unread or malformed result ${JSON.stringify(data)}`, () => {
      const step = jobs[judgeId]?.steps.find((entry) => entry.name === 'Read the judged verdict')
      const cwd = fixture('qare-judged-invalid-')
      writeFileSync(join(cwd, 'judged-result.json'), data)
      writeFileSync(join(cwd, 'output'), '')
      const result = spawnSync('bash', ['-eo', 'pipefail', '-c', step?.run ?? 'exit 99'], { cwd, env: { PATH: process.env.PATH, GITHUB_OUTPUT: join(cwd, 'output'), JUDGE_OUTPUT: cwd }, encoding: 'utf8' })
      expect(result.status).not.toBe(0)
      expect(readFileSync(join(cwd, 'output'), 'utf8')).toBe('')
      expect(result.stdout + result.stderr).toContain('no readable supported verdict')
    })
  }
}

test('advisory context is GET only in collect and new replies run in publishing before sticky replacement', () => {
  expect(jobs.collect?.steps.some((step) => step.run?.includes('advisory-context'))).toBe(true)
  expect(JSON.stringify(jobs.judge)).not.toContain('advisory-replies')
  const steps = jobs.publish?.steps ?? []
  const reply = steps.findIndex((step) => step.run?.includes('advisory-replies'))
  const post = steps.findIndex((step) => step.run?.includes('post-evidence'))
  expect(reply).toBeGreaterThan(-1)
  expect(post).toBeGreaterThan(reply)
  expect(steps[post]?.run).toContain('--dismissed advisory-dismissed.json')
})

test('report waits for publishing and prefers the judged verdict over executed input', () => {
  expect(jobs.report?.needs).toContain('publish')
  expect(jobs.report?.if).toContain("needs.publish.outputs.posted != 'true'")
  const report = jobs.report?.steps.find((step) => step.name === 'Report the failure on the pull request')
  expect(report?.env?.RECORDED_VERDICT).toBe('${{ needs.judge.outputs.verdict || needs.execute.outputs.verdict }}')
})
