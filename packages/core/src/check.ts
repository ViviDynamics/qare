import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BootOpts } from './boot.js'
import { jobFromPlan } from './job-from-plan.js'
import { judgeRun, judgedResult, prepareVerifierInputs, runVerifier, toSideResults, verdictOf } from './judge.js'
import type { ReadMail } from './mailbox.js'
import { PLAN_SCHEMA_VERSION, type Plan } from './plan.js'
import { NO_DIFF, planRun } from './plan-step.js'
import { ProfileMissingError, loadProfile, type QaProfile } from './profile.js'
import { redactResult, redactionRules } from './redact.js'
import type { RunResult } from './result.js'
import { runJob, type FlowSessionFactory } from './run.js'
import type { AgentRunner } from './runner.js'

export class CheckInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CheckInputError'
  }
}

export interface CheckOptions {
  /** Each criterion in plain words; one criterion per entry. */
  criteria: string[]
  /** The `.qa/` profile directory. */
  profileDir: string
  /** Where command checks run. */
  repoPath: string
  evidenceDir: string
  /** The planner's model, through nare. */
  planner: AgentRunner
  /**
   * The verifier's model, confined to the evidence directory it is handed, or
   * `none` to judge from the evidence alone, as `qare judge --runner none` does.
   */
  verifier: ((evidenceDir: string) => AgentRunner) | 'none'
  id?: string
  run?: BootOpts & { readMail?: ReadMail; flowSession?: FlowSessionFactory }
}

export interface CheckOutcome {
  /** What `qare run` wrote: the executed result.json. */
  executed: RunResult
  /** What judge made of it, written as judged-result.json: the verdict to act on. */
  judged: RunResult
  /** Anything the plan could not carry into the run, for the caller to show. */
  notes: string[]
}

/**
 * A criterion in plain words in, a verdict out (#123): plan, run and judge in
 * one call, with no issue, diff or ledger.
 *
 * Each sentence becomes a criterion `check-<n>`. The planner and the verifier
 * are told there is no diff. Nothing is dropped: a criterion the planner could
 * not plan, or every criterion when planning itself failed, is reported
 * unverified with the reason. The executed and judged results keep the same
 * contract as `qare run` and `qare judge`, in the same files.
 */
export async function checkCriteria(opts: CheckOptions): Promise<CheckOutcome> {
  const texts = opts.criteria.map((text) => text.trim())
  if (texts.length === 0) throw new CheckInputError('qare check needs at least one criterion to check')
  if (texts.some((text) => text === '')) throw new CheckInputError('a criterion is empty; say what should hold, in a sentence')
  const criteria = texts.map((text, index) => ({ id: `check-${index + 1}`, text }))

  // A repository with no profile is refused by the run, naming the gap, so
  // nothing is planned for it: a model call would be spent on nothing.
  let profile: QaProfile | undefined
  try {
    profile = await loadProfile(opts.profileDir)
  } catch (error) {
    if (!(error instanceof ProfileMissingError)) throw error
  }

  const plan = profile === undefined ? unplanned(criteria, 'there is no usable profile to plan against') : await planOrReport(opts.planner, criteria, profile)
  await mkdir(opts.evidenceDir, { recursive: true })
  await writeFile(join(opts.evidenceDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`)

  const { job, notes } = jobFromPlan(plan, {
    id: opts.id ?? 'qare-check',
    repoPath: opts.repoPath,
    // A one-off check runs the app as it is: there is no second side.
    baseRef: 'none',
    headRef: 'as running',
    profile: { path: opts.profileDir },
    evidenceDir: opts.evidenceDir,
  })
  const { result: executed } = await runJob(job, opts.run ?? {})

  const judged = judgeRun({ base: [], head: toSideResults(executed) })
  const evidenceById = new Map(executed.criteria.map((criterion) => [criterion.id, 'evidence' in criterion ? criterion.evidence ?? [] : []]))
  let verdicts = judged.criteria
  // A refused run executed nothing, so there is nothing for the verifier to read.
  if (opts.verifier !== 'none' && executed.verdict !== 'refused') {
    verdicts = await runVerifier(
      opts.verifier(opts.evidenceDir),
      prepareVerifierInputs({
        criteria: judged.criteria,
        texts: Object.fromEntries(criteria.map((criterion) => [criterion.id, criterion.text])),
        evidence: Object.fromEntries(evidenceById),
        diff: NO_DIFF,
      }),
    )
  }
  const verdict = executed.verdict === 'refused' ? 'refused' : verdictOf(verdicts, judged.regressions)
  const final = redactResult(judgedResult(executed, verdict, verdicts, evidenceById), redactionRules(profile?.redact))
  await writeFile(join(opts.evidenceDir, 'judged-result.json'), `${JSON.stringify(final, null, 2)}\n`)
  return { executed, judged: final, notes }
}

async function planOrReport(planner: AgentRunner, criteria: { id: string; text: string }[], profile: QaProfile): Promise<Plan> {
  try {
    return await planRun(planner, {
      criteria,
      suites: profile.suites.map((suite) => suite.name),
      ...(profile.target === undefined ? {} : { target: profile.target.url }),
    })
  } catch (error) {
    // A planner that could not answer (nare missing, a model error, an answer
    // that never parsed) leaves every criterion unverified, naming why, and
    // the run still reports each one rather than stopping without a result.
    return unplanned(criteria, `planning failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function unplanned(criteria: { id: string; text: string }[], reason: string): Plan {
  return { schemaVersion: PLAN_SCHEMA_VERSION, criteria: criteria.map((criterion) => ({ ...criterion, unplannable: reason })) }
}
