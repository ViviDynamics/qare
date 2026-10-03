import { expect, test } from 'vitest'
import {
  FakeAgentRunner,
  RESULT_SCHEMA_VERSION,
  UX_REVIEW_OUTPUT_SCHEMA,
  advisoryFindingId,
  advisoryScreens,
  consumeUxFindings,
  redactionRules,
  reviewJudged,
  runUxReview,
} from '../src/index.js'
import type { AdvisoryScreen, AgentRunResult, RunResult } from '../src/index.js'

// #150: the advisory UX review. A model reads what the run saw of the screens
// the change touched and reports findings a person reads. Nothing here can
// reach a verdict.

const SIGNUP = 'checks/signup-form/0'

/** A run whose flow drove a sign-up form, and whose command check drove nothing. */
function judged(overrides: Partial<RunResult> = {}): RunResult {
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    verdict: 'passed',
    criteria: [
      {
        id: 'signup-form',
        outcome: 'proven',
        evidence: [`${SIGNUP}/actions.log`, `${SIGNUP}/assert-2.json`, `${SIGNUP}/capture-1.png`, `${SIGNUP}/final.png`, `${SIGNUP}/a11y.json`, `${SIGNUP}/a11y/open-0-1280xlight.png`],
        base: { outcome: 'proven', evidence: ['base/checks/signup-form/0/actions.log'] },
      },
      { id: 'export-csv', outcome: 'proven', evidence: ['checks/export-csv/0/stdout.txt', 'checks/export-csv/0/command.json'] },
    ],
    ...overrides,
  }
}

const SCREENS: AdvisoryScreen[] = [
  { screen: SIGNUP, criterionId: 'signup-form', files: [`${SIGNUP}/actions.log`, `${SIGNUP}/assert-2.json`, `${SIGNUP}/a11y.json`], screenshot: `${SIGNUP}/final.png` },
]

const UNLABELLED = {
  screen: SIGNUP,
  category: 'label',
  severity: 'high',
  saw: 'A required text field has no accessible name.',
  why: 'Nobody can tell what to type into it.',
  element: 'textbox (required)',
}
const UNHELPFUL = {
  screen: SIGNUP,
  category: 'error-message',
  severity: 'medium',
  saw: 'Submitting the empty form shows the alert "Error".',
  why: 'It does not say which field is wrong or what to do.',
  element: 'alert "Error"',
}

function answered(findings: unknown): AgentRunResult {
  return { status: 'completed', stopReason: 'end_turn', usage: { inputTokens: 120, outputTokens: 40 }, output: JSON.stringify({ findings }) }
}

test('a screen is the evidence directory of a check that drove a page, with the screenshot the harness saved of it', () => {
  expect(advisoryScreens(judged())).toEqual(SCREENS)
})

test('a check that drove no page is no screen, and a run of command checks has none', () => {
  expect(advisoryScreens(judged({ criteria: [{ id: 'export-csv', outcome: 'proven', evidence: ['checks/export-csv/0/stdout.txt'] }] }))).toEqual([])
  // A suite runs a browser qare cannot see: its one text file is no screen.
  expect(advisoryScreens(judged({ criteria: [{ id: 'suite', outcome: 'proven', evidence: ['checks/suite/0/suite.txt'] }] }))).toEqual([])
})

test('the screenshot of a screen is the failure, else the final page, else the last capture, else an audit shot, and none is invented', () => {
  const screenOf = (files: string[]): AdvisoryScreen | undefined =>
    advisoryScreens(judged({ criteria: [{ id: 'c', outcome: 'failed', evidence: ['checks/c/0/actions.log', ...files.map((file) => `checks/c/0/${file}`)] }] }))[0]
  expect(screenOf(['final.png', 'failure.png', 'capture-1.png'])?.screenshot).toBe('checks/c/0/failure.png')
  expect(screenOf(['capture-1.png', 'final.png'])?.screenshot).toBe('checks/c/0/final.png')
  expect(screenOf(['capture-1.png', 'capture-12.png', 'capture-3.png'])?.screenshot).toBe('checks/c/0/capture-12.png')
  expect(screenOf(['a11y/open-0-1280xlight.png'])?.screenshot).toBe('checks/c/0/a11y/open-0-1280xlight.png')
  // No screenshot was saved (a one-time code was on the page): the screen is
  // still reviewed, and no finding on it can name a file that is not there.
  expect(screenOf([])).toEqual({ screen: 'checks/c/0', criterionId: 'c', files: ['checks/c/0/actions.log'] })
})

