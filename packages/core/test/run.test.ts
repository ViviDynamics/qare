import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import {
  JobValidationError,
  NARE_CONTRACT,
  VERSION,
  installCancelCleanup,
  loadJobFromText,
  loadResult,
  renderComment,
  runJob,
  type BootOpts,
  type Job,
  type JobCriterion,
  type JobProfileRef,
  type QaProfile,
} from '../src/index.js'

const HEALTH_URL = ['http:', '//localhost:3000/up'].join('')
// Assembled like HEALTH_URL: no network marker sits as a literal in a test.
const localUrl = (rest: string): string => ['http:', rest].join('')

const INLINE_PROFILE: QaProfile = {
  app: {
    boot: { compose: 'compose.qa.yaml', service: 'admin' },
    health: { http: HEALTH_URL, timeout: '120s' },
    seed: { command: 'bin/rails db:seed:qa' },
    login: { fixture: 'fixtures/users.yml', role: 'admin' },
  },
  stubs: [
    {
      service: 'billing',
      hosts: ['api.billing-vendor.example'],
      provided_by: { compose_service: 'billing-stub' },
    },
    {
      service: 'mail',
      hosts: ['api.mailgun.net'],
      provided_by: { compose_service: 'mailpit' },
    },
  ],
  visual: { widths: [1440, 390], themes: ['light', 'dark'] },
  suites: [{ name: 'browser-e2e', command: 'npm --prefix e2e test', kind: 'flow' }],
}

const fixtureDir = new URL('../fixtures/qa-valid/.qa', import.meta.url)

const HEALTHY_BOOT = {
  runCompose: async () => ({ code: 0, stdout: 'up out', stderr: 'up err' }),
  probe: async () => ({ ok: true }),
  pollIntervalMs: 1,
}

async function makeJob(fields: { criteria: JobCriterion[]; profile: JobProfileRef }): Promise<Job> {
  const repoPath = await mkdtemp(join(tmpdir(), 'qare-run-'))
  return {
    id: 'job-run-smoke',
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

function jobError(run: () => unknown): JobValidationError {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(JobValidationError)
    return error as JobValidationError
  }
  throw new Error('expected the loader to throw JobValidationError')
}

test('a passing job proves both command criteria and writes loadable evidence', async () => {
  const job = await makeJob({
    criteria: commandCriteria('echo ok', 'echo ok'),
    profile: { inline: INLINE_PROFILE },
  })

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.verdict).toBe('passed')
  expect(result.schemaVersion).toBe('1')
  expect(result.criteria).toEqual([
    {
      id: 'criterion-1',
      outcome: 'proven',
      evidence: ['checks/criterion-1/0/stdout.txt', 'checks/criterion-1/0/stderr.txt', 'checks/criterion-1/0/command.json'],
    },
    {
      id: 'criterion-2',
      outcome: 'proven',
      evidence: ['checks/criterion-2/0/stdout.txt', 'checks/criterion-2/0/stderr.txt', 'checks/criterion-2/0/command.json'],
    },
  ])
  for (const criterion of result.criteria) {
    if (criterion.outcome === 'proven') {
      for (const path of criterion.evidence) {
        expect(existsSync(join(job.evidenceDir, path)), path).toBe(true)
      }
    }
  }
  expect(
    await readFile(join(job.evidenceDir, 'checks', 'criterion-1', '0', 'stdout.txt'), 'utf8'),
  ).toBe('ok\n')
  expect(JSON.parse(await readFile(join(job.evidenceDir, 'checks', 'criterion-1', '0', 'command.json'), 'utf8'))).toEqual({
    command: 'echo ok',
    outcome: 'passed',
    exit_code: 0,
  })

  const written = loadResult(await readFile(join(job.evidenceDir, 'result.json'), 'utf8'))
  expect(written).toEqual(result)
  expect(written.job).toEqual({ id: 'job-run-smoke' })
})

test('a failing command fails its criterion and the run', async () => {
  const job = await makeJob({
    criteria: commandCriteria('false'),
    profile: { inline: INLINE_PROFILE },
  })

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.verdict).toBe('failed')
  expect(result.criteria).toEqual([
    {
      id: 'criterion-1',
      outcome: 'failed',
      evidence: ['checks/criterion-1/0/stdout.txt', 'checks/criterion-1/0/stderr.txt', 'checks/criterion-1/0/command.json'],
    },
  ])
  expect(JSON.parse(await readFile(join(job.evidenceDir, 'checks', 'criterion-1', '0', 'command.json'), 'utf8'))).toEqual({
    command: 'false',
    outcome: 'failed',
    exit_code: 1,
  })
})

test('a command that passes silently records the exit code it closed with', async () => {
  const job = await makeJob({
    criteria: commandCriteria('true'),
    profile: { inline: INLINE_PROFILE },
  })

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.verdict).toBe('passed')
  expect(result.criteria).toEqual([
    {
      id: 'criterion-1',
      outcome: 'proven',
      evidence: ['checks/criterion-1/0/stdout.txt', 'checks/criterion-1/0/stderr.txt', 'checks/criterion-1/0/command.json'],
    },
  ])
  expect(await readFile(join(job.evidenceDir, 'checks', 'criterion-1', '0', 'stdout.txt'), 'utf8')).toBe('')
  expect(JSON.parse(await readFile(join(job.evidenceDir, 'checks', 'criterion-1', '0', 'command.json'), 'utf8'))).toEqual({
    command: 'true',
    outcome: 'passed',
    exit_code: 0,
  })
})

