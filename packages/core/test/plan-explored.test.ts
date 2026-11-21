import { expect, test } from 'vitest'

import { FakeAgentRunner, PlanStepError, planRun, type AgentRunResult, type ExploredPage, type PlanInputs } from '../src/index.js'

// The bridge's address, assembled at runtime as the other tests do.
const BRIDGE = ['http:', '//127.0.0.1:47001/'].join('')
const CRITERIA = [{ id: 'c1', text: 'saving the settings shows a confirmation' }]
const SAVE_AT = 'document/main/button "Save"'
const EXPLORED: ExploredPage[] = [{ page: '/settings', paths: ['document', 'document/main', SAVE_AT] }]

function inputs(explored: ExploredPage[] = EXPLORED): PlanInputs {
  return {
    criteria: CRITERIA,
    diff: 'diff --git a/settings.ts b/settings.ts',
    app: { address: ['http:', '//localhost:{{run.app_port}}'].join('') },
    exploration: { endpoint: BRIDGE, tools: ['observe', 'snapshot', 'navigate'], explored: () => explored },
  }
}

function flowPlan(element: Record<string, unknown>): string {
  return JSON.stringify({
    schemaVersion: '1',
    criteria: [
      {
        id: 'c1',
        text: CRITERIA[0].text,
        checks: [
          {
            kind: 'flow',
            name: 'save settings',
            actions: [
              { action: 'open', url: '/settings' },
              { action: 'click', element },
              { action: 'assertText', text: 'Saved' },
            ],
          },
        ],
      },
    ],
  })
}

const completed = (output: string): AgentRunResult => ({ status: 'completed', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, output })
const SEEN = { role: 'button', name: 'Save', at: SAVE_AT, page: '/settings' }

test('a planned flow names elements read from an explored page, and the plan keeps the page each came from (#377)', async () => {
  const runner = new FakeAgentRunner([completed(flowPlan(SEEN))])
  const plan = await planRun(runner, inputs())
  expect(plan.criteria[0]?.checks?.[0]).toMatchObject({ kind: 'flow', actions: [{ action: 'open' }, { action: 'click', element: SEEN }, { action: 'assertText' }] })
  expect(runner.requests).toHaveLength(1)
  const prompt = runner.requests[0]?.prompt ?? ''
  // The model is told the tools by the names it calls them by, and the rule its elements are held to.
  expect(prompt).toContain('explore__snapshot')
  expect(prompt).toContain('"page"')
  expect(prompt).not.toContain(BRIDGE)
})

test('an element the session never saw is corrected once, naming why, then refused (#377)', async () => {
  for (const [element, said] of [
    [{ role: 'button', name: 'Save' }, 'carries no page'],
    [{ role: 'button', name: 'Save', at: SAVE_AT, page: '/billing' }, 'was never snapshotted'],
    [{ role: 'button', name: 'Delete', at: 'document/main/button "Delete"', page: '/settings' }, 'is not in the snapshot'],
    [{ testId: 'save' }, 'test id'],
  ] as const) {
    const corrected = new FakeAgentRunner([completed(flowPlan(element)), completed(flowPlan(SEEN))])
    await planRun(corrected, inputs())
    expect(corrected.requests, JSON.stringify(element)).toHaveLength(2)
    expect(corrected.requests[1]?.prompt).toContain(said)

    const refused = new FakeAgentRunner([completed(flowPlan(element)), completed(flowPlan(element))])
    await expect(planRun(refused, inputs())).rejects.toThrow(PlanStepError)
  }
})

test('a session that snapshotted nothing cannot plan a flow against the app (#377)', async () => {
  const runner = new FakeAgentRunner([completed(flowPlan(SEEN)), completed(flowPlan(SEEN))])
  await expect(planRun(runner, inputs([]))).rejects.toThrow(/no page was snapshotted/)
})

test('without exploration an element needs no page, as before (#377)', async () => {
  const { exploration: _exploration, ...blind } = inputs()
  void _exploration
  const runner = new FakeAgentRunner([completed(flowPlan({ role: 'button', name: 'Save' }))])
  const plan = await planRun(runner, blind)
  expect(runner.requests).toHaveLength(1)
  expect(runner.requests[0]?.tools).toBeUndefined()
  expect(plan.criteria[0]?.checks?.[0]).toMatchObject({ kind: 'flow' })
})
