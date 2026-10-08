import type { JobCriterion } from './job.js'

/**
 * The lanes a run's criteria divide into when it shards its work (#48):
 *
 * - Workers: the criteria that are independent of each other's leftovers.
 *   They run across the workers side by side against the one booted app, so
 *   the app boots once and every criterion that shares no state with its
 *   neighbours still reuses it.
 * - Sequential: the criteria that cannot run side by side, in the plan order
 *   the job gave them, one after another. A criterion is sequential when it
 *   publishes or consumes mail artefacts (`{{mail.<name>.link}}`,
 *   `{{mail.<name>.code}}`) or reads the inbox, because a run that reordered
 *   those hand-offs could return different verdicts than a serial run does.
 *   A criterion whose checks mutate shared state is sequential too, and runs
 *   against an app instance of its own instead of the shared one.
 *
 * The lanes say how a criterion runs. When each runs is the run's to decide
 * (#278): with one worker, one criterion at a time in plan order; with more,
 * a sequential criterion on the shared app only once the workers have
 * drained.
 */

/**
 * True when the criterion must run against an app of its own: it declares
 * itself isolated, or it names a suite the profile declares isolated (#48).
 * A declared mutation would leave shared state behind for the criteria that
 * run beside it, so those checks get an app no other criterion touches.
 */
export function criterionOwnBoot(criterion: JobCriterion, isolatedSuites: Set<string>): boolean {
  if (criterion.isolated === true) return true
  for (const check of criterion.checks ?? []) {
    if (check.kind === 'flow' && check.suite !== undefined && isolatedSuites.has(check.suite)) return true
  }
  return false
}

const ARTEFACT_REFERENCE = /\{\{\s*mail\./

/**
 * True when the criterion hands values to, or takes them from, another
 * criterion through mail artefacts or the inbox, so its place in the plan
 * order decides what it reads. The whole check is scanned, not just a flow's
 * actions: a command or a tool call whose run names `{{mail.<name>.link}}`
 * consumes the artefact just as a flow step does. Anything that returns true
 * cannot run beside the workers without risking a different verdict than a
 * serial run gives.
 */
function criterionHandsOff(criterion: JobCriterion): boolean {
  for (const check of criterion.checks ?? []) {
    if (check.kind === 'mail') return true
    if (ARTEFACT_REFERENCE.test(JSON.stringify(check))) return true
  }
  return false
}

/**
 * The sharding plan for one job's criteria. Every index in the job's criteria
 * list appears exactly once: the sequential ones once each with their own
 * boot decision, the shared ones partitioned over the workers.
 */
export interface LanePlan {
  /**
   * The criteria that keep plan order, each with whether it boots an app of
   * its own. They run one after another, in plan order.
   */
  sequential: Array<{ index: number; ownBoot: boolean }>
  /**
   * The criteria that run across the workers, one array per worker, each
   * array in plan order.
   */
  shared: number[][]
}

/**
 * Shard the criteria across the workers. The independent ones are dealt
 * round-robin over the workers in plan order, so every worker drains its
 * slice one criterion after another while the workers run side by side; the
 * rest stay sequential in plan order, booting their own app where the job or
 * a suite declares one. With one worker (the default) this is the serial
 * run: every criterion runs in plan order against the one booted app.
 */
export function shardCriteria(criteria: JobCriterion[], workers: number, isolatedSuites: Set<string>): LanePlan {
  const slices = Array.from({ length: Math.max(1, workers) }, (): number[] => [])
  const plan: LanePlan = { sequential: [], shared: slices }
  for (const [index, criterion] of criteria.entries()) {
    if (!criterionHandsOff(criterion) && !criterionOwnBoot(criterion, isolatedSuites)) {
      const slice = plan.shared[index % plan.shared.length]
      if (slice === undefined) throw new Error('sharding: no worker slice to place a criterion in')
      slice.push(index)
      continue
    }
    plan.sequential.push({ index, ownBoot: criterionOwnBoot(criterion, isolatedSuites) })
  }
  return plan
}
