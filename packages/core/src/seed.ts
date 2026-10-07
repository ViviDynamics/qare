import { spawn } from 'node:child_process'
import { parseDurationMs, shellCharacter } from './duration.js'
import type { ExecutionKind } from './environment.js'
import { composeEnv, type RunIsolation } from './isolation.js'
import type { ProfileApp } from './profile.js'
import { runCommandCheck } from './run.js'
import { substituteValues, type RunValues } from './values.js'

/** How long a seed may take when the profile does not say (`app.seed.timeout`). */
export const DEFAULT_SEED_TIMEOUT = '5m'

/** The seed log's name in a side's evidence (#240). */
export const SEED_LOG = 'seed.log'

export interface SeedOutcome {
  ok: boolean
  /** The command as it ran, run values substituted. */
  command: string
  /** Why the app is not seeded; names the command and how it ended. */
  reason?: string
  /** What the seed did: the command, its streams, and how it ended. */
  log: string
}

/**
 * Why a seed command cannot run as written (#240). The seed is split on
 * whitespace and spawned without a shell, exactly as a command check is, so
 * a character with shell meaning would reach the command as a literal token.
 */
export function unrunnableSeedReason(command: string): string | undefined {
  const character = shellCharacter(command)
  if (character === undefined) return undefined
  return `the seed command is split on whitespace and spawned without a shell, so ${JSON.stringify(character)} is not interpreted; put shell syntax in a script the command names`
}

/**
 * Run the profile's seed command (#240): once for an app that has just come
 * up, before any check, so the checks meet the data the profile says they
 * will, the login fixture included.
 *
 * The seed runs where a command check and a suite run: on the runner, from
 * the checkout of the side it seeds, with run values substituted. A seed that
 * belongs inside the booted service says so in its own words, with
 * `docker compose -p qare-{{run.id}} -f <compose file> exec -T <service> ...`,
 * which is how a suite already reaches the stack. It is handed the
 * environment the run's compose calls get (`QARE_RUN_ID`, `QARE_APP_PORT`),
 * so a compose file that binds the run's port reads the same from the seed
 * as it did from the boot. Otherwise its environment is a command step's
 * (#91): the minimal one on a host, the image's own in a container.
 *
 * Nothing here decides a criterion. A seed that exits non-zero, outlives its
 * bound or cannot start is reported with its output, and the caller leaves
 * every criterion unverified (rule 6): an app that was not seeded proves
 * nothing about the change.
 */
export async function runSeed(
  app: ProfileApp,
  values: RunValues,
  isolation: RunIsolation | undefined,
  cwd: string,
  execution: ExecutionKind | undefined,
): Promise<SeedOutcome> {
  const command = substituteValues(app.seed.command, values)
  const unrunnable = unrunnableSeedReason(command)
  if (unrunnable !== undefined) return { ok: false, command, reason: `the seed command cannot run: ${unrunnable}: ${command}`, log: `$ ${command}\n[not run] ${unrunnable}\n` }
  const timeout = app.seed.timeout ?? DEFAULT_SEED_TIMEOUT
  let timeoutMs: number
  try {
    timeoutMs = parseDurationMs(timeout)
  } catch (error) {
    const problem = `app.seed.timeout ${error instanceof Error ? error.message : String(error)}`
    return { ok: false, command, reason: problem, log: `$ ${command}\n[not run] ${problem}\n` }
  }
  const outcome = await runCommandCheck({ kind: 'command', run: command }, cwd, timeoutMs, execution, undefined, (tokens, at, env) =>
    // Its own process group, as a command check has, so a seed that outlives
    // its bound is stopped with everything it forked.
    spawn(tokens[0] ?? '', tokens.slice(1), {
      cwd: at,
      env: { ...(env ?? process.env), ...composeEnv(isolation) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    }),
  )
  const streams = `$ ${command}\n${section('stdout', outcome.stdout, outcome.stdoutTruncated)}${section('stderr', outcome.stderr, outcome.stderrTruncated)}`
  if (outcome.status === 'passed') return { ok: true, command, log: `${streams}[exit 0]\n` }
  if (outcome.status === 'failed') {
    const ended = outcome.code === undefined ? 'was killed before it exited' : `exited ${outcome.code}`
    return { ok: false, command, reason: `the seed command ${ended}, so the app was not seeded and nothing was checked: ${command}`, log: `${streams}[${ended}]\n` }
  }
  // Unverified: the seed outlived its bound, or its program is not there.
  const why = outcome.reason?.startsWith('check timed out') === true ? `did not finish within ${timeout} (app.seed.timeout)` : `could not run (${outcome.reason ?? 'no reason given'})`
  return { ok: false, command, reason: `the seed command ${why}, so the app was not seeded and nothing was checked: ${command}`, log: `${streams}[${why}]\n` }
}

function section(name: string, text: string, truncated: boolean | undefined): string {
  if (text === '') return ''
  return `[${name}]\n${text.endsWith('\n') ? text : `${text}\n`}${truncated === true ? '[truncated at 1 MiB]\n' : ''}`
}
