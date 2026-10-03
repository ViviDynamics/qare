import { expect, test } from 'vitest'
import { attachedAndroidDevices, detectHost, describeHost, placementProblem, requirementsOf, unmetRequirements, validateProfileConfig, type HostProbes } from '../src/index.js'

const TARGET = { target: { url: 'https://staging.example.com', health: { http: 'https://staging.example.com/up', timeout: '10s' } } }
const CLIENT = { driver: 'electron', executable: 'dist/my-app' }

const LINUX: HostProbes = { platform: 'linux', arch: 'x64', env: {}, virtualisation: () => undefined }
const NO_PROBES = {
  cell: async () => undefined,
  display: () => undefined,
}

test('the requirement table: what a profile declares, and what its shape already implies (#76)', () => {
  // The browser needs nothing of its host.
  expect(requirementsOf(validateProfileConfig(TARGET))).toEqual({})
  // What a profile declares is carried as it is written.
  expect(requirementsOf(validateProfileConfig({ ...TARGET, requires: { os: 'macos', virtualisation: true, devices: ['android'] } }))).toEqual({
    os: 'macos',
    virtualisation: true,
    devices: ['android'],
  })
  // A contained build needs a cell made for it (#223); an uncontained one opens its windows on the host (#72).
  expect(requirementsOf(validateProfileConfig({ client: CLIENT }))).toEqual({ cell: true })
  expect(requirementsOf(validateProfileConfig({ client: { ...CLIENT, egress: 'uncontained' } }))).toEqual({ display: true })
  expect(requirementsOf(validateProfileConfig({ client: { ...CLIENT, egress: 'uncontained' }, requires: { os: 'windows' } }))).toEqual({ os: 'windows', display: true })
})

test('the host kind is read from the machine: operating system, architecture, virtualisation, and the runner it is (#76)', () => {
  expect(detectHost(LINUX)).toEqual({ os: 'linux', arch: 'x64', virtualisation: true })
  expect(detectHost({ platform: 'darwin', arch: 'arm64', env: {} })).toEqual({ os: 'macos', arch: 'arm64', virtualisation: false })
  expect(detectHost({ platform: 'win32', arch: 'x64', env: {} })).toEqual({ os: 'windows', arch: 'x64', virtualisation: false })
  // A platform qare has no name for is itself, never one of the three.
  expect(detectHost({ platform: 'freebsd', arch: 'x64', env: {} }).os).toBe('freebsd')
  // A Linux host with no usable /dev/kvm offers none.
  expect(detectHost({ ...LINUX, virtualisation: () => '/dev/kvm is not there' }).virtualisation).toBe(false)
  // The runner is what GitHub Actions says, or what the pipeline handed into the run's container.
  expect(detectHost({ ...LINUX, env: { RUNNER_ENVIRONMENT: 'github-hosted' } }).runner).toBe('github-hosted')
  expect(detectHost({ ...LINUX, env: { RUNNER_ENVIRONMENT: 'self-hosted' } }).runner).toBe('self-hosted')
  expect(detectHost({ ...LINUX, env: { QARE_RUNNER_ENVIRONMENT: 'self-hosted', RUNNER_ENVIRONMENT: 'github-hosted' } }).runner).toBe('self-hosted')
  // Anything else is no runner qare knows: a run somebody started.
  expect(detectHost({ ...LINUX, env: { RUNNER_ENVIRONMENT: 'my-farm' } }).runner).toBeUndefined()
  expect(detectHost({ ...LINUX, env: { QARE_RUNNER_ENVIRONMENT: '' } }).runner).toBeUndefined()
})

test('a host is described the way the evidence names it (#76)', () => {
  expect(describeHost({ os: 'linux', arch: 'x64', virtualisation: true, runner: 'github-hosted' })).toBe('a linux x64 host, a GitHub-hosted runner')
  expect(describeHost({ os: 'macos', arch: 'arm64', virtualisation: false, runner: 'self-hosted' })).toBe('a macos arm64 host, a self-hosted runner')
  expect(describeHost({ os: 'linux', arch: 'arm64', virtualisation: false })).toBe('a linux arm64 host')
})

test('a host that meets every requirement is missing nothing (#76)', async () => {
  const host = detectHost(LINUX)
  expect(await unmetRequirements({}, host, LINUX)).toEqual([])
  expect(await unmetRequirements({ os: 'linux', virtualisation: true }, host, LINUX)).toEqual([])
  expect(await unmetRequirements({ cell: true }, host, { ...LINUX, ...NO_PROBES })).toEqual([])
  expect(await unmetRequirements({ display: true }, host, { ...LINUX, ...NO_PROBES })).toEqual([])
  expect(await unmetRequirements({ devices: ['android'] }, host, { ...LINUX, devices: async () => ({ attached: ['R58M12ABCDE'] }) })).toEqual([])
})