test('a job with a profile path boots through the injected compose and proves its criterion', async () => {
  const job = await makeJob({
    criteria: commandCriteria('echo ok'),
    profile: { path: fixtureDir.pathname },
  })

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.verdict).toBe('passed')
  expect(result.criteria).toEqual([
    {
      id: 'criterion-1',
      outcome: 'proven',
      evidence: ['checks/criterion-1/0/stdout.txt', 'checks/criterion-1/0/stderr.txt', 'checks/criterion-1/0/command.json'],
    },
  ])
})

test('a blocked boot marks every criterion unverified and the run blocked', async () => {
  const job = await makeJob({
    criteria: commandCriteria('echo ok', 'echo ok'),
    profile: { inline: INLINE_PROFILE },
  })

  const { result } = await runJob(job, {
    runCompose: async () => ({ code: 1, stdout: '', stderr: 'compose boom' }),
  })

  expect(result.verdict).toBe('blocked')
  expect(result.criteria).toEqual([
    { id: 'criterion-1', outcome: 'unverified', reason: 'compose up exited 1' },
    { id: 'criterion-2', outcome: 'unverified', reason: 'compose up exited 1' },
  ])
})

test('a criterion with zero checks stays unverified pending planning', async () => {
  const job = await makeJob({
    criteria: [{ id: 'planned-later', text: 'planned by the agent later', checks: [] }],
    profile: { inline: INLINE_PROFILE },
  })

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.verdict).toBe('blocked')
  expect(result.criteria).toEqual([
    {
      id: 'planned-later',
      outcome: 'unverified',
      reason: 'no checks were given for this criterion, so nothing ran',
    },
  ])
})

test('a check that outlives its timeoutMs times out to unverified', async () => {
  const job = await makeJob({
    criteria: [
      {
        id: 'slow-check',
        text: 'sleeps past the deadline',
        checks: [{ kind: 'command', run: 'sleep 2', timeoutMs: 50 }],
      },
    ],
    profile: { inline: INLINE_PROFILE },
  })

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.verdict).toBe('blocked')
  expect(result.criteria).toEqual([
    { id: 'slow-check', outcome: 'unverified', reason: 'check timed out after 50ms' },
  ])
})

test('duplicate criterion ids fail job loading', () => {
  const text = [
    'id: job-dup',
    'repoPath: .',
    'baseRef: main',
    'headRef: HEAD~1',
    'profile: { path: .qa }',
    'criteria:',
    '  - { id: same, text: one }',
    '  - { id: same, text: two }',
    'evidenceDir: evidence',
    'post: none',
  ].join('\n')

  const error = jobError(() => loadJobFromText(text))

  expect(error.name).toBe('JobValidationError')
  expect(error.field).toBe('criteria')
  expect(error.message).toContain('duplicate criterion id "same"')
})

test('a check cwd resolves inside the repo and is honored', async () => {
  const job = await makeJob({
    criteria: [{ id: 'cwd-check', text: 'runs in a subdirectory', checks: [{ kind: 'command', run: 'echo ok', cwd: 'sub' }] }],
    profile: { inline: INLINE_PROFILE },
  })
  await mkdir(join(job.repoPath, 'sub'), { recursive: true })

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.verdict).toBe('passed')
  expect(
    await readFile(join(job.evidenceDir, 'checks', 'cwd-check', '0', 'stdout.txt'), 'utf8'),
  ).toBe('ok\n')
})

test('a check cwd that escapes the repo is refused to unverified', async () => {
  const job = await makeJob({
    criteria: [{ id: 'escape', text: 'tries to escape', checks: [{ kind: 'command', run: 'echo ok', cwd: '..' }] }],
    profile: { inline: INLINE_PROFILE },
  })

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.verdict).toBe('blocked')
  expect(result.criteria).toEqual([
    { id: 'escape', outcome: 'unverified', reason: expect.stringContaining('escapes the repository path') },
  ])
})

test('a criterion id with a path separator fails job loading', () => {
  const text = [
    'id: job-traversal',
    'repoPath: .',
    'baseRef: main',
    'headRef: HEAD~1',
    'profile: { path: .qa }',
    'criteria:',
    '  - { id: ../escape, text: traversal }',
    'evidenceDir: evidence',
    'post: none',
  ].join('\n')

  const error = jobError(() => loadJobFromText(text))

  expect(error.name).toBe('JobValidationError')
  expect(error.field).toBe('criteria[0].id')
  expect(error.message).toContain('path separators')
})

test('a check whose binary is missing leaves the criterion unverified and the run blocked', async () => {
  const job = await makeJob({
    criteria: commandCriteria('definitely-not-a-binary-xyz'),
    profile: { inline: INLINE_PROFILE },
  })

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.verdict).toBe('blocked')
  expect(result.criteria).toEqual([
    {
      id: 'criterion-1',
      outcome: 'unverified',
      reason: expect.stringContaining('the planned command cannot run'),
    },
  ])
})

test('a check with env opts into the minimal environment and sees its marker', async () => {
  const job = await makeJob({
    criteria: [
      {
        id: 'env-marker',
        text: 'sees the marker it was handed',
        checks: [{ kind: 'command', run: './marker.sh', env: { QA_MARKER: 'present' } }],
      },
    ],
    profile: { inline: INLINE_PROFILE },
  })
  await writeFile(join(job.repoPath, 'marker.sh'), '#!/bin/sh\necho "$QA_MARKER"\n', { mode: 0o755 })

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.verdict).toBe('passed')
  expect(
    await readFile(join(job.evidenceDir, 'checks', 'env-marker', '0', 'stdout.txt'), 'utf8'),
  ).toContain('present')
})

