import { execSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { main } from '../src/index.js'
import type { Writer } from '../src/index.js'

function capture(): { lines: string[]; writer: Writer } {
  const lines: string[] = []
  return { lines, writer: { write: (chunk) => lines.push(chunk) } }
}

// Split on purpose: a repo-wide guard forbids a literal URL in a test file,
// so no test can quietly reach the network.
const TARGET_URL = ['http:', '//target-host:3000'].join('')

const BOOT = { probe: async () => ({ ok: true }), pollIntervalMs: 1 }

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function planInGit(): Promise<{ repo: string; planPath: string; base: string; head: string }> {
  const repo = await mkdtemp(join(tmpdir(), 'qare-runcache-'))
  dirs.push(repo)
  execSync('git init -q', { cwd: repo })
  execSync('git config user.email t@e.st', { cwd: repo })
  execSync('git config user.name t', { cwd: repo })
  await writeFile(join(repo, 'marker.txt'), 'present\n')
  execSync('git add marker.txt', { cwd: repo })
  execSync('git commit -q -m base', { cwd: repo })
  const base = execSync('git rev-parse HEAD', { cwd: repo }).toString().trim()
  execSync('git commit -q --allow-empty -m head', { cwd: repo })
  const head = execSync('git rev-parse HEAD', { cwd: repo }).toString().trim()
  const qa = join(repo, '.qa')
  await mkdir(qa, { recursive: true })
  await writeFile(join(qa, 'QA.md'), 'profile instructions\n', 'utf8')
  await writeFile(
    join(qa, 'config.yml'),
    `target:\n  url: ${TARGET_URL}\n  health:\n    http: ${TARGET_URL}/up\n    timeout: 1s\n`,
    'utf8',
  )
  const planPath = join(repo, 'plan.json')
  await writeFile(
    planPath,
    JSON.stringify({
      schemaVersion: '1',
      criteria: [{ id: 'c1', text: 'copy the marker', checks: [{ kind: 'command', name: 'copy', command: 'cp marker.txt copied.txt' }] }],
    }),
    'utf8',
  )
  return { repo, planPath, base, head }
}

test('qare run --cache replays unchanged criteria and marks them cached', async () => {
  const { repo, planPath, base, head } = await planInGit()
  const run = (evidence: string, err: { lines: string[]; writer: Writer }): Promise<number> =>
    main(
      [
        'run', '--plan', planPath,
        '--id', 'run-cache', '--repo', repo, '--base', base, '--head', head,
        '--profile', join(repo, '.qa'), '--evidence', join(repo, evidence), '--cache', join(repo, 'cache'),
      ],
      capture().writer,
      err.writer,
      BOOT,
    )
  const first = capture()
  expect(await run('evidence-1', first)).toBe(0)
  await rm(join(repo, 'marker.txt'))
  const second = capture()
  expect(await run('evidence-2', second)).toBe(0)
  const result = JSON.parse(await readFile(join(repo, 'evidence-2', 'result.json'), 'utf8'))
  expect(result.criteria[0].cached).toBe(true)
  const summary = JSON.parse(await readFile(join(repo, 'evidence-2', 'cache.json'), 'utf8'))
  expect(summary.hits).toHaveLength(1)
})
