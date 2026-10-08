import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BootOpts } from './boot.js'
import { flowDriverFor } from './flow-driver.js'
import { jobFromPlan } from './job-from-plan.js'
import { plannerAddress } from './app-address.js'
import { judgeExecuted } from './judge.js'
import type { ReadMail } from './mailbox.js'
import { startMcpToolServer, startRegisteredMcpSources, mcpRecordsFile, type McpCallRecord, type McpSource, type McpToolServer } from './mcp.js'
import { PLAN_SCHEMA_VERSION, type Plan } from './plan.js'
import { NO_DIFF, planRun } from './plan-step.js'
import { ProfileMissingError, loadProfile, type QaProfile } from './profile.js'
import { redactText, redactionRules, valueRules } from './redact.js'
import type { RunResult } from './result.js'
import { runJob, type FlowSessionFactory } from './run.js'
import { VISUAL_RECORD, type VisualSessionFactory } from './visual-run.js'
import { NareAgentRunner, type AgentRunner } from './runner.js'

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
  run?: BootOpts & { readMail?: ReadMail; flowSession?: FlowSessionFactory; visualSession?: VisualSessionFactory }
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

/**
 * The models behind planning and judging, through nare. The verifier is
 * confined to the evidence it reads: nare's working directory and file root
 * are that directory. `qare judge` and `qare check` build it here, so their
 * verifiers are sandboxed alike.
 */
