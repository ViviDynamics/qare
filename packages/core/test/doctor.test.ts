import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { runDoctor } from '../src/index.js'

const HEALTHY_PROBES = {
  which: (name: string) => `/usr/local/bin/${name}`,
  dockerInfo: async () => ({ ok: true, detail: 'docker daemon reachable (server 27.0)' }),
  chromium: async () => ({ ok: true, detail: 'chromium driver at /drivers/chromium' }),
}

const PROFILE_FIXTURE = fileURLToPath(new URL('../fixtures/qa-valid/.qa', import.meta.url))

test('without a profile, only the runtime is required and the rest is inventory', async () => {
  const report = await runDoctor({ probes: HEALTHY_PROBES })
  expect(report.ready).toBe(true)
  expect(report.findings.filter((finding) => finding.required).map((finding) => finding.name)).toEqual([
    'qare',
    'node',
    'nare',
  ])
  const byName = new Map(report.findings.map((finding) => [finding.name, finding]))
  expect(byName.get('docker')?.required).toBe(false)
  expect(byName.get('chromium')?.required).toBe(false)
  expect(byName.get('display')?.ok).toBe(true)
  expect(byName.get('devices')?.ok).toBe(true)
})

test('a profile that boots an app and drives a browser requires the daemon and the driver', async () => {
  const report = await runDoctor({ profilePath: PROFILE_FIXTURE, probes: HEALTHY_PROBES })
  expect(report.ready).toBe(true)
  const byName = new Map(report.findings.map((finding) => [finding.name, finding]))
  expect(byName.get('docker')?.required).toBe(true)
  expect(byName.get('chromium')?.required).toBe(true)
})

test('a missing required piece names how to install it and fails the host', async () => {
  const report = await runDoctor({
    profilePath: PROFILE_FIXTURE,
    probes: {
      which: () => undefined,
      dockerInfo: async () => ({ ok: false, detail: 'docker daemon not reachable' }),
      chromium: async () => ({ ok: false, detail: 'playwright-core is not installed' }),
    },
  })
  expect(report.ready).toBe(false)
  const byName = new Map(report.findings.map((finding) => [finding.name, finding]))
  expect(byName.get('nare')?.ok).toBe(false)
  expect(byName.get('nare')?.install).toContain('nare')
  expect(byName.get('docker')?.install).toContain('Docker')
  expect(byName.get('chromium')?.install).toContain('playwright install chromium')
})

test('an explicit nare binary is checked in place, so no PATH lookup runs', async () => {
  const report = await runDoctor({
    probes: { ...HEALTHY_PROBES, which: () => {
      throw new Error('an explicit binary must not be looked up on PATH')
    } },
    nare: process.execPath,
  })
  expect(report.ready).toBe(true)
  const nare = report.findings.find((finding) => finding.name === 'nare')
  expect(nare?.ok).toBe(true)
  expect(nare?.detail).toContain(process.execPath)
})

test('a missing profile is tolerated: the requirements it would add are not checked', async () => {
  const report = await runDoctor({ profilePath: '/no/such/profile', probes: HEALTHY_PROBES })
  expect(report.ready).toBe(true)
  const byName = new Map(report.findings.map((finding) => [finding.name, finding]))
  expect(byName.get('profile')?.name).toBe('profile')
  expect(byName.get('docker')?.required).toBe(false)
  expect(byName.get('chromium')?.required).toBe(false)
})

test('a profile that is there but broken is a caller mistake, not a finding', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-doctor-'))
  // A profile whose instructions are there but whose config is malformed.
  await writeFile(join(dir, 'QA.md'), '# QA\n', 'utf8')
  const healthUrl = ['http:', '//localhost:3000/up'].join('')
  await writeFile(
    join(dir, 'config.yml'),
    [
      `app: { boot: { compose: compose.yaml, service: admin }, health: { http: "${healthUrl}", timeout: 120s }, seed: { command: bin/rails }, login: { fixture: f, role: admin } }`,
      'stubs: []',
      'visual: { widths: [not-a-number], themes: [] }',
      'suites: []',
    ].join('\n'),
    'utf8',
  )
  await expect(runDoctor({ profilePath: dir, probes: HEALTHY_PROBES })).rejects.toThrow()
})