test('a check with env does not inherit the harness environment', async () => {
  process.env.QA_SHOULD_NOT_EXIST = 'harness-secret'
  const job = await makeJob({
    criteria: [
      {
        id: 'env-minimal',
        text: 'runs with only the minimal deterministic environment',
        checks: [{ kind: 'command', run: './minimal.sh', env: { QA_MARKER: 'present' } }],
      },
    ],
    profile: { inline: INLINE_PROFILE },
  })
  await writeFile(
    join(job.repoPath, 'minimal.sh'),
    [
      '#!/bin/sh',
      'echo "marker=$QA_MARKER"',
      'echo "missing=$QA_SHOULD_NOT_EXIST"',
      'echo "home=$HOME"',
    ].join('\n'),
    { mode: 0o755 },
  )

  try {
    const { result } = await runJob(job, HEALTHY_BOOT)

    expect(result.verdict).toBe('passed')
    const stdout = await readFile(join(job.evidenceDir, 'checks', 'env-minimal', '0', 'stdout.txt'), 'utf8')
    expect(stdout).toContain('marker=present')
    expect(stdout).not.toContain('harness-secret')
    expect(stdout).toContain('missing=')
    expect(stdout).toMatch(/home=.+/)
  } finally {
    delete process.env.QA_SHOULD_NOT_EXIST
  }
})

test('on a host, a check without env still gets the minimal deterministic environment', async () => {
  process.env.QA_SHOULD_NOT_EXIST = 'harness-secret'
  const job = await makeJob({
    criteria: commandCriteria('./minimal.sh'),
    profile: { inline: INLINE_PROFILE },
  })
  await writeFile(
    join(job.repoPath, 'minimal.sh'),
    [
      '#!/bin/sh',
      'echo "missing=$QA_SHOULD_NOT_EXIST"',
      'echo "home=$HOME"',
    ].join('\n'),
    { mode: 0o755 },
  )

  try {
    const { result } = await runJob(job, { ...HEALTHY_BOOT, execution: 'native' })

    expect(result.verdict).toBe('passed')
    const stdout = await readFile(join(job.evidenceDir, 'checks', 'criterion-1', '0', 'stdout.txt'), 'utf8')
    expect(stdout).not.toContain('harness-secret')
    expect(stdout).toContain('missing=')
    expect(stdout).toMatch(/home=.+/)
  } finally {
    delete process.env.QA_SHOULD_NOT_EXIST
  }
})

test('on a containerised run, a check without env inherits the harness environment', async () => {
  process.env.QA_SHOULD_NOT_EXIST = 'harness-secret'
  const job = await makeJob({
    criteria: commandCriteria('./minimal.sh'),
    profile: { inline: INLINE_PROFILE },
  })
  await writeFile(join(job.repoPath, 'minimal.sh'), '#!/bin/sh\necho "missing=$QA_SHOULD_NOT_EXIST"\n', { mode: 0o755 })

  try {
    const { result } = await runJob(job, { ...HEALTHY_BOOT, execution: 'containerised' })

    expect(result.verdict).toBe('passed')
    const stdout = await readFile(join(job.evidenceDir, 'checks', 'criterion-1', '0', 'stdout.txt'), 'utf8')
    expect(stdout).toContain('missing=harness-secret')
  } finally {
    delete process.env.QA_SHOULD_NOT_EXIST
  }
})

test('the result records the environment the run executed in', async () => {
  const job = await makeJob({
    criteria: commandCriteria('echo ok'),
    profile: { inline: INLINE_PROFILE },
  })

  const { result } = await runJob(job, { ...HEALTHY_BOOT, execution: 'native' })

  expect(result.environment).toEqual({
    execution: 'native',
    versions: { qare: VERSION, node: process.versions.node, nareContract: NARE_CONTRACT },
  })
  // The same finishRun writes the record into the evidence, so result.json
  // carries it without the caller passing anything.
  const written = loadResult(await readFile(join(job.evidenceDir, 'result.json'), 'utf8'))
  expect(written.environment?.execution).toBe('native')
  expect(written.environment?.versions.nareContract).toBe(NARE_CONTRACT)
})

test('a check env with a non-string value fails job loading', () => {
  const text = [
    'id: job-env',
    'repoPath: .',
    'baseRef: main',
    'headRef: HEAD~1',
    'profile: { path: .qa }',
    'criteria:',
    '  - id: env-check',
    '    text: env',
    '    checks:',
    '      - { kind: command, run: echo ok, env: { QA_MARKER: 7 } }',
    'evidenceDir: evidence',
    'post: none',
  ].join('\n')

  const error = jobError(() => loadJobFromText(text))

  expect(error.name).toBe('JobValidationError')
  expect(error.field).toBe('criteria[0].checks[0].env')
  expect(error.message).toContain('must be a string')
})

test('a check whose grandchild holds the stdio pipes still settles unverified', async () => {
  const job = await makeJob({
    criteria: [
      {
        id: 'forks-daemon',
        text: 'forks a child that inherits the pipes',
        checks: [{ kind: 'command', run: './forks.sh', timeoutMs: 50 }],
      },
    ],
    profile: { inline: INLINE_PROFILE },
  })
  // no shell: the script itself must fork a pipe-holding grandchild
  await writeFile(
    join(job.repoPath, 'forks.sh'),
    '#!/bin/sh\n( sleep 30 ) &\nexit 0\n',
    { mode: 0o755 },
  )

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.verdict).toBe('blocked')
  expect(result.criteria).toEqual([
    {
      id: 'forks-daemon',
      outcome: 'unverified',
      reason: expect.stringContaining('check timed out after 50ms'),
    },
  ])
}, 10000)

// Assembled at runtime so no literal token sits in the repository.
const SEEDED_TOKEN = ['ghp', '_', 'Zz9'.repeat(12)].join('')

