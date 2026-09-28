import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { RESULT_SCHEMA_VERSION } from '@qare/core'
import { main } from '../src/index.js'
import type { Writer } from '../src/index.js'

function capture(): { lines: string[]; writer: Writer } {
  const lines: string[] = []
  return { lines, writer: { write: (chunk) => lines.push(chunk) } }
}

const made: string[] = []
afterEach(async () => {
  await Promise.all(made.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const ADMIN_RULE = [
  'target:',
  ['  url: http:', '//localhost:3000'].join(''),
  '  health:',
  '    http: /up',
  '    timeout: 30s',
  '  hosts: []',
  'redact:',
  '  values:',
  '    - s3cret-value',
].join('\n')
const PLAIN_RULE = [
  'target:',
  ['  url: http:', '//localhost:3000'].join(''),
  '  health:',
  '    http: /up',
  '    timeout: 30s',
  '  hosts: []',
].join('\n')

/**
 * A several-app result whose reason carries a secret only the admin app's
 * profile declares, exactly the way execute leaves it before judge reads it.
 */
async function severalResult(dir: string, withProfiles: boolean): Promise<string> {
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'result.json')
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: RESULT_SCHEMA_VERSION,
      verdict: 'blocked',
      criteria: [
        { id: 'c1', outcome: 'unverified', reason: 'the storefront total was s3cret-value aware' },
      ],
      ...(withProfiles ? { profiles: [{ name: 'admin', verdict: 'refused', criteria: ['c1'] }] } : {}),
    }),
    'utf8',
  )
  return path
}

async function profileAt(dir: string, config: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'config.yml'), config, 'utf8')
  await writeFile(join(dir, 'QA.md'), '# QA\n', 'utf8')
  return dir
}

async function severalFixture(): Promise<{ root: string; resultPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-judge-several-'))
  made.push(dir)
  const root = join(dir, 'qa')
  await profileAt(join(root, 'admin'), ADMIN_RULE)
  await profileAt(join(root, 'storefront'), PLAIN_RULE)
  const resultPath = await severalResult(join(dir, 'evidence'), true)
  return { root, resultPath }
}

test('judge redacts a several-app result with the rules of every app it names', async () => {
  const { root, resultPath } = await severalFixture()

  const code = await main(['judge', '--result', resultPath, '--runner', 'none', '--profile', root], capture().writer, capture().writer)

  expect(code).toBe(0)
  const judged = JSON.parse(await readFile(join(resultPath, '..', 'judged-result.json'), 'utf8'))
  expect(judged.criteria[0].reason).not.toContain('s3cret-value')
  expect(judged.criteria[0].reason).toContain('[redacted]')
})

test('judge of a several-app result without a profile is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-judge-several-'))
  made.push(dir)
  const resultPath = await severalResult(join(dir, 'evidence'), true)
  const err = capture()

  const code = await main(['judge', '--result', resultPath, '--runner', 'none'], capture().writer, err.writer)

  expect(code).toBe(4)
  expect(err.lines.join('')).toContain('the result names the apps it ran')
})

test('judge of a several-app result with an app missing from the profile is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-judge-several-'))
  made.push(dir)
  const root = join(dir, 'qa')
  await profileAt(join(root, 'storefront'), PLAIN_RULE)
  const resultPath = await severalResult(join(dir, 'evidence'), true)
  const err = capture()

  const code = await main(['judge', '--result', resultPath, '--runner', 'none', '--profile', root], capture().writer, err.writer)

  expect(code).toBe(4)
  expect(err.lines.join('')).toContain('no usable profile for app "admin"')
})

test('judge of a single-app result needs no profile', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-judge-several-'))
  made.push(dir)
  const resultPath = await severalResult(join(dir, 'evidence'), false)

  const code = await main(['judge', '--result', resultPath, '--runner', 'none'], capture().writer, capture().writer)

  expect(code).toBe(0)
  const judged = JSON.parse(await readFile(join(resultPath, '..', 'judged-result.json'), 'utf8'))
  // No profile named the secret, so the built-in rules alone apply and the
  // reason is judged as it stands.
  expect(judged.criteria[0].reason).toContain('s3cret-value')
})

