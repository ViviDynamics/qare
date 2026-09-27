import { expect, test } from 'vitest'
import { detectExecution, runEnvironment } from '../src/environment.js'
import { NARE_CONTRACT } from '../src/runner.js'
import { VERSION } from '../src/version.js'

test('a containerised run is claimed only by evidence the image controls', () => {
  expect(detectExecution({ QARE_CONTAINER: '1' }, '/no/such/file')).toBe('containerised')
  expect(detectExecution({ QARE_CONTAINER: '0' }, '/no/such/file')).toBe('native')
  expect(detectExecution({}, '/no/such/file')).toBe('native')
})

test('the container root file marks the run containerised without any flag', () => {
  // A directory stands in for /.dockerenv: the probe is existsSync, so any
  // path that exists proves the claim.
  expect(detectExecution({}, '.')).toBe('containerised')
})

test('the environment record names the versions the run executed with', () => {
  expect(runEnvironment('native')).toEqual({
    execution: 'native',
    versions: { qare: VERSION, node: process.versions.node, nareContract: NARE_CONTRACT },
  })
  expect(runEnvironment('containerised').execution).toBe('containerised')
})
