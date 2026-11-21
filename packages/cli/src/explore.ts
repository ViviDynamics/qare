import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  bootApp,
  bootedAppOrigin,
  detectExecution,
  explorationPageOf,
  isolateRun,
  loadProfile,
  makePlaywrightFlowSession,
  mintRunValues,
  redactionRules,
  redactText,
  runSeed,
  startExplorationServer,
  valueRules,
  type BootOpts,
  type FlowPage,
  type QaProfile,
  type RunIsolation,
} from '@qare/core'

interface Writer {
  write(chunk: string): unknown
}

/** The browser the serve side drives: a flow page and how to close it. */
export interface ExploreSession {
  page: FlowPage
  dispose(): Promise<void>
}

export interface ExploreDeps {
  boot?: BootOpts
  /** The seed seam; the profile's seed command run as a run runs it, by default. */
  seed?: typeof runSeed
  /** The browser seam; Playwright's chromium by default. */
  session?: () => Promise<ExploreSession>
  /** Resolves when the serve side should stop; SIGTERM or SIGINT by default. */
  stopped?: Promise<void>
}

/** What `qare explore boot` leaves for the steps after it, in its out directory. */
export const EXPLORE_APP_FILE = 'app.json'
export const EXPLORE_ISOLATION_FILE = 'isolation.json'
export const EXPLORE_BOOT_LOG = 'explore-boot.log'

const USAGE = [
  'qare explore boot --profile <dir> [--repo <dir>] [--out <dir>]',
  "  boot the base revision's app the profile explores (explore: base), seed it, and leave it up;",
  '  writes app.json (where it answers) and isolation.json (the compose project to reap) to --out',
  'qare explore serve --app <origin> --port <port> [--host <addr>] [--ready <file>]',
  '  drive a browser on the booted app and serve the exploration channel (#87) until stopped',
].join('\n')

/**
 * `qare explore` (#377): the two halves of exploring the base app in the
 * plan job, as separate processes so they can run in separate steps with
 * separate access. `boot` needs the runner's docker and exits once the app
 * is up; `serve` needs none and runs while the planner explores. Neither
 * reads a secret: the environment each runs in is the pipeline's to keep
 * empty, and nothing here asks for a key or a token.
 */
export async function exploreCommand(argv: string[], out: Writer, err: Writer, deps: ExploreDeps = {}): Promise<number> {
  const [sub, ...rest] = argv
  try {
    if (sub === 'boot') return await exploreBoot(rest, out, err, deps)
    if (sub === 'serve') return await exploreServe(rest, out, deps)
    if (sub === '--help' || sub === '-h' || sub === undefined) {
      out.write(`${USAGE}\n`)
      return sub === undefined ? 1 : 0
    }
    throw new Error(`unknown explore subcommand ${JSON.stringify(sub)}\n${USAGE}`)
  } catch (error) {
    err.write(`${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`)
    return 1
  }
}

function value(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name)
  if (at === -1) return undefined
  const given = argv[at + 1]
  if (given === undefined || given.startsWith('--')) throw new Error(`${name} needs a value`)
  return given
}