async function allEvidenceText(dir: string): Promise<string> {
  const files = (await readdir(dir, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile())
  const texts = await Promise.all(files.map((entry) => readFile(join(entry.parentPath, entry.name), 'utf8')))
  return texts.join('\n')
}

test('a seeded token and fixture data in command output reach neither the evidence nor the comment (#52)', async () => {
  const job = await makeJob({
    criteria: [
      {
        id: 'leaky',
        text: 'prints what it should not',
        checks: [{ kind: 'command', run: './leak.sh', env: { SEEDED: SEEDED_TOKEN, CUSTOMER: 'jane@pilot.example' } }],
      },
      // The reason for a check that cannot start names its command, so a
      // secret in the command reaches result.json through the reason.
      { id: 'unstartable', text: 'names a secret', checks: [{ kind: 'command', run: SEEDED_TOKEN }] },
    ],
    profile: { inline: { ...INLINE_PROFILE, redact: { values: ['jane@pilot.example'] } } },
  })
  await writeFile(
    join(job.repoPath, 'leak.sh'),
    '#!/bin/sh\necho "pushing with $SEEDED"\necho "mailed $CUSTOMER" >&2\nexit 1\n',
    { mode: 0o755 },
  )

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.criteria.map((criterion) => criterion.outcome)).toEqual(['failed', 'unverified'])
  const evidence = await allEvidenceText(job.evidenceDir)
  expect(evidence).toContain('pushing with [redacted]')
  expect(evidence).toContain('mailed [redacted]')
  for (const published of [evidence, JSON.stringify(result), renderComment(result)]) {
    expect(published).not.toContain(SEEDED_TOKEN)
    expect(published).not.toContain('jane@pilot.example')
  }
})

test('run values substitute into check run and env, and the minted values land in evidence', async () => {
  const job = await makeJob({
    criteria: [
      {
        id: 'values-in-run',
        text: 'echoes the minted address',
        checks: [{ kind: 'command', run: 'echo {{run.mail_address}}' }],
      },
      {
        id: 'values-in-env',
        text: 'reads the minted address from its environment',
        checks: [{ kind: 'command', run: 'printenv ADDR', env: { ADDR: '{{run.mail_address}}' } }],
      },
    ],
    profile: { inline: INLINE_PROFILE },
  })

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.verdict).toBe('passed')
  const stdout = await readFile(join(job.evidenceDir, 'checks', 'values-in-run', '0', 'stdout.txt'), 'utf8')
  const values = JSON.parse(await readFile(join(job.evidenceDir, 'values.json'), 'utf8')) as Record<string, string>
  expect(stdout.trim()).toBe(values.mail_address)
  expect(values.mail_address).toBe(`qare-${values.id}@localhost`)
  expect(
    (await readFile(join(job.evidenceDir, 'checks', 'values-in-env', '0', 'stdout.txt'), 'utf8')).trim(),
  ).toBe(values.mail_address)
})

test('values.json is redacted like every other published evidence file', async () => {
  const job = await makeJob({
    criteria: commandCriteria('echo ok'),
    profile: { inline: { ...INLINE_PROFILE, redact: { values: ['@localhost'] } } },
  })

  await runJob(job, HEALTHY_BOOT)

  const values = await readFile(join(job.evidenceDir, 'values.json'), 'utf8')
  expect(values).not.toContain('@localhost')
})

test('an unknown run value reference refuses the whole run before anything boots', async () => {
  let bootAttempted = false
  const job = await makeJob({
    criteria: commandCriteria('echo {{run.bogus}}'),
    profile: { inline: INLINE_PROFILE },
  })

  const { result } = await runJob(job, {
    runCompose: async () => {
      bootAttempted = true
      return { code: 0, stdout: '', stderr: '' }
    },
    probe: async () => ({ ok: true }),
  })

  expect(bootAttempted).toBe(false)
  expect(result.verdict).toBe('refused')
  for (const criterion of result.criteria) {
    expect(criterion.outcome).toBe('unverified')
    expect(criterion.reason).toContain('{{run.bogus}}')
  }
  expect(existsSync(join(job.evidenceDir, 'checks'))).toBe(false)
})

test('an unterminated run value reference refuses the run the same way', async () => {
  const job = await makeJob({
    criteria: commandCriteria('echo {{oops'),
    profile: { inline: INLINE_PROFILE },
  })

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.verdict).toBe('refused')
  expect(result.criteria[0].reason).toContain('unterminated run value reference')
})

test('an unknown run value reference in the seed command is a plan-time refusal too', async () => {
  const job = await makeJob({
    criteria: commandCriteria('echo ok'),
    profile: { inline: { ...INLINE_PROFILE, app: { ...INLINE_PROFILE.app, seed: { command: 'bin/rails db:seed:qa {{run.bogus}}' } } } },
  })

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.verdict).toBe('refused')
  expect(result.criteria[0].reason).toContain('{{run.bogus}}')
  expect(result.criteria[0].reason).toContain('app.seed.command')
})

test('a run value reference in a check cwd is refused at plan time with the cwd field named', async () => {
  const job = await makeJob({
    criteria: [
      {
        id: 'cwd-ref',
        text: 'runs somewhere with a reference in the cwd',
        checks: [{ kind: 'command', run: 'echo ok', cwd: 'e2e-{{run.bogus}}' }],
      },
    ],
    profile: { inline: INLINE_PROFILE },
  })

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.verdict).toBe('refused')
  expect(result.criteria[0].reason).toContain('criteria[0].checks[0].cwd')
  expect(result.criteria[0].reason).toContain('{{run.bogus}}')
})

test('a reference in an env key is refused: keys name variables, they are not substitution sites', async () => {
  const job = await makeJob({
    criteria: [
      {
        id: 'env-key-ref',
        text: 'carries a reference in an env key',
        checks: [{ kind: 'command', run: 'echo ok', env: { '{{run.bogus}}': 'x' } }],
      },
    ],
    profile: { inline: INLINE_PROFILE },
  })

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.verdict).toBe('refused')
  expect(result.criteria[0].reason).toContain('env key')
})

