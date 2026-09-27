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
}

const NO_DEADLINE_MS = 0
/** The project prefix qare boots every run under (#53); reap touches nothing else. */
const PROJECT_PREFIX = 'qare-'

/**
 * Tear down every running compose project qare booted (#53). This is the
 * cleanup for a run that died without stopping its stack: an orchestrator
 * runs it after a cancel or a crash, and a stuck run is reaped rather than
 * holding the queue. `docker compose ls` names what is running; each project
 * that starts with `qare-` is downed with `--volumes`, so the run's volumes
 * go with it. Compose's own listing is the only source of truth: a project
 * qare booted but compose no longer sees needs no reap.
 */
export async function reapProjects(opts: ReapOpts = {}): Promise<ReapOutcome> {
  const runCompose = opts.runCompose ?? defaultRunCompose
  const listing = await runCompose(['ls', '--format', 'json'], NO_DEADLINE_MS)
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
    const outcome = await runCompose(['-p', project, 'down', '--volumes'], NO_DEADLINE_MS).catch((error: unknown) => ({
      code: -1,
      stdout: '',
      stderr: String(error),
    }))
    if (outcome.code === 0) reaped.push(project)
    else failures.push({ project, reason: (outcome.stderr || outcome.stdout).trim() || `compose down exited ${outcome.code}` })
  }
  return { reaped, failures }
}
