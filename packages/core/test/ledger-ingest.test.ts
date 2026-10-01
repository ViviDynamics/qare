import { expect, test } from 'vitest'
import { criterionIdFor } from '../src/issue-criteria.js'
import { integrityOf, type LedgerEntry } from '../src/ledger.js'
import {
  hasIngestComment,
  ingestCommentMarker,
  ingestCriteria,
  renderUncheckableComment,
  WRITING_CRITERIA_GUIDE,
  type IngestSource,
} from '../src/ledger-ingest.js'
import type { AgentRunResult, AgentRunner } from '../src/runner.js'

const link = (host: string, path: string) => ['https:', `//${host}${path}`].join('')

const ISSUE_BODY = '## Acceptance criteria\n\n- [ ] the payouts page shows the 1099 notice for a host paid past the annual threshold\n'
const VAGUE_BODY = '## Acceptance criteria\n\n- [ ] the article is pleasant to read\n'
const ISSUE_LINK = link('example.test', '/issues/37')
const PR_LINK = link('example.test', '/pull/40')

function planner(plan: unknown): AgentRunner {
  return {
    run: async (): Promise<AgentRunResult> => ({
      status: 'completed',
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
      output: JSON.stringify(plan),
    }),
  }
}

function planWith(criteria: unknown[]): unknown {
  return { schemaVersion: '1', criteria }
}

function source(overrides: Partial<IngestSource> = {}): IngestSource {
  return {
    kind: 'issue',
    number: 37,
    author: 'Jason733i',
    link: ISSUE_LINK,
    body: ISSUE_BODY,
    ...overrides,
  }
}

const COMMAND_CHECK = { kind: 'command', name: 'notice', command: 'node notice.mjs' }
const FLOW_CHECK = { kind: 'flow', name: 'notice', actions: [{ action: 'open', url: '/payouts' }] }
const PLANNED = (body: string, checks: unknown[]) => ({
  id: criterionIdFor(body),
  text: body,
  checks,
})

test('a criterion the ledger already carries is a duplicate, not a proposal', async () => {
  const text = 'the payouts page shows the 1099 notice for a host paid past the annual threshold'
  const ledger: LedgerEntry[] = [
    { criterion: criterionIdFor(text), status: 'active', source: [link('example.test', '/issues/9')], proof: 'command' },
  ]
  const outcome = await ingestCriteria([source({ body: `## Acceptance criteria\n\n- [ ] ${text}\n` })], {
    ledger,
    planner: planner(planWith([])),
  })
  expect(outcome.proposals).toEqual([])
  expect(outcome.duplicates).toHaveLength(1)
  expect(outcome.duplicates[0]!.id).toBe(criterionIdFor(text))
  expect(outcome.duplicates[0]!.status).toBe('active')
  expect(outcome.duplicates[0]!.sources).toEqual([source({})])
  expect(outcome.fingerprint).toBe(integrityOf(ledger))
})

test('the same wording under a hand-minted id is still a duplicate', async () => {
  const text = 'the payouts page shows the 1099 notice for a host paid past the annual threshold'
  const ledger: LedgerEntry[] = [
    { criterion: 'c-handminted00000000000000000000ff', status: 'active', source: [link('example.test', '/issues/9')], proof: 'command', note: text },
  ]
  const outcome = await ingestCriteria([source({ body: `## Acceptance criteria\n\n- [ ] ${text}\n` })], {
    ledger,
    planner: planner(planWith([])),
  })
  expect(outcome.proposals).toEqual([])
  expect(outcome.duplicates).toHaveLength(1)
})

test('the ingest planner sees the QA.md and the declared commands the profile carries (#156)', async () => {
  const text = 'the payouts page shows the 1099 notice for a host paid past the annual threshold'
  const prompts: string[] = []
  const outcome = await ingestCriteria([source({ body: `## Acceptance criteria\n\n- [ ] ${text}\n` })], {
    ledger: [],
    planner: {
      run: async (request) => {
        prompts.push(request.prompt)
        return { status: 'completed', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, output: JSON.stringify(planWith([PLANNED(text, [COMMAND_CHECK])])) }
      },
    },
    qaMd: 'log in as jane@pilot.example, the seeded host',
    commands: { test: { run: 'pnpm --filter {{package}} exec vitest run -t {{pattern}}', about: 'runs the tests in one package' } },
  })
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('log in as jane@pilot.example, the seeded host')
  expect(prompts[0]).toContain('pnpm --filter {{package}} exec vitest run -t {{pattern}}')
  expect(outcome.proposals).toHaveLength(1)
})

