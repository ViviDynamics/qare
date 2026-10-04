import { readFileSync } from 'node:fs'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
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
  // nare is installed in the runtime stage, the last FROM, so that is the one
  // held to the floor; the builder stage alone could not satisfy this.
  const stages = recipe.split('\n').filter((line) => line.startsWith('FROM '))
  expect(stages.at(-1)).toMatch(new RegExp(`^FROM python:${NARE_PYTHON_MINIMUM.replace('.', '\\.')}-`))
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

// The real docker probe, run against a fake `docker` that is the only thing on
// PATH. The tests above fake `dockerInfo`, so they never reach the probe (#206).
const REAL_PATH = process.env.PATH

afterEach(() => {
  process.env.PATH = REAL_PATH
})

async function dockerFindingWith(script: string | undefined) {
  const dir = await mkdtemp(join(tmpdir(), 'qare-doctor-docker-'))
  if (script !== undefined) {
    await writeFile(join(dir, 'docker'), script, 'utf8')
    await chmod(join(dir, 'docker'), 0o755)
  }
  process.env.PATH = dir
  // Every probe but dockerInfo is faked, so the docker one is the real one.
  const report = await runDoctor({
    probes: { which: HEALTHY_PROBES.which, chromium: HEALTHY_PROBES.chromium, python: HEALTHY_PROBES.python },
  })
  return report.findings.find((finding) => finding.name === 'docker')
}

test('a docker daemon that answers docker info is reported reachable (#206)', async () => {
  const docker = await dockerFindingWith('#!/bin/sh\necho "server 27.0"\n')
  expect(docker?.ok).toBe(true)
  expect(docker?.detail).toBe('docker daemon reachable (server 27.0)')
  expect(docker?.install).toBeUndefined()
})

test('a docker whose daemon does not answer is reported not reachable', async () => {
  const docker = await dockerFindingWith('#!/bin/sh\necho "Cannot connect to the Docker daemon" >&2\nexit 1\n')
  expect(docker?.ok).toBe(false)
  expect(docker?.detail).toBe('docker daemon not reachable')
  expect(docker?.install).toContain('Docker')
})

test('a host with no docker on PATH is reported not reachable', async () => {
  const docker = await dockerFindingWith(undefined)
  expect(docker?.ok).toBe(false)
  expect(docker?.detail).toBe('docker daemon not reachable')
})

test('a profile that launches a desktop build on the host requires a display, and says how to get one (#72)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-doctor-client-'))
  await writeFile(join(dir, 'QA.md'), '# QA\n')
  await writeFile(join(dir, 'config.yml'), 'client:\n  driver: electron\n  executable: dist/app/app\n  egress: uncontained\n')

  const problem = 'the electron driver needs a display, and neither DISPLAY nor WAYLAND_DISPLAY is set'
  const dark = await runDoctor({ profilePath: dir, probes: { ...HEALTHY_PROBES, display: () => problem } })
  const display = dark.findings.find((finding) => finding.name === 'display')
  expect(dark.ready).toBe(false)
  expect(display).toMatchObject({ ok: false, required: true })
  expect(display?.detail).toContain('this profile launches a desktop build')
  expect(display?.install).toContain('Xvfb')
  // The browser is not what this profile drives, and nothing boots.
  expect(dark.findings.find((finding) => finding.name === 'chromium')?.required).toBe(false)
  expect(dark.findings.find((finding) => finding.name === 'docker')?.required).toBe(false)

  const lit = await runDoctor({ profilePath: dir, probes: { ...HEALTHY_PROBES, display: () => undefined } })
  expect(lit.ready).toBe(true)
  expect(lit.findings.find((finding) => finding.name === 'display')).toMatchObject({
    ok: true,
    required: true,
    detail: 'a display is available for the electron driver',
  })
  // Nothing is installed for a build launched in place, so nothing unpacks.
  expect(lit.findings.find((finding) => finding.name === 'tar')).toBeUndefined()
})

test('a profile that installs an archive requires tar, and one that installs a directory does not (#75)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-doctor-artefact-'))
  await writeFile(join(dir, 'QA.md'), '# QA\n')
  const config = (kind: string): string =>
    ['client:', '  driver: electron', '  artefact:', `    kind: ${kind}`, '    executable: greeter/greeter', '    head: { path: artefacts/head }'].join('\n')
  await writeFile(join(dir, 'config.yml'), config('archive'))
  const probes = { ...HEALTHY_PROBES, display: () => undefined, host: { cell: async () => undefined } }

  const bare = await runDoctor({ profilePath: dir, probes: { ...probes, which: (name: string) => (name === 'tar' ? undefined : `/usr/local/bin/${name}`) } })
  const tar = bare.findings.find((finding) => finding.name === 'tar')
  expect(bare.ready).toBe(false)
  expect(tar).toMatchObject({ ok: false, required: true })
  expect(tar?.detail).toContain('this profile installs an archive (client.artefact.kind), which is unpacked with tar')
  expect(tar?.install).toContain('install tar')

  const equipped = await runDoctor({ profilePath: dir, probes })
  expect(equipped.ready).toBe(true)
  expect(equipped.findings.find((finding) => finding.name === 'tar')).toMatchObject({ ok: true, required: true, detail: 'tar at /usr/local/bin/tar' })

  await writeFile(join(dir, 'config.yml'), config('directory'))
  const copied = await runDoctor({ profilePath: dir, probes })
  expect(copied.findings.find((finding) => finding.name === 'tar')).toBeUndefined()
})

