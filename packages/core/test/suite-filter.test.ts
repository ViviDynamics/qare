import { expect, test } from 'vitest'

import {
  JobValidationError,
  PlanValidationError,
  fingerprintPlan,
  jobFromPlan,
  loadJobFromText,
  parsePlan,
  suiteFilterViolation,
} from '../src/index.js'

// A planned suite check may name the one test a suite runs (#376). The value
// is the model's, so it is held to a fixed form before it reaches a command.

test('a filter that names a test or a path is accepted', () => {
  for (const filter of [
    'spec/models/invoice_spec.rb',
    'spec/models/invoice_spec.rb:42',
    'InvoiceTotals',
    'invoice.*totals',
    'features/sign_in.feature',
    'tests/test_billing.py::test_refund',
    '^Invoice_totals',
  ])
    expect(suiteFilterViolation(filter), filter).toBeUndefined()
})

test('a filter that a shell, an option parser or a path climb would read differently is refused', () => {
  for (const filter of [
    '',
    'two words',
    '--require=evil.rb',
    '-e',
    'spec;rm',
    'a|b',
    'a&&b',
    '$(id)',
    '`id`',
    'total$',
    'a>b',
    "it's",
    '"quoted"',
    'a\\b',
    '{{run.id}}',
    '../../etc/passwd',
    'spec/../../secret',
    '/etc/passwd',
    'line\nbreak',
    'x'.repeat(201),
  ])
    expect(suiteFilterViolation(filter), JSON.stringify(filter)).toBeDefined()
})

const PLAN = (check: Record<string, unknown>) =>
  ({ schemaVersion: '1', criteria: [{ id: 'c1', text: 'totals add up', checks: [{ kind: 'flow', name: 'totals', suite: 'rspec', ...check }] }] })

test('a plan carries a suite check filter to the job', () => {
  const plan = parsePlan(PLAN({ filter: 'spec/models/invoice_spec.rb' }))
  expect(plan.criteria[0]).toMatchObject({ checks: [{ kind: 'flow', suite: 'rspec', filter: 'spec/models/invoice_spec.rb' }] })
  const { job } = jobFromPlan(plan, { id: 'pr-1', repoPath: '/work', baseRef: 'a', headRef: 'b', profile: { path: '.qa' }, evidenceDir: 'evidence' })
  expect(job.criteria[0]?.checks).toEqual([{ kind: 'flow', suite: 'rspec', filter: 'spec/models/invoice_spec.rb' }])
})

test('a plan refuses an unsafe filter, and a filter on anything but a suite', () => {
  expect(() => parsePlan(PLAN({ filter: '--require=evil.rb' }))).toThrow(PlanValidationError)
  expect(() =>
    parsePlan({ schemaVersion: '1', criteria: [{ id: 'c1', text: 'x', checks: [{ kind: 'flow', name: 'n', actions: [{ action: 'capture' }], filter: 'a' }] }] }),
  ).toThrow(PlanValidationError)
})

test('the filter is part of the locked check', () => {
  expect(fingerprintPlan(parsePlan(PLAN({ filter: 'a_spec.rb' })))).not.toBe(fingerprintPlan(parsePlan(PLAN({ filter: 'b_spec.rb' }))))
  expect(fingerprintPlan(parsePlan(PLAN({ filter: 'a_spec.rb' })))).not.toBe(fingerprintPlan(parsePlan(PLAN({}))))
})

const JOB = (filter: string) => `
id: job-filter
repoPath: .
baseRef: main
headRef: HEAD
profile: { inline: {} }
evidenceDir: evidence
post: none
criteria:
  - id: c1
    text: x
    checks:
      - kind: flow
        suite: rspec
        filter: ${JSON.stringify(filter)}
`

test('a job carries a safe filter and refuses an unsafe one when it loads', () => {
  expect(loadJobFromText(JOB('spec/models/invoice_spec.rb')).criteria[0]?.checks?.[0]).toEqual({
    kind: 'flow',
    suite: 'rspec',
    filter: 'spec/models/invoice_spec.rb',
  })
  expect(() => loadJobFromText(JOB('$(id)'))).toThrow(JobValidationError)
})
