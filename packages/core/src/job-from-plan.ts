import { parseJob } from './job.js'
import type { Job, JobCheck, JobCriterion, JobProfileRef, JobPostTarget } from './job.js'
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
  /** The single form's profile. A plan that names its profiles carries them instead. */
  profile?: JobProfileRef
  evidenceDir: string
  post?: JobPostTarget
}

/** The job check a planned check becomes; undefined for a kind the runner does not execute. */
function runnable(check: PlanCheck): JobCheck | undefined {
  switch (check.kind) {
    case 'command':
      return { kind: 'command', run: check.command }
    case 'flow':
      return {
        kind: 'flow',
        ...(check.suite === undefined ? {} : { suite: check.suite }),
        ...(check.actions === undefined ? {} : { actions: check.actions }),
      }
    case 'mail':
      return {
        kind: 'mail',
        name: check.name,
        address: check.address,
        ...(check.from === undefined ? {} : { from: check.from }),
        ...(check.subject === undefined ? {} : { subject: check.subject }),
        ...(check.body === undefined ? {} : { body: check.body }),
        ...(check.timeoutMs === undefined ? {} : { timeoutMs: check.timeoutMs }),
        ...(check.singleUse === undefined ? {} : { singleUse: check.singleUse }),
        ...(check.code === undefined ? {} : { code: check.code }),
      }
    case 'tool':
      return {
        kind: 'tool',
        ...(check.name === undefined ? {} : { name: check.name }),
        tool: check.tool,
        ...(check.args === undefined ? {} : { args: check.args }),
        assert: check.assert,
        ...(check.timeoutMs === undefined ? {} : { timeoutMs: check.timeoutMs }),
      }
    case 'visual':
      // The widths and themes the plan chose travel with the check (#143). A
      // plan that chose none, or an empty list, takes the profile's `visual`
      // section when the check runs.
      return {
        kind: 'visual',
        name: check.name,
        screenshot: check.screenshot,
        ...(check.url === undefined ? {} : { url: check.url }),
        ...(check.widths === undefined || check.widths.length === 0 ? {} : { widths: check.widths }),
        ...(check.themes === undefined || check.themes.length === 0 ? {} : { themes: check.themes }),
      }
    case 'a11y':
      // The page or the actions that reach it travel with the check (#149),
      // and so do the widths and themes the plan chose, as a visual check's do.
      return {
        kind: 'a11y',
        name: check.name,
        ...(check.url === undefined ? {} : { url: check.url }),
        ...(check.actions === undefined ? {} : { actions: check.actions }),
        ...(check.widths === undefined || check.widths.length === 0 ? {} : { widths: check.widths }),
        ...(check.themes === undefined || check.themes.length === 0 ? {} : { themes: check.themes }),
      }
    default:
      // Every kind a plan carries today runs. A plan written by a newer
      // planner may carry one this runner has never heard of.
      return undefined
  }
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
      // The planner's reason travels with it, so the result says why nothing ran.
      return { id: criterion.id, text: criterion.text, unrunnable: `the planner could not plan it: ${criterion.unplannable}` }
    }
    const checks = criterion.checks.map(runnable).filter((check): check is JobCheck => check !== undefined)
    const skipped = criterion.checks.filter((check) => runnable(check) === undefined)
    if (skipped.length > 0)
      notes.push(
        `${criterion.id}: ${skipped.length} check(s) not run, because the runner executes command, mail, flow, tool, visual and a11y checks only` +
          `(${[...new Set(skipped.map((check) => check.kind))].join(', ')})`,
      )
    const kinds = [...new Set(skipped.map((check) => check.kind))].join(', ')
    const isolated = criterion.isolated === undefined ? {} : { isolated: criterion.isolated }
    if (checks.length > 0)
      return skipped.length === 0
        ? { id: criterion.id, text: criterion.text, checks, ...isolated }
        : {
            id: criterion.id,
            text: criterion.text,
            checks,
            ...isolated,
            skipped: `${skipped.length} of its planned checks did not run (${kinds}), which the runner does not execute`,
          }
    return {
      id: criterion.id,
      text: criterion.text,
      unrunnable: `the plan checks it only with ${kinds} checks, which the runner does not execute`,
    }
  })

  if (criteria.every((criterion) => criterion.checks === undefined))
    notes.push(
      'nothing in this plan can be run: every criterion will report unverified, which is an outcome and not a pass',
    )

  // A plan that names its profiles runs as one run over several apps (#55):
  // one group per planned app, its profile the planned path, and only the
  // criteria planned against it. The planned paths are relative to the
  // repository, so the same plan runs wherever the repository is, and the
  // result carries the same reference judge and redact re-read from the .qa
  // artifact.
  if (plan.profiles !== undefined) {
    const plannedProfiles = plan.criteria.map((criterion) => criterion.profile)
    const groups = plan.profiles.map((planned) => ({
      name: planned.name,
      profile: { path: planned.path },
      criteria: criteria.filter((_criterion, index) => plannedProfiles[index] === planned.name),
    }))
    for (const group of groups.filter((group) => group.criteria.length === 0))
      notes.push(
        `${group.name}: no criterion in the plan is checked against this app, so it takes no part in the run`,
      )
    // The built job passes through the same validator as a hand-written job,
    // so criterion ids carry the same safety rules and stay unique across
    // groups: ids become evidence directory names, whatever form builds them.
    return {
      job: parseJob({
        id: context.id,
        repoPath: context.repoPath,
        baseRef: context.baseRef,
        headRef: context.headRef,
        profiles: groups.filter((group) => group.criteria.length > 0),
        evidenceDir: context.evidenceDir,
        post: context.post ?? 'none',
      }),
      notes,
    }
  }
  if (context.profile === undefined)
    throw new Error('the plan names no profiles and the run context names no profile, so nothing can be planned to run')

  return {
    job: parseJob({
      id: context.id,
      repoPath: context.repoPath,
      baseRef: context.baseRef,
      headRef: context.headRef,
      profile: context.profile,
      criteria,
      evidenceDir: context.evidenceDir,
      post: context.post ?? 'none',
    }),
    notes,
  }
}
