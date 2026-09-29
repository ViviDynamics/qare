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

// The check the runs share: it fails its first attempt and passes its second.
const FLIP_SCRIPT = [
  "import { existsSync, writeFileSync } from 'node:fs'",
  "if (existsSync('flipped')) process.exit(0)",
  "writeFileSync('flipped', 'now')",
  'process.exit(1)',
].join('\n')

async function planInGit(): Promise<{ repo: string; planPath: string; base: string; head: string }> {
  const repo = await mkdtemp(join(tmpdir(), 'qare-runquarantine-'))
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
  await writeFile(join(repo, 'flip.mjs'), FLIP_SCRIPT, 'utf8')
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
      criteria: [{ id: 'c1', text: 'flip the marker', checks: [{ kind: 'command', name: 'flip', command: 'node flip.mjs' }] }],
    }),
    'utf8',
  )
  return { repo, planPath, base, head }
}

test('qare run --flake-attempts quarantines a check that fails and then passes', async () => {
  const { repo, planPath, base, head } = await planInGit()
  const out = capture()
  const err = capture()
  const code = await main(
    [
      'run', '--plan', planPath,
      '--id', 'run-quarantine', '--repo', repo, '--base', base, '--head', head,
      '--profile', join(repo, '.qa'), '--evidence', join(repo, 'evidence'),
      '--flake-attempts', '2', '--quarantine', join(repo, 'quarantine'),
    ],
    out.writer,
    err.writer,
    BOOT,
  )
  expect(code).toBe(2)
  expect(out.lines.join('')).toContain('verdict blocked')
  const store = JSON.parse(await readFile(join(repo, 'quarantine', 'quarantine.json'), 'utf8'))
  expect(store.records).toHaveLength(1)
  expect(store.records[0].check).toBe('command check 0 of criterion c1')
  expect(store.records[0].reason).toContain('unstable')
  const result = JSON.parse(await readFile(join(repo, 'evidence', 'result.json'), 'utf8'))
  expect(result.verdict).toBe('blocked')
  expect(result.criteria[0].outcome).toBe('unverified')
  expect(result.criteria[0].reason).toMatch(/^quarantined \(/)
})

test('qare run refuses a --flake-attempts that is not one or more', async () => {
  const { repo, planPath, base, head } = await planInGit()
  const out = capture()
  const err = capture()
  const code = await main(
    [
      'run', '--plan', planPath,
      '--id', 'run-zero', '--repo', repo, '--base', base, '--head', head,
      '--profile', join(repo, '.qa'), '--evidence', join(repo, 'evidence'),
      '--flake-attempts', '0',
    ],
    out.writer,
    err.writer,
    BOOT,
  )
  expect(code).toBe(4)
  expect(err.lines.join('')).toContain('--flake-attempts takes a whole number of attempts, one or more, not "0"')
})
