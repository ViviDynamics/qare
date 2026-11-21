import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { missingStubsFromResult, parseResult, renderComment, runJob, type BootOpts, type Job, type QaProfile } from '../src/index.js'
import { NO_EGRESS_IMAGE } from '../src/stack-egress.js'

// #382: a booted stack's egress is contained, what it looked up is read back
// in code after the checks, and a name no stub declares refuses the run.

const HEALTH_URL = ['http:', '//localhost:3000/up'].join('')
const IMAGE = 'ghcr.io/vividynamics/qare-core:2026.11.21'
const READY = '{"event":"ready","address":"192.0.2.2","port":53}'
const lookup = (host: string, declared: boolean): string => JSON.stringify({ event: 'lookup', host, declared })

const PROFILE: QaProfile = {
  app: {
    boot: { compose: 'compose.qa.yaml', service: 'web' },
    health: { http: HEALTH_URL, timeout: '120s' },
    seed: { command: 'true' },
    login: { fixture: 'fixtures/users.yml', role: 'admin' },
  },
  stubs: [{ service: 'billing', hosts: ['api.billing-vendor.example'], provided_by: { compose_service: 'billing-stub' } }],
  suites: [],
  visual: { widths: [], themes: [] },
  base: { criteria: 'all' },
}

const CONFIG = JSON.stringify({
  networks: { default: { name: 'x_default' } },
  services: { web: { networks: { default: null }, ports: [{ target: 3000, published: '3000', protocol: 'tcp' }] }, 'billing-stub': { networks: { default: null } } },
})

/**
 * A compose whose resolver says, for each project in the order the run
 * boots them, what that stack looked up. Its first log read is the boot's
 * wait for the ready line; the next is the record.
 */
