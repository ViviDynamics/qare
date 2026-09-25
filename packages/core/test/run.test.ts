import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  JobValidationError,
  loadJobFromText,
  loadResult,
  renderComment,
  runJob,
  type Job,
  type JobCriterion,
  type JobProfileRef,
  type QaProfile,
} from '../src/index.js'

const HEALTH_URL = ['http:', '//localhost:3000/up'].join('')

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
      evidence: ['checks/criterion-1/0/stdout.txt', 'checks/criterion-1/0/stderr.txt'],
    },
    {
      id: 'criterion-2',
      outcome: 'proven',
      evidence: ['checks/criterion-2/0/stdout.txt', 'checks/criterion-2/0/stderr.txt'],
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
      evidence: ['checks/criterion-1/0/stdout.txt', 'checks/criterion-1/0/stderr.txt'],
    },
  ])
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
      evidence: ['checks/criterion-1/0/stdout.txt', 'checks/criterion-1/0/stderr.txt'],
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
      reason: expect.stringContaining('could not start'),
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
