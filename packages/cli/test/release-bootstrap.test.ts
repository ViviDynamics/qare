import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { VERSION } from '@qare/core'

const installer = fileURLToPath(new URL('../../../scripts/install.sh', import.meta.url))

test.each(['missing', 'stopped'])('setup explains a %s Docker installation before writing files', (condition) => {
  const bin = mkdtempSync(join(tmpdir(), 'qare-install-'))
  try {
    if (condition === 'stopped') writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const run = spawnSync('/bin/sh', [installer], { cwd: bin, env: { PATH: bin }, encoding: 'utf8' })
    expect(run.status).not.toBe(0)
    expect(run.stderr).toMatch(condition === 'missing' ? /install Docker/i : /Docker daemon/i)
  } finally {
    rmSync(bin, { recursive: true, force: true })
  }
})

test('the release publishes an installer pinned by the same stamp as the CLI', () => {
  expect(readFileSync(installer, 'utf8')).toContain(`release='${VERSION}'`)
  const workflow = readFileSync(new URL('../../../.github/workflows/release.yml', import.meta.url), 'utf8')
  expect(workflow).toMatch(/gh release create [^\n]*scripts\/install\.sh/)
  expect(workflow).toContain('sh scripts/test-install.sh')
})
