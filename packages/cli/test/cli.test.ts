import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { Readable } from 'node:stream'
import { RESULT_SCHEMA_VERSION, VERSION } from '@qare/core'
import { main } from '../src/index.js'
import type { Writer } from '../src/index.js'

const HEALTH_URL = ['http:', '//localhost:3000/up'].join('')

const HEALTHY_BOOT = {
  runCompose: async () => ({ code: 0, stdout: 'up out', stderr: 'up err' }),
  probe: async () => ({ ok: true }),
  pollIntervalMs: 1,
}

const NO_OUT: Writer = { write: () => {} }

function capture(): { lines: string[]; writer: Writer } {
  const lines: string[] = []
  return { lines, writer: { write: (chunk) => lines.push(chunk) } }
}

async function writeJobFile(check: string): Promise<{ jobPath: string; evidenceDir: string; jobText: string }> {
  const repoPath = await mkdtemp(join(tmpdir(), 'qare-cli-'))
  const evidenceDir = join(repoPath, 'evidence')
  const jobPath = join(repoPath, 'job.yml')
  const jobText =
    [
      'id: job-cli',
      `repoPath: ${repoPath}`,
      'baseRef: main',
      'headRef: HEAD~1',
      'profile:',
      '  inline:',
      '    app:',
      '      boot: { compose: compose.qa.yaml, service: admin }',
      `      health: { http: "${HEALTH_URL}", timeout: 120s }`,
      '      seed: { command: bin/rails db:seed:qa }',
      '      login: { fixture: fixtures/users.yml, role: admin }',
      '    stubs: []',
      '    visual: { widths: [1440], themes: [light] }',
      '    suites: []',
      'criteria:',
      '  - id: criterion-1',
      '    text: does the thing',
      '    checks:',
      `      - { kind: command, run: "${check}" }`,
      `evidenceDir: ${evidenceDir}`,
      'post: none',
    ].join('\n') + '\n'
  await writeFile(jobPath, jobText, 'utf8')
  return { jobPath, evidenceDir, jobText }
}

test('--version prints the core version', async () => {
  const { lines, writer } = capture()
  const code = await main(['--version'], writer)
  expect(code).toBe(0)
  expect(lines.join('')).toBe(`${VERSION}\n`)
})

test('no arguments prints usage', async () => {
  const { lines, writer } = capture()
  const code = await main([], writer)
  expect(code).toBe(0)
  expect(lines.join('')).toContain('usage: qare --version')
})

test('run --job on a passing job exits 0, prints the verdict and writes result.json', async () => {
  const { jobPath, evidenceDir } = await writeJobFile('echo ok')
  const { lines, writer } = capture()
  const code = await main(['run', '--job', jobPath], writer, NO_OUT, HEALTHY_BOOT)
  expect(code).toBe(0)
  expect(lines.join('')).toContain('verdict passed')
  expect(lines.join('')).toContain(evidenceDir)
  expect(existsSync(join(evidenceDir, 'result.json'))).toBe(true)
})

test('run --job on a failing job exits 1 and still writes result.json', async () => {
  const { jobPath, evidenceDir } = await writeJobFile('false')
  const { lines, writer } = capture()
  const code = await main(['run', '--job', jobPath], writer, NO_OUT, HEALTHY_BOOT)
  expect(code).toBe(1)
  expect(lines.join('')).toContain('verdict failed')
  expect(existsSync(join(evidenceDir, 'result.json'))).toBe(true)
})

test('run --job - reads the job from stdin and exits 0', async () => {
  const { jobText, evidenceDir } = await writeJobFile('echo ok')
  const { lines, writer } = capture()
  const code = await main(['run', '--job', '-'], writer, NO_OUT, HEALTHY_BOOT, Readable.from([jobText]))
  expect(code).toBe(0)
  expect(lines.join('')).toContain('verdict passed')
  expect(existsSync(join(evidenceDir, 'result.json'))).toBe(true)
})

test('run --job on an invalid job exits 4 with the named error on stderr', async () => {
  const repoPath = await mkdtemp(join(tmpdir(), 'qare-cli-'))
  const jobPath = join(repoPath, 'job.yml')
  await writeFile(jobPath, 'id: [unclosed\n', 'utf8')
  const out = capture()
  const errors = capture()
  const code = await main(['run', '--job', jobPath], out.writer, errors.writer, HEALTHY_BOOT)
  expect(code).toBe(4)
  expect(errors.lines.join('')).toContain('JobValidationError')
  expect(out.lines.join('')).not.toContain('verdict')
})

