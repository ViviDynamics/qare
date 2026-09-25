import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BootOpts } from './boot.js'
import { jobFromPlan } from './job-from-plan.js'
import { judgeExecuted } from './judge.js'
import type { ReadMail } from './mailbox.js'
import { PLAN_SCHEMA_VERSION, type Plan } from './plan.js'
import { NO_DIFF, PlanStepError, planRun } from './plan-step.js'
import { ProfileMissingError, loadProfile, type QaProfile } from './profile.js'
import { redactionRules } from './redact.js'
import type { RunResult } from './result.js'
import { runJob, type FlowSessionFactory } from './run.js'
import { NareAgentRunner, NareRunnerError, type AgentRunner } from './runner.js'

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
  /** The criteria as checked: the id each sentence was given, and its text. */
  criteria: { id: string; text: string }[]
  /** What `qare run` wrote: the executed result.json. */
  executed: RunResult
  /** What judge made of it, written as judged-result.json: the verdict to act on. */
  judged: RunResult
  /** Anything the plan could not carry into the run, for the caller to show. */
  notes: string[]
}

/** The model behind a check, through nare; the verifier is confined to the evidence it reads. */
export function nareCheckRunners(binary?: string): { planner: AgentRunner; verifier: (evidenceDir: string) => AgentRunner } {
  const options = binary === undefined ? {} : { binary }
  return {
    planner: new NareAgentRunner(options),
    verifier: (evidenceDir) => new NareAgentRunner({ ...options, cwd: evidenceDir, root: evidenceDir }),
  }
}

/**
 * Where a check writes when the caller names nowhere: a directory of its own
 * per run under `qare-evidence/`, with the evidence inside it, so the flow
 * traces a run keeps beside its evidence never collide with another run's.
 */
export function defaultCheckEvidenceDir(root: string, now: Date = new Date()): string {
  return join(root, 'qare-evidence', `check-${now.toISOString().replace(/[:.]/g, '-')}`, 'evidence')
}

/**
 * A criterion in plain words in, a verdict out (#123): plan, run and judge in
 * one call, with no issue, diff or ledger.
 *
 * Each sentence becomes a criterion `check-<n>`. The planner and the verifier
 * are told there is no diff. Nothing is dropped: a criterion the planner could
 * not plan, or every criterion when planning itself failed, is reported
 * unverified with the reason. The executed and judged results keep the same
 * contract as `qare run` and `qare judge`, in the same files, and judging is
 * the same code as `qare judge`.
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

  const plan =
    profile === undefined
      ? unplanned(criteria, 'there is no usable profile to plan against')
      : await planOrReport(opts.planner, criteria, profile)
  await mkdir(opts.evidenceDir, { recursive: true })
  await writeFile(join(opts.evidenceDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`)

  const { job, notes } = jobFromPlan(plan, {
    id: opts.id ?? 'qare-check',
    repoPath: opts.repoPath,
    // A one-off check runs the app as it is: there is no second side.
    baseRef: 'none',
    headRef: 'as running',
    // Loaded once: the run gets the profile validated here. A missing one
    // goes by path, so the run refuses it and names the gap.
    profile: profile === undefined ? { path: opts.profileDir } : { inline: profile },
    evidenceDir: opts.evidenceDir,
  })
  const { result: executed } = await runJob(job, opts.run ?? {})

  const { result: judged } = await judgeExecuted(executed, {
    texts: Object.fromEntries(criteria.map((criterion) => [criterion.id, criterion.text])),
    diff: NO_DIFF,
    rules: redactionRules(profile?.redact),
    ...(opts.verifier === 'none' ? {} : { verifier: opts.verifier(opts.evidenceDir) }),
  })
  await writeFile(join(opts.evidenceDir, 'judged-result.json'), `${JSON.stringify(judged, null, 2)}\n`)
  return { criteria, executed, judged, notes }
}

async function planOrReport(planner: AgentRunner, criteria: { id: string; text: string }[], profile: QaProfile): Promise<Plan> {
  try {
    return await planRun(planner, {
      criteria,
      suites: profile.suites.map((suite) => suite.name),
      ...(profile.target === undefined ? {} : { target: profile.target.url }),
    })
  } catch (error) {
    // A planner that could not answer (nare missing or failing, a model that
    // never produced a usable plan) leaves every criterion unverified, naming
    // why. Anything else is a bug, and surfaces as one.
    if (!(error instanceof PlanStepError || error instanceof NareRunnerError)) throw error
    return unplanned(criteria, `planning failed: ${error.message}`)
  }
}

function unplanned(criteria: { id: string; text: string }[], reason: string): Plan {
  return { schemaVersion: PLAN_SCHEMA_VERSION, criteria: criteria.map((criterion) => ({ ...criterion, unplannable: reason })) }
}
