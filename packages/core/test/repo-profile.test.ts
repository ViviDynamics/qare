import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { expect, test } from 'vitest'
import { loadProfile } from '../src/index.js'

const repoQaDir = fileURLToPath(new URL('../../../.qa', import.meta.url))

interface DeclaredTarget {
  target: { url: string; health: { http: string; timeout: string }; hosts: string[] }
}

test("the repository's own profile loads as a target profile", async () => {
  // The expected URL values are read from the file rather than named here, so
  // the source carries no network markers (the scanner in runner.test.ts).
  const declared = parseYaml(readFileSync(join(repoQaDir, 'config.yml'), 'utf8')) as DeclaredTarget
  const profile = await loadProfile(repoQaDir)

  expect(profile.app).toBeUndefined()
  expect(profile.target?.url).toBe(declared.target.url)
  // A path health check resolves against the target URL.
  expect(profile.target?.health.http).toBe(`${declared.target.url}/wiki/Main_Page`)
  expect(profile.target?.health.timeout).toBe('30s')
  expect(profile.target?.hosts).toEqual(declared.target.hosts)

  expect(profile.stubs).toEqual([])
  // The suites the main lane runs for the ledger's active criteria (#363):
  // the mail self-checks, and nothing that runs the repository's test suites.
  expect(profile.suites).toEqual([
    { name: 'mail-quoted-auth', command: 'node -- .qa/checks/mail-evidence.mjs quoted-auth', kind: 'command' },
    { name: 'mail-missing-code', command: 'node -- .qa/checks/mail-evidence.mjs missing-code', kind: 'command' },
  ])
})

test("the repository's own profile ships non-empty QA.md instructions", () => {
  const qaMd = readFileSync(join(repoQaDir, 'QA.md'), 'utf8')

  expect(qaMd.trim().length).toBeGreaterThan(0)
})