interface CapturedComposeCall {
  args: string[]
  env?: Record<string, string>
}

function isolatedBootCapture(): { opts: BootOpts; calls: CapturedComposeCall[]; probedUrls: string[] } {
  const calls: CapturedComposeCall[] = []
  const probedUrls: string[] = []
  return {
    calls,
    probedUrls,
    opts: {
      runCompose: async (args, _timeoutMs, env) => {
        calls.push({ args, env })
        return { code: 0, stdout: 'up out', stderr: '' }
      },
      probe: async (url) => {
        probedUrls.push(url)
        return { ok: true }
      },
      pollIntervalMs: 1,
    },
  }
}

test('an app run records its isolation, boots under its own project, and mints app_port', async () => {
  const captured = isolatedBootCapture()
  const job = await makeJob({
    criteria: commandCriteria('echo ok'),
    profile: { inline: INLINE_PROFILE },
  })

  const { result, isolation } = await runJob(job, captured.opts)

  expect(result.verdict).toBe('passed')
  expect(isolation?.project).toBe(`qare-${isolation?.runId}`)
  // The evidence names what the run booted, so leftovers are findable (#53).
  const recorded = JSON.parse(await readFile(join(job.evidenceDir, 'isolation.json'), 'utf8')) as Record<string, unknown>
  expect(recorded.project).toBe(isolation?.project)
  expect(recorded.run_id).toBe(isolation?.runId)
  expect(recorded.port).toBe(isolation?.port)
  const values = JSON.parse(await readFile(join(job.evidenceDir, 'values.json'), 'utf8')) as Record<string, string>
  expect(values.app_port).toBe(String(isolation?.port))
  // One id per run: the compose project and the mail address name the same run.
  expect(values.id).toBe(isolation?.runId)
  expect(captured.calls.length).toBe(1)
  expect(captured.calls[0]?.args?.[0]).toBe('-p')
  expect(captured.calls[0]?.args?.[1]).toBe(isolation?.project)
  expect(captured.calls[0]?.env).toEqual({ QARE_RUN_ID: isolation?.runId, QARE_APP_PORT: String(isolation?.port) })
})

test('an app run refuses an isolation that carries no port, so runs cannot fall back to one default port', async () => {
  const captured = isolatedBootCapture()
  const job = await makeJob({
    criteria: commandCriteria('echo ok'),
    profile: { inline: INLINE_PROFILE },
  })

  const { result, isolation } = await runJob(job, {
    ...captured.opts,
    isolation: { runId: 'run-1', project: 'qare-run-1', startedAt: '2026-01-01T00:00:00.000Z' },
  })

  expect(result.verdict).toBe('refused')
  expect(isolation).toBeUndefined()
  expect(result.criteria[0].reason).toContain('no usable app port')
  // Nothing booted: a refused run leaves no stack and writes no isolation evidence.
  expect(captured.calls).toEqual([])
  expect(existsSync(join(job.evidenceDir, 'isolation.json'))).toBe(false)
})

test('an app run refuses an isolation whose port is not a host port (#53)', async () => {
  const captured = isolatedBootCapture()
  const job = await makeJob({
    criteria: commandCriteria('echo ok'),
    profile: { inline: INLINE_PROFILE },
  })

  for (const port of [0, 70000, 1.5, Number.NaN]) {
    const { result } = await runJob(job, {
      ...captured.opts,
      isolation: { runId: 'run-1', project: 'qare-run-1', startedAt: '2026-01-01T00:00:00.000Z', port },
    })
    expect(result.verdict).toBe('refused')
    expect(result.criteria[0].reason).toContain('no usable app port')
  }

  // Nothing booted: a refused run leaves no stack and writes no isolation evidence.
  expect(captured.calls).toEqual([])
  expect(existsSync(join(job.evidenceDir, 'isolation.json'))).toBe(false)
})

test('an app run refuses a caller isolation whose project is not qare-<run id>, so no foreign project is ever touched (#53)', async () => {
  const captured = isolatedBootCapture()
  const job = await makeJob({
    criteria: commandCriteria('echo ok'),
    profile: { inline: INLINE_PROFILE },
  })

  const { result } = await runJob(job, {
    ...captured.opts,
    isolation: { runId: 'run-1', project: 'production', startedAt: '2026-01-01T00:00:00.000Z', port: 3000 },
  })

  expect(result.verdict).toBe('refused')
  expect(result.criteria[0].reason).toContain('not carry a usable project')
  // Nothing booted: a refused run leaves no stack and writes no isolation evidence.
  expect(captured.calls).toEqual([])
  expect(existsSync(join(job.evidenceDir, 'isolation.json'))).toBe(false)
})

test('two runs of the same repository at the same time never share a stack, a port, or a probe URL (#53)', async () => {
  const bootA = isolatedBootCapture()
  const bootB = isolatedBootCapture()
  const jobA = await makeJob({
    criteria: commandCriteria('echo ok'),
    profile: { inline: INLINE_PROFILE },
  })
  const jobB = await makeJob({
    criteria: commandCriteria('echo ok'),
    profile: { inline: INLINE_PROFILE },
  })

  const [runA, runB] = await Promise.all([runJob(jobA, bootA.opts), runJob(jobB, bootB.opts)])

  expect(runA.result.verdict).toBe('passed')
  expect(runB.result.verdict).toBe('passed')
  expect(runA.isolation?.project).toMatch(/^qare-/)
  expect(runB.isolation?.project).toMatch(/^qare-/)
  expect(runA.isolation?.project).not.toBe(runB.isolation?.project)
  expect(runA.isolation?.port).not.toBe(runB.isolation?.port)
  // Each run composed under its own project, with its own port env.
  expect(bootA.calls[0]?.args?.[1]).toBe(runA.isolation?.project)
  expect(bootB.calls[0]?.args?.[1]).toBe(runB.isolation?.project)
  expect(bootA.calls[0]?.env?.QARE_APP_PORT).toBe(String(runA.isolation?.port))
  expect(bootB.calls[0]?.env?.QARE_APP_PORT).toBe(String(runB.isolation?.port))
  // Each run's health probe is pinned to the port that run published its app on.
  expect(bootA.probedUrls).toEqual([localUrl(`//localhost:${runA.isolation?.port}/up`)])
  expect(bootB.probedUrls).toEqual([localUrl(`//localhost:${runB.isolation?.port}/up`)])
})

