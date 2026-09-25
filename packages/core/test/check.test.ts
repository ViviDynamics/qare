import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { NareRunnerError, checkCriteria, defaultCheckEvidenceDir, type AgentRunner } from '../src/index.js'

const TARGET_URL = ['https:', '//wiki.example.test'].join('')

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-check-core-'))
  await mkdir(join(dir, '.qa'))
  await writeFile(join(dir, '.qa', 'QA.md'), '# QA\n')
  await writeFile(join(dir, '.qa', 'config.yml'), `target:\n  url: ${TARGET_URL}\n  health: { http: /health, timeout: 1s }\n`)
  return dir
}

function throwing(error: Error): AgentRunner {
  return { run: async () => { throw error } }
}

async function check(dir: string, planner: AgentRunner) {
  return checkCriteria({
    criteria: ['the home page loads'],
    profileDir: join(dir, '.qa'),
    repoPath: dir,
    evidenceDir: join(dir, 'evidence'),
    planner,
    verifier: 'none',
    run: { probe: async () => ({ ok: true }), pollIntervalMs: 1 },
  })
}

test('a planner that fails as a planner leaves the criterion unverified, naming why', async () => {
  const dir = await repo()
  const { judged } = await check(dir, throwing(new NareRunnerError('could not run nare (nare): ENOENT')))
  expect(judged.criteria[0]).toMatchObject({ outcome: 'unverified', reason: expect.stringContaining('planning failed: could not run nare') })
})

test('a bug in the planner path surfaces as a bug, not as an unverified outcome', async () => {
  const dir = await repo()
  await expect(check(dir, throwing(new TypeError('Cannot read properties of undefined')))).rejects.toThrow(TypeError)
})

test('each default evidence directory sits in a run directory of its own, so traces beside it never collide', () => {
  const first = defaultCheckEvidenceDir('/work', new Date(0))
  const second = defaultCheckEvidenceDir('/work', new Date(1000))
  expect(first).toBe('/work/qare-evidence/check-1970-01-01T00-00-00-000Z/evidence')
  // run.ts keeps traces at <evidenceDir>/../traces: per run, never shared.
  expect(join(first, '..', 'traces')).not.toBe(join(second, '..', 'traces'))
})