test('each unmet requirement is named for what is missing, and all of them are named at once (#76)', async () => {
  const host = detectHost({ ...LINUX, virtualisation: () => '/dev/kvm is not there' })
  const probes: HostProbes = {
    ...LINUX,
    virtualisation: () => '/dev/kvm is not there',
    devices: async () => ({ attached: [], detail: 'no adb is on PATH' }),
  }
  expect(await unmetRequirements({ os: 'macos' }, host, probes)).toEqual(['a macos host (requires.os): this host is linux'])
  expect(await unmetRequirements({ os: 'windows', virtualisation: true, devices: ['android'] }, host, probes)).toEqual([
    'a windows host (requires.os): this host is linux',
    'hardware virtualisation (requires.virtualisation): /dev/kvm is not there',
    'an attached android device (requires.devices): no adb is on PATH',
  ])
  // The two requirements a client profile implies keep the words their probes already had.
  expect(await unmetRequirements({ cell: true }, host, { ...probes, cell: async () => 'a client build runs contained, in a cell the docker daemon makes, and no daemon answered' })).toEqual([
    'a client build runs contained, in a cell the docker daemon makes, and no daemon answered',
  ])
  expect(await unmetRequirements({ display: true }, host, { ...probes, display: () => 'the electron driver needs a display' })).toEqual(['the electron driver needs a display'])
})

test('hardware virtualisation is detected on Linux only, and a host of another kind says so (#76)', async () => {
  const mac = detectHost({ platform: 'darwin', arch: 'arm64', env: {} })
  expect(await unmetRequirements({ os: 'macos', virtualisation: true }, mac, { platform: 'darwin', arch: 'arm64', env: {} })).toEqual([
    'hardware virtualisation (requires.virtualisation): qare detects it on Linux only (/dev/kvm), and this host is macos',
  ])
  // A macOS host meets a profile that requires macOS and nothing else.
  expect(await unmetRequirements({ os: 'macos' }, mac, { platform: 'darwin', arch: 'arm64', env: {} })).toEqual([])
})

test('attached android devices are what adb lists in the device state, emulators left out (#76)', async () => {
  const adb = (stdout: string, code = 0) => async () => ({ code, stdout })
  expect(
    await attachedAndroidDevices(adb('List of devices attached\nR58M12ABCDE\tdevice\nemulator-5554\tdevice\n0123456789\tunauthorized\nZY22ABCDEF\toffline\n\n')),
  ).toEqual({ attached: ['R58M12ABCDE'] })
  expect(await attachedAndroidDevices(adb('List of devices attached\n\n'))).toEqual({ attached: [], detail: 'adb lists no attached device in the device state' })
  // An emulator is not an attached device: it is what virtualisation is for.
  expect(await attachedAndroidDevices(adb('List of devices attached\nemulator-5554\tdevice\n'))).toEqual({
    attached: [],
    detail: 'adb lists no attached device in the device state',
  })
  expect(await attachedAndroidDevices(adb('', 127))).toEqual({ attached: [], detail: 'no adb answered (adb devices exited 127), so no attached device can be seen' })
})

test('a public repository stays on hosted runners unless its caller opts in (#76)', () => {
  const selfHosted = detectHost({ ...LINUX, env: { QARE_RUNNER_ENVIRONMENT: 'self-hosted' } })
  const hosted = detectHost({ ...LINUX, env: { QARE_RUNNER_ENVIRONMENT: 'github-hosted' } })
  const nowhere = detectHost(LINUX)

  const refused = placementProblem(selfHosted, { QARE_REPOSITORY_VISIBILITY: 'public' })
  expect(refused).toBe(
    'this repository is public and the run landed on a self-hosted runner: a public repository keeps its runs on GitHub-hosted runners, because a runner that outlives its job keeps whatever a pull request left on it; to use your own capacity anyway, opt in with the pipeline input self-hosted: allow',
  )
  // The opt in is one word, and nothing else is read as it.
  expect(placementProblem(selfHosted, { QARE_REPOSITORY_VISIBILITY: 'public', QARE_SELF_HOSTED: 'allow' })).toBeUndefined()
  expect(placementProblem(selfHosted, { QARE_REPOSITORY_VISIBILITY: 'public', QARE_SELF_HOSTED: 'true' })).toBe(refused)
  // A hosted runner, a private repository and a run nobody placed are all left alone.
  expect(placementProblem(hosted, { QARE_REPOSITORY_VISIBILITY: 'public' })).toBeUndefined()
  expect(placementProblem(selfHosted, { QARE_REPOSITORY_VISIBILITY: 'private' })).toBeUndefined()
  expect(placementProblem(selfHosted, { QARE_REPOSITORY_VISIBILITY: 'internal' })).toBeUndefined()
  expect(placementProblem(selfHosted, {})).toBeUndefined()
  expect(placementProblem(nowhere, { QARE_REPOSITORY_VISIBILITY: 'public' })).toBeUndefined()
})
