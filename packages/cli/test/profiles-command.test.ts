import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { main } from '../src/index.js'
import type { Writer } from '../src/index.js'

function capture(): { lines: string[]; writer: Writer } {
  const lines: string[] = []
  return { lines, writer: { write: (chunk) => lines.push(chunk) } }
}

const TARGET_CONFIG = [
  'target:',
  ['  url: http:', '//localhost:3000'].join(''),
  '  health:',
  `    http: ${['http:', '//localhost:3000/up'].join('')}`,
  '    timeout: 30s',
  '  hosts: []',
].join('\n')

async function monorepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'qare-cli-profiles-'))
  await mkdir(join(repo, '.qa', 'storefront'), { recursive: true })
  await writeFile(join(repo, '.qa', 'storefront', 'QA.md'), 'what this app is', 'utf8')
  await writeFile(join(repo, '.qa', 'storefront', 'config.yml'), `${TARGET_CONFIG}\n`, 'utf8')
  await mkdir(join(repo, '.qa', 'admin'), { recursive: true })
  await writeFile(join(repo, '.qa', 'admin', 'QA.md'), 'what this app is', 'utf8')
  await writeFile(join(repo, '.qa', 'admin', 'config.yml'), `${TARGET_CONFIG}\npaths:\n  - apps/admin\n`, 'utf8')
  return repo
}

const DIFF = ['diff --git a/apps/admin/src/a.ts b/apps/admin/src/a.ts', '--- a/apps/admin/src/a.ts', '+++ b/apps/admin/src/a.ts'].join('\n')

test('qare profiles lists every profile when no diff or paths are given', async () => {
  const repo = await monorepo()
  const { lines, writer } = capture()
  const code = await main(['profiles', repo], writer)
  expect(code).toBe(0)
  const report = lines.join('')
  expect(report).toContain('admin')
  expect(report).toContain('storefront')
})

test('qare profiles --diff selects only the profiles the change touches', async () => {
  const repo = await monorepo()
  const diffPath = join(repo, 'change.diff')
  await writeFile(diffPath, `${DIFF}\n`, 'utf8')
  const { lines, writer } = capture()
  const code = await main(['profiles', repo, '--diff', diffPath], writer)
  expect(code).toBe(0)
  const report = lines.join('')
  expect(report).toContain('admin')
  expect(report).not.toContain('storefront')
})

test('qare profiles --paths selects the same way', async () => {
  const repo = await monorepo()
  const { lines, writer } = capture()
  const code = await main(['profiles', repo, '--paths', 'apps/admin,docs'], writer)
  expect(code).toBe(0)
  const report = lines.join('')
  expect(report).toContain('admin')
  expect(report).not.toContain('storefront')
})

test('qare profiles on a repository without .qa/ reports that nothing is there', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'qare-cli-profiles-'))
  const { lines, writer } = capture()
  const code = await main(['profiles', repo], writer)
  expect(code).toBe(0)
  expect(lines.join('')).toMatch(/no .qa\/ profile matches/)
})

test('qare profiles exits 4 for a malformed profile', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'qare-cli-profiles-'))
  await mkdir(join(repo, '.qa', 'broken'), { recursive: true })
  await writeFile(join(repo, '.qa', 'broken', 'QA.md'), 'x', 'utf8')
  await writeFile(join(repo, '.qa', 'broken', 'config.yml'), 'app: { boot: {} }\n', 'utf8')
  const errors = capture()
  const code = await main(['profiles', repo], capture().writer, errors.writer)
  expect(code).toBe(4)
  expect(errors.lines.join('')).not.toBe('')
})

test('qare profiles takes --diff or --paths, not both', async () => {
  const repo = await monorepo()
  const errors = capture()
  const code = await main(['profiles', repo, '--diff', 'x', '--paths', 'a'], capture().writer, errors.writer)
  expect(code).toBe(4)
  expect(errors.lines.join('')).toMatch(/not both/)
})

test('qare profiles exits 4 for an unknown flag', async () => {
  const repo = await monorepo()
  const errors = capture()
  const code = await main(['profiles', repo, '--wat'], capture().writer, errors.writer)
  expect(code).toBe(4)
  expect(errors.lines.join('')).toMatch(/unknown profiles flag/)
})
