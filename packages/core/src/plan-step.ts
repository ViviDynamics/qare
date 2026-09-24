import type { AgentRunner } from './runner.js'
import { PLAN_SCHEMA_VERSION, parsePlan, type Plan } from './plan.js'

export interface PlanCriterionInput {
  id: string
  text: string
}

export interface PlanInputs {
  /** The acceptance criteria, as the ledger or the issue states them. */
  criteria: PlanCriterionInput[]
  /** The change under test. */
  diff: string
  /** Suite names the profile declares, which a flow or command check may name. */
  suites?: string[]
}

export class PlanStepError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlanStepError'
  }
}

const SYSTEM = [
  'You map acceptance criteria to checks that a harness will run.',
  'You never decide whether a criterion passes: you only say what would show it.',
  'A criterion you cannot map to a runnable check is marked unplannable with a reason,',
  'and inventing a check that cannot run is worse than saying so.',
].join(' ')

/**
 * The schema nare enforces on the answer.
 *
 * It is deliberately looser than `parsePlan`. nare validates a documented
 * subset of JSON Schema (type, properties, required, items, enum,
 * additionalProperties) and refuses a schema using anything else at startup, so
 * the union over check kinds cannot be expressed here. This catches the shape;
 * `parsePlan` remains the authority, which is also the constitution's rule that
 * code decides rather than the model.
 */
export const PLAN_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    schemaVersion: { type: 'string' },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          unplannable: { type: 'string' },
          checks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['command', 'flow', 'visual', 'mail'] },
                name: { type: 'string' },
                command: { type: 'string' },
                suite: { type: 'string' },
                actions: { type: 'array', items: { type: 'string' } },
                screenshot: { type: 'string' },
                widths: { type: 'array', items: { type: 'integer' } },
                themes: { type: 'array', items: { type: 'string' } },
                address: { type: 'string' },
                from: { type: 'string' },
                subject: { type: 'string' },
                body: { type: 'string' },
                timeoutMs: { type: 'integer' },
                inferred: { type: 'boolean' },
              },
              required: ['kind', 'name'],
            },
          },
        },
        required: ['id', 'text'],
      },
    },
  },
  required: ['schemaVersion', 'criteria'],
}

function prompt(inputs: PlanInputs, correction?: string): string {
  const criteria = inputs.criteria
    .map((criterion) => `- ${criterion.id}: ${criterion.text}`)
    .join('\n')
  const suites = inputs.suites?.length
    ? `Suites this repository declares, which a check may name:\n${inputs.suites.map((suite) => `- ${suite}`).join('\n')}`
    : 'This repository declares no suites, so every check must stand on its own.'
  return [
    'Map each acceptance criterion to the checks that would show it holds.',
    '',
    'Every criterion below must appear in your answer exactly once, under the id given,',
    'either with a non-empty checks array or with an unplannable reason. Do not add,',
    'rename or drop a criterion.',
    '',
    `Criteria:\n${criteria}`,
    '',
    suites,
    '',
    'A check is one of:',
    '- command: {"kind":"command","name":...,"command":"the shell command to run"}',
    '- flow: {"kind":"flow","name":...,"suite":"an existing suite"} or {"kind":"flow","name":...,"actions":["..."]}',
    '- visual: {"kind":"visual","name":...,"screenshot":"name","widths":[390],"themes":["light"]}',
    '- mail: {"kind":"mail","name":...,"address":"the address a message is waited for","subject":"a substring to match", "timeoutMs":60000}',
    '',
    'Mark a check "inferred": true when the criterion did not state how it should be proven.',
    `Answer with schemaVersion "${PLAN_SCHEMA_VERSION}".`,
    '',
    `The change under test:\n${inputs.diff}`,
    ...(correction ? ['', `Your previous answer was rejected: ${correction}`] : []),
  ].join('\n')
}

function coverage(plan: Plan, inputs: PlanInputs): string | undefined {
  const asked = new Set(inputs.criteria.map((criterion) => criterion.id))
  const planned = new Set(plan.criteria.map((criterion) => criterion.id))
  const missing = [...asked].filter((id) => !planned.has(id))
  const invented = [...planned].filter((id) => !asked.has(id))
  if (missing.length === 0 && invented.length === 0) return undefined
  return [
    missing.length ? `it left out ${missing.join(', ')}` : '',
    invented.length ? `it invented ${invented.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(' and ')
}

/**
 * The plan step (#9): criteria and a diff in, a parsed plan out.
 *
 * Fails closed in every direction. A run that did not complete is never turned
 * into a plan, a plan that `parsePlan` rejects is not accepted, and a plan that
 * covers a different set of criteria than the one asked about is refused rather
 * than quietly shrinking the run: a criterion nobody planned is a criterion
 * nothing will ever check.
 *
 * One correction round, carrying the reason, then it raises.
 */
export async function planRun(runner: AgentRunner, inputs: PlanInputs): Promise<Plan> {
  if (inputs.criteria.length === 0)
    throw new PlanStepError('no criteria to plan: an empty plan passes nothing, so the step fails closed')

  let correction: string | undefined
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const run = await runner.run({
      prompt: prompt(inputs, correction),
      system: SYSTEM,
      toolPolicy: 'none',
      outputSchema: JSON.stringify(PLAN_OUTPUT_SCHEMA),
      budget: { maxOutputTokens: 4096 },
    })
    if (run.status !== 'completed')
      throw new PlanStepError(
        `the planning run did not complete (stop reason ${run.stopReason}), so there is no plan` +
          (run.error ? `: ${run.error}` : ''),
      )
    if (typeof run.output !== 'string')
      throw new PlanStepError('the planning run returned no answer to read')

    let plan: Plan
    try {
      plan = parsePlan(JSON.parse(run.output))
    } catch (error) {
      correction = error instanceof Error ? error.message : String(error)
      continue
    }
    const gap = coverage(plan, inputs)
    if (gap === undefined) return plan
    correction = `${gap}. Every criterion must appear exactly once, under the id given.`
  }

  throw new PlanStepError(`the model could not produce a usable plan: ${correction}`)
}
