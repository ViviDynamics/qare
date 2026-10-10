import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { detectExecution, readRunImage, runEnvironment } from '../src/environment.js'
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

test('a run without an image environment has no image record', () => {
  expect(readRunImage({}, '/no/such/file')).toBeUndefined()
  expect(runEnvironment('containerised', {})).not.toHaveProperty('image')
})

test('a native run reports no image record even with an image environment', () => {
  const env = { QARE_IMAGE_REF: 'ghcr.io/vividynamics/qare-core:2026.9.0', QARE_IMAGE_DIGEST: 'ghcr.io/vividynamics/qare-core@sha256:abc' }
  expect(runEnvironment('native', env)).not.toHaveProperty('image')
})

test('the image record names the ref, digest, flavour and versions that produced the run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qare-image-'))
  const imageFile = join(dir, 'IMAGE.json')
  writeFileSync(imageFile, JSON.stringify({ name: 'qare-core', flavour: 'core', qare: '2026.9.0', nare: '2026.9.10', node: '22.23.3', drivers: {} }))
  const env = {
    QARE_IMAGE_REF: 'ghcr.io/vividynamics/qare-core:2026.9.0',
    QARE_IMAGE_DIGEST: 'ghcr.io/vividynamics/qare-core@sha256:abc123',
  }
  const image = readRunImage(env, imageFile)
  expect(image).toEqual({
    name: 'ghcr.io/vividynamics/qare-core',
    ref: 'ghcr.io/vividynamics/qare-core:2026.9.0',
    digest: 'ghcr.io/vividynamics/qare-core@sha256:abc123',
    versions: { qare: '2026.9.0', nare: '2026.9.10', node: '22.23.3' },
  })
})

test('the flavour and driver versions travel in the environment the image sets', () => {
  const env = {
    QARE_IMAGE_REF: 'ghcr.io/vividynamics/qare-web:2026.9.0',
    QARE_IMAGE_DIGEST: 'ghcr.io/vividynamics/qare-web@sha256:def456',
    QARE_FLAVOUR: 'web',
    QARE_DRIVER_VERSIONS: 'chromium=1.63.0',
  }
  const image = readRunImage(env, '/no/such/file')
  expect(image).toEqual({
    name: 'ghcr.io/vividynamics/qare-web',
    ref: 'ghcr.io/vividynamics/qare-web:2026.9.0',
    digest: 'ghcr.io/vividynamics/qare-web@sha256:def456',
    flavour: 'web',
    drivers: { chromium: '1.63.0' },
    versions: { qare: VERSION, nare: String(NARE_CONTRACT), node: process.versions.node },
  })
})

test('an image ref without a digest refuses to write an unnamed record', () => {
  expect(() => readRunImage({ QARE_IMAGE_TAG: 'tag', QARE_IMAGE_DIGEST: 'digest' }, '/no/such/file')).toThrow(/must be set together/)
  expect(() => readRunImage({ QARE_IMAGE_REF: 'ghcr.io/vividynamics/qare-core:2026.9.0' }, '/no/such/file'))
    .toThrow(/QARE_IMAGE_REF and QARE_IMAGE_DIGEST must be set together/)
  expect(() => readRunImage({ QARE_IMAGE_DIGEST: 'ghcr.io/vividynamics/qare-core@sha256:abc' }, '/no/such/file'))
    .toThrow(/QARE_IMAGE_REF and QARE_IMAGE_DIGEST must be set together/)
})


test('an immutable operational image keeps the release tag only in evidence', () => {
  const tag = 'ghcr.io/vividynamics/qare-web:2026.10.51'
  const digest = `ghcr.io/vividynamics/qare-web@sha256:${'a'.repeat(64)}`
  expect(readRunImage({ QARE_IMAGE_REF: digest, QARE_IMAGE_TAG: tag, QARE_IMAGE_DIGEST: digest }, '/no/such/file')).toMatchObject({ ref: tag, digest })
  // Local callers without a separate tag retain their existing image record.
  expect(readRunImage({ QARE_IMAGE_REF: digest, QARE_IMAGE_DIGEST: digest }, '/no/such/file')).toMatchObject({ ref: digest, digest })
})
