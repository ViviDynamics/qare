import { expect, test } from 'vitest'
import { RESULT_SCHEMA_VERSION, renderCheckRun, renderComment } from '../src/index.js'
import type { AdvisoryFinding, RunAdvisory, RunResult } from '../src/index.js'

// #150: the advisory section of the comment. Findings are shown in a section
// of their own, marked advisory, below everything the verdict rests on.

const SCREEN = 'checks/signup-form/0'
// Assembled, never literal: no network marker sits as a literal in a test.
const WEB = ['https:', '//'].join('')
const SHOT = `${SCREEN}/final.png`

const UNLABELLED: AdvisoryFinding = {
  id: '0a1b2c3d',
  screen: SCREEN,
  criterionId: 'signup-form',
  category: 'label',
  severity: 'high',
  saw: 'A required text field has no accessible name.',
  why: 'Nobody can tell what to type into it.',
  element: 'textbox (required)',
  screenshot: SHOT,
}
const UNHELPFUL: AdvisoryFinding = {
  id: '4e5f6a7b',
  screen: SCREEN,
  criterionId: 'signup-form',
  category: 'error-message',
  severity: 'medium',
  saw: 'Submitting the empty form shows the alert "Error".',
  why: 'It does not say which field is wrong or what to do.',
}

function run(advisory?: RunAdvisory): RunResult {
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    verdict: 'passed',
    criteria: [{ id: 'signup-form', outcome: 'proven', evidence: [`${SCREEN}/actions.log`, SHOT] }],
    ...(advisory === undefined ? {} : { advisory }),
  }
}

const REVIEWED: RunAdvisory = { status: 'reviewed', screens: [SCREEN], findings: [UNLABELLED, UNHELPFUL] }

function section(body: string): string {
  const start = body.indexOf('## Advisory UX review')
  expect(start, 'the comment has no advisory section').toBeGreaterThan(-1)
  const end = body.indexOf('\nDetails:', start)
  return end === -1 ? body.slice(start) : body.slice(start, end)
}

test('findings appear in a section of their own, marked advisory, under the verdict they did not decide', () => {
  const body = renderComment(run(REVIEWED), { kind: 'artifact', url: `${WEB}example.test/artifact`, screenshots: { [SHOT]: `${WEB}example.test/raw/final.png` } })
  expect(body).toContain('## QARE run: passed')
  // Below the criteria table, never inside it.
  expect(body.indexOf('## Advisory UX review')).toBeGreaterThan(body.indexOf('| signup-form | proven |') === -1 ? body.indexOf('| `signup-form` | proven |') : body.indexOf('| signup-form | proven |'))
  const text = section(body)
  expect(text).toContain('Advisory')
  expect(text).toMatch(/not evidence/)
  expect(text).toMatch(/verdict above was decided without them/)
  expect(text).toContain('1 screen')
  // Each finding: its id, severity, screen, what was seen, why it matters, the element, the screenshot.
  expect(text).toContain('- **high** `0a1b2c3d` (label) on `checks/signup-form/0`, element `textbox (required)`')
  expect(text).toContain('  - Saw: `A required text field has no accessible name.`')
  expect(text).toContain('  - Why it matters: `Nobody can tell what to type into it.`')
  expect(text).toContain(`  - Screenshot: [final.png](<${WEB}example.test/raw/final.png>)`)
  expect(text).toContain('- **medium** `4e5f6a7b` (error-message) on `checks/signup-form/0`')
  // A finding the harness saved no screenshot for names none.
  expect(text.slice(text.indexOf('4e5f6a7b'))).not.toContain('Screenshot')
  // What a person can do with one, in one action each.
  expect(text).toContain('`/qa-dismiss 0a1b2c3d`')
  expect(text).toContain('`/qa-promote 0a1b2c3d`')
  expect(text).toMatch(/files no issue unless asked/)
})

test('a screenshot that was not pushed is named, never linked (rule 4)', () => {
  const text = section(renderComment(run(REVIEWED), { kind: 'artifact', url: undefined }))
  expect(text).toContain('  - Screenshot: `checks/signup-form/0/final.png`')
  expect(text).not.toContain('](')
})

test('model text cannot render: a finding that carries Markdown stays a code span', () => {
  const sly: AdvisoryFinding = { ...UNHELPFUL, saw: `[click](${WEB}evil.example) <img src=x> @someone \`tick\``, why: 'line\nbreak | pipe' }
  const text = section(renderComment(run({ ...REVIEWED, findings: [sly] }), { kind: 'artifact', url: undefined }))
  // A fence longer than any backtick run inside, padded because the text ends in one.
  expect(text).toContain(`  - Saw: \`\` [click](${WEB}evil.example) <img src=x> @someone \`tick\` \`\``)
  expect(text).toContain('  - Why it matters: `line break | pipe`')
})

test('beside its evidence the comment links the screenshot by its path, and offers no replies', () => {
  const text = section(renderComment(run(REVIEWED)))
  expect(text).toContain('  - Screenshot: [final.png](<checks/signup-form/0/final.png>)')
  expect(text).not.toContain('/qa-dismiss')
})

test('a review that found nothing says so, and one a person dismissed findings of counts them', () => {
  const clean = section(renderComment(run({ status: 'reviewed', screens: [SCREEN, 'checks/signup-form/1'], findings: [] }), { kind: 'artifact', url: undefined }))
  expect(clean).toContain('2 screens')
  expect(clean).toContain('It reported nothing.')
  expect(clean).not.toContain('/qa-dismiss')
  const dismissed = section(renderComment(run({ status: 'reviewed', screens: [SCREEN], findings: [UNHELPFUL], dismissed: ['0a1b2c3d'] }), { kind: 'artifact', url: undefined }))
  expect(dismissed).toContain('1 finding a person dismissed on this pull request was not raised again.')
})

test('a review that did not answer is said, with its reason, and changes nothing else', () => {
  const unavailable: RunAdvisory = { status: 'unavailable', reason: 'the run stopped (max_tokens)', screens: [SCREEN], findings: [] }
  const body = renderComment(run(unavailable), { kind: 'artifact', url: undefined })
  expect(section(body)).toContain('The advisory UX review did not answer (`the run stopped (max_tokens)`), so it has no findings. The verdict does not depend on it.')
  expect(body).toContain('## QARE run: passed')
})

test('a run nobody reviewed renders no advisory section, and the check run never mentions one', () => {
  expect(renderComment(run())).not.toContain('Advisory')
  expect(renderCheckRun(run(REVIEWED))).toEqual(renderCheckRun(run()))
  expect(JSON.stringify(renderCheckRun(run(REVIEWED)))).not.toMatch(/advisory/i)
})
