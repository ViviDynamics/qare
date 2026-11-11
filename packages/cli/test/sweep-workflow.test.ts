import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { parse } from 'yaml'
import { MAIN_PASSES_PATH } from '@qare/core'

// #361: the scheduled sweep reads the record of passes on main beside the
// ledger. The step that places it there is run here as the job runs it,
// against a repository whose origin has, or has not, a qa-assets branch.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const STEP = 'Place the record of passes on main beside the ledger'

interface Step {
  name?: string
  run?: string
}

function stepScript(): string {
  const workflow = parse(readFileSync(join(repoRoot, '.github/workflows/sweep.yml'), 'utf8')) as { jobs: { sweep: { steps: Step[] } } }
  const steps = workflow.jobs.sweep.steps
  const index = steps.findIndex((step) => step.name === STEP)
  expect(index).toBeGreaterThan(-1)
  // Before the sweep classifies: what it places is what the classification reads.
  expect(index).toBeLessThan(steps.findIndex((step) => step.name === 'Classify the ledger'))
  const script = steps[index]?.run
  if (script === undefined) throw new Error(`${STEP} has no script`)
  return script
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'qare', GIT_AUTHOR_EMAIL: 'qare@example.invalid', GIT_COMMITTER_NAME: 'qare', GIT_COMMITTER_EMAIL: 'qare@example.invalid' } })
}

async function repository(assets?: Record<string, string>): Promise<{ root: string; work: string }> {
  const root = await mkdtemp(join(tmpdir(), 'qare-sweep-step-'))
  const origin = join(root, 'origin')
  const seed = join(root, 'seed')
  git(root, 'init', '-q', '--bare', origin)
  git(root, 'init', '-q', '-b', 'main', seed)
  await mkdir(join(seed, '.qa'), { recursive: true })
  await writeFile(join(seed, '.qa', 'ledger.json'), '{}\n')
  git(seed, 'add', '.')
  git(seed, 'commit', '-q', '-m', 'main')
  git(seed, 'push', '-q', origin, 'main')
  if (assets !== undefined) {
    git(seed, 'checkout', '-q', '--orphan', 'qa-assets')
    git(seed, 'rm', '-q', '-r', '--cached', '.')
    for (const [path, content] of Object.entries(assets)) {
      await mkdir(dirname(join(seed, path)), { recursive: true })
      await writeFile(join(seed, path), content)
      git(seed, 'add', path)
    }
    git(seed, 'commit', '-q', '-m', 'qa-assets')
    git(seed, 'push', '-q', origin, 'qa-assets')
  }
  const work = join(root, 'work')
  git(root, 'clone', '-q', '--branch', 'main', origin, work)
  return { root, work }
}

function runStep(cwd: string): string {
  return execFileSync('bash', ['-e', '-c', stepScript()], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

test('the scheduled sweep places the record of passes from qa-assets beside the ledger before it classifies', async () => {
  const record = '{"schemaVersion":"1","passes":{}}\n'
  const { root, work } = await repository({ [MAIN_PASSES_PATH]: record, 'metrics/2026-11-10/x.json': '{}' })
  try {
    runStep(work)
    expect(await readFile(join(work, '.qa', MAIN_PASSES_PATH), 'utf8')).toBe(record)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('with no qa-assets branch, or no record on it, the step places nothing and says why', async () => {
  for (const assets of [undefined, { 'metrics/2026-11-10/x.json': '{}' }]) {
    const { root, work } = await repository(assets)
    try {
      const said = runStep(work)
      expect(said).toMatch(assets === undefined ? /no qa-assets branch/ : /no record of passes/)
      await expect(readFile(join(work, '.qa', MAIN_PASSES_PATH), 'utf8')).rejects.toThrow(/ENOENT/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})
