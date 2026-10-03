import { readFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { NARE_PYTHON_MINIMUM, runDoctor } from '../src/index.js'

const HEALTHY_PROBES = {
  which: (name: string) => `/usr/local/bin/${name}`,
  dockerInfo: async () => ({ ok: true, detail: 'docker daemon reachable (server 27.0)' }),
  chromium: async () => ({ ok: true, detail: 'chromium driver at /drivers/chromium' }),
  python: async () => ({ version: '3.12.7', detail: 'python3 3.12.7 at /usr/local/bin/python3' }),
}

// A runner whose python is older than the pinned nare accepts (#204): pip
// refuses the wheel with "requires a different Python: 3.11.16 not in '>=3.12'".
const OLD_PYTHON = async () => ({ version: '3.11.16', detail: 'python3 3.11.16 at /usr/bin/python3' })

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
      python: HEALTHY_PROBES.python,
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

test('the pinned nare\'s python floor is the one the core image is built on', () => {
  // One floor, two places: the image recipe pins the base python the pinned
  // nare requires, and doctor checks a host against the same floor (#204).
  const recipe = readFileSync(fileURLToPath(new URL('../../../images/core/Dockerfile', import.meta.url)), 'utf8')
  expect(recipe).toContain(`FROM python:${NARE_PYTHON_MINIMUM}-`)
})

test('a host without nare whose python is too old to install it names the python, not just nare (#204)', async () => {
  const report = await runDoctor({ probes: { ...HEALTHY_PROBES, which: () => undefined, python: OLD_PYTHON } })
  expect(report.ready).toBe(false)
  const python = report.findings.find((finding) => finding.name === 'python')
  expect(python?.required).toBe(true)
  expect(python?.ok).toBe(false)
  expect(python?.detail).toContain('3.11.16')
  expect(python?.detail).toContain(`needs python ${NARE_PYTHON_MINIMUM} or newer`)
  expect(python?.install).toContain(`Python ${NARE_PYTHON_MINIMUM} or newer`)
  expect(python?.install).toContain('actions/setup-python')
  const nare = report.findings.find((finding) => finding.name === 'nare')
  expect(nare?.install).toContain(`python ${NARE_PYTHON_MINIMUM} or newer`)
})

test('a host without nare and without python3 says python3 is missing', async () => {
  const report = await runDoctor({
    probes: { ...HEALTHY_PROBES, which: () => undefined, python: async () => ({ detail: 'python3 is not on PATH' }) },
  })
  const python = report.findings.find((finding) => finding.name === 'python')
  expect(python?.required).toBe(true)
  expect(python?.ok).toBe(false)
  expect(python?.detail).toContain('python3 is not on PATH')
})

test('a host without nare but with a new enough python can install it', async () => {
  const report = await runDoctor({ probes: { ...HEALTHY_PROBES, which: () => undefined } })
  const python = report.findings.find((finding) => finding.name === 'python')
  expect(python?.required).toBe(true)
  expect(python?.ok).toBe(true)
  expect(python?.install).toBeUndefined()
})

test('once nare is installed, the python3 on PATH is inventory and cannot fail the host', async () => {
  // nare may run under its own interpreter (pipx, a venv), so an older
  // python3 on PATH says nothing about the nare that is already there.
  const report = await runDoctor({ probes: { ...HEALTHY_PROBES, python: OLD_PYTHON } })
  expect(report.ready).toBe(true)
  const python = report.findings.find((finding) => finding.name === 'python')
  expect(python?.required).toBe(false)
  expect(python?.ok).toBe(false)
})

test('a python version is compared numerically, so 3.9 is below the floor and 3.13 above it', async () => {
  const at = async (version: string) =>
    (await runDoctor({ probes: { ...HEALTHY_PROBES, which: () => undefined, python: async () => ({ version, detail: version }) } }))
      .findings.find((finding) => finding.name === 'python')?.ok
  expect(await at('3.9.18')).toBe(false)
  expect(await at('3.13.0')).toBe(true)
  expect(await at(`${NARE_PYTHON_MINIMUM}.0`)).toBe(true)
  expect(await at('4.0.0')).toBe(true)
})
