import { expect, test } from 'vitest'

import { jobFromPlan, parsePlan, type Plan } from '../src/index.js'

const CONTEXT = {
  id: 'pr-104',
  repoPath: '/work',
  baseRef: 'abc123',
  headRef: 'def456',
  profile: { path: '.qa' },
  evidenceDir: 'evidence',
}

function plan(criteria: unknown[]): Plan {
  return parsePlan({ schemaVersion: '1', criteria })
}

const COMMAND = { kind: 'command', name: 'login unit', command: 'npm test -- login' }

test('a command check becomes a runnable check on the job', () => {
  const { job } = jobFromPlan(plan([{ id: 'c1', text: 'logs in', checks: [COMMAND] }]), CONTEXT)

  expect(job.criteria).toEqual([
    { id: 'c1', text: 'logs in', checks: [{ kind: 'command', run: 'npm test -- login' }] },
  ])
})

test('the run context comes from the caller, not from the plan', () => {
  const { job } = jobFromPlan(plan([{ id: 'c1', text: 'logs in', checks: [COMMAND] }]), CONTEXT)

  expect(job).toMatchObject({
    id: 'pr-104',
    repoPath: '/work',
    baseRef: 'abc123',
    headRef: 'def456',
    profile: { path: '.qa' },
    evidenceDir: 'evidence',
    post: 'none',
  })
})

test('an unplannable criterion is carried, so it is reported rather than forgotten', () => {
  // Dropping it would shrink the run: the criterion would vanish from the
  // evidence table and nobody would see that nothing checked it.
  const { job, notes } = jobFromPlan(
    plan([{ id: 'c1', text: 'email arrives', unplannable: 'needs a mailbox' }]),
    CONTEXT,
  )

  expect(job.criteria).toEqual([{ id: 'c1', text: 'email arrives', unrunnable: 'the planner could not plan it: needs a mailbox' }])
  expect(notes.join(' ')).toContain('needs a mailbox')
})

test('a check kind the runner cannot execute is named, not silently dropped', () => {
  const { job, notes } = jobFromPlan(
    plan([
      {
        id: 'c1',
        text: 'looks right',
        checks: [{ kind: 'visual', name: 'home', screenshot: 'home' }],
      },
    ]),
    CONTEXT,
  )

  expect(job.criteria[0]?.checks).toBeUndefined()
  // The result says why nothing ran, not only the notes on stderr.
  expect(job.criteria[0]?.unrunnable).toBe('the plan checks it only with visual checks, which the runner does not execute yet')
  expect(notes.join(' ')).toMatch(/visual/)
  expect(notes.join(' ')).toContain('c1')
})

test('a criterion mixing runnable and unrunnable checks keeps the runnable ones', () => {
  const { job, notes } = jobFromPlan(
    plan([
      {
        id: 'c1',
        text: 'logs in',
        checks: [COMMAND, { kind: 'visual', name: 'home', screenshot: 'home' }],
      },
    ]),
    CONTEXT,
  )

  expect(job.criteria[0]?.checks).toEqual([{ kind: 'command', run: 'npm test -- login' }])
  expect(job.criteria[0]?.skipped).toBe('1 of its planned checks did not run (visual), which the runner does not execute yet')
  expect(notes.join(' ')).toMatch(/visual/)
  expect(notes.join(' ')).toContain('c1')
})

test('flow checks are carried to the job, with suites and typed actions', () => {
  const actions = [
    { action: 'open', url: ['http:', '//localhost:3000'].join('') },
    { action: 'type', element: { role: 'textbox', name: 'Email' }, value: 'me@example.com' },
    { action: 'click', element: { testId: 'sign-in' } },
    { action: 'assertText', text: 'Welcome' },
  ]
  const { job, notes } = jobFromPlan(
    plan([
      {
        id: 'c1',
        text: 'logs in',
        checks: [
          { kind: 'flow', name: 'login flow', suite: 'e2e' },
          { kind: 'flow', name: 'login actions', actions },
        ],
      },
    ]),
    CONTEXT,
  )

  expect(job.criteria[0]?.checks).toEqual([
    { kind: 'flow', suite: 'e2e' },
    { kind: 'flow', actions },
  ])
  expect(notes.join(' ')).not.toMatch(/flow/)
})

