import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const workflowPath = join(repoRoot, '.github', 'workflows', 'qare.yml')
const workflow = readFileSync(workflowPath, 'utf8')
const lines = workflow.split('\n')

function section(job: string): string {
  const start = lines.indexOf(`  ${job}:`)
  expect(start, `job ${job} is not declared in ${workflowPath}`).toBeGreaterThanOrEqual(0)
  const end = lines.findIndex((line, index) => index > start && /^  \w+:$/.test(line))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

test('the qare workflow exists alongside its fallback job fixture', () => {
  expect(existsSync(workflowPath)).toBe(true)
  expect(workflow).toContain('.github/qare/fallback-job.yml')
})

test('the workflow declares the three jobs plan, execute and judge', () => {
  expect(lines).toContain('  plan:')
  expect(lines).toContain('  execute:')
  expect(lines).toContain('  judge:')
})

test('the artifact handoff names are pinned', () => {
  expect(workflow).toContain('name: plan.json')
  expect(workflow).toContain('name: execute-evidence')
  expect(workflow).toContain('name: judge-artifacts')
})

test('the plan failure names the pending nare integration', () => {
  expect(workflow).toContain(
    'plan job unavailable: nare integration pending (nare issues #9-#11); plan.json cannot be produced yet',
  )
})

test('the qare CLI invocation is pinned to the repo own build', () => {
  expect(workflow.match(/node packages\/cli\/dist\/index\.js/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
  expect(workflow).toContain('pnpm build')
})

test('secret hygiene: only named secrets, and the execute job holds none', () => {
  expect(workflow).toContain('${{ secrets.QARE_MODEL_KEY }}')
  expect(workflow).toContain('${{ secrets.GITHUB_TOKEN }}')
  const execute = section('execute')
  expect(execute).not.toContain('secrets.')
  expect(section('plan')).toContain('${{ secrets.QARE_MODEL_KEY }}')
  const judge = section('judge')
  expect(judge).toContain('${{ secrets.QARE_MODEL_KEY }}')
  expect(judge).toContain('${{ secrets.GITHUB_TOKEN }}')
})

test('plan continues on error and the downstream jobs always run', () => {
  const plan = section('plan')
  expect(plan).toContain('continue-on-error: true')
  expect(section('execute')).toMatch(/needs: plan\n/)
  expect(section('judge')).toContain('needs: [plan, execute]')
  expect(workflow.match(/if: always\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
})