test('redact sweeps an evidence directory with the rules of every app the result names', async () => {
  const { root, resultPath } = await severalFixture()
  await writeFile(join(resultPath, '..', 'notes.txt'), 'the storefront total was s3cret-value aware\n', 'utf8')

  const code = await main(
    ['redact', '--evidence', join(resultPath, '..'), '--profile', root],
    capture().writer,
    capture().writer,
  )

  expect(code).toBe(0)
  expect(await readFile(join(resultPath, '..', 'notes.txt'), 'utf8')).not.toContain('s3cret-value')
})

test('judge applies the rules of an inline profile the result carries itself', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-judge-several-'))
  made.push(dir)
  const evidence = join(dir, 'evidence')
  await mkdir(evidence, { recursive: true })
  const resultPath = join(evidence, 'result.json')
  await writeFile(
    resultPath,
    JSON.stringify({
      schemaVersion: RESULT_SCHEMA_VERSION,
      verdict: 'blocked',
      criteria: [{ id: 'c1', outcome: 'unverified', reason: 'the storefront total was s3cret-value aware' }],
      profiles: [
        {
          name: 'inline-app',
          verdict: 'refused',
          criteria: ['c1'],
          profile: { inline: { redact: { values: ['s3cret-value'] } } },
        },
      ],
    }),
    'utf8',
  )
  // No .qa root carries this app: its rules travel in the result itself.
  const root = join(dir, 'qa')

  const code = await main(['judge', '--result', resultPath, '--runner', 'none', '--profile', root], capture().writer, capture().writer)

  expect(code).toBe(0)
  const judged = JSON.parse(await readFile(join(resultPath, '..', 'judged-result.json'), 'utf8'))
  expect(judged.criteria[0].reason).not.toContain('s3cret-value')
})

test('judge refuses a result whose profile path the qa-profile artifact cannot carry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-judge-several-'))
  made.push(dir)
  const evidence = join(dir, 'evidence')
  await mkdir(evidence, { recursive: true })
  const resultPath = join(evidence, 'result.json')
  await writeFile(
    resultPath,
    JSON.stringify({
      schemaVersion: RESULT_SCHEMA_VERSION,
      verdict: 'blocked',
      criteria: [{ id: 'c1', outcome: 'unverified', reason: 'r' }],
      profiles: [{ name: 'admin', verdict: 'refused', criteria: ['c1'], profile: { path: 'apps/admin/.qa' } }],
    }),
    'utf8',
  )
  const err = capture()

  const code = await main(['judge', '--result', resultPath, '--runner', 'none', '--profile', join(dir, 'qa')], capture().writer, err.writer)

  expect(code).toBe(4)
  expect(err.lines.join('')).toContain('which the qa-profile artifact cannot carry')
})

test('a named boot profile is read with the fixtures and stubs the .qa root shares', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-judge-several-'))
  made.push(dir)
  const root = join(dir, 'qa')
  const bootProfile = [
    'app:',
    '  boot: { compose: compose.qa.yaml, service: admin }',
    "  health: { http: '" + ['http:', '//localhost:3000/up'].join('') + "', timeout: 120s }",
    '  seed: { command: bin/rails db:seed:qa }',
    '  login: { fixture: fixtures/users.yml, role: admin }',
    'stubs: []',
    'visual: { widths: [], themes: [] }',
    'suites: []',
    'redact:',
    '  values:',
    '    - s3cret-value',
  ].join('\n')
  await profileAt(join(root, 'admin'), bootProfile)
  await mkdir(join(root, 'fixtures'), { recursive: true })
  await mkdir(join(root, 'stubs'), { recursive: true })
  const resultPath = await severalResult(join(dir, 'evidence'), true)

  const code = await main(['judge', '--result', resultPath, '--runner', 'none', '--profile', root], capture().writer, capture().writer)

  expect(code).toBe(0)
  const judged = JSON.parse(await readFile(join(resultPath, '..', 'judged-result.json'), 'utf8'))
  expect(judged.criteria[0].reason).not.toContain('s3cret-value')
})