async function exploreBoot(argv: string[], out: Writer, err: Writer, deps: ExploreDeps): Promise<number> {
  const profilePath = value(argv, '--profile')
  if (profilePath === undefined) throw new Error('qare explore boot requires --profile <dir>')
  const repo = resolve(value(argv, '--repo') ?? '.')
  const outDir = resolve(value(argv, '--out') ?? '.qare-explore')
  const profile = await loadProfile(resolve(profilePath))
  if (profile.explore !== 'base' || profile.app === undefined)
    throw new Error(`the profile at ${profilePath} does not explore (explore: base), so there is no base app to boot for the planner`)
  await mkdir(outDir, { recursive: true })

  // The base app is built from the base tree, always (#377). The prebuilt
  // base image is trusted by the revision label its pusher wrote, which is
  // enough where nothing is held; beside the job that holds the model key it
  // is not, so it is never asked for here, and neither is the build cache.
  const app = { ...profile.app, boot: withoutPrebuilt(profile.app.boot) }
  const booted: QaProfile = { ...profile, app }
  const isolation = await isolateRun()
  // Written before the boot, so a boot that fails half way is still reaped.
  await writeFile(join(outDir, EXPLORE_ISOLATION_FILE), `${JSON.stringify(isolation, null, 2)}\n`, 'utf8')
  const rules = [...redactionRules(profile.redact), ...valueRules([app.login?.totp?.secret, app.login?.backupCode?.value])]
  const log: string[] = []
  const say = async (): Promise<void> => {
    await writeFile(join(outDir, EXPLORE_BOOT_LOG), redactText(log.join('\n'), rules), 'utf8')
  }
  const boot = await bootApp(booted, { ...deps.boot, isolation, root: repo })
  log.push(boot.logs)
  if (boot.kind === 'blocked') {
    await say()
    err.write(`the base app did not come up for exploration: ${boot.reason ?? 'no reason recorded'}\n`)
    return 1
  }
  const values = mintRunValues(runValuesOf(isolation))
  const seeded = await (deps.seed ?? runSeed)(app, values, isolation, repo, detectExecution())
  log.push(seeded.log)
  await say()
  if (!seeded.ok) {
    err.write(`the base app was not seeded, so it is not explored: ${seeded.reason ?? 'the seed command did not succeed'}\n`)
    return 1
  }
  const origin = bootedAppOrigin(app.health.http, values)
  if (origin === undefined) {
    err.write(`the health check ${app.health.http} names no http origin, so there is no page to explore\n`)
    return 1
  }
  await writeFile(join(outDir, EXPLORE_APP_FILE), `${JSON.stringify({ origin, project: isolation.project }, null, 2)}\n`, 'utf8')
  out.write(`the base app is up and seeded at ${origin} for the planner to explore; compose project ${isolation.project}\n`)
  return 0
}

function withoutPrebuilt<T extends object>(boot: T): T {
  if (!('prebuilt' in boot)) return boot
  const { prebuilt: _prebuilt, ...rest } = boot as T & { prebuilt?: unknown }
  void _prebuilt
  return rest as T
}

function runValuesOf(isolation: RunIsolation): { runId: string; appPort?: string } {
  return { runId: isolation.runId, ...(isolation.port === undefined ? {} : { appPort: String(isolation.port) }) }
}

async function exploreServe(argv: string[], out: Writer, deps: ExploreDeps): Promise<number> {
  const app = value(argv, '--app')
  const portText = value(argv, '--port')
  if (app === undefined || portText === undefined) throw new Error('qare explore serve requires --app <origin> and --port <port>')
  const port = Number(portText)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port takes a port from 1 to 65535 (0 for any free one), not ${JSON.stringify(portText)}`)
  const host = value(argv, '--host') ?? '127.0.0.1'
  const ready = value(argv, '--ready')

  const session = await (deps.session ?? playwrightSession)()
  try {
    const page = explorationPageOf(session.page, app)
    // The page stands on the app before the channel answers, so the first
    // observe tells the planner's side where the app is.
    await page.navigate(new URL('/', app).href)
    const server = await startExplorationServer(page, { host, port })
    try {
      if (ready !== undefined) await writeFile(resolve(ready), `${JSON.stringify({ endpoint: server.url })}\n`, 'utf8')
      out.write(`serving the exploration channel for ${new URL(app).origin} at ${server.url}\n`)
      await (deps.stopped ?? untilSignalled())
    } finally {
      await server.close().catch(() => {})
    }
  } finally {
    await session.dispose().catch(() => {})
  }
  return 0
}

async function playwrightSession(): Promise<ExploreSession> {
  const session = await makePlaywrightFlowSession()
  return { page: session.page, dispose: session.dispose }
}

function untilSignalled(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGTERM', () => resolve())
    process.once('SIGINT', () => resolve())
  })
}
