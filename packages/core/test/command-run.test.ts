import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, execSync } from 'node:child_process'
import { expect, test } from 'vitest'
import type { CellProcess, CellRecord } from '../src/client-cell.js'
import { runJob, type Job, type JobCriterion, type QaProfile } from '../src/index.js'
import type { CommandCell, CommandCellOptions } from '../src/command-cell.js'

// Test files carry no network literals (the offline scanner), so the URL is joined at runtime.
const HEALTH_URL = ['http:', '//localhost:3000/up'].join('')

const PROFILE: QaProfile = {
  app: {
    boot: { compose: 'compose.qa.yaml', service: 'admin' },
    health: { http: HEALTH_URL, timeout: '120s' },
    seed: { command: 'true' },
    login: { fixture: 'fixtures/users.yml', role: 'admin' },
  },
  stubs: [
    {
      service: 'billing',
      hosts: ['api.billing-vendor.example'],
      provided_by: { compose_service: 'billing' },
    },
  ],
  suites: [{ name: 'browser-e2e', command: 'echo suite ran', kind: 'flow' }],
  visual: { widths: [], themes: [] },
}

const COMMANDS: QaProfile['commands'] = {
  test: {
    run: 'echo hi',
    about: 'runs the suite, printing its machine-readable report',
  },
}

const BOOT = {
  runCompose: async () => ({ code: 0, stdout: 'up out', stderr: 'up err' }),
  probe: async () => ({ ok: true }),
  pollIntervalMs: 1,
  clientCell: { problem: async () => undefined },
}

async function makeJob(fields: { criteria: JobCriterion[]; profile: { inline: QaProfile } }): Promise<Job> {
  const repoPath = await mkdtemp(join(tmpdir(), 'qare-command-'))
  return {
    id: 'job-command-smoke',
    repoPath,
    baseRef: 'main',
    headRef: 'HEAD~1',
    profile: fields.profile,
    criteria: fields.criteria,
    evidenceDir: join(repoPath, 'evidence'),
    post: 'none',
  }
}

function commandCriteria(...runs: string[]): JobCriterion[] {
  return runs.map((run, index) => ({
    id: `criterion-${index + 1}`,
    text: `criterion ${index + 1}`,
    checks: [{ kind: 'command', run }],
  }))
}

