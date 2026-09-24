import { cpSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { RESULT_SCHEMA_VERSION } from '@qare/core'
import { main } from '../src/index.js'
import type { Writer } from '../src/index.js'

// Assembled at runtime so no literal token sits in the repository.
const TOKEN = ['ghp', '_', 'Rr5'.repeat(12)].join('')
const profileFixture = fileURLToPath(new URL('../../core/fixtures/qa-valid/.qa', import.meta.url))

function capture(): { lines: string[]; writer: Writer } {
  const lines: string[] = []
  return { lines, writer: { write: (chunk) => lines.push(chunk) } }
}

const made: string[] = []
afterEach(async () => {
  await Promise.all(made.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function workspace(): Promise<{ root: string; evidence: string; stdout: string }> {
  const root = await mkdtemp(join(tmpdir(), 'qare-redact-cli-'))
  made.push(root)
  const evidence = join(root, 'evidence')
  await mkdir(join(evidence, 'checks', 'c1', '0'), { recursive: true })
  const stdout = join(evidence, 'checks', 'c1', '0', 'stdout.txt')
  await writeFile(stdout, `pushed with ${TOKEN} for jane@pilot.example\n`)
  return { root, evidence, stdout }
}

test('redact rewrites the evidence in place with the built-in rules and the profile rules', async () => {
  const { root, evidence, stdout } = await workspace()
  const profile = join(root, '.qa')
  cpSync(profileFixture, profile, { recursive: true })
  const config = await readFile(join(profile, 'config.yml'), 'utf8')
  await writeFile(join(profile, 'config.yml'), `${config}\nredact:\n  values: [jane@pilot.example]\n`)
  const out = capture()

  const code = await main(['redact', '--evidence', evidence, '--profile', profile], out.writer, capture().writer)

  expect(code).toBe(0)
  expect(await readFile(stdout, 'utf8')).toBe('pushed with [redacted] for [redacted]\n')
  expect(out.lines.join('')).toContain(`redacted ${join('checks', 'c1', '0', 'stdout.txt')}`)
  expect(out.lines.join('')).toContain('1 of 1 files redacted')
})

test('a repository with no profile gets the built-in rules, and says so', async () => {
  const { root, evidence, stdout } = await workspace()
  const out = capture()

  const code = await main(['redact', '--evidence', evidence, '--profile', join(root, '.qa')], out.writer, capture().writer)

  expect(code).toBe(0)
  expect(await readFile(stdout, 'utf8')).toBe('pushed with [redacted] for jane@pilot.example\n')
  expect(out.lines.join('')).toContain('only the built-in redaction rules apply')
})

test('a broken profile fails rather than redacting with fewer rules', async () => {
  const { root, evidence, stdout } = await workspace()
  const profile = join(root, '.qa')
  cpSync(profileFixture, profile, { recursive: true })
  await writeFile(join(profile, 'config.yml'), 'app: [')
  const err = capture()

  expect(await main(['redact', '--evidence', evidence, '--profile', profile], capture().writer, err.writer)).toBe(4)
  expect(err.lines.join('')).toContain('config.yml')
  expect(await readFile(stdout, 'utf8')).toContain(TOKEN)
})

test('a file redaction cannot vouch for fails the command, naming it', async () => {
  const { evidence } = await workspace()
  await writeFile(join(evidence, 'trace.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))
  const err = capture()

  expect(await main(['redact', '--evidence', evidence], capture().writer, err.writer)).toBe(4)
  expect(err.lines.join('')).toContain('trace.zip')
})

test('redact requires --evidence and rejects flags it does not take', async () => {
  const err = capture()
  expect(await main(['redact'], capture().writer, err.writer)).toBe(4)
  expect(err.lines.join('')).toContain('requires --evidence')
  expect(await main(['redact', '--evidence', '.', '--force'], capture().writer, err.writer)).toBe(4)
  expect(err.lines.join('')).toContain('does not take --force')
})

test('judge redacts what it writes, since every file it writes is published', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qare-judge-redact-'))
  made.push(root)
  const result = join(root, 'result.json')
  await writeFile(
    result,
    JSON.stringify({
      schemaVersion: RESULT_SCHEMA_VERSION,
      verdict: 'blocked',
      criteria: [{ id: 'c1', outcome: 'unverified', reason: `boot said ${TOKEN}` }],
    }),
  )

  expect(await main(['judge', '--result', result, '--runner', 'none'], capture().writer, capture().writer)).toBe(0)

  for (const name of ['judged-result.json', 'comment.md']) {
    const written = await readFile(join(root, name), 'utf8')
    expect(written, name).not.toContain(TOKEN)
    expect(written, name).toContain('boot said [redacted]')
  }
})

test('judge applies the profile rules to what it writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qare-judge-profile-'))
  made.push(root)
  const profile = join(root, '.qa')
  cpSync(profileFixture, profile, { recursive: true })
  const config = await readFile(join(profile, 'config.yml'), 'utf8')
  await writeFile(join(profile, 'config.yml'), `${config}\nredact:\n  values: [jane@pilot.example]\n`)
  const result = join(root, 'result.json')
  await writeFile(
    result,
    JSON.stringify({
      schemaVersion: RESULT_SCHEMA_VERSION,
      verdict: 'blocked',
      criteria: [{ id: 'c1', outcome: 'unverified', reason: 'mailed jane@pilot.example' }],
    }),
  )

  const code = await main(
    ['judge', '--result', result, '--runner', 'none', '--profile', profile],
    capture().writer,
    capture().writer,
  )

  expect(code).toBe(0)
  for (const name of ['judged-result.json', 'comment.md'])
    expect(await readFile(join(root, name), 'utf8'), name).not.toContain('jane@pilot.example')
})