test('the drop note names flow among the kinds the runner executes', () => {
  const { notes } = jobFromPlan(
    plan([
      {
        id: 'c1',
        text: 'x',
        checks: [{ kind: 'visual', name: 'home', screenshot: 'home' }],
      },
    ]),
    CONTEXT,
  )

  expect(notes.join(' ')).toMatch(/command, mail, flow and tool checks only/)
})

test('a plan whose criteria are all unrunnable says so', () => {
  const { job, notes } = jobFromPlan(
    plan([
      { id: 'c1', text: 'one', unplannable: 'no way to check it' },
      { id: 'c2', text: 'two', checks: [{ kind: 'visual', name: 'x', screenshot: 'x' }] },
    ]),
    CONTEXT,
  )

  expect(job.criteria.every((criterion) => criterion.checks === undefined)).toBe(true)
  expect(notes.join(' ')).toMatch(/nothing in this plan can be run/i)
})

test('post defaults to none, because posting is the caller asking for it', () => {
  const { job } = jobFromPlan(plan([{ id: 'c1', text: 'x', checks: [COMMAND] }]), CONTEXT)

  expect(job.post).toBe('none')
})

test('a post target the runner cannot post to is refused, not silently carried', () => {
  // The built job passes through the job validator, which understands "none"
  // only, so a plan-run cannot smuggle a post target the job form refuses.
  expect(() =>
    jobFromPlan(plan([{ id: 'c1', text: 'x', checks: [COMMAND] }]), {
      ...CONTEXT,
      post: 'ViviDynamics/qare#104',
    }),
  ).toThrow(/unknown post target/)
})

test('a job criterion carrying both checks and an unrunnable reason is refused as contradictory', async () => {
  const { parseJob } = await import('../src/index.js')
  const job = {
    id: 'j', repoPath: '/work', baseRef: 'a', headRef: 'b', profile: { path: '.qa' }, evidenceDir: 'e', post: 'none',
    criteria: [{ id: 'c1', text: 'x', unrunnable: 'no way', checks: [{ kind: 'command', run: 'true' }] }],
  }
  expect(() => parseJob(job)).toThrow(/criteria\[0\]\.unrunnable/)
})

test('a plan that names its profiles builds one run over several apps, each with its own criteria', () => {
  const { job, notes } = jobFromPlan(
    parsePlan({
      schemaVersion: '1',
      profiles: [
        { name: 'admin', path: '.qa/admin' },
        { name: 'docs', path: '.qa/docs' },
      ],
      criteria: [
        { id: 'c1', text: 'admin boots', checks: [COMMAND], profile: 'admin' },
        { id: 'c2', text: 'docs boots', checks: [COMMAND], profile: 'docs' },
      ],
    }),
    CONTEXT,
  )

  expect('profiles' in job).toBe(true)
  if (!('profiles' in job)) throw new Error('expected the several-profile job form')
  expect(job.profiles).toEqual([
    {
      name: 'admin',
      profile: { path: '.qa/admin' },
      criteria: [{ id: 'c1', text: 'admin boots', checks: [{ kind: 'command', run: 'npm test -- login' }] }],
    },
    {
      name: 'docs',
      profile: { path: '.qa/docs' },
      criteria: [{ id: 'c2', text: 'docs boots', checks: [{ kind: 'command', run: 'npm test -- login' }] }],
    },
  ])
  expect(notes).toEqual([])
})

test('an app the plan planned no criterion against takes no part in the run, and the run says so', () => {
  const { job, notes } = jobFromPlan(
    parsePlan({
      schemaVersion: '1',
      profiles: [
        { name: 'admin', path: '.qa/admin' },
        { name: 'docs', path: '.qa/docs' },
      ],
      criteria: [{ id: 'c1', text: 'admin boots', checks: [COMMAND], profile: 'admin' }],
    }),
    CONTEXT,
  )

  expect('profiles' in job && job.profiles.map((group) => group.name)).toEqual(['admin'])
  expect(notes.join(' ')).toContain('docs')
  expect(notes.join(' ')).toContain('no criterion in the plan is checked against this app')
})

test('a plan that names several apps refuses a criterion that names no app', () => {
  expect(() =>
    parsePlan({
      schemaVersion: '1',
      profiles: [
        { name: 'admin', path: '.qa/admin' },
        { name: 'docs', path: '.qa/docs' },
      ],
      criteria: [
        { id: 'c1', text: 'admin boots', checks: [COMMAND], profile: 'admin' },
        { id: 'c2', text: 'nobody planned me', checks: [COMMAND] },
      ],
    }),
  ).toThrow(/criterion "c2" names no profile/)
})