test("a finding's identity is its screen, its category and the element it names, not its wording", () => {
  const id = advisoryFindingId(UNLABELLED)
  expect(id).toMatch(/^[0-9a-f]{8}$/)
  expect(advisoryFindingId({ ...UNLABELLED, saw: 'The required input is missing a label.' })).toBe(id)
  expect(advisoryFindingId({ ...UNLABELLED, element: '  Textbox   (REQUIRED) ' })).toBe(id)
  expect(advisoryFindingId({ ...UNLABELLED, element: 'textbox "Email"' })).not.toBe(id)
  expect(advisoryFindingId({ ...UNLABELLED, category: 'copy' })).not.toBe(id)
  expect(advisoryFindingId({ ...UNLABELLED, screen: 'checks/signup-form/1' })).not.toBe(id)
  // With no element to hold on to, what it saw is the identity.
  const bare = { screen: SIGNUP, category: 'flow', saw: 'There is no way back from step two.' }
  expect(advisoryFindingId(bare)).toBe(advisoryFindingId({ ...bare, saw: ' there is no way back   from step two. ' }))
  expect(advisoryFindingId(bare)).not.toBe(advisoryFindingId({ ...bare, saw: 'Step two has no heading.' }))
})

test('findings are kept as the model gave them, each with the screenshot code attached', () => {
  const consumed = consumeUxFindings(JSON.stringify({ findings: [UNHELPFUL, UNLABELLED] }), SCREENS, [])
  expect(consumed).toEqual({
    findings: [
      // Most severe first, so the comment leads with what matters.
      { id: advisoryFindingId(UNLABELLED), ...UNLABELLED, criterionId: 'signup-form', screenshot: `${SIGNUP}/final.png` },
      { id: advisoryFindingId(UNHELPFUL), ...UNHELPFUL, criterionId: 'signup-form', screenshot: `${SIGNUP}/final.png` },
    ],
    dismissed: [],
  })
})

test('a finding about a screen the reviewer was not given is dropped', () => {
  const consumed = consumeUxFindings(JSON.stringify({ findings: [{ ...UNLABELLED, screen: 'checks/other/0' }, UNHELPFUL] }), SCREENS, [])
  expect(consumed?.findings.map((finding) => finding.category)).toEqual(['error-message'])
})

test('nothing the model writes beside a finding is carried: no file, no criterion, no outcome', () => {
  const smuggled = { ...UNLABELLED, screenshot: '../../etc/passwd', criterionId: 'export-csv', outcome: 'failed', id: 'deadbeef', verdict: 'failed' }
  const [finding] = consumeUxFindings(JSON.stringify({ findings: [smuggled] }), SCREENS, [])?.findings ?? []
  expect(finding).toEqual({ id: advisoryFindingId(UNLABELLED), ...UNLABELLED, criterionId: 'signup-form', screenshot: `${SIGNUP}/final.png` })
})

test('a finding a person dismissed is not raised again, and is counted as dismissed', () => {
  const dismissed = [{ id: advisoryFindingId(UNLABELLED), screen: SIGNUP, category: 'label', saw: UNLABELLED.saw, element: UNLABELLED.element }]
  const reworded = { ...UNLABELLED, saw: 'The required input still has no label.' }
  expect(consumeUxFindings(JSON.stringify({ findings: [reworded, UNHELPFUL] }), SCREENS, dismissed)).toEqual({
    findings: [{ id: advisoryFindingId(UNHELPFUL), ...UNHELPFUL, criterionId: 'signup-form', screenshot: `${SIGNUP}/final.png` }],
    dismissed: [advisoryFindingId(UNLABELLED)],
  })
})