const LINUX_HOST = { platform: 'linux', arch: 'x64', env: {}, virtualisation: () => '/dev/kvm is not there, so this host offers no hardware virtualisation' }

async function profileDir(config: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-doctor-requires-'))
  await writeFile(join(dir, 'QA.md'), '# QA\n')
  await writeFile(join(dir, 'config.yml'), config)
  return dir
}

const TARGET_CONFIG = ['target:', `  url: ${['https:', '//app.example.test'].join('')}`, '  health: { http: /up, timeout: 5s }'].join('\n')

test('the host kind is reported, and a profile that requires nothing of it requires nothing (#76)', async () => {
  const report = await runDoctor({ probes: { ...HEALTHY_PROBES, host: { ...LINUX_HOST, env: { RUNNER_ENVIRONMENT: 'github-hosted' } } } })
  expect(report.host).toEqual({ os: 'linux', arch: 'x64', virtualisation: false, runner: 'github-hosted' })
  expect(report.findings.find((finding) => finding.name === 'host')).toEqual({
    name: 'host',
    ok: true,
    required: false,
    detail: 'a linux x64 host, a GitHub-hosted runner; hardware virtualisation is not usable (/dev/kvm is not there, so this host offers no hardware virtualisation)',
  })
  for (const name of ['os', 'virtualisation', 'cell']) expect(report.findings.find((finding) => finding.name === name), name).toBeUndefined()
  expect(report.ready).toBe(true)
})

test('what a profile requires of the host is held to it: operating system, virtualisation, attached devices (#76)', async () => {
  const dir = await profileDir(`${TARGET_CONFIG}\nrequires:\n  os: macos\n  virtualisation: true\n  devices: [android]\n`)
  const short = await runDoctor({
    profilePath: dir,
    probes: { ...HEALTHY_PROBES, host: { ...LINUX_HOST, devices: async () => ({ attached: [], detail: 'adb lists no attached device in the device state' }) } },
  })
  expect(short.ready).toBe(false)
  const byName = new Map(short.findings.map((finding) => [finding.name, finding]))
  expect(byName.get('os')).toEqual({
    name: 'os',
    ok: false,
    required: true,
    detail: 'this profile requires a macos host (requires.os): this host is linux',
    install: 'run it on a macos host: an operating system is not something to install',
  })
  expect(byName.get('virtualisation')).toMatchObject({
    ok: false,
    required: true,
    detail: 'this profile requires hardware virtualisation (requires.virtualisation): /dev/kvm is not there, so this host offers no hardware virtualisation',
  })
  expect(byName.get('virtualisation')?.install).toContain('/dev/kvm')
  expect(byName.get('devices')).toMatchObject({
    ok: false,
    required: true,
    detail: 'this profile requires an attached android device (requires.devices): adb lists no attached device in the device state',
  })
  expect(byName.get('devices')?.install).toContain('adb')

  const mac = await runDoctor({
    profilePath: dir,
    probes: { ...HEALTHY_PROBES, host: { platform: 'darwin', arch: 'arm64', env: {}, devices: async () => ({ attached: ['R58M12ABCDE'] }) } },
  })
  const onMac = new Map(mac.findings.map((finding) => [finding.name, finding]))
  expect(onMac.get('os')).toEqual({ name: 'os', ok: true, required: true, detail: 'this host is macos, which the profile requires' })
  expect(onMac.get('devices')).toEqual({ name: 'devices', ok: true, required: true, detail: 'an attached android device is there, which the profile requires' })
  // Virtualisation is detected on Linux only, and a macOS host is told so.
  expect(onMac.get('virtualisation')?.detail).toBe(
    'this profile requires hardware virtualisation (requires.virtualisation): qare detects it on Linux only (/dev/kvm), and this host is macos',
  )
  expect(mac.ready).toBe(false)
})

test('a contained client build requires a cell of the host, not a display (#223, #76)', async () => {
  const dir = await profileDir('client:\n  driver: electron\n  executable: dist/app/app\n')
  const problem = 'a contained build or command runs in a cell the docker daemon makes, and no daemon answered (docker exited 127)'
  const bare = await runDoctor({
    profilePath: dir,
    probes: {
      ...HEALTHY_PROBES,
      display: () => {
        throw new Error('a contained build was asked about a display')
      },
      host: { ...LINUX_HOST, cell: async () => problem },
    },
  })
  expect(bare.ready).toBe(false)
  expect(bare.findings.find((finding) => finding.name === 'cell')).toEqual({
    name: 'cell',
    ok: false,
    required: true,
    detail: problem,
    install: 'run it where a docker daemon holds the qare image the run is in (the pipeline does), or say client.egress: uncontained in the profile',
  })
  // Its windows open on the cell's display, so this host's is not required.
  expect(bare.findings.find((finding) => finding.name === 'display')).toMatchObject({ ok: true, required: false })

  const able = await runDoctor({ profilePath: dir, probes: { ...HEALTHY_PROBES, host: { ...LINUX_HOST, cell: async () => undefined } } })
  expect(able.ready).toBe(true)
  expect(able.findings.find((finding) => finding.name === 'cell')).toEqual({ name: 'cell', ok: true, required: true, detail: 'this host can make a cell for the build' })
})
