import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { main } from '../src/index.js'
import type { Writer } from '../src/index.js'

const URL_LINE = `calls ${['http:', '//api.example.com/v1'].join('')} and ${['http:', '//api.example.com'].join('')}`

function capture(): { lines: string[]; writer: Writer } {
  const lines: string[] = []
  return { lines, writer: { write: (chunk) => lines.push(chunk) } }
}

async function repoWithCompose(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-cli-readiness-'))
  await writeFile(
    join(dir, 'docker-compose.yml'),
    'services:\n  admin:\n    image: admin:latest\n    healthcheck: {}\n',
    'utf8',
  )
  await writeFile(join(dir, 'config.ts'), `${URL_LINE}\n`, 'utf8')
  return dir
}

test('qare readiness prints a report and exits 0 with no verdict', async () => {
  const repo = await repoWithCompose()
  const { lines, writer } = capture()
  const code = await main(['readiness', repo], writer)
  expect(code).toBe(0)
  const report = lines.join('')
  expect(report).toContain('# QARE readiness report')
  expect(report).toContain('## Boot')
  expect(report).toContain('admin: admin:latest, healthcheck: yes')
  expect(report).toContain(['http:', '//api.example.com'].join(''))
  expect(report.toLowerCase()).not.toContain('verdict')
})

test('qare readiness --out writes the same report to a file', async () => {
  const repo = await repoWithCompose()
  const outPath = join(repo, 'docs', 'readiness.md')
  const { lines, writer } = capture()
  const code = await main(['readiness', repo, '--out', outPath], writer)
  expect(code).toBe(0)
  expect(lines.join('')).toContain(`report ${outPath}`)
  expect(existsSync(outPath)).toBe(true)
  const fileReport = await readFile(outPath, 'utf8')
  expect(fileReport).toContain('# QARE readiness report')
  expect(fileReport.toLowerCase()).not.toContain('verdict')
})

test('qare readiness defaults to the working directory', async () => {
  const repo = await repoWithCompose()
  const previousCwd = process.cwd()
  try {
    process.chdir(repo)
    // What the command reports is process.cwd(), which is the REAL path: on
    // macOS the temp directory is /var/..., a symlink to /private/var/..., and
    // chdir resolves it. Comparing against the unresolved path passed on Linux
    // and failed on every Mac.
    const reported = process.cwd()
    const { lines, writer } = capture()
    const code = await main(['readiness'], writer)
    expect(code).toBe(0)
    expect(lines.join('')).toContain(`Repo: ${reported}`)
  } finally {
    process.chdir(previousCwd)
  }
})

test('qare readiness exits 4 for a missing path', async () => {
  const errors = capture()
  const code = await main(['readiness', '/definitely/not/here'], capture().writer, errors.writer)
  expect(code).toBe(4)
  expect(errors.lines.join('')).toMatch(/does not exist/)
})

test('qare readiness exits 4 for an unknown flag', async () => {
  const repo = await repoWithCompose()
  const errors = capture()
  const code = await main(['readiness', repo, '--wat'], capture().writer, errors.writer)
  expect(code).toBe(4)
  expect(errors.lines.join('')).toMatch(/unknown readiness flag/)
})

test('qare readiness rejects more than one path', async () => {
  const repo = await repoWithCompose()
  const errors = capture()
  const code = await main(['readiness', repo, '/also/here'], capture().writer, errors.writer)
  expect(code).toBe(4)
  expect(errors.lines.join('')).toMatch(/at most one path/)
})

test('qare readiness unparseable compose exits 4 with a named error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-cli-readiness-'))
  await writeFile(join(dir, 'compose.yml'), 'services: [broken', 'utf8')
  const errors = capture()
  const code = await main(['readiness', dir], capture().writer, errors.writer)
  expect(code).toBe(4)
  expect(errors.lines.join('')).toMatch(/not valid YAML/)
})