test('the same finding twice is one finding, long text is cut, and the list is bounded', () => {
  const many = Array.from({ length: 30 }, (_, index) => ({ ...UNHELPFUL, element: `alert ${index}` }))
  const consumed = consumeUxFindings(JSON.stringify({ findings: [UNLABELLED, UNLABELLED, { ...UNLABELLED, element: 'x', saw: 'a'.repeat(5000), why: 'multi\nline\twhy' }, ...many] }), SCREENS, [])
  expect(consumed?.findings).toHaveLength(12)
  expect(consumed?.findings.filter((finding) => finding.id === advisoryFindingId(UNLABELLED))).toHaveLength(1)
  const long = consumed?.findings.find((finding) => finding.element === 'x')
  expect(long?.saw.length).toBe(300)
  expect(long?.saw.endsWith('…')).toBe(true)
  // One line each: a finding is a row of a comment, never a block of Markdown.
  expect(long?.why).toBe('multi line why')
})

test('an answer that is not a findings list is no answer', () => {
  expect(consumeUxFindings('looks great', SCREENS, [])).toBeUndefined()
  expect(consumeUxFindings(JSON.stringify({ verdict: 'passed' }), SCREENS, [])).toBeUndefined()
  expect(consumeUxFindings(JSON.stringify({ findings: [{ ...UNLABELLED, severity: 'blocker' }] }), SCREENS, [])).toBeUndefined()
  expect(consumeUxFindings(JSON.stringify({ findings: [{ ...UNLABELLED, category: 'vibes' }] }), SCREENS, [])).toBeUndefined()
  expect(consumeUxFindings(JSON.stringify({ findings: [{ ...UNLABELLED, saw: '' }] }), SCREENS, [])).toBeUndefined()
  expect(consumeUxFindings(undefined, SCREENS, [])).toBeUndefined()
  expect(consumeUxFindings(JSON.stringify({ findings: [] }), SCREENS, [])).toEqual({ findings: [], dismissed: [] })
})

test('the reviewer is asked through the runner with the read-only tool set, the screens, the criteria, QA.md, the house rules and what was dismissed', async () => {
  const runner = new FakeAgentRunner([answered([UNLABELLED])])
  const dismissed = [{ id: 'aaaaaaaa', screen: SIGNUP, category: 'copy', saw: 'The heading says Sign-up, the button says Register.' }]
  const advisory = await runUxReview(runner, {
    screens: SCREENS,
    texts: { 'signup-form': 'A visitor can sign up with an email address.' },
    qaMd: 'The app is a sign-up funnel.',
    houseRules: ['An error message says what to do next.'],
    dismissed,
  })
  expect(advisory).toEqual({
    status: 'reviewed',
    screens: [SIGNUP],
    findings: [{ id: advisoryFindingId(UNLABELLED), ...UNLABELLED, criterionId: 'signup-form', screenshot: `${SIGNUP}/final.png` }],
    usage: { inputTokens: 120, outputTokens: 40 },
  })
  const [request] = runner.requests
  expect(request?.toolPolicy).toBe('read-only')
  expect(request?.outputSchema).toBe(JSON.stringify(UX_REVIEW_OUTPUT_SCHEMA))
  // The schema has no field that names a criterion, an outcome or a file.
  expect(Object.keys(UX_REVIEW_OUTPUT_SCHEMA.properties.findings.items.properties).sort()).toEqual(['category', 'element', 'saw', 'screen', 'severity', 'why'])
  const prompt = request?.prompt ?? ''
  expect(prompt).toContain('advisory')
  expect(prompt).toContain('You cannot see the screenshots')
  const payload = JSON.parse(prompt.slice(prompt.indexOf('\n\n{') + 2)) as Record<string, unknown>
  expect(payload).toEqual({
    screens: [
      {
        screen: SIGNUP,
        criterion: { id: 'signup-form', text: 'A visitor can sign up with an email address.' },
        files: [`${SIGNUP}/actions.log`, `${SIGNUP}/assert-2.json`, `${SIGNUP}/a11y.json`],
      },
    ],
    qaMd: 'The app is a sign-up funnel.',
    houseRules: ['An error message says what to do next.'],
    dismissed: [{ screen: SIGNUP, category: 'copy', saw: 'The heading says Sign-up, the button says Register.' }],
  })
})

