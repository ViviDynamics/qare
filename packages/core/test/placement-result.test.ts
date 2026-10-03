import { expect, test } from 'vitest'
import { RESULT_SCHEMA_VERSION, ResultValidationError, describeRequirements, parseResult, renderComment } from '../src/index.js'

const VERSIONS = { qare: '2026.10.4', node: '24.5.0', nareContract: 1 }

const result = (extra: Record<string, unknown> = {}, environment: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: RESULT_SCHEMA_VERSION,
  verdict: 'refused',
  criteria: [{ id: 'greets', outcome: 'unverified', reason: 'refused: unmet requirement: a macos host (requires.os): this host is linux. Nothing was provisioned.' }],
  environment: { execution: 'containerised', versions: VERSIONS, ...environment },
  ...extra,
})

function resultError(input: unknown): ResultValidationError {
  try {
    parseResult(input)
  } catch (error) {
    expect(error).toBeInstanceOf(ResultValidationError)
    return error as ResultValidationError
  }
  throw new Error('expected the result to be rejected')
}

test('a result names the host kind that produced it, and what its profile required (#76)', () => {
  const loaded = parseResult(
    result({ requirements: { os: 'macos', virtualisation: true, devices: ['android'], cell: true, display: true } }, { host: { os: 'linux', arch: 'x64', virtualisation: false, runner: 'github-hosted' } }),
  )
  expect(loaded.environment?.host).toEqual({ os: 'linux', arch: 'x64', virtualisation: false, runner: 'github-hosted' })
  expect(loaded.requirements).toEqual({ os: 'macos', virtualisation: true, devices: ['android'], cell: true, display: true })
  // A run nothing placed names no runner, and a host qare has no name for is itself.
  expect(parseResult(result({}, { host: { os: 'freebsd', arch: 'arm64', virtualisation: false } })).environment?.host).toEqual({ os: 'freebsd', arch: 'arm64', virtualisation: false })
})

test('a result written before the host was recorded still loads (#76)', () => {
  const loaded = parseResult(result())
  expect(loaded.environment).toEqual({ execution: 'containerised', versions: VERSIONS })
  expect(loaded.requirements).toBeUndefined()
})

test('a host record or a requirements record that is not one is rejected by name (#76)', () => {
  expect(resultError(result({}, { host: 'linux' })).field).toBe('environment.host')
  expect(resultError(result({}, { host: { os: '', arch: 'x64', virtualisation: false } })).field).toBe('environment.host.os')
  expect(resultError(result({}, { host: { os: 'linux', virtualisation: false } })).field).toBe('environment.host.arch')
  // Both are named in a posted comment, so each is a plain name and nothing a reader's markdown would act on.
  expect(resultError(result({}, { host: { os: 'linux [x](y)', arch: 'x64', virtualisation: false } })).field).toBe('environment.host.os')
  expect(resultError(result({}, { host: { os: 'linux', arch: 'x64\n# hello', virtualisation: false } })).field).toBe('environment.host.arch')
  expect(resultError(result({}, { host: { os: 'linux', arch: 'x64', virtualisation: 'yes' } })).field).toBe('environment.host.virtualisation')
  const runner = resultError(result({}, { host: { os: 'linux', arch: 'x64', virtualisation: false, runner: 'my-farm' } }))
  expect(runner.field).toBe('environment.host.runner')
  expect(runner.message).toContain('"github-hosted" or "self-hosted"')

  expect(resultError(result({ requirements: ['macos'] })).field).toBe('requirements')
  expect(resultError(result({ requirements: { os: 'darwin' } })).field).toBe('requirements.os')
  expect(resultError(result({ requirements: { virtualisation: false } })).field).toBe('requirements.virtualisation')
  expect(resultError(result({ requirements: { devices: 'android' } })).field).toBe('requirements.devices')
  expect(resultError(result({ requirements: { devices: ['toaster'] } })).field).toBe('requirements.devices[0]')
  expect(resultError(result({ requirements: { cell: 'docker' } })).field).toBe('requirements.cell')
  expect(resultError(result({ requirements: { display: 1 } })).field).toBe('requirements.display')
  expect(resultError(result({ requirements: { gpu: true } })).field).toBe('requirements.gpu')
})

test('each app of a several-app result carries what its own profile required (#76)', () => {
  const loaded = parseResult(
    result({
      profiles: [
        { name: 'phone', verdict: 'refused', criteria: ['greets'], requirements: { devices: ['android'] } },
        { name: 'web', verdict: 'passed', criteria: [] },
      ],
    }),
  )
  expect(loaded.profiles).toEqual([
    { name: 'phone', verdict: 'refused', criteria: ['greets'], requirements: { devices: ['android'] } },
    { name: 'web', verdict: 'passed', criteria: [] },
  ])
  expect(resultError(result({ profiles: [{ name: 'phone', verdict: 'refused', criteria: [], requirements: { os: 'amiga' } }] })).field).toBe('profiles[0].requirements.os')
})

test('what a profile requires is said in words a reader of the comment can check (#76)', () => {
  expect(describeRequirements({})).toEqual([])
  expect(describeRequirements({ os: 'macos', virtualisation: true, devices: ['android'], cell: true, display: true })).toEqual([
    'a macos host',
    'hardware virtualisation',
    'an attached android device',
    'a cell the docker daemon makes for the build',
    'a display',
  ])
})

test('the comment names the host kind that produced the result and what the profile required (#76)', () => {
  const body = renderComment(
    parseResult(result({ requirements: { os: 'macos', virtualisation: true } }, { host: { os: 'linux', arch: 'x64', virtualisation: false, runner: 'github-hosted' } })),
  )
  expect(body).toContain('Executed in a container on a linux x64 host, a GitHub-hosted runner, with qare 2026.10.4, node 24.5.0, nare contract 1.')
  expect(body).toContain('The profile requires a macos host and hardware virtualisation; this host offers no hardware virtualisation.')

  // A host that has it says so, and a profile that requires nothing adds no line.
  const met = renderComment(
    parseResult({ ...result({ requirements: { os: 'linux', virtualisation: true } }, { execution: 'native', host: { os: 'linux', arch: 'arm64', virtualisation: true } }), verdict: 'refused' }),
  )
  expect(met).toContain('Executed natively on a linux arm64 host with qare 2026.10.4, node 24.5.0, nare contract 1.')
  expect(met).toContain('The profile requires a linux host and hardware virtualisation; this host offers hardware virtualisation.')
  const plain = renderComment(parseResult(result({}, { host: { os: 'linux', arch: 'x64', virtualisation: false, runner: 'self-hosted' } })))
  expect(plain).toContain('Executed in a container on a linux x64 host, a self-hosted runner, with qare 2026.10.4, node 24.5.0, nare contract 1.')
  expect(plain).not.toContain('The profile requires')

  // A result from before the host was recorded reads as it always did.
  expect(renderComment(parseResult(result()))).toContain('Executed in a container with qare 2026.10.4, node 24.5.0, nare contract 1.')
  expect(renderComment(parseResult(result({}, { execution: 'native' })))).toContain('Executed natively on a host with qare 2026.10.4, node 24.5.0, nare contract 1.')

  // In a run over several apps, each app's requirement is named beside the app.
  const several = renderComment(
    parseResult(
      result({
        profiles: [
          { name: 'phone', verdict: 'refused', criteria: ['greets'], requirements: { devices: ['android'] } },
          { name: 'web', verdict: 'passed', criteria: [] },
        ],
      }),
    ),
  )
  expect(several).toContain('`phone` requires an attached android device.')
})
