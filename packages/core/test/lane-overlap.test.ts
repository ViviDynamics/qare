import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { runJob, type Job, type JobCriterion, type QaProfile } from '../src/index.js'

// #278: with the default of one worker, a criterion with a mail check still
// ran beside another criterion on the one booted app, because the sequential
// lane was started alongside the shared lane. On a consumer's run each
// criterion's suite truncated the database under the other, and two true
// criteria came back failed.

const HEALTH_URL = ['http:', '//localhost:3000/up'].join('')
const PROFILE: QaProfile = {
  app: {
    boot: { compose: 'compose.qa.yaml', service: 'web' },
    health: { http: HEALTH_URL, timeout: '120s' },
    seed: { command: 'true' },
    login: { fixture: 'fixtures/users.yml', role: 'admin' },
  },
  stubs: [],
  suites: [],
  visual: { widths: [], themes: [] },
}
const BOOT = { runCompose: async () => ({ code: 0, stdout: '', stderr: '' }), probe: async () => ({ ok: true }), pollIntervalMs: 1 }

// Each criterion's command marks when it starts and when it ends, with time
// between the two for a neighbour to start in if anything lets it.
const MARK = [
  "const { appendFileSync } = require('node:fs')",
  "const name = process.argv[2]",
  "appendFileSync('marks.log', 'start ' + name + '\\n')",
  "setTimeout(() => appendFileSync('marks.log', 'end ' + name + '\\n'), 250)",
].join('\n')

/** A criterion on the shared app that nothing keeps out of a worker. */
const shared = (name: string): JobCriterion => ({ id: name, text: `criterion ${name}`, checks: [{ kind: 'command', run: `node mark.cjs ${name}` }] })
/** A criterion with a mail check: it keeps plan order, on the shared app. */
const withMail = (name: string): JobCriterion => ({
  id: name,
  text: `criterion ${name}`,
  checks: [
    { kind: 'command', run: `node mark.cjs ${name}` },
    { kind: 'mail', address: '{{run.mail_address}}', subject: 'Welcome', timeoutMs: 20 },
  ],
})
/** A criterion that declares it mutates shared state: an app of its own. */
const isolated = (name: string): JobCriterion => ({ ...shared(name), isolated: true })

async function jobOf(criteria: JobCriterion[]): Promise<Job> {
  const repoPath = await mkdtemp(join(tmpdir(), 'qare-lane-overlap-'))
  await writeFile(join(repoPath, 'mark.cjs'), MARK)
  return { id: 'job-lane-overlap', repoPath, baseRef: 'main', headRef: 'HEAD~1', profile: { inline: PROFILE }, criteria, evidenceDir: join(repoPath, 'evidence'), post: 'none' }
}

async function marks(job: Job): Promise<string[]> {
  return (await readFile(join(job.repoPath, 'marks.log'), 'utf8')).split('\n').filter((line) => line !== '')
}

/** The pairs of criteria that were in flight at the same time, from the marks. */
function overlaps(log: string[]): string[] {
  const open = new Set<string>()
  const pairs = new Set<string>()
  for (const line of log) {
    const [what, name] = line.split(' ') as [string, string]
    if (what === 'start') {
      for (const other of open) pairs.add([other, name].sort().join('+'))
      open.add(name)
    } else open.delete(name)
  }
  return [...pairs].sort()
}

test('with one worker, the default, a run executes one criterion at a time, in plan order, whatever lane each is in', async () => {
  const job = await jobOf([withMail('a'), shared('b'), isolated('c'), shared('d'), withMail('e')])

  const { result } = await runJob(job, BOOT)

  const log = await marks(job)
  expect(overlaps(log)).toEqual([])
  expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c', 'start d', 'end d', 'start e', 'end e'])
  expect(result.criteria.map((criterion) => criterion.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
})

test('one worker asked for by name is the same run', async () => {
  const job = await jobOf([shared('a'), withMail('b'), shared('c')])

  await runJob(job, { ...BOOT, workers: 1 })

  expect(await marks(job)).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
})

test('with more workers, a criterion that keeps plan order on the shared app never runs beside a shared criterion', async () => {
  const job = await jobOf([withMail('m1'), shared('s1'), shared('s2'), withMail('m2'), shared('s3'), shared('s4')])

  const { result } = await runJob(job, { ...BOOT, workers: 2 })

  const log = await marks(job)
  const together = overlaps(log)
  // The workers may run their criteria side by side: that is what more workers asks for.
  for (const pair of together) expect(pair, 'a mail criterion ran beside another criterion on the shared app').toMatch(/^s\d\+s\d$/)
  // The criteria that hand mail on keep plan order between themselves.
  expect(log.indexOf('end m1')).toBeLessThan(log.indexOf('start m2'))
  // And the results read as a serial run's do.
  expect(result.criteria.map((criterion) => criterion.id)).toEqual(['m1', 's1', 's2', 'm2', 's3', 's4'])
})

test('with more workers, the criteria that keep plan order still run one at a time, an app of their own or not', async () => {
  const job = await jobOf([isolated('i1'), withMail('m1'), isolated('i2'), shared('s1'), shared('s2')])

  const { result } = await runJob(job, { ...BOOT, workers: 2 })

  const log = await marks(job)
  const sequential = log.filter((line) => /^(start|end) [im]\d$/.test(line))
  expect(sequential).toEqual(['start i1', 'end i1', 'start m1', 'end m1', 'start i2', 'end i2'])
  for (const pair of overlaps(log)) expect(pair).not.toMatch(/m1/)
  expect(result.criteria.map((criterion) => criterion.id)).toEqual(['i1', 'm1', 'i2', 's1', 's2'])
})
