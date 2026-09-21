import { readFile } from 'node:fs/promises'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { RESULT_SCHEMA_VERSION } from '@qare/core'
import { exitCodeFor, main } from '../src/index.js'
import type { Writer } from '../src/index.js'
import { loadResult as loadOrchestratorResult, reactToResult } from '../../../examples/orchestrator.mjs'

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

async function writeJobFile(check: string): Promise<{ jobPath: string; evidenceDir: string }> {
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
  return { jobPath, evidenceDir }
}

test('exit codes are total over the five verdicts, with waived distinct from errors', () => {
  expect(exitCodeFor('passed')).toBe(0)
  expect(exitCodeFor('failed')).toBe(1)
  expect(exitCodeFor('blocked')).toBe(2)
  expect(exitCodeFor('refused')).toBe(3)
  expect(exitCodeFor('waived')).toBe(5)
})

test('a real qare run writes a result.json the orchestrator example reacts to as passed', async () => {
  const { jobPath, evidenceDir } = await writeJobFile('echo ok')
  const { lines, writer } = capture()
  const code = await main(['run', '--job', jobPath], writer, NO_OUT, HEALTHY_BOOT)
  expect(code).toBe(0)
  expect(lines.join('')).toContain('verdict passed; evidence')

  const text = await readFile(join(evidenceDir, 'result.json'), 'utf8')
  const result = JSON.parse(text)
  expect(result.schemaVersion).toBe(RESULT_SCHEMA_VERSION)
  expect(result.verdict).toBe('passed')
  expect(result.job).toEqual({ id: 'job-cli' })
  expect(result.criteria[0].outcome).toBe('proven')
  expect(result.criteria[0].evidence).toContain('checks/criterion-1/0/stdout.txt')

  const reaction = capture()
  const reactionCode = reactToResult(loadOrchestratorResult(text), { out: reaction.writer })
  expect(reactionCode).toBe(0)
  expect(reaction.lines.join('')).toContain('QARE_PASS:')
  expect(reaction.lines.join('')).toContain('evidence: checks/criterion-1/0/stdout.txt')
})
