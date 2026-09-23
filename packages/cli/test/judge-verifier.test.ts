import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { RESULT_SCHEMA_VERSION } from '@qare/core'
import { main } from '../src/index.js'
import type { Writer } from '../src/index.js'

function capture(): { lines: string[]; writer: Writer } {
  const lines: string[] = []
  return { lines, writer: { write: (chunk) => lines.push(chunk) } }
}

/**
 * A proven run as execute leaves it, with the plan and diff the pipeline hands
 * judge. The evidence file really exists, because the verifier reads it.
 */
async function provenRun(): Promise<{ dir: string; resultPath: string; planPath: string; diffPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-judge-'))
  const evidenceDir = join(dir, 'evidence')
  const resultPath = join(evidenceDir, 'result.json')
  await mkdir(join(evidenceDir, 'checks', 'export-csv', '0'), { recursive: true })
  await writeFile(join(evidenceDir, 'checks', 'export-csv', '0', 'stdout.txt'), 'exported 0 rows\n', 'utf8')
  await writeFile(
    resultPath,
    JSON.stringify({
      schemaVersion: RESULT_SCHEMA_VERSION,
      verdict: 'passed',
      criteria: [{ id: 'export-csv', outcome: 'proven', evidence: ['checks/export-csv/0/stdout.txt'] }],
    }),
    'utf8',
  )
  const planPath = join(dir, 'plan.json')
  await writeFile(
    planPath,
    JSON.stringify({
      schemaVersion: '1',
      criteria: [
        {
          id: 'export-csv',
          text: 'The ledger exports every row to CSV.',
          checks: [{ kind: 'command', name: 'export', command: 'bin/export' }],
        },
      ],
    }),
    'utf8',
  )
  const diffPath = join(dir, 'change.diff')
  await writeFile(diffPath, 'diff --git a/export.rb b/export.rb\n', 'utf8')
  return { dir, resultPath, planPath, diffPath }
}

/** A real executable standing in for nare: records its argv, answers with `output`. */
async function fakeNare(output: unknown): Promise<{ binary: string; argv: () => Promise<string[]> }> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-nare-'))
  const argvPath = join(dir, 'argv.json')
  const binary = join(dir, 'nare')
  const result = {
    type: 'result',
    status: 'done',
    stop_reason: 'end_turn',
    usage: { input: 1, output: 1 },
    contract: 1,
    output,
    error: null,
    questions: [],
  }
  const script = [
    `import { writeFileSync } from 'node:fs'`,
    `writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)))`,
    `console.log(JSON.stringify({ type: 'output', text: ${JSON.stringify(JSON.stringify(output))} }))`,
    `console.log(${JSON.stringify(JSON.stringify(result))})`,
  ].join('\n')
  await writeFile(`${binary}.mjs`, script, 'utf8')
  await writeFile(binary, `#!/bin/sh\nexec node ${binary}.mjs "$@"\n`, 'utf8')
  await chmod(binary, 0o755)
  return { binary, argv: async () => JSON.parse(await readFile(argvPath, 'utf8')) as string[] }
}

async function judge(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out = capture()
  const err = capture()
  const code = await main(['judge', ...args], out.writer, err.writer)
  return { code, out: out.lines.join(''), err: err.lines.join('') }
}

// Issue #23's seeded scenario: the check passed, but its evidence does not show
// what the criterion says. The verifier catches it and the run fails.
test('a verifier finding fails a run the checks passed, and the comment says why', async () => {
  const { dir, resultPath, planPath, diffPath } = await provenRun()
  const nare = await fakeNare({
    findings: [{ criterionId: 'export-csv', problem: 'the export wrote 0 rows, so it did not export every row' }],
  })

  const run = await judge(['--result', resultPath, '--plan', planPath, '--diff', diffPath, '--nare', nare.binary, '--outDir', dir])

  expect(run.code).toBe(0)
  expect(run.out).toContain('verdict failed')
  const judged = JSON.parse(await readFile(join(dir, 'judged-result.json'), 'utf8'))
  expect(judged.verdict).toBe('failed')
  expect(judged.criteria).toEqual([
    {
      id: 'export-csv',
      outcome: 'failed',
      evidence: ['checks/export-csv/0/stdout.txt'],
      reason: 'verifier: the export wrote 0 rows, so it did not export every row',
    },
  ])
  expect(await readFile(join(dir, 'comment.md'), 'utf8')).toContain('the export wrote 0 rows')
  expect(run.err).toContain('verifier: export-csv failed')
})

