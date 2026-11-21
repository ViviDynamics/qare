import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { main } from '../src/index.js'
import type { Writer } from '../src/index.js'

// #381: `qare run --build-cache-from <dir> [--build-cache-to <dir>]` hands
// the boot the opt-in buildx layer cache. The pipeline's execute step reads
// one; main_execute reads one and writes the next.

const HEALTH_URL = ['http:', '//localhost:3000/up'].join('')

function capture(): { text: () => string; writer: Writer } {
  const lines: string[] = []
  return { text: () => lines.join(''), writer: { write: (chunk) => lines.push(chunk) } }
}

async function job(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), 'qare-cli-cache-'))
  const jobPath = join(repoPath, 'job.yml')
  await writeFile(
    jobPath,
    [
      'id: job-cache',
      `repoPath: ${repoPath}`,
      'baseRef: origin/main',
      'headRef: HEAD',
      'profile:',
      '  inline:',
      '    app:',
      '      boot: { compose: compose.qa.yaml, service: web }',
      `      health: { http: "${HEALTH_URL}", timeout: 5s }`,
      '      seed: { command: "true" }',
      '      login: { fixture: fixtures/users.yml, role: admin }',
      '    stubs: []',
      '    visual: { widths: [1440], themes: [light] }',
      '    suites: []',
      '    base: { criteria: none }',
      'criteria:',
      '  - id: up',
      '    text: it is up',
      '    checks:',
      '      - { kind: command, run: "true" }',
      `evidenceDir: ${join(repoPath, 'evidence')}`,
      'post: none',
    ].join('\n') + '\n',
  )
  return jobPath
}

function seam() {
  const builds: Array<{ args: string[]; env?: Record<string, string> }> = []
  return {
    builds,
    runCompose: async (args: string[], _timeoutMs: number, env?: Record<string, string>) => {
      if (args.includes('config')) return { code: 0, stdout: JSON.stringify({ services: { web: { build: { context: '.' } } } }), stderr: '' }
      if (args.includes('build')) builds.push({ args, ...(env === undefined ? {} : { env }) })
      return { code: 0, stdout: '', stderr: '' }
    },
    probe: async () => ({ ok: true }),
    pollIntervalMs: 1,
  }
}

test('qare run --build-cache-to hands the boot a cache to write, and the build an override that writes it (#381)', async () => {
  const boot = seam()
  const to = await mkdtemp(join(tmpdir(), 'qare-cache-to-'))
  const code = await main(['run', '--job', await job(), '--build-cache-from', join(to, 'none-yet'), '--build-cache-to', to], capture().writer, capture().writer, boot)
  expect(code).toBe(0)
  expect(boot.builds[0]?.args.some((arg) => arg.endsWith('.build-cache.json'))).toBe(true)
  expect(boot.builds[0]?.env).toMatchObject({ BUILDX_BAKE_ENTITLEMENTS_FS: '0' })
})

test('without the flags the boot builds with no cache (#381)', async () => {
  const boot = seam()
  expect(await main(['run', '--job', await job()], capture().writer, capture().writer, boot)).toBe(0)
  expect(boot.builds[0]?.args.some((arg) => arg.endsWith('.build-cache.json'))).toBe(false)
})
