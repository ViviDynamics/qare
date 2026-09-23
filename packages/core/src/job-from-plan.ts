import type { Job, JobCommandCheck, JobCriterion, JobProfileRef, JobPostTarget } from './job.js'
import type { Plan, PlanCheck } from './plan.js'

/**
 * What a run knows that a plan does not.
 *
 * A plan is about criteria and checks and is the same wherever it runs. These
 * are facts about this run: which checkout, which two sides, where evidence
 * goes, and whether anything is posted.
 */
export interface RunContext {
  id: string
  repoPath: string
  baseRef: string
  headRef: string
  profile: JobProfileRef
  evidenceDir: string
  post?: JobPostTarget
}

/** Check kinds the job runner executes today. */
function runnable(check: PlanCheck): JobCommandCheck | undefined {
  return check.kind === 'command' ? { kind: 'command', run: check.command } : undefined
}

/**
 * The job that runs a plan (#105).
 *
 * Nothing is dropped quietly. A criterion whose checks the runner cannot
 * execute, and an unplannable one, are both carried with no checks, so each
 * comes out `unverified` in the evidence rather than vanishing: a criterion
 * missing from the table is one nobody can see went unchecked. What could not
 * be translated comes back as notes for the caller to report.
 */
export function jobFromPlan(plan: Plan, context: RunContext): { job: Job; notes: string[] } {
  const notes: string[] = []
  const criteria: JobCriterion[] = plan.criteria.map((criterion) => {
    if ('unplannable' in criterion) {
      notes.push(`${criterion.id}: nothing to run, the plan called it unplannable (${criterion.unplannable})`)
      return { id: criterion.id, text: criterion.text }
    }
    const checks = criterion.checks.map(runnable).filter((check): check is JobCommandCheck => check !== undefined)
    const skipped = criterion.checks.filter((check) => runnable(check) === undefined)
    if (skipped.length > 0)
      notes.push(
        `${criterion.id}: ${skipped.length} check(s) not run, because the runner executes command checks only ` +
          `(${[...new Set(skipped.map((check) => check.kind))].join(', ')})`,
      )
    return checks.length > 0
      ? { id: criterion.id, text: criterion.text, checks }
      : { id: criterion.id, text: criterion.text }
  })

  if (criteria.every((criterion) => criterion.checks === undefined))
    notes.push(
      'nothing in this plan can be run: every criterion will report unverified, which is an outcome and not a pass',
    )

  return {
    job: {
      id: context.id,
      repoPath: context.repoPath,
      baseRef: context.baseRef,
      headRef: context.headRef,
      profile: context.profile,
      criteria,
      evidenceDir: context.evidenceDir,
      post: context.post ?? 'none',
    },
    notes,
  }
}