test('every proposal names the issue or pull request that stated it', async () => {
  const outcome = await ingestCriteria(
    [
      source({ body: '## Acceptance criteria\n\n- [ ] a proposed ledger shows every criterion as proposed\n' }),
      source({
        kind: 'pr',
        number: 40,
        author: 'alice',
        link: PR_LINK,
        body: '## Done when\n\n- [x] the ledger keeps its integrity across a move\n',
      }),
    ],
    {
      ledger: [],
      planner: planner(
        planWith([
          PLANNED('a proposed ledger shows every criterion as proposed', [COMMAND_CHECK]),
          PLANNED('the ledger keeps its integrity across a move', [COMMAND_CHECK]),
        ]),
      ),
    },
  )
  expect(outcome.proposals).toHaveLength(2)
  expect(outcome.proposals[0]!.source).toEqual([ISSUE_LINK])
  expect(outcome.proposals[1]!.source).toEqual([PR_LINK])
  expect(outcome.proposals.every((proposal) => proposal.status === 'proposed')).toBe(true)
  expect(outcome.proposals.every((proposal) => proposal.note !== undefined)).toBe(true)
})

test('the same wording stated in an issue and a pull request is one proposal with both sources', async () => {
  const text = 'ingest never writes the ledger itself'
  const outcome = await ingestCriteria(
    [
      source({ body: `## Acceptance criteria\n\n- [ ] ${text}\n` }),
      source({
        kind: 'pr',
        number: 40,
        author: 'alice',
        link: PR_LINK,
        body: `## Acceptance criteria\n\n- [x] ${text}\n`,
      }),
    ],
    { ledger: [], planner: planner(planWith([PLANNED(text, [COMMAND_CHECK])])) },
  )
  expect(outcome.proposals).toHaveLength(1)
  expect(outcome.proposals[0]!.source).toEqual([ISSUE_LINK, PR_LINK])
})

test('a criterion no check can prove is proposed nowhere and its comment names the author and the why', async () => {
  const outcome = await ingestCriteria([source({ body: VAGUE_BODY })], {
    ledger: [],
    planner: planner(
      planWith([
        { id: criterionIdFor('the article is pleasant to read'), text: 'the article is pleasant to read', unplannable: 'pleasant is not something a check can show' },
      ]),
    ),
  })
  expect(outcome.proposals).toEqual([])
  expect(outcome.uncheckable).toHaveLength(1)
  expect(outcome.uncheckable[0]!.why).toBe('pleasant is not something a check can show')
  const body = renderUncheckableComment(outcome.uncheckable[0]!)
  expect(body).toContain('@Jason733i')
  expect(body).toContain('pleasant is not something a check can show')
  expect(body).toContain('the article is pleasant to read')
  expect(body).toContain('restate it as something a check can prove')
  expect(body).toContain(WRITING_CRITERIA_GUIDE)
  expect(body).toContain(ingestCommentMarker(outcome.uncheckable[0]!.id))
  expect(hasIngestComment([body], outcome.uncheckable[0]!.id)).toBe(true)
  expect(hasIngestComment(['a comment about something else'], outcome.uncheckable[0]!.id)).toBe(false)
})

test('the suggested proof is a command when every check is a command and a flow otherwise', async () => {
  const text = 'the payouts page shows the 1099 notice'
  const commandOutcome = await ingestCriteria([source({ body: `## Acceptance criteria\n\n- [ ] ${text}\n` })], {
    ledger: [],
    planner: planner(planWith([PLANNED(text, [COMMAND_CHECK])])),
  })
  expect(commandOutcome.proposals[0]!.proof).toBe('command')
  const flowOutcome = await ingestCriteria(
    [source({ link: link('example.test', '/issues/38'), body: `## Acceptance criteria\n\n- [ ] ${text}\n` })],
    { ledger: [], planner: planner(planWith([PLANNED(text, [COMMAND_CHECK, FLOW_CHECK])])) },
  )
  expect(flowOutcome.proposals[0]!.proof).toBe('flow')
})

test('a source with no criteria section contributes nothing and a malformed section is named', async () => {
  const quiet = await ingestCriteria([source({ body: 'No criteria section here at all.\n' })], {
    ledger: [],
    planner: planner(planWith([])),
  })
  expect(quiet.proposals).toEqual([])
  await expect(
    ingestCriteria([source({ body: '## Acceptance criteria\n' })], { ledger: [], planner: planner(planWith([])) }),
  ).rejects.toThrow(/issue #37: the issue has a criteria section with no criteria/)
})