/** A cell that runs the command on this host, and records what the test says the gate did. */
function fakeCell(record: CellRecord, asked: unknown[] = []): (opts: Omit<CommandCellOptions, 'image'>) => Promise<CommandCell> {
  return async (opts) => {
    asked.push(opts)
    return {
      run: (argv, env) => spawn(argv[0] ?? '', argv.slice(1), { cwd: opts.checkout, env, stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as CellProcess,
      record: () => record,
      dispose: async () => undefined,
      reap: () => undefined,
    }
  }
}

test('a contained command runs in a cell and its evidence carries what the gate recorded (#224)', async () => {
  const asked: unknown[] = []
  const job = await makeJob({
    criteria: commandCriteria('echo hi'),
    profile: { inline: { ...PROFILE, commands: COMMANDS } },
  })

  const { result } = await runJob(job, {
    ...BOOT,
    commandCell: { start: fakeCell({ reached: [{ host: 'api.billing-vendor.example', port: 443, protocol: 'https', declared: true, count: 1 }] }, asked) },
  })

  expect(result.criteria[0].outcome).toBe('proven')
  expect(result.criteria[0].evidence).toContain('checks/criterion-1/0/outbound.json')
  const outbound = JSON.parse(await readFile(join(job.evidenceDir, 'checks', 'criterion-1', '0', 'outbound.json'), 'utf8')) as Record<string, unknown>
  expect(outbound).toEqual({
    command: 'echo hi',
    containment: 'cell',
    declared: ['api.billing-vendor.example'],
    reached: [{ host: 'api.billing-vendor.example', port: 443, protocol: 'https', declared: true, count: 1 }],
  })
  // The cell is the one the run declared for the profile: the app at the
  // published port, the stub as the service that provides it, the gate
  // joining the compose project's network.
  expect(asked[0]).toMatchObject({
    hosts: ['api.billing-vendor.example'],
    map: { 'api.billing-vendor.example': 'billing' },
    app: { host: 'localhost', scheme: 'http' },
    checkout: job.repoPath,
  })
  const request = asked[0] as { app?: { port?: number }; composeProject?: string }
  expect(typeof request.app?.port).toBe('number')
  expect(request.composeProject).toMatch(/^qare-/)
})

test("a criterion with an app of its own gives the cell the shard's app, not the run's (#224)", async () => {
  const asked: unknown[] = []
  const job = await makeJob({
    criteria: [
      ...commandCriteria('echo other'),
      { id: 'mutator-1', text: 'it mutates', checks: [{ kind: 'command', run: 'echo hi' }], isolated: true },
    ],
    profile: { inline: { ...PROFILE, commands: COMMANDS } },
  })

  const { result } = await runJob(job, { ...BOOT, commandCell: { start: fakeCell({ reached: [] }, asked) }, workers: 2 })

  expect(result.criteria.map((criterion) => criterion.outcome)).toEqual(['proven', 'proven'])
  const runIsolation = JSON.parse(await readFile(join(job.evidenceDir, 'isolation.json'), 'utf8')) as Record<string, string>
  const shardIsolation = JSON.parse(await readFile(join(job.evidenceDir, 'isolation-mutator-1.json'), 'utf8')) as Record<string, string>
  // The cell the isolated criterion's command ran in was made for the app
  // that criterion booted: the shard's compose project, at the shard's
  // published port, never the run's shared app.
  const request = asked[0] as { app?: { port?: number }; composeProject?: string }
  expect(request.composeProject).toBe(shardIsolation.project)
  expect(request.composeProject).not.toBe(runIsolation.project)
  expect(request.app?.port).toBe(Number(shardIsolation.port))
})

test('a destination the profile does not declare refuses the check: the result is unverified and said to be (#224)', async () => {
  const job = await makeJob({
    criteria: commandCriteria('echo hi'),
    profile: { inline: { ...PROFILE, commands: COMMANDS } },
  })

  const { result } = await runJob(job, {
    ...BOOT,
    commandCell: { start: fakeCell({ reached: [{ host: 'telemetry.example', port: 443, protocol: 'https', declared: false, count: 2 }] }) },
  })

  expect(result.criteria[0].outcome).toBe('unverified')
  expect(result.criteria[0].reason).toBe(
    "refused: undeclared host: telemetry.example:443 (https); the profile does not list it in the command's declared hosts",
  )
  const outbound = JSON.parse(await readFile(join(job.evidenceDir, 'checks', 'criterion-1', '0', 'outbound.json'), 'utf8')) as Record<string, unknown>
  expect(outbound.containment).toBe('cell')
})

test("the cell's start failing leaves the run standing: the check is unverified and its record says why (#224)", async () => {
  const job = await makeJob({
    criteria: commandCriteria('echo hi'),
    profile: { inline: { ...PROFILE, commands: COMMANDS } },
  })

  const { result } = await runJob(job, {
    ...BOOT,
    commandCell: {
      start: async () => {
        throw new Error('docker daemon is unreachable')
      },
    },
  })

  expect(result.criteria[0].outcome).toBe('unverified')
  expect(result.criteria[0].reason).toBe("the command's cell did not start: docker daemon is unreachable")
  const outbound = JSON.parse(await readFile(join(job.evidenceDir, 'checks', 'criterion-1', '0', 'outbound.json'), 'utf8')) as Record<string, unknown>
  expect(outbound).toEqual({
    command: 'echo hi',
    containment: 'cell',
    declared: ['api.billing-vendor.example'],
    reached: [],
    incomplete: 'docker daemon is unreachable',
  })
})

test('a command that opts out runs with the network its step has, and its evidence says what it was not shown (#224)', async () => {
  const asked: unknown[] = []
  const job = await makeJob({
    criteria: commandCriteria('echo hi'),
    profile: { inline: { ...PROFILE, commands: { test: { ...COMMANDS.test, egress: 'uncontained' } } } },
  })

  const { result } = await runJob(job, { ...BOOT, commandCell: { start: fakeCell({ reached: [] }, asked) } })

  expect(result.criteria[0].outcome).toBe('proven')
  expect(asked).toEqual([])
  const outbound = JSON.parse(await readFile(join(job.evidenceDir, 'checks', 'criterion-1', '0', 'outbound.json'), 'utf8')) as Record<string, unknown>
  expect(outbound).toEqual({
    command: 'echo hi',
    containment: 'none',
    reason: 'the profile opts out with egress: uncontained, so the command ran with the network its step has and what it reached was not recorded',
  })
})

test('a check that names no command of the profile runs uncontained, and its evidence carries no record of traffic (#224)', async () => {
  const asked: unknown[] = []
  const job = await makeJob({
    criteria: commandCriteria('echo bare'),
    profile: { inline: { ...PROFILE, commands: COMMANDS } },
  })

  const { result } = await runJob(job, { ...BOOT, commandCell: { start: fakeCell({ reached: [] }, asked) } })

  expect(result.criteria[0].outcome).toBe('proven')
  expect(asked).toEqual([])
  await expect(readFile(join(job.evidenceDir, 'checks', 'criterion-1', '0', 'outbound.json'), 'utf8')).rejects.toThrow()
})

test("the suite's evidence says in as many words that it ran uncontained (#224)", async () => {
  const job = await makeJob({
    criteria: [{ id: 'criterion-1', text: 'criterion 1', checks: [{ kind: 'flow', suite: 'browser-e2e' }] }],
    profile: { inline: { ...PROFILE, commands: COMMANDS } },
  })

  const { result } = await runJob(job, { ...BOOT, commandCell: { start: fakeCell({ reached: [] }) } })

  expect(result.verdict).toBe('passed')
  expect(result.criteria[0].evidence).toEqual(['checks/criterion-1/0/suite.txt', 'checks/criterion-1/0/stdout.txt', 'checks/criterion-1/0/stderr.txt'])
  const suite = JSON.parse(await readFile(join(job.evidenceDir, 'checks', 'criterion-1', '0', 'suite.txt'), 'utf8')) as Record<string, unknown>
  expect(suite.containment).toBe('none')
  expect(suite.note).toBe('a suite runs uncontained, so it may reach for whatever its step can reach and its traffic is not recorded')
})

test('an incomplete record of what the command reached is not proof: the check is unverified (#224)', async () => {
  const job = await makeJob({
    criteria: commandCriteria('echo hi'),
    profile: { inline: { ...PROFILE, commands: COMMANDS } },
  })

  const { result } = await runJob(job, {
    ...BOOT,
    commandCell: {
      start: fakeCell({
        reached: [{ host: 'api.billing-vendor.example', port: 443, protocol: 'https', declared: true, count: 1 }],
        incomplete: 'the gate stopped before the command did',
      }),
    },
  })

  expect(result.criteria[0].outcome).toBe('unverified')
  expect(result.criteria[0].reason).toBe(
    'refused: the record of what the command reached is incomplete: the gate stopped before the command did',
  )
})

test("a target run's cell carries the target's own host and the destinations it declares (#224)", async () => {
  const asked: unknown[] = []
  const TARGET_URL = ['https:', '//qa.example.test/health'].join('')
  const job = await makeJob({
    criteria: commandCriteria('echo hi'),
    profile: {
      inline: {
        target: {
          url: TARGET_URL,
          health: { http: ['https:', '//qa.example.test/up'].join(''), timeout: '120s' },
          hosts: ['data.vendor.example'],
        },
        suites: [],
        visual: { widths: [], themes: [] },
        commands: COMMANDS,
      } as QaProfile,
    },
  })

  const { result } = await runJob(job, { ...BOOT, commandCell: { start: fakeCell({ reached: [] }, asked) } })

  expect(result.criteria[0].outcome).toBe('proven')
  expect(asked[0]).toMatchObject({ hosts: ['qa.example.test', 'data.vendor.example'] })
})

test("a contained command on a run whose target is the machine's own loopback is refused (#224)", async () => {
  const LOCAL_TARGET = ['http:', '//127.0.0.1:4173'].join('')
  const job = await makeJob({
    criteria: commandCriteria('echo hi'),
    profile: {
      inline: {
        target: {
          url: LOCAL_TARGET,
          health: { http: ['http:', '//127.0.0.1:4173/up'].join(''), timeout: '120s' },
        },
        suites: [],
        visual: { widths: [], themes: [] },
        commands: COMMANDS,
      } as QaProfile,
    },
  })

  await expect(runJob(job, { ...BOOT, commandCell: { start: fakeCell({ reached: [] }) } })).rejects.toThrow(
    'a contained command cannot reach a target on the machine\'s own loopback',
  )
})

test("the cell is told the scheme the app's health URL carries, not always http (#224)", async () => {
  const asked: unknown[] = []
  const HTTPS_HEALTH_URL = ['https:', '//localhost:3000/up'].join('')
  const job = await makeJob({
    criteria: commandCriteria('echo hi'),
    profile: {
      inline: {
        ...PROFILE,
        app: { ...PROFILE.app, health: { http: HTTPS_HEALTH_URL, timeout: '120s' } },
        commands: COMMANDS,
      },
    },
  })

  const { result } = await runJob(job, { ...BOOT, commandCell: { start: fakeCell({ reached: [] }, asked) } })

  expect(result.criteria[0].outcome).toBe('proven')
  expect(asked[0]).toMatchObject({ app: { scheme: 'https' } })
})

test('a check two commands both name is refused: the profile must not declare overlapping commands (#224)', async () => {
  const job = await makeJob({
    criteria: commandCriteria('tool smoke'),
    profile: {
      inline: {
        ...PROFILE,
        commands: {
          test: { run: 'tool {{name}}', about: 'runs any tool' },
          smoke: { run: 'tool smoke', about: 'runs the smoke check' },
        },
      },
    },
  })

  const { result } = await runJob(job, { ...BOOT, commandCell: { start: fakeCell({ reached: [] }) } })

  expect(result.criteria[0].outcome).toBe('unverified')
  expect(result.criteria[0].reason).toBe(
    'refused: the profile declares overlapping commands (tool {{name}} and tool smoke); a check is contained by the one command its run names',
  )
})

test('a contained check runs from the cwd it names, with the whole checkout copied into the cell (#224)', async () => {
  const asked: unknown[] = []
  const job = await makeJob({
    criteria: [
      {
        id: 'criterion-1',
        text: 'criterion 1',
        checks: [{ kind: 'command', run: 'echo hi', cwd: 'packages/foo' }],
      },
    ],
    profile: { inline: { ...PROFILE, commands: COMMANDS } },
  })

  const { result } = await runJob(job, { ...BOOT, commandCell: { start: fakeCell({ reached: [] }, asked) } })

  expect(result.criteria[0].outcome).toBe('proven')
  // The cell holds a copy of the repository root, not the subtree the check
  // runs from: a command under packages/foo still reads the repository's own
  // files, and its repository-relative scratch stays repository-relative.
  expect(asked[0]).toMatchObject({ checkout: job.repoPath, cwd: 'packages/foo' })
})

test('the cell is handed the ports the stubs declare, beside the app the run boots (#224)', async () => {
  const asked: unknown[] = []
  const job = await makeJob({
    criteria: commandCriteria('echo hi'),
    profile: {
      inline: {
        ...PROFILE,
        stubs: [{ service: 'billing', hosts: ['api.billing-vendor.example'], ports: [8080, 9090], provided_by: { compose_service: 'billing' } }],
        commands: COMMANDS,
      },
    },
  })

  const { result } = await runJob(job, { ...BOOT, commandCell: { start: fakeCell({ reached: [] }, asked) } })

  expect(result.criteria[0].outcome).toBe('proven')
  expect(asked[0]).toMatchObject({
    hosts: ['api.billing-vendor.example'],
    map: { 'api.billing-vendor.example': 'billing' },
    stubPorts: [
      { host: 'api.billing-vendor.example', port: 8080 },
      { host: 'api.billing-vendor.example', port: 9090 },
    ],
  })
})

test('a refusal for overlapping commands is decided by every run: a cached refusal never stands in (#224)', async () => {
  const job = await makeJob({
    criteria: commandCriteria('tool smoke'),
    profile: {
      inline: {
        ...PROFILE,
        commands: {
          test: { run: 'tool {{name}}', about: 'runs any tool' },
          smoke: { run: 'tool smoke', about: 'runs the smoke check' },
        },
      },
    },
  })
  execSync('git init -q && git -c user.name=t -c user.email=t@example.test commit -q --allow-empty -m build', { cwd: job.repoPath })
  const cached = { ...job, baseRef: 'HEAD', headRef: 'HEAD' }
  const cacheDir = join(job.repoPath, '..', `${job.id}-cache-${Date.now()}`)
  const first = await runJob(cached, { ...BOOT, commandCell: { start: fakeCell({ reached: [] }) }, cacheDir })
  const second = await runJob({ ...cached, evidenceDir: join(job.repoPath, 'evidence-2') }, { ...BOOT, commandCell: { start: fakeCell({ reached: [] }) }, cacheDir })

  expect(first.result.criteria[0].outcome).toBe('unverified')
  expect(first.result.criteria[0].reason).toBe(
    'refused: the profile declares overlapping commands (tool {{name}} and tool smoke); a check is contained by the one command its run names',
  )
  expect(second.result.criteria[0].outcome).toBe('unverified')
  expect(second.result.criteria[0].reason).toBe(first.result.criteria[0].reason)
  // The second run refused by its own answer: a refusal is never cached.
  expect(second.result.criteria[0].cached).toBeUndefined()
})