test('run without --job exits 4 with the usage error on stderr', async () => {
  const out = capture()
  const errors = capture()
  const code = await main(['run'], out.writer, errors.writer, HEALTHY_BOOT)
  expect(code).toBe(4)
  expect(errors.lines.join('')).toContain('--job')
})

async function writeResultFile(): Promise<{ dir: string; resultPath: string; resultText: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-cli-'))
  const resultText = `${JSON.stringify(
    {
      schemaVersion: RESULT_SCHEMA_VERSION,
      verdict: 'passed',
      criteria: [{ id: 'criterion-1', outcome: 'proven', evidence: ['checks/criterion-1/0/stdout.txt'] }],
      job: { id: 'job-cli' },
    },
    null,
    2,
  )}\n`
  const resultPath = join(dir, 'result.json')
  await writeFile(resultPath, resultText, 'utf8')
  return { dir, resultPath, resultText }
}

test('judge writes judged-result.json, comment.md and checkrun.json next to the result', async () => {
  const { dir, resultPath, resultText } = await writeResultFile()
  const { lines, writer } = capture()
  const code = await main(['judge', '--result', resultPath], writer, NO_OUT)
  expect(code).toBe(0)
  expect(lines.join('')).toContain('verdict passed')
  const judged = JSON.parse(await readFile(join(dir, 'judged-result.json'), 'utf8'))
  expect(judged.verdict).toBe('passed')
  expect(judged.schemaVersion).toBe(RESULT_SCHEMA_VERSION)
  expect(await readFile(join(dir, 'comment.md'), 'utf8')).toContain('## QARE run: passed')
  const checkRun = JSON.parse(await readFile(join(dir, 'checkrun.json'), 'utf8'))
  expect(checkRun.title).toBe('QARE')
  expect(checkRun.conclusion).toBe('success')
  expect(await readFile(resultPath, 'utf8')).toBe(resultText)
})

test('judge of a waived result keeps the waived verdict and the waiver record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-cli-'))
  const resultPath = join(dir, 'result.json')
  await writeFile(
    resultPath,
    `${JSON.stringify({
      schemaVersion: RESULT_SCHEMA_VERSION,
      verdict: 'waived',
      criteria: [{ id: 'criterion-1', outcome: 'unverified', reason: 'waived by hana' }],
      job: { id: 'job-cli' },
      waived: [{ criterionId: 'criterion-1', by: 'hana' }],
    }, null, 2)}\n`,
    'utf8',
  )
  const { lines, writer } = capture()
  const code = await main(['judge', '--result', resultPath], writer, NO_OUT)
  expect(code).toBe(0)
  expect(lines.join('')).toContain('verdict waived')
  const judged = JSON.parse(await readFile(join(dir, 'judged-result.json'), 'utf8'))
  expect(judged.verdict).toBe('waived')
  expect(judged.waived).toEqual([{ criterionId: 'criterion-1', by: 'hana' }])
  expect(judged.criteria).toEqual([
    { id: 'criterion-1', outcome: 'unverified', reason: 'waived by human' },
  ])
})

// The verifier is downgrade-only, so a judge run whose verifier cannot start
// still writes its artifacts and still reports the code-decided verdict. What
// must never happen is silence: the reason reaches stderr.
test('judge --runner nare reports why the verifier did not run, and still writes all three artifacts', async () => {
  const { resultPath } = await writeResultFile()
  const outDir = join(await mkdtemp(join(tmpdir(), 'qare-cli-')), 'artifacts')
  const out = capture()
  const errors = capture()
  const code = await main(
    ['judge', '--result', resultPath, '--outDir', outDir, '--runner', 'nare'],
    out.writer,
    errors.writer,
  )
  expect(code).toBe(0)
  expect(errors.lines.join('')).toContain('verifier skipped:')
  // nare is not installed in the test environment, so the runner reports that
  // rather than the placeholder's NotImplemented it used to raise.
  expect(errors.lines.join('')).toMatch(/NareRunnerError|nare/)
  for (const name of ['judged-result.json', 'comment.md', 'checkrun.json'])
    expect(existsSync(join(outDir, name))).toBe(true)
  const judged = JSON.parse(await readFile(join(outDir, 'judged-result.json'), 'utf8'))
  expect(judged.verdict).toBe('passed')
})

test('judge on malformed result.json exits 4 with the named error on stderr', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-cli-'))
  const resultPath = join(dir, 'result.json')
  await writeFile(resultPath, 'not json at all {', 'utf8')
  const out = capture()
  const errors = capture()
  const code = await main(['judge', '--result', resultPath], out.writer, errors.writer)
  expect(code).toBe(4)
  expect(errors.lines.join('')).toContain('ResultValidationError')
  expect(existsSync(join(dir, 'judged-result.json'))).toBe(false)
})
