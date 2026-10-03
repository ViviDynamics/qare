import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { loadResult, renderComment, toBaseSideResults } from '@qare/core'
import { main } from '../src/index.js'
import type { Writer } from '../src/index.js'

const HEALTH_URL = ['http:', '//localhost:3000/up'].join('')

const HEALTHY_BOOT = {
  runCompose: async () => ({ code: 0, stdout: '', stderr: '' }),
  probe: async () => ({ ok: true }),
  pollIntervalMs: 1,
}

function capture(): { text: () => string; writer: Writer } {
  const lines: string[] = []
  return { text: () => lines.join(''), writer: { write: (chunk) => lines.push(chunk) } }
}

/**
 * A head checkout and a base checkout, and a job over the head that checks
 * two files: `old.txt`, which only the base has, and `later.txt`, which
 * neither has.
 */
async function twoSidedJob(base?: string): Promise<{ jobPath: string; evidenceDir: string; baseRepo: string }> {
  const repoPath = await mkdtemp(join(tmpdir(), 'qare-cli-head-'))
  const baseRepo = await mkdtemp(join(tmpdir(), 'qare-cli-base-'))
  await writeFile(join(baseRepo, 'old.txt'), 'base\n')
  const evidenceDir = join(repoPath, 'evidence')
  const jobPath = join(repoPath, 'job.yml')
  const jobText =
    [
      'id: job-two-sided',
      `repoPath: ${repoPath}`,
      'baseRef: origin/main',
      'headRef: HEAD',
      'profile:',
      '  inline:',
      '    app:',
      '      boot: { compose: compose.qa.yaml, service: admin }',
      `      health: { http: "${HEALTH_URL}", timeout: 120s }`,
      '      seed: { command: bin/seed }',
      '      login: { fixture: fixtures/users.yml, role: admin }',
      '    stubs: []',
      '    visual: { widths: [1440], themes: [light] }',
      '    suites: []',
      ...(base === undefined ? [] : [`    base: ${base}`]),
      'criteria:',
      '  - id: old-behaviour',
      '    text: the old file is still there',
      '    checks:',
      '      - { kind: command, run: "test -f old.txt" }',
      '  - id: not-built-yet',
      '    text: the later file is there',
      '    checks:',
      '      - { kind: command, run: "test -f later.txt" }',
      `evidenceDir: ${evidenceDir}`,
      'post: none',
    ].join('\n') + '\n'
  await writeFile(jobPath, jobText, 'utf8')
  return { jobPath, evidenceDir, baseRepo }
}

test('qare run checks the base too and names the regression; qare judge is handed that base (#147)', async () => {
  const { jobPath, evidenceDir, baseRepo } = await twoSidedJob()
  const out = capture()
  const err = capture()
  const code = await main(['run', '--job', jobPath, '--base-repo', baseRepo], out.writer, err.writer, HEALTHY_BOOT)

  expect(code).toBe(1)
  expect(out.text()).toContain('regression old-behaviour: proven at the base, failed at the head\n')
  expect(out.text()).not.toContain('regression not-built-yet')
  expect(out.text()).toContain('verdict failed; evidence')
  expect(err.text()).toBe('')

  const executed = loadResult(await readFile(join(evidenceDir, 'result.json'), 'utf8'))
  expect(executed.base).toEqual({ ref: 'origin/main', status: 'executed' })
  // The judge gets a non-empty base out of what the run wrote.
  expect(toBaseSideResults(executed)).toEqual([
    { criterionId: 'old-behaviour', outcome: 'proven' },
    { criterionId: 'not-built-yet', outcome: 'failed' },
  ])

  const judgeErr = capture()
  const judged = await main(['judge', '--result', join(evidenceDir, 'result.json'), '--runner', 'none', '--outDir', evidenceDir], capture().writer, judgeErr.writer, HEALTHY_BOOT)
  expect(judgeErr.text()).toBe('')
  expect(judged).toBe(0)
  const result = loadResult(await readFile(join(evidenceDir, 'judged-result.json'), 'utf8'))
  expect(result.criteria).toMatchObject([
    { id: 'old-behaviour', outcome: 'failed', regression: true, base: { outcome: 'proven' } },
    { id: 'not-built-yet', outcome: 'failed', regression: false, base: { outcome: 'failed' } },
  ])
  // Base and head evidence, both on disk under their own side.
  const comment = await readFile(join(evidenceDir, 'comment.md'), 'utf8')
  expect(comment).toBe(`${renderComment(result)}\n`)
  expect(comment).toContain('| old-behaviour | failed (regression) | regression: proven at the base, failed at the head |')
  expect(comment).toContain('- old-behaviour at the base: ')
  expect(comment).toContain('(<base/checks/old-behaviour/0/command.json>)')
  expect(comment).toContain('(<head/checks/old-behaviour/0/command.json>)')
})

test('qare run without a base to check out says so on stderr, and still checks the head (#147)', async () => {
  const { jobPath, evidenceDir } = await twoSidedJob()
  const out = capture()
  const err = capture()
  const code = await main(['run', '--job', jobPath], out.writer, err.writer, HEALTHY_BOOT)

  expect(code).toBe(1)
  expect(err.text()).toContain('base origin/main not checked, so nothing was compared: ')
  expect(out.text()).not.toContain('regression ')
  const executed = loadResult(await readFile(join(evidenceDir, 'result.json'), 'utf8'))
  expect(executed.base?.status).toBe('not-executed')
  expect(toBaseSideResults(executed)).toEqual([])
})

test('a profile that runs nothing at the base costs one side, and the result says so (#147)', async () => {
  const { jobPath, evidenceDir, baseRepo } = await twoSidedJob('{ criteria: none }')
  const calls: string[][] = []
  const boot = { ...HEALTHY_BOOT, runCompose: async (args: string[]) => (calls.push(args), { code: 0, stdout: '', stderr: '' }) }
  const err = capture()
  await main(['run', '--job', jobPath, '--base-repo', baseRepo], capture().writer, err.writer, boot)

  expect(calls.filter((args) => args.includes('up'))).toHaveLength(1)
  expect(err.text()).toContain('base.criteria: none')
  const executed = loadResult(await readFile(join(evidenceDir, 'result.json'), 'utf8'))
  expect(executed.base).toEqual({ ref: 'origin/main', status: 'not-executed', reason: 'the profile runs no criteria at the base (base.criteria: none)' })
})
