import { expect, test } from 'vitest'
import { baseImageRef, resolveBaseImage, type RunDocker } from '../src/base-image.js'

// #381: a profile can name a prebuilt image for the base side. The run pulls
// it and uses it only when the image says it was built from the base commit;
// anything else leaves the base to be built from the base tree, as before,
// and the record says why.

const BASE = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const DIGEST = `ghcr.io/acme/app@sha256:${'c'.repeat(64)}`

function docker(opts: { pull?: number; inspect?: unknown; inspectCode?: number }): { run: RunDocker; calls: string[][] } {
  const calls: string[][] = []
  const run: RunDocker = async (args) => {
    calls.push(args)
    if (args[0] === 'pull') return { code: opts.pull ?? 0, stdout: '', stderr: opts.pull ? 'Error response from daemon: manifest unknown\n' : '' }
    if (args[0] === 'image' && args[1] === 'inspect') return { code: opts.inspectCode ?? 0, stdout: JSON.stringify(opts.inspect ?? []), stderr: '' }
    return { code: 125, stdout: '', stderr: `unexpected ${args.join(' ')}` }
  }
  return { run, calls }
}

const labelled = (revision: string | undefined) => [{ RepoDigests: [DIGEST], Config: { Labels: revision === undefined ? {} : { 'org.opencontainers.image.revision': revision } } }]

test('{base} in the reference is the full base commit, and only that is replaced (#381)', () => {
  expect(baseImageRef('ghcr.io/acme/app:{base}', BASE)).toBe(`ghcr.io/acme/app:${BASE}`)
  expect(baseImageRef('ghcr.io/acme/app:main', BASE)).toBe('ghcr.io/acme/app:main')
})

test('an image whose revision label is the base commit is used, by the digest it pulled (#381)', async () => {
  const { run, calls } = docker({ inspect: labelled(BASE) })
  const record = await resolveBaseImage('ghcr.io/acme/app:{base}', BASE, run)
  expect(record).toEqual({ ref: `ghcr.io/acme/app:${BASE}`, used: true, digest: DIGEST, revision: BASE })
  expect(calls).toEqual([
    ['pull', '--', `ghcr.io/acme/app:${BASE}`],
    ['image', 'inspect', '--', `ghcr.io/acme/app:${BASE}`],
  ])
})

test('an image built from another commit is not used, and the record names both commits (#381)', async () => {
  const record = await resolveBaseImage('ghcr.io/acme/app:main', BASE, docker({ inspect: labelled(OTHER) }).run)
  expect(record).toEqual({
    ref: 'ghcr.io/acme/app:main',
    used: false,
    digest: DIGEST,
    revision: OTHER,
    reason: `the image says it was built from ${OTHER}, not the base commit ${BASE}, so the base side was built from the base tree`,
  })
})

test('an image with no revision label cannot show it is the base, so it is not used (#381)', async () => {
  const record = await resolveBaseImage('ghcr.io/acme/app:main', BASE, docker({ inspect: labelled(undefined) }).run)
  expect(record.used).toBe(false)
  expect(record.reason).toBe('the image carries no org.opencontainers.image.revision label, so it cannot show it was built from the base commit; the base side was built from the base tree')
})

test('an image that will not pull, or cannot be read, is not used, and the run goes on (#381)', async () => {
  const unpulled = await resolveBaseImage('ghcr.io/acme/app:{base}', BASE, docker({ pull: 1 }).run)
  expect(unpulled).toEqual({
    ref: `ghcr.io/acme/app:${BASE}`,
    used: false,
    reason: 'the image could not be pulled (docker pull exited 1: Error response from daemon: manifest unknown), so the base side was built from the base tree',
  })
  const unread = await resolveBaseImage('ghcr.io/acme/app:main', BASE, docker({ inspect: 'not json', inspectCode: 0 }).run)
  expect(unread.used).toBe(false)
  expect(unread.reason).toMatch(/^the pulled image could not be inspected/)
  const thrown = await resolveBaseImage('ghcr.io/acme/app:main', BASE, async () => {
    throw new Error('spawn docker ENOENT')
  })
  expect(thrown).toEqual({ ref: 'ghcr.io/acme/app:main', used: false, reason: 'the image could not be pulled (Error: spawn docker ENOENT), so the base side was built from the base tree' })
})

test('with no known base commit nothing is pulled, and nothing stands in for the base (#381)', async () => {
  const { run, calls } = docker({ inspect: labelled(BASE) })
  const record = await resolveBaseImage('ghcr.io/acme/app:{base}', undefined, run)
  expect(record).toEqual({ ref: 'ghcr.io/acme/app:{base}', used: false, reason: 'the base commit is not known, so no image can be shown to be built from it; the base side was built from the base tree' })
  expect(calls).toEqual([])
})