function stack(records: string[][]): BootOpts & { calls: string[][] } {
  const calls: string[][] = []
  const projects: string[] = []
  return {
    calls,
    egressImage: IMAGE,
    runCompose: async (args) => {
      calls.push(args)
      const project = args[args.indexOf('-p') + 1] as string
      if (!projects.includes(project)) projects.push(project)
      if (args.includes('config')) return { code: 0, stdout: CONFIG, stderr: '' }
      if (args.includes('logs')) return { code: 0, stdout: [READY, ...(records[projects.indexOf(project)] ?? [])].join('\n'), stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    },
    probe: async () => ({ ok: true }),
    pollIntervalMs: 1,
  }
}

async function jobFor(profile: QaProfile = PROFILE): Promise<Job> {
  const repoPath = await mkdtemp(join(tmpdir(), 'qare-stack-egress-'))
  return {
    id: 'job-egress',
    repoPath,
    baseRef: 'main',
    headRef: 'HEAD',
    profile: { inline: profile },
    criteria: [{ id: 'runs', text: 'the check runs', checks: [{ kind: 'command', run: 'true' }] }],
    evidenceDir: join(repoPath, 'evidence'),
    post: 'none',
  }
}

test('a stack that looks up a name no stub declares refuses the run, and the comment lists the name (#382)', async () => {
  const job = await jobFor()
  const { result } = await runJob(job, stack([[lookup('api.billing-vendor.example', true), lookup('api.stripe.com', false)]]))
  expect(result.verdict).toBe('refused')
  // The check itself ran and passed: the refusal is the stack's, not the criterion's.
  expect(result.criteria[0]).toMatchObject({ outcome: 'proven' })
  expect(result.egress).toEqual({ containment: 'contained', declared: ['api.billing-vendor.example'], undeclared: ['api.stripe.com'] })
  // What was written is what the loader reads back.
  expect(parseResult(JSON.parse(await readFile(join(job.evidenceDir, 'result.json'), 'utf8'))).egress).toEqual(result.egress)
  const comment = renderComment(result)
  expect(comment).toContain('api.stripe.com')
  expect(comment).toContain('refused: missing stub: api.stripe.com:unknown (dns)')
  // The stub work is filed from the record, like any missing stub.
  expect(missingStubsFromResult(result)).toEqual([{ host: 'api.stripe.com', port: 'unknown', protocol: 'dns', count: 1 }])
})

test('a stack that looked up only what its stubs declare passes, and says it ran contained (#382)', async () => {
  const { result } = await runJob(await jobFor(), stack([[lookup('api.billing-vendor.example', true)]]))
  expect(result.verdict).toBe('passed')
  expect(result.egress).toEqual({ containment: 'contained', declared: ['api.billing-vendor.example'], undeclared: [] })
  expect(renderComment(result)).toContain('ran contained')
})

test('a record the run cannot read keeps the run from passing (#382)', async () => {
  const boot = stack([])
  let reads = 0
  const runCompose = boot.runCompose!
  boot.runCompose = async (args, timeoutMs, env) => {
    if (args.includes('logs') && ++reads > 1) return { code: 1, stdout: '', stderr: 'no such service' }
    return runCompose(args, timeoutMs, env)
  }
  const { result } = await runJob(await jobFor(), boot)
  expect(result.verdict).toBe('blocked')
  expect(result.egress).toMatchObject({ containment: 'contained', unread: "the stack's resolver log could not be read, so what the stack looked up is not known" })
})

test('a stack booted with no image to contain it from passes on its checks, and the result and comment say it ran uncontained (#382)', async () => {
  const { result } = await runJob(await jobFor(), { ...stack([]), egressImage: '' })
  expect(result.verdict).toBe('passed')
  expect(result.egress).toEqual({ containment: 'uncontained', reason: NO_EGRESS_IMAGE })
  expect(renderComment(result)).toContain('was not contained')
})

test('a base side whose stack looks up an undeclared name refuses the run, and its record is kept apart from the head (#382)', async () => {
  const job = await jobFor()
  const base = await mkdtemp(join(tmpdir(), 'qare-stack-egress-base-'))
  const { result } = await runJob(job, { ...stack([[lookup('telemetry.example', false)], []]), base: { repoPath: base } })
  expect(result.base).toMatchObject({ status: 'executed', egress: { containment: 'contained', undeclared: ['telemetry.example'] } })
  expect(result.egress).toEqual({ containment: 'contained', declared: [], undeclared: [] })
  expect(result.verdict).toBe('refused')
  expect(renderComment(result)).toContain('telemetry.example')
})

test('a criterion that boots its own stack is held to the stubs too (#382)', async () => {
  const job = await jobFor()
  job.criteria = [{ id: 'own', text: 'own', isolated: true, checks: [{ kind: 'command', run: 'true' }] }]
  // The run's stack first, then the criterion's.
  const { result } = await runJob(job, stack([[], [lookup('api.stripe.com', false)]]))
  expect(result.egress?.undeclared).toEqual(['api.stripe.com'])
  expect(result.verdict).toBe('refused')
})

test('the result loader holds an egress record to its shape (#382)', () => {
  const result = (egress: unknown): unknown => ({ schemaVersion: '1', verdict: 'passed', criteria: [], egress })
  expect(() => parseResult(result({ containment: 'leaky' }))).toThrow(/unknown containment/)
  expect(() => parseResult(result({ containment: 'uncontained' }))).toThrow(/reason/)
  expect(() => parseResult(result({ containment: 'uncontained', reason: 'x', undeclared: ['a.example'] }))).toThrow(/records no names/)
  expect(() => parseResult(result({ containment: 'contained', undeclared: 'a.example' }))).toThrow(/array of host names/)
  expect(parseResult(result({ containment: 'contained', declared: [], undeclared: ['a.example'], capped: true })).egress).toEqual({ containment: 'contained', declared: [], undeclared: ['a.example'], capped: true })
})

test('a run against a target says its egress was not contained by the run (#382)', () => {
  const comment = renderComment({ schemaVersion: '1', verdict: 'passed', criteria: [], target: { url: ['https:', '//staging.example'].join(''), comparison: 'none' } })
  expect(comment).toContain('The target is not a stack this run booted, so its own egress was not contained by the run.')
})
