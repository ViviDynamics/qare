import { defaultRunCompose } from './boot.js'

/**
 * What reaping found: the qare projects torn down, and the ones compose could
 * not. A failure is collected, not thrown mid-sweep, so one stuck project
 * cannot leave the rest of the leftovers holding the port queue.
 */
export interface ReapOutcome {
  reaped: string[]
  failures: { project: string; reason: string }[]
}

export interface ReapOpts {
  /** The compose runner; args begin after the `compose` subcommand. */
  runCompose?: (args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>
  /**
   * The projects to reap, named explicitly, rather than every `qare-*`
   * project compose is running (#53). A name that is not qare's is recorded
   * as a failure and never downed.
   */
  projects?: string[]
}

// Reap never waits forever on a compose call: a docker daemon that hangs
// instead of rejecting is bounded by this deadline, and a call that outlives
// it is recorded as that step's failure rather than holding the cleanup
// queue forever (#53).
const REAP_CALL_TIMEOUT_MS = 60000
/** The project prefix qare boots every run under (#53); reap touches nothing else. */
const PROJECT_PREFIX = 'qare-'

/**
 * Tear down compose projects qare booted (#53). With projects named, exactly
 * those are downed — the ownership boundary a live queue needs: the
 * orchestrator reaps the run that just died while its other runs stay live,
 * and a name that is not qare's is refused, never touched. Without names,
 * this is the quiescent sweep: every running project qare booted is torn
 * down, active or not, so it belongs when no qare run is left working — after
 * a crash that took the queue down, or after everything was canceled. For the
 * sweep, `docker compose ls` is the only source of truth: a project qare
 * booted but compose no longer sees needs no reap. A downed project goes with
 * `--volumes`, so the run's volumes go with it.
 */
export async function reapProjects(opts: ReapOpts = {}): Promise<ReapOutcome> {
  const runCompose = opts.runCompose ?? defaultRunCompose
  const named = [...new Set(opts.projects ?? [])]
  if (named.length > 0) {
    const reaped: string[] = []
    const failures: { project: string; reason: string }[] = []
    for (const project of named) {
      if (!project.startsWith(PROJECT_PREFIX)) {
        failures.push({ project, reason: 'not a qare project, so reap does not touch it' })
        continue
      }
      const outcome = await down(runCompose, project)
      if (outcome.code === 0) reaped.push(project)
      else failures.push({ project, reason: (outcome.stderr || outcome.stdout).trim() || `compose down exited ${outcome.code}` })
    }
    return { reaped, failures }
  }
  const listing = await runCompose(['ls', '--format', 'json'], REAP_CALL_TIMEOUT_MS)
  // The listing's exit code first, and its stdout alone after that: a listing
  // that failed is never a sweep that found nothing, and a warning on stderr
  // does not get to break the parse of a good listing.
  if (listing.code !== 0) {
    throw new Error(`compose ls exited ${listing.code}, so qare cannot tell which projects are its leftovers: ${(listing.stderr || listing.stdout).trim()}`)
  }
  let running: unknown
  try {
    running = JSON.parse(listing.stdout)
  } catch {
    throw new Error(`compose ls output is not JSON, so qare cannot tell which projects are its leftovers: ${listing.stdout.trim()}`)
  }
  if (!Array.isArray(running)) throw new Error(`compose ls output is not a project list, so qare cannot tell which projects are its leftovers: ${listing.stdout.trim()}`)
  const projects = [
    ...new Set(
      running
        .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
        .map((entry) => (typeof entry.Name === 'string' ? entry.Name : typeof entry.name === 'string' ? entry.name : undefined))
        .filter((name): name is string => name !== undefined && name.startsWith(PROJECT_PREFIX)),
    ),
  ]
  const reaped: string[] = []
  const failures: { project: string; reason: string }[] = []
  for (const project of projects) {
    const outcome = await down(runCompose, project)
    if (outcome.code === 0) reaped.push(project)
    else failures.push({ project, reason: (outcome.stderr || outcome.stdout).trim() || `compose down exited ${outcome.code}` })
  }
  return { reaped, failures }
}

// Reap never waits forever on a compose call, so the down is bounded (#53); a
// call the deadline killed resolves with a non-zero code and no output.
function down(runCompose: NonNullable<ReapOpts['runCompose']>, project: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return runCompose(['-p', project, 'down', '--volumes'], REAP_CALL_TIMEOUT_MS).catch((error: unknown) => ({
    code: -1,
    stdout: '',
    stderr: String(error),
  }))
}
