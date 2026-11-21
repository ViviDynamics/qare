import { readFile, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { NO_EGRESS_IMAGE } from '../src/stack-egress.js'
import { loadResult, runJob, type BootOpts, type Job, type JobCriterion, type QaProfile } from '../src/index.js'
import type { RunDocker } from '../src/base-image.js'

// #381: the base side runs the profile's prebuilt image in place of its
// build, when the image shows it is the base commit's, and the result says
// which image the base side used.

const HEALTH_URL = ['http:', '//localhost:3000/up'].join('')
const BASE_SHA = 'a'.repeat(40)
const IMAGE_DIGEST = `ghcr.io/acme/app@sha256:${'c'.repeat(64)}`

const PROFILE: QaProfile = {
  app: {
    boot: { compose: 'compose.qa.yaml', service: 'admin' },
    health: { http: HEALTH_URL, timeout: '120s' },
    seed: { command: 'true' },
    login: { fixture: 'fixtures/users.yml', role: 'admin' },
  },
  stubs: [],
  visual: { widths: [], themes: [] },
  suites: [],
  base: { criteria: 'all', image: 'ghcr.io/acme/app:{base}' },
}

function seams(revision: string | undefined): BootOpts & { calls: string[][]; docker: string[][]; runDocker: RunDocker } {
  const calls: string[][] = []
  const docker: string[][] = []
  return {
    calls,
    docker,
    runCompose: async (args) => {
      calls.push(args)
      return { code: 0, stdout: '', stderr: '' }
    },
    runDocker: async (args) => {
      docker.push(args)
      if (args[0] === 'pull') return { code: 0, stdout: '', stderr: '' }
      return { code: 0, stdout: JSON.stringify([{ RepoDigests: [IMAGE_DIGEST], Config: { Labels: revision === undefined ? {} : { 'org.opencontainers.image.revision': revision } } }]), stderr: '' }
    },
    probe: async () => ({ ok: true }),
    pollIntervalMs: 1,
  }
}

const check: JobCriterion = { id: 'kept', text: 'old.txt is there', checks: [{ kind: 'command', run: 'test -f old.txt' }] }

async function trees(): Promise<{ head: string; base: string }> {
  const head = await mkdtemp(join(tmpdir(), 'qare-head-'))
  const base = await mkdtemp(join(tmpdir(), 'qare-base-'))
  for (const dir of [head, base]) await writeFile(join(dir, 'old.txt'), 'here\n')
  return { head, base }
}

function jobFor(repoPath: string, profile: QaProfile = PROFILE, baseRef = BASE_SHA): Job {
  return { id: 'job-base-image', repoPath, baseRef, headRef: 'b'.repeat(40), profile: { inline: profile }, criteria: [check], evidenceDir: join(repoPath, 'evidence'), post: 'none' }
}

test('the base side runs the image built from the base commit, and the result names it (#381)', async () => {
  const { head, base } = await trees()
  const boot = seams(BASE_SHA)
  const job = jobFor(head)
  const { result } = await runJob(job, { ...boot, base: { repoPath: base } })

  expect(result.base).toEqual({
    ref: BASE_SHA,
    status: 'executed',
    images: [{ ref: `ghcr.io/acme/app:${BASE_SHA}`, used: true, digest: IMAGE_DIGEST, revision: BASE_SHA }],
    egress: { containment: 'uncontained', reason: NO_EGRESS_IMAGE },
  })
  expect(boot.docker[0]).toEqual(['pull', '--', `ghcr.io/acme/app:${BASE_SHA}`])
  // The base boots with the override that runs the image; the head builds as before.
  const ups = boot.calls.filter((args) => args.includes('up'))
  expect(ups).toHaveLength(2)
  expect(ups[0]?.filter((arg) => arg.endsWith('.base-image.yml'))).toHaveLength(1)
  expect(ups[1]?.some((arg) => arg.endsWith('.base-image.yml'))).toBe(false)
  // result.json on disk says the same.
  expect(loadResult(await readFile(join(job.evidenceDir, 'result.json'), 'utf8')).base).toEqual(result.base)
})

test('an image built from another commit is not used: the base is built, and the result says why (#381)', async () => {
  const { head, base } = await trees()
  const boot = seams('d'.repeat(40))
  const { result } = await runJob(jobFor(head), { ...boot, base: { repoPath: base } })
  expect(result.base?.status).toBe('executed')
  expect(result.base?.images?.[0]).toMatchObject({ used: false, revision: 'd'.repeat(40) })
  expect(result.base?.images?.[0]?.reason).toContain(`not the base commit ${BASE_SHA}`)
  expect(boot.calls.some((args) => args.some((arg) => arg.endsWith('.base-image.yml')))).toBe(false)
  // The criterion is still compared with the base that was built.
  expect(result.criteria[0]).toMatchObject({ outcome: 'proven', base: { outcome: 'proven' } })
})

test('a profile that names no base image pulls nothing, and the result names no image (#381)', async () => {
  const { head, base } = await trees()
  const boot = seams(BASE_SHA)
  const { result } = await runJob(jobFor(head, { ...PROFILE, base: { criteria: 'all' } }), { ...boot, base: { repoPath: base } })
  expect(boot.docker).toEqual([])
  expect(result.base).toEqual({ ref: BASE_SHA, status: 'executed', egress: { containment: 'uncontained', reason: NO_EGRESS_IMAGE } })
})

test('a base ref that is not a commit id leaves the commit unknown, and nothing stands in for the base (#381)', async () => {
  const { head, base } = await trees()
  const boot = seams(BASE_SHA)
  const { result } = await runJob(jobFor(head, PROFILE, 'origin/main'), { ...boot, base: { repoPath: base } })
  expect(boot.docker).toEqual([])
  expect(result.base?.images?.[0]).toMatchObject({ ref: 'ghcr.io/acme/app:{base}', used: false })
  expect(result.base?.images?.[0]?.reason).toMatch(/^the base commit is not known/)
})

test('a result that says an image was not used must say why (#381)', () => {
  const result = (images: unknown) => JSON.stringify({ schemaVersion: '1', verdict: 'passed', criteria: [], base: { ref: BASE_SHA, status: 'executed', images } })
  expect(loadResult(result([{ ref: 'r', used: true, digest: IMAGE_DIGEST }])).base?.images).toEqual([{ ref: 'r', used: true, digest: IMAGE_DIGEST }])
  expect(() => loadResult(result([{ ref: 'r', used: false }]))).toThrow(/base\.images\[0\]\.reason/)
  expect(() => loadResult(result([{ ref: 'r', used: 'yes' }]))).toThrow(/base\.images\[0\]\.used/)
  expect(() => loadResult(result('r'))).toThrow(/base\.images/)
})