test('the verifier reads the criterion text and the diff, confined read-only to the evidence directory', async () => {
  const { dir, resultPath, planPath, diffPath } = await provenRun()
  const nare = await fakeNare({ findings: [] })

  await judge(['--result', resultPath, '--plan', planPath, '--diff', diffPath, '--nare', nare.binary, '--outDir', dir])

  const argv = await nare.argv()
  const prompt = argv[1] ?? ''
  expect(prompt).toContain('The ledger exports every row to CSV.')
  expect(prompt).toContain('diff --git a/export.rb b/export.rb')
  expect(prompt).toContain('checks/export-csv/0/stdout.txt')
  expect(argv[argv.indexOf('--tools') + 1]).toBe('read')
  expect(argv[argv.indexOf('--root') + 1]).toBe(join(dir, 'evidence'))
  expect(argv).toContain('--schema')
})

test('no findings leaves the pass standing', async () => {
  const { dir, resultPath, planPath, diffPath } = await provenRun()
  const nare = await fakeNare({ findings: [] })

  const run = await judge(['--result', resultPath, '--plan', planPath, '--diff', diffPath, '--nare', nare.binary, '--outDir', dir])

  expect(run.out).toContain('verdict passed')
})

// Fail closed: a verifier that never answered checked nothing, so the pass
// does not stand. The run blocks, names why, and still writes its artifacts.
test('a verifier that cannot run blocks the run rather than letting the pass stand', async () => {
  const { dir, resultPath, planPath, diffPath } = await provenRun()

  const run = await judge([
    '--result', resultPath, '--plan', planPath, '--diff', diffPath,
    '--nare', join(dir, 'no-such-nare'), '--outDir', dir,
  ])

  expect(run.code).toBe(0)
  expect(run.out).toContain('verdict blocked')
  const judged = JSON.parse(await readFile(join(dir, 'judged-result.json'), 'utf8'))
  expect(judged.criteria[0].outcome).toBe('unverified')
  expect(judged.criteria[0].reason).toMatch(/^verifier did not answer: could not run nare/)
  expect(run.err).toContain('verifier did not answer')
  for (const name of ['judged-result.json', 'comment.md', 'checkrun.json'])
    expect(existsSync(join(dir, name))).toBe(true)
})

test('judging with the verifier but without a plan or diff is a usage error that names the way out', async () => {
  const { dir, resultPath, planPath } = await provenRun()

  const run = await judge(['--result', resultPath, '--plan', planPath, '--outDir', dir])

  expect(run.code).toBe(4)
  expect(run.err).toContain('--diff <path>')
  expect(run.err).toContain('--runner none')
  expect(existsSync(join(dir, 'judged-result.json'))).toBe(false)
})

test('--runner none judges from the evidence alone, with no plan and no model', async () => {
  const { dir, resultPath } = await provenRun()

  const run = await judge(['--result', resultPath, '--runner', 'none', '--outDir', dir])

  expect(run.code).toBe(0)
  expect(run.out).toContain('verdict passed')
})

test('judging a judged result again keeps the reason the verifier gave', async () => {
  const { dir, resultPath, planPath, diffPath } = await provenRun()
  const nare = await fakeNare({ findings: [{ criterionId: 'export-csv', problem: 'the export wrote 0 rows' }] })
  await judge(['--result', resultPath, '--plan', planPath, '--diff', diffPath, '--nare', nare.binary, '--outDir', dir])
  const again = join(dir, 'again')

  await judge(['--result', join(dir, 'judged-result.json'), '--runner', 'none', '--outDir', again])

  const judged = JSON.parse(await readFile(join(again, 'judged-result.json'), 'utf8'))
  expect(judged.criteria[0].reason).toBe('verifier: the export wrote 0 rows')
})