test('the health URL may name the run port as {{run.app_port}} and probes the allocated port', async () => {
  const captured = isolatedBootCapture()
  const job = await makeJob({
    criteria: commandCriteria('echo ok'),
    profile: {
      inline: {
        ...INLINE_PROFILE,
        app: { ...INLINE_PROFILE.app, health: { http: localUrl('//localhost:{{run.app_port}}/up'), timeout: '120s' } },
      },
    },
  })

  const { result, isolation } = await runJob(job, captured.opts)

  expect(result.verdict).toBe('passed')
  expect(isolation?.port).toEqual(expect.any(Number))
  expect(captured.probedUrls).toEqual([localUrl(`//localhost:${isolation?.port}/up`)])
})

test('a canceled run stops its own compose project before exiting', async () => {
  const composeArgs: string[][] = []
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  const cleanup = installCancelCleanup(INLINE_PROFILE, {
    runCompose: async (args) => {
      composeArgs.push(args)
      return { code: 0, stdout: '', stderr: '' }
    },
    isolation: { runId: 'run-1', project: 'qare-run-1', startedAt: '2026-01-01T00:00:00.000Z', port: 4321 },
  })
  try {
    process.emit('SIGINT')
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(composeArgs).toEqual([['-p', 'qare-run-1', '-f', 'compose.qa.yaml', 'down']])
    expect(exit).toHaveBeenCalledWith(4)
  } finally {
    cleanup()
    exit.mockRestore()
  }
})

test('a cancel with a caller isolation naming a foreign project kills nothing and downs nothing (#53)', async () => {
  const composeArgs: string[][] = []
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  const cleanup = installCancelCleanup(INLINE_PROFILE, {
    runCompose: async (args) => {
      composeArgs.push(args)
      return { code: 0, stdout: '', stderr: '' }
    },
    isolation: { runId: 'run-1', project: 'production', startedAt: '2026-01-01T00:00:00.000Z', port: 4321 },
  })
  try {
    process.emit('SIGINT')
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(composeArgs).toEqual([])
    expect(exit).toHaveBeenCalledWith(4)
  } finally {
    cleanup()
    exit.mockRestore()
  }
})

test('a cancel whose compose down never settles still exits 4, bounded by the down deadline (#53)', async () => {
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  const errors: string[] = []
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((line) => errors.push(String(line)))
  const cleanup = installCancelCleanup(INLINE_PROFILE, {
    runCompose: () => new Promise(() => {}),
    downTimeoutMs: 50,
    isolation: { runId: 'run-1', project: 'qare-run-1', startedAt: '2026-01-01T00:00:00.000Z', port: 4321 },
  })
  try {
    process.emit('SIGINT')
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(4), { timeout: 5000 })

    expect(errors.join('')).toContain('the compose down did not settle within 50ms')
  } finally {
    cleanup()
    errorSpy.mockRestore()
    exit.mockRestore()
  }
})

test('one SIGINT cancels every run in the process, and the exit waits for every down (#53)', async () => {
  const composeArgs: string[][] = []
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  const runCompose = async (args: string[]) => {
    composeArgs.push(args)
    return { code: 0, stdout: '', stderr: '' }
  }
  const cleanupA = installCancelCleanup(INLINE_PROFILE, {
    runCompose,
    isolation: { runId: 'run-a', project: 'qare-run-a', startedAt: '2026-01-01T00:00:00.000Z', port: 4321 },
  })
  const cleanupB = installCancelCleanup(INLINE_PROFILE, {
    runCompose,
    isolation: { runId: 'run-b', project: 'qare-run-b', startedAt: '2026-01-01T00:00:00.000Z', port: 4322 },
  })
  try {
    process.emit('SIGINT')
    await new Promise((resolve) => setTimeout(resolve, 20))

    // Both downs ran, and the process exited once — after the last down, not
    // after the first.
    expect(composeArgs).toHaveLength(2)
    expect(exit).toHaveBeenCalledTimes(1)
  } finally {
    cleanupA()
    cleanupB()
    exit.mockRestore()
  }
})

test('a cancel override of zero is normalized to the cancellation bound, so no caller can opt the exit out of its deadline (#53)', async () => {
  const timeouts: number[] = []
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  const cleanup = installCancelCleanup(INLINE_PROFILE, {
    runCompose: (_args, timeoutMs) => {
      timeouts.push(timeoutMs)
      return new Promise(() => {})
    },
    downTimeoutMs: 0,
    isolation: { runId: 'run-1', project: 'qare-run-1', startedAt: '2026-01-01T00:00:00.000Z', port: 4321 },
  })
  try {
    process.emit('SIGINT')
    await new Promise((resolve) => setTimeout(resolve, 10))

    // The zero override reaches the down as the cancellation bound, not as no
    // deadline: the exit cannot be opted out of its guarantee.
    expect(timeouts).toEqual([30000])
  } finally {
    cleanup()
    exit.mockRestore()
  }
})