test('a criterion naming an app the plan does not plan is refused at load', () => {
  expect(() =>
    parsePlan({
      schemaVersion: '1',
      profiles: [{ name: 'admin', path: '.qa/admin' }],
      criteria: [{ id: 'c1', text: 'x', checks: [COMMAND], profile: 'docs' }],
    }),
  ).toThrow(/names "docs", which the plan does not plan/)
})

test('a planned profile path that carries a dot segment is refused, because no git diff path matches it', () => {
  expect(() =>
    parsePlan({
      schemaVersion: '1',
      profiles: [{ name: 'admin', path: './apps/admin/.qa' }],
      criteria: [{ id: 'c1', text: 'x', checks: [COMMAND], profile: 'admin' }],
    }),
  ).toThrow(/carries a "\." segment/)
})

test('an unplannable criterion names its app too, so it is reported against the right app', () => {
  const { job } = jobFromPlan(
    parsePlan({
      schemaVersion: '1',
      profiles: [
        { name: 'admin', path: '.qa/admin' },
        { name: 'docs', path: '.qa/docs' },
      ],
      criteria: [
        { id: 'c1', text: 'admin mail', unplannable: 'needs a mailbox', profile: 'admin' },
        { id: 'c2', text: 'docs boots', checks: [COMMAND], profile: 'docs' },
      ],
    }),
    CONTEXT,
  )

  expect('profiles' in job && job.profiles[0]).toMatchObject({
    name: 'admin',
    criteria: [{ id: 'c1', text: 'admin mail', unrunnable: 'the planner could not plan it: needs a mailbox' }],
  })
})

test('a plan that names no profiles and a context that names no profile cannot build a job', () => {
  const contextWithoutProfile = { ...CONTEXT, profile: undefined }
  expect(() =>
    jobFromPlan(plan([{ id: 'c1', text: 'x', checks: [COMMAND] }]), contextWithoutProfile),
  ).toThrow(/names no profile/)
})

test('a criterion id that climbs out of the evidence directory is refused, whatever form builds the job', () => {
  expect(() =>
    jobFromPlan(plan([{ id: '../outside', text: 'x', checks: [COMMAND] }]), CONTEXT),
  ).toThrow(/must not contain path separators/)
})

test('criterion ids must be unique across every group of a several-profile plan', () => {
  expect(() =>
    jobFromPlan(
      parsePlan({
        schemaVersion: '1',
        profiles: [
          { name: 'admin', path: '.qa/admin' },
          { name: 'docs', path: '.qa/docs' },
        ],
        criteria: [
          { id: 'c1', text: 'x', checks: [COMMAND], profile: 'admin' },
          { id: 'c1', text: 'y', checks: [COMMAND], profile: 'docs' },
        ],
      }),
      CONTEXT,
    ),
  ).toThrow(/duplicate criterion id "c1" in profiles admin and docs/)
})

test('a planned profile name that cannot be an evidence file name is refused at load', () => {
  expect(() =>
    parsePlan({
      schemaVersion: '1',
      profiles: [{ name: 'foo/../../outside', path: '.qa/admin' }],
      criteria: [{ id: 'c1', text: 'x', checks: [COMMAND], profile: 'foo/../../outside' }],
    }),
  ).toThrow(/must not contain path separators/)
})

test('a planned profile cannot take the name the single root profile reserves', () => {
  expect(() =>
    parsePlan({
      schemaVersion: '1',
      profiles: [{ name: 'default', path: '.qa/default' }],
      criteria: [{ id: 'c1', text: 'x', checks: [COMMAND], profile: 'default' }],
    }),
  ).toThrow(/reserved for the single root profile/)
})

test('a several-app job whose profile lives outside the .qa layout is refused', async () => {
  const { parseJob } = await import('../src/index.js')
  expect(() =>
    parseJob({
      id: 'j', repoPath: '/work', baseRef: 'a', headRef: 'b', evidenceDir: 'e', post: 'none',
      profiles: [
        {
          name: 'admin',
          profile: { path: 'apps/admin/.qa' },
          criteria: [{ id: 'c1', text: 'x', checks: [{ kind: 'command', run: 'true' }] }],
        },
      ],
    }),
  ).toThrow(/profile path "apps\/admin\/\.qa" must be "\.qa\/admin"/)
})
