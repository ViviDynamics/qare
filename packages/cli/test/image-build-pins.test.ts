import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { parse } from 'yaml'
import { expect, test } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const core = readFileSync(join(root, 'images/core/Dockerfile'), 'utf8')
const recipes = ['core', 'web', 'android', 'desktop-linux']

test('each default Docker base resolves to a digest, including both core stages', () => {
  for (const image of recipes) {
    const source = readFileSync(join(root, `images/${image}/Dockerfile`), 'utf8')
    const defaults = new Map([...source.matchAll(/^ARG (\w+)=(.+)$/gm)].map((match) => [match[1], match[2]]))
    const bases = [...source.matchAll(/^FROM (\S+)/gm)].map((match) => match[1]?.startsWith('$') ? defaults.get(match[1].slice(1)) : match[1])
    expect(bases.length).toBe(image === 'core' ? 2 : 1)
    for (const base of bases) expect(base, image).toMatch(/@sha256:[a-f0-9]{64}$/)
  }
})

test('the core builder uses the hashed workspace package manager before installing dependencies', () => {
  expect(core).not.toMatch(/npm install --global pnpm/)
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { packageManager: string }
  expect(manifest.packageManager).toMatch(/^pnpm@[\d.]+\+sha512\.[a-f0-9]{128}$/)
  expect(core.indexOf('corepack enable')).toBeGreaterThan(core.indexOf('COPY package.json'))
  expect(core.indexOf('corepack enable')).toBeLessThan(core.indexOf('pnpm install --frozen-lockfile'))
})

for (const matching of [true, false]) {
  test(`the nare build installs only a wheel with matching bytes: ${matching}`, () => {
    const block = core.match(/^RUN .*\n(?:.*\\\n)*.*$/gm)?.find((run) => run.includes('"$NARE_WHEEL"')) ?? ''
    expect(block).toContain('sha256sum')
    const cwd = mkdtempSync(join(tmpdir(), 'qare-wheel-hash-'))
    const bin = join(cwd, 'bin')
    mkdirSync(bin)
    const bytes = 'fixture wheel bytes'
    const fixture = join(cwd, 'fixture.whl')
    writeFileSync(fixture, bytes)
    // Download is a local fixture; the checksum command is the real one.
    // pip is a sentinel so this test never installs into its Python environment.
    writeFileSync(join(bin, 'python3'), `#!/bin/bash\nset -euo pipefail\nif [[ "$1" == -c ]]; then\n  cp "$QARE_WHEEL_FIXTURE" "\${@: -1}"\nelse\n  touch "$QARE_INSTALL_SENTINEL"\nfi\n`, { mode: 0o755 })
    const sentinel = join(cwd, 'installed')
    const script = block.replace(/^RUN /, '').replace(/\\\n/g, ' ').replaceAll('/tmp/qare-nare', join(cwd, 'download'))
    const result = spawnSync('bash', ['-eo', 'pipefail', '-c', script], { cwd, env: { PATH: `${bin}:${process.env.PATH ?? ''}`, NARE_WHEEL: fixture, NARE_SHA256: createHash('sha256').update(matching ? bytes : 'different bytes').digest('hex'), QARE_WHEEL_FIXTURE: fixture, QARE_INSTALL_SENTINEL: sentinel }, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(matching ? 0 : 1)
    expect(existsSync(sentinel)).toBe(matching)
    if (!matching) expect(result.stdout + result.stderr).toContain('FAILED')
  })
}

test('release flavours use the digest returned by their own core build', () => {
  const release = parse(readFileSync(join(root, '.github/workflows/release.yml'), 'utf8')) as { jobs: Record<string, { steps: Array<{ id?: string; name?: string; with?: Record<string, unknown> }> }> }
  const steps = Object.values(release.jobs).flatMap((job) => job.steps)
  const built = steps.find((step) => step.with?.file === 'images/core/Dockerfile')
  expect(built?.id).toBe('core')
  for (const image of recipes.slice(1)) {
    const step = steps.find((candidate) => candidate.with?.file === `images/${image}/Dockerfile`)
    expect(step?.with?.['build-args']).toBe('QARE_IMAGE=ghcr.io/vividynamics/qare-core@${{ steps.core.outputs.digest }}\n')
  }
})