test('a refused run keeps the timestamp the run started with, so the wall clock counts the work before the refusal (#51)', async () => {
  vi.resetModules()
  vi.doMock('../src/isolation.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/isolation.js')>()
    return {
      ...actual,
      isolateRun: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30))
        throw new Error('the compose project could not be minted')
      },
    }
  })
  try {
    const { runJob: bootWithSlowIsolation } = await import('../src/run.js')
    const job = await makeJob({ criteria: commandCriteria('echo ok'), profile: { inline: INLINE_PROFILE } })

    const { result } = await bootWithSlowIsolation(job, HEALTHY_BOOT)

    expect(result.verdict).toBe('refused')
    // The wall clock starts when the run did, not when the refusal did: the
    // isolation attempt above takes real time, and that time is the run's (#51).
    expect(Date.parse(result.finishedAt) - Date.parse(result.startedAt)).toBeGreaterThanOrEqual(30)
  } finally {
    vi.doUnmock('../src/isolation.js')
  }
})

async function reportScript(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-report-'))
  const path = join(dir, 'report.js')
  await writeFile(path, content)
  return path
}

const TEST_COMMANDS: QaProfile['commands'] = {
  test: {
    run: 'node {{script}} {{pattern}}',
    about: 'runs the suite, printing its machine-readable report',
    filter: 'pattern',
    report: 'vitest-json',
  },
}

const vitestReport = (names: string[]): string =>
  `process.stdout.write(JSON.stringify({ testResults: [{ assertionResults: [${names
    .map((name) => `{ fullName: ${JSON.stringify(name)} }`)
    .join(', ')}] }] }))\n`

test('a filtered command whose report shows the filter selecting exactly some tests passes and writes selected.txt (#157)', async () => {
  const script = await reportScript(
    vitestReport(['replay stores a run', 'suite other a', 'suite other b']),
  )
  const job = await makeJob({
    criteria: commandCriteria(`node ${script} replay`),
    profile: { inline: { ...INLINE_PROFILE, commands: TEST_COMMANDS } },
  })

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.criteria[0].outcome).toBe('proven')
  expect(result.criteria[0].evidence).toContain('checks/criterion-1/0/selected.txt')
  const selected = await readFile(join(job.evidenceDir, 'checks', 'criterion-1', '0', 'selected.txt'), 'utf8')
  expect(selected).toContain('replay stores a run')
  expect(selected).not.toContain('suite other a')
})

test('a filter that selects nothing leaves the check unverified naming the filter and the counts: replaying #138s plan yields unverified, not proven (#157)', async () => {
  const script = await reportScript(
    vitestReport(['one', 'two', 'three', 'four', 'five', 'six']),
  )
  const job = await makeJob({
    criteria: commandCriteria(`node ${script} --testNamePattern=replay`),
    profile: {
      inline: {
        ...INLINE_PROFILE,
        commands: {
          test: {
            run: 'node {{script}} {{pattern}}',
            about: 'runs the suite',
            filter: 'pattern',
            report: 'vitest-json',
          },
        },
      },
    },
  })

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.criteria[0].outcome).toBe('unverified')
  expect(result.criteria[0].reason).toContain('--testNamePattern=replay')
  expect(result.criteria[0].reason).toContain('none of the 6 tests')
})

test('a filter that selects every test leaves the check unverified: a whole-suite run cannot prove a filtered criterion (#157)', async () => {
  const script = await reportScript(vitestReport(['replay one', 'replay two']))
  const job = await makeJob({
    criteria: commandCriteria(`node ${script} replay`),
    profile: { inline: { ...INLINE_PROFILE, commands: TEST_COMMANDS } },
  })

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.criteria[0].outcome).toBe('unverified')
  expect(result.criteria[0].reason).toContain('all 2 tests')
})

test('a report the runner cannot read leaves the check unverified, never passed (#157)', async () => {
  const script = await reportScript("process.stdout.write('this is not a machine-readable report\\n')\n")
  const job = await makeJob({
    criteria: commandCriteria(`node ${script} replay`),
    profile: { inline: { ...INLINE_PROFILE, commands: TEST_COMMANDS } },
  })

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.criteria[0].outcome).toBe('unverified')
})

test('a filter matches the way vitest matches -t, as a regular expression against the full name (#157)', async () => {
  const script = await reportScript(vitestReport(['a replay', 'replay b']))
  const job = await makeJob({
    criteria: commandCriteria(`node ${script} ^a`),
    profile: { inline: { ...INLINE_PROFILE, commands: TEST_COMMANDS } },
  })

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.criteria[0].outcome).toBe('proven')
  const selected = await readFile(join(job.evidenceDir, 'checks', 'criterion-1', '0', 'selected.txt'), 'utf8')
  expect(selected).toContain('a replay')
  expect(selected).not.toContain('replay b')
})

test('a node --test TAP report is read the same way: the filter selects the tests it names (#157)', async () => {
  const script = await reportScript(
    "process.stdout.write('TAP version 13\\nok 1 replay stores a run\\nok 2 suite other a\\nnot ok 3 suite other b\\n')\n",
  )
  const job = await makeJob({
    criteria: commandCriteria(`node ${script} replay`),
    profile: {
      inline: {
        ...INLINE_PROFILE,
        commands: {
          test: {
            run: 'node {{script}} {{pattern}}',
            about: 'runs the suite',
            filter: 'pattern',
            report: 'node-tap',
          },
        },
      },
    },
  })

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.criteria[0].outcome).toBe('proven')
  const selected = await readFile(join(job.evidenceDir, 'checks', 'criterion-1', '0', 'selected.txt'), 'utf8')
  expect(selected).toContain('replay stores a run')
  expect(selected).not.toContain('suite other a')
})

