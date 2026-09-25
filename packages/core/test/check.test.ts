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

test('a planner that cannot run leaves the criterion unverified, naming the error and its kind', async () => {
  const dir = await repo()
  const { judged } = await check(dir, throwing(new NareRunnerError('could not run nare (nare): ENOENT')))
  expect(judged.criteria[0]).toMatchObject({ outcome: 'unverified', reason: expect.stringContaining('planning failed (NareRunnerError: could not run nare') })

  // Whatever the failure, the check still reports every criterion, and a bug
  // shows as one by name rather than aborting with no result at all.
  const bug = await check(dir, throwing(new TypeError('Cannot read properties of undefined')))
  expect(bug.judged.verdict).toBe('blocked')
  expect(bug.judged.criteria[0]).toMatchObject({ outcome: 'unverified', reason: expect.stringContaining('TypeError: Cannot read') })
})

test('each default evidence directory sits in a run directory of its own, so traces beside it never collide', () => {
  const first = defaultCheckEvidenceDir('/work', new Date(0), 'aaaa')
  const second = defaultCheckEvidenceDir('/work', new Date(0))
  expect(first).toBe('/work/qare-evidence/check-1970-01-01T00-00-00-000Z-aaaa/evidence')
  // Two runs started in the same millisecond still get directories of their own.
  expect(defaultCheckEvidenceDir('/work', new Date(0))).not.toBe(second)
  // run.ts keeps traces at <evidenceDir>/../traces: per run, never shared.
  expect(join(first, '..', 'traces')).not.toBe(join(second, '..', 'traces'))
})