export function nareRunners(binary?: string): { planner: AgentRunner; verifier: (evidenceDir: string) => AgentRunner } {
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
 * The time orders runs; the suffix keeps two started together apart.
 */
export function defaultCheckEvidenceDir(root: string, now: Date = new Date(), suffix: string = randomUUID().slice(0, 8)): string {
  return join(root, 'qare-evidence', `check-${now.toISOString().replace(/[:.]/g, '-')}-${suffix}`, 'evidence')
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

  const notes: string[] = []
  // The evidence directory exists before planning starts: the MCP call records
  // land in it while the plan is being made, not only when the plan is written.
  await mkdir(opts.evidenceDir, { recursive: true })
  const plan =
    profile === undefined
      ? unplanned(criteria, 'there is no usable profile to plan against')
      : await planOrReport(opts.planner, criteria, profile, opts.evidenceDir, notes, opts.repoPath)
  await writeFile(join(opts.evidenceDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`)

  const { job, notes: runNotes } = jobFromPlan(plan, {
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
  notes.push(...runNotes)
  const { result: executed } = await runJob(job, opts.run ?? {})
  notes.push(...(await uncomparedVisualNotes(executed, opts.evidenceDir)))

  const rules = redactionRules(profile?.redact)
  const { result: judged, changed } = await judgeExecuted(executed, {
    texts: Object.fromEntries(criteria.map((criterion) => [criterion.id, criterion.text])),
    diff: NO_DIFF,
    rules,
    ...(opts.verifier === 'none' ? {} : { verifier: opts.verifier(opts.evidenceDir) }),
  })
  // The verifier, not the run, changed these: say so, as qare judge does.
  for (const criterion of changed) notes.push(`verifier: ${criterion.criterionId} ${criterion.outcome}: ${redactText(criterion.reason ?? '', rules)}`)
  await writeFile(join(opts.evidenceDir, 'judged-result.json'), `${JSON.stringify(judged, null, 2)}\n`)
  return { criteria, executed, judged, notes }
}

/**
 * A one-off check has one side, so a visual check in it compares with nothing
 * (#143). The harness's own record says so, and so does the caller: a proven
 * visual criterion here means the page was captured, not that it matches a
 * base. Read from the evidence the run wrote, never from a model.
 */
async function uncomparedVisualNotes(executed: RunResult, evidenceDir: string): Promise<string[]> {
  const notes: string[] = []
  for (const criterion of executed.criteria) {
    for (const path of criterion.evidence ?? []) {
      if (path !== VISUAL_RECORD && !path.endsWith(`/${VISUAL_RECORD}`)) continue
      let record: { screenshot?: unknown; comparison?: { with?: unknown; reason?: unknown } }
      try {
        record = JSON.parse(await readFile(join(evidenceDir, path), 'utf8')) as typeof record
      } catch {
        continue
      }
      if (record.comparison?.with !== 'nothing') continue
      const note = `${criterion.id}: the visual check ${String(record.screenshot)} captured the head only: ${String(record.comparison.reason)}`
      if (!notes.includes(note)) notes.push(note)
    }
  }
  return notes
}

/**
 * Plan against the profile, with the profile's registered MCP servers started
 * for the plan step (#93). The planner's session looks through them over one
 * channel the harness serves; every call and every result is recorded to the
 * run's evidence as mcp-calls.jsonl; and a registered server that cannot be
 * started or reached is reported in the notes, never silently skipped.
 * Whatever started is closed before this returns.
 */
async function planOrReport(
  planner: AgentRunner,
  criteria: { id: string; text: string }[],
  profile: QaProfile,
  evidenceDir: string,
  notes: string[],
  repoPath?: string,
): Promise<Plan> {
  const registered = profile.mcp ?? []
  const records: McpCallRecord[] = []
  let sources: McpSource[] = []
  let server: McpToolServer | undefined
  let plan: Plan
  try {
    const started = await startRegisteredMcpSources(registered, 'plan', {
      record: (record) => records.push(record),
    })
    sources = started.sources
    for (const failure of started.failures)
      notes.push(`host mcp server '${failure.server}' is unreachable: ${failure.reason}`)
    server = sources.length === 0 ? undefined : await startMcpToolServer(sources)
    plan = await planRun(planner, {
      criteria,
      repoPath,
      suites: profile.suites.map((suite) => suite.name),
      ...(profile.instructions ? { qaMd: profile.instructions } : {}),
      ...(profile.redact === undefined ? {} : { redact: profile.redact }),
      ...(profile.commands === undefined ? {} : { commands: profile.commands }),
      // The profile's MCP mapping is the driver when it declares one (#94):
      // the mapping is the capability declaration, so plan time rejects an
      // action the mapped tools cannot perform, before anything runs.
      driver: flowDriverFor(profile),
      // How the app is addressed, whichever of target, client and booted app
      // the profile names (#267).
      ...plannerAddress(profile),
      ...(server === undefined
        ? {}
        : {
            mcp: {
              endpoint: server.url,
              servers: sources.map((source) => ({
                name: source.name,
                tools: source.tools.map((tool) =>
                  tool.description === undefined ? { name: tool.name } : { name: tool.name, description: tool.description },
                ),
              })),
            },
          }),
    })
  } catch (error) {
    // A planner that could not run, for whatever reason, leaves every
    // criterion unverified, naming the error and its kind: the run still
    // reports each one, and a bug still shows as one, by name.
    const named = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    plan = unplanned(criteria, `planning failed (${named})`)
  } finally {
    await server?.close().catch(() => {})
    await Promise.all(sources.map((source) => source.close().catch(() => {})))
    if (registered.length > 0 && records.length > 0) {
      // The records are evidence, so they leave through the same redaction
      // the rest of the evidence sweeps: a tool argument or result that
      // carried a secret is redacted before the file is published. The
      // seeded login values sweep alongside the profile's own rules, exactly
      // as the run path sweeps them (#64).
      const login = profile.app?.login
      await writeFile(
        join(evidenceDir, 'mcp-calls.jsonl'),
        mcpRecordsFile(records, [...redactionRules(profile.redact), ...valueRules([login?.totp?.secret, login?.backupCode?.value])]),
      )
    }
  }
  return plan
}

function unplanned(criteria: { id: string; text: string }[], reason: string): Plan {
  return { schemaVersion: PLAN_SCHEMA_VERSION, criteria: criteria.map((criterion) => ({ ...criterion, unplannable: reason })) }
}
