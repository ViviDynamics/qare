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

  expect(job.criteria).toEqual([{ id: 'c1', text: 'email arrives' }])
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
  expect(notes.join(' ')).toMatch(/visual/)
  expect(notes.join(' ')).toContain('c1')
})

test('flow checks are carried to the job, with suites and typed actions', () => {
  const actions = [
    { action: 'open', url: ['http:', '//localhost:3000'].join('') },
    { action: 'type', element: { role: 'textbox', name: 'Email' }, value: 'me@example.com' },
    { action: 'click', element: { testId: 'sign-in' } },
    { action: 'assert', text: 'Welcome' },
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

  expect(notes.join(' ')).toMatch(/command, mail and flow checks only/)
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

test('a post target is carried when the caller names one', () => {
  const { job } = jobFromPlan(plan([{ id: 'c1', text: 'x', checks: [COMMAND] }]), {
    ...CONTEXT,
    post: 'ViviDynamics/qare#104',
  })

  expect(job.post).toBe('ViviDynamics/qare#104')
})