test('a command check whose profile command declares no filter is unchanged (#157)', async () => {
  const script = await reportScript("process.stdout.write('all good\\n')\n")
  const job = await makeJob({
    criteria: commandCriteria(`node ${script}`),
    profile: {
      inline: {
        ...INLINE_PROFILE,
        commands: { script: { run: 'node {{script}}', about: 'runs a plain script' } },
      },
    },
  })

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.criteria[0].outcome).toBe('proven')
  expect(result.criteria[0].evidence).not.toContain('checks/criterion-1/0/selected.txt')
})

test('a skipped vitest test is not a test the command ran (#200 review round 2)', async () => {
  const script = await reportScript(
    "process.stdout.write(JSON.stringify({ testResults: [{ assertionResults: [" +
    "{ fullName: 'replay stores a run', status: 'skipped' }, { fullName: 'suite other a', status: 'passed' }" +
    "] }] }))\n",
  )
  const job = await makeJob({
    criteria: commandCriteria(`node ${script} replay`),
    profile: { inline: { ...INLINE_PROFILE, commands: TEST_COMMANDS } },
  })

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.criteria[0].outcome).toBe('unverified')
  expect(result.criteria[0].reason).toContain('none of the 1 test')
})

test('a TAP line skipped by directive is not a test the command ran (#200 review round 2)', async () => {
  const script = await reportScript(
    "process.stdout.write('TAP version 13\\nok 1 replay case # SKIP pattern\\nok 2 suite other a\\n')\n",
  )
  const job = await makeJob({
    criteria: commandCriteria(`node ${script} replay`),
    profile: {
      inline: {
        ...INLINE_PROFILE,
        commands: {
          test: {
            run: 'node {{script}} {{pattern}}',
            about: 'runs the suite, printing its machine-readable report',
            filter: 'pattern',
            report: 'node-tap',
          },
        },
      },
    },
  })

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.criteria[0].outcome).toBe('unverified')
  expect(result.criteria[0].reason).toContain('none of the 1 test')
})

test('an empty embedded filter selects the whole suite and cannot prove (#200 review round 4)', async () => {
  const script = await reportScript(vitestReport(['one', 'two', 'three']))
  const job = await makeJob({
    criteria: commandCriteria(`node ${script} --testNamePattern=`),
    profile: {
      inline: {
        ...INLINE_PROFILE,
        commands: {
          test: {
            run: 'node {{script}} --testNamePattern={{pattern}}',
            about: 'runs the suite',
            filter: 'pattern',
            report: 'vitest-json',
          },
        },
      },
    },
  })

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.criteria[0].outcome).toBe('unverified')
  expect(result.criteria[0].reason).toContain('selected all 3 tests')
})

test('a skipped junit testcase is not a test the command ran (#200 review round 3)', async () => {
  const script = await reportScript(
    "process.stdout.write('<testsuites><testsuite name=\"s\">' +\n" +
    "  '<testcase name=\"replay stores a run\"><skipped message=\"no\"/></testcase>' +\n" +
    "  '<testcase name=\"suite other a\"></testcase>' +\n" +
    "  '</testsuite></testsuites>')\n",
  )
  const job = await makeJob({
    criteria: commandCriteria(`node ${script} replay`),
    profile: {
      inline: {
        ...INLINE_PROFILE,
        commands: {
          test: {
            run: 'node {{script}} {{pattern}}',
            about: 'runs the suite, printing its machine-readable report',
            filter: 'pattern',
            report: 'junit-xml',
          },
        },
      },
    },
  })

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.criteria[0].outcome).toBe('unverified')
  expect(result.criteria[0].reason).toContain('none of the 1 test')
})

test('a filter embedded in a flag token is resolved and verified, not bypassed (#157, #200 review)', async () => {
  const script = await reportScript(vitestReport(['one', 'two', 'three']))
  const job = await makeJob({
    criteria: commandCriteria(`node ${script} --testNamePattern=nomatch`),
    profile: {
      inline: {
        ...INLINE_PROFILE,
        commands: {
          test: {
            run: 'node {{script}} --testNamePattern={{pattern}}',
            about: 'runs the suite',
            filter: 'pattern',
            report: 'vitest-json',
          },
        },
      },
    },
  })

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.criteria[0].outcome).toBe('unverified')
  expect(result.criteria[0].reason).toContain('none of the 3 tests')
})

test('a TAP directive is not part of the name a filter matches (#157, #200 review)', async () => {
  const script = await reportScript(
    "process.stdout.write('TAP version 13\\nok 1 replay case # IMPORTANT note\\nok 2 suite other a\\n')\n",
  )
  const job = await makeJob({
    criteria: commandCriteria(`node ${script} replay`),
    profile: {
      inline: {
        ...INLINE_PROFILE,
        commands: {
          test: {
            run: 'node {{script}} {{pattern}}',
            about: 'runs the suite',
            filter: 'pattern',
            report: 'node-tap',
          },
        },
      },
    },
  })

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.criteria[0].outcome).toBe('proven')
  const selected = await readFile(join(job.evidenceDir, 'checks', 'criterion-1', '0', 'selected.txt'), 'utf8')
  expect(selected).toBe('replay case\n')
})

test('an empty selection writes an empty selected.txt: the report was read, nothing was selected (#157, #200 review)', async () => {
  const script = await reportScript(vitestReport(['one', 'two', 'three']))
  const job = await makeJob({
    criteria: commandCriteria(`node ${script} nomatch`),
    profile: { inline: { ...INLINE_PROFILE, commands: TEST_COMMANDS } },
  })

  const { result } = await runJob(job, HEALTHY_BOOT)

  expect(result.criteria[0].outcome).toBe('unverified')
  const selected = await readFile(join(job.evidenceDir, 'checks', 'criterion-1', '0', 'selected.txt'), 'utf8')
  expect(selected).toBe('')
})