test('with no screen there is nothing to review, and no model is called', async () => {
  // An unscripted call throws: the fake has nothing to answer with.
  expect(await runUxReview(new FakeAgentRunner([]), { screens: [], texts: {} })).toBeUndefined()
})

test('a reviewer that does not answer is named unavailable, with no findings', async () => {
  const threw = await runUxReview(new FakeAgentRunner([]), { screens: SCREENS, texts: {} })
  expect(threw).toEqual({ status: 'unavailable', reason: expect.stringContaining('fake runner script is exhausted') as string, screens: [SIGNUP], findings: [] })
  const stopped = await runUxReview(
    new FakeAgentRunner([{ status: 'failed', stopReason: 'max_tokens', usage: { inputTokens: 9, outputTokens: 4096 }, output: undefined, error: 'cut off' }]),
    { screens: SCREENS, texts: {} },
  )
  expect(stopped).toEqual({ status: 'unavailable', reason: 'the run stopped (max_tokens): cut off', screens: [SIGNUP], findings: [], usage: { inputTokens: 9, outputTokens: 4096 } })
  const garbage = await runUxReview(new FakeAgentRunner([{ status: 'completed', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, output: 'all good' }]), { screens: SCREENS, texts: {} })
  expect(garbage).toEqual({ status: 'unavailable', reason: 'its answer was not a findings list', screens: [SIGNUP], findings: [], usage: { inputTokens: 1, outputTokens: 1 } })
})

test('a judged result gains the findings under advisory, and nothing else in it moves', async () => {
  const result = judged()
  const reviewed = await reviewJudged(result, { reviewer: new FakeAgentRunner([answered([UNLABELLED, UNHELPFUL])]), texts: {} })
  expect(reviewed.advisory?.findings.map((finding) => finding.category)).toEqual(['label', 'error-message'])
  const rest: RunResult = { ...reviewed }
  delete rest.advisory
  expect(rest).toEqual(result)
})

test('no review is made of a refused run, of a run with no screens, or without a reviewer', async () => {
  const unscripted = (): FakeAgentRunner => new FakeAgentRunner([])
  const refused = judged({ verdict: 'refused' })
  expect(await reviewJudged(refused, { reviewer: unscripted(), texts: {} })).toBe(refused)
  const commands = judged({ criteria: [{ id: 'export-csv', outcome: 'proven', evidence: ['checks/export-csv/0/stdout.txt'] }] })
  expect(await reviewJudged(commands, { reviewer: unscripted(), texts: {} })).toBe(commands)
  const result = judged()
  expect(await reviewJudged(result, { texts: {} })).toBe(result)
  // A profile that turned the review off for a criterion's app leaves its screens out.
  expect(await reviewJudged(result, { reviewer: unscripted(), texts: {}, skip: (criterionId) => criterionId === 'signup-form' })).toBe(result)
})

test('a result judged before carries no stale findings into a run that was not reviewed', async () => {
  const stale = judged({ advisory: { status: 'reviewed', screens: [SIGNUP], findings: [] } })
  expect((await reviewJudged(stale, { texts: {} })).advisory).toBeUndefined()
})

test('what a finding quotes is redacted with the rules of the run', async () => {
  const leaking = { ...UNHELPFUL, saw: 'The alert reads "token sk-live-fixture-0001 rejected".', element: 'alert "sk-live-fixture-0001"' }
  const reviewed = await reviewJudged(judged(), {
    reviewer: new FakeAgentRunner([answered([leaking])]),
    texts: {},
    rules: redactionRules({ values: ['sk-live-fixture-0001'] }),
  })
  expect(JSON.stringify(reviewed.advisory)).not.toContain('sk-live-fixture-0001')
  expect(reviewed.advisory?.findings[0]?.saw).toBe('The alert reads "token [redacted] rejected".')
})
