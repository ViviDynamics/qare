#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { dirname, join, relative, resolve } from 'node:path'
import { initCommand } from './init.js'
import {
  BranchLedgerStore,
  FileLedgerStore,
  resolveCriteriaSubset,
  criteriaSubsetPlan,
  buildReadinessReport,
  ingestCommentMarker,
  ingestCriteria,
  integrityOf,
  LEDGER_FILE,
  loadJobFromFile,
  loadJobFromText,
  jobFromPlan,
  readQuarantine,
  checkCriteria,
  defaultCheckEvidenceDir,
  judgeExecuted,
  nareRunners,
  reviewJudged,
  loadPlan,
  loadResult,
  renderUncheckableComment,
  NareAgentRunner,
  ProfileMissingError,
  BUILTIN_REDACTION_RULES,
  BROWSER_FLOW_DRIVER,
  loadProfile,
  browserlessFlavour,
  flowDriverFor,
  plannedAppAddress,
  redactEvidenceDir,
  redactText,
  redactionRules,
  valueRules,
  startMcpToolServer,
  startRegisteredMcpSources,
  mcpRecordsFile,
  criteriaFromIssue,
  criteriaFromIssues,
  detectContradictions,
  executedFromResult,
  holdForQuestions,
  IssueCriteriaError,
  linkedIssues,
  planRun,
  PlanStepError,
  PLAN_SCHEMA_VERSION,
  questionIdFor,
  renderCheckRun,
  renderComment,
  readinessInventory,
  replayRun,
  resolveContradictions,
  reapProjects,
  runCellCommand,
  runDoctor,
  runJob,
  discoverProfiles,
  selectCriteria,
  selectProfiles,
  appendChange,
  parseLedgerDocument,
  serializeLedgerDocument,
  renderCriteriaMarkdown,
  renderHistoryMarkdown,
  sweepLedger,
  touchedPathsFromDiff,
  VERSION,
  WRITING_CRITERIA_GUIDE,
  appendRunMetrics,
  appendMetricsNote,
  metricsSummaryLines,
  METRICS_SCHEMA_VERSION,
  readMetricsStore,
  summarizeMetrics,
} from '@qare/core'
import type {
  BootOpts,
  RunJobOpts,
  FlowDriverCapabilities,
  PlanSuite,
  IngestOutcome,
  IntroducedCriterion,
  Job,
  DismissedFinding,
  JobProfileRef,
  LedgerEntry,
  LedgerResolution,
  MetricsNoteKind,
  Plan,
  QaProfile,
  RedactionRule,
  McpCallRecord,
  McpSource,
  McpToolServer,
  ResolutionSource,
  ReplayDifference,
  RunContext,
  RunResult,
  RunVerdict,
  MetricsStore,
  SweepPayload,
} from '@qare/core'

export interface Writer {
  write(chunk: string): void
}

export async function main(
  argv: string[],
  out: Writer = process.stdout,
  err: Writer = process.stderr,
  boot: BootOpts = {},
  stdin: Readable = process.stdin,
): Promise<number> {
  if (argv.includes('--version') || argv.includes('-v')) {
    out.write(`${VERSION}\n`)
    return 0
  }
  if (argv[0] === 'run') return runCommand(argv.slice(1), out, err, boot, stdin)
  if (argv[0] === 'check') return checkCommand(argv.slice(1), out, err, boot)
  if (argv[0] === 'linked-issues') return linkedIssuesCommand(argv.slice(1), out, err)
  if (argv[0] === 'issue-criteria') return issueCriteriaCommand(argv.slice(1), out, err)
  if (argv[0] === 'plan') return planCommand(argv.slice(1), out, err)
  if (argv[0] === 'judge') return judgeCommand(argv.slice(1), out, err)
  if (argv[0] === 'replay') return replayCommand(argv.slice(1), out, err)
  if (argv[0] === 'ledger') return runLedgerCommand(argv.slice(1), out, err)
  if (argv[0] === 'ingest') return ingestCommand(argv.slice(1), out, err)
  if (argv[0] === 'select') return selectCommand(argv.slice(1), out, err)
  if (argv[0] === 'init') return initCommand(argv.slice(1), out, err)
  if (argv[0] === 'readiness') return readinessCommand(argv.slice(1), out, err)
  if (argv[0] === 'profiles') return profilesCommand(argv.slice(1), out, err)
  if (argv[0] === 'doctor') return doctorCommand(argv.slice(1), out, err)
  if (argv[0] === 'redact') return redactCommand(argv.slice(1), out, err)
  if (argv[0] === 'sweep') return sweepCommand(argv.slice(1), out, err)
  if (argv[0] === 'metrics') return metricsCommand(argv.slice(1), out, err)
  if (argv[0] === 'reap') return reapCommand(out, err, argv.slice(1), boot)
  // The two halves of a client build's cell (#223): started by the run, from
  // the image it is in, never by a person, so the usage below does not list it.
  if (argv[0] === 'cell') return runCellCommand(argv.slice(1), { out: (line) => out.write(`${line}\n`), err: (line) => err.write(`${line}\n`) })
  out.write(
    `qare ${VERSION}\nusage: qare --version | qare check "<criterion>"... [--file <path>] [--profile <dir>] [--repo <dir>] [--evidence <dir>] [--nare <binary> | --runner none] | qare linked-issues --body <path> | qare issue-criteria --out <file> <issue.md>... | qare plan (--issue <path> | --criteria <path>) --diff <path> [--allow-no-criteria] [--out <file>] [--suites a,b] [--nare <binary>] | qare run (--job <path|-> | --plan <path> --id <id> --repo <dir> --base <ref> --head <ref> [--profile <dir>] --evidence <dir> | --criteria <ids> --id <id> --repo <dir> --base <ref> --head <ref> --profile <dir> --evidence <dir> [--ledger <dir>]) [--base-repo <dir>] [--workers <n>] | qare judge --result <path> (--plan <path> --diff <path> [--nare <binary>] | --runner none) [--outDir <dir>] [--profile <dir>] [--dismissed <path>] | qare ledger <list|show|diff|status|contradict|resolve|decide|export|import|publish|migrate> [--ledger <dir>] | qare select [--ledger <dir>] (--diff <path> | --paths a,b) [--budget <ms>] [--smoke <suite>] [--out <file>] | qare ingest --sources <manifest.json> --out <dir> --nare <binary> [--ledger <dir>] [--profile <dir>] | qare init [path] [--target <url>] [--health <path>] [--service <name>] [--model <name>] [--file-issues <owner/name>] | qare readiness [path] [--out <file>] | qare profiles [path] [--diff <path> | --paths a,b) [--out <file>] | qare doctor [--profile <dir>] [--nare <binary>] [--json] | qare redact --evidence <dir> [--profile <dir>] | qare sweep [--ledger <dir>] [--json] [--out <file>] | qare metrics <record|note> | qare reap [project...] | qare replay <dir>\n`,
  )
  return 0
}

const CHECK_FLAGS = new Set(['--file', '--profile', '--repo', '--evidence', '--nare', '--runner', '--id'])

/**
 * `qare check "<criterion>"`: a criterion in plain words in, a verdict out
 * (#123). Plans through nare, runs, and judges, with no issue, diff or ledger.
 * The exit code and result files are the same contract as `qare run` and
 * `qare judge`: result.json is what ran, judged-result.json the verdict.
 */
async function checkCommand(argv: string[], out: Writer, err: Writer, boot: BootOpts): Promise<number> {
  try {
    const sentences: string[] = []
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i] as string
      if (CHECK_FLAGS.has(arg)) {
        i += 1
        continue
      }
      if (arg.startsWith('--')) throw new Error(`unknown check flag ${JSON.stringify(arg)}`)
      sentences.push(arg)
    }
    const file = flag(argv, '--file')
    if (file !== undefined) {
      // One criterion per line; blank lines and # comments are skipped.
      const lines = (await readFile(resolve(file), 'utf8')).split('\n').map((line) => line.trim())
      sentences.push(...lines.filter((line) => line !== '' && !line.startsWith('#')))
    }
    const runnerSpec = flag(argv, '--runner') ?? 'nare'
    if (runnerSpec !== 'nare' && runnerSpec !== 'none')
      throw new Error(`unknown --runner ${JSON.stringify(runnerSpec)} (expected "nare" or "none")`)
    const runners = nareRunners(flag(argv, '--nare'))
    const repoPath = resolve(flag(argv, '--repo') ?? '.')
    // Evidence stays where qare runs, never in the repository checked.
    const evidenceDir = resolve(flag(argv, '--evidence') ?? defaultCheckEvidenceDir(process.cwd()))

    const { criteria, judged, notes } = await checkCriteria({
      criteria: sentences,
      // Named paths resolve from where qare runs; the default profile is the
      // repository's. The MCP tool resolves them the same way.
      profileDir: resolve(flag(argv, '--profile') ?? join(repoPath, '.qa')),
      repoPath,
      evidenceDir,
      planner: runners.planner,
      verifier: runnerSpec === 'none' ? 'none' : runners.verifier,
      ...(flag(argv, '--id') === undefined ? {} : { id: flag(argv, '--id') as string }),
      run: boot,
    })
    for (const note of notes) err.write(`${note}\n`)
    const texts = new Map(criteria.map((criterion) => [criterion.id, criterion.text]))
    for (const criterion of judged.criteria) {
      const why = 'reason' in criterion && criterion.reason !== undefined ? ` (${criterion.reason})` : ''
      out.write(`${criterion.id} ${criterion.outcome}: ${texts.get(criterion.id) ?? ''}${why}\n`)
    }
    out.write(`verdict ${judged.verdict}; evidence ${evidenceDir}\n`)
    return exitCodeFor(judged.verdict)
  } catch (error) {
    err.write(`${formatError(error)}\n`)
    return 4
  }
}

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name)
  if (at === -1) return undefined
  const value = argv[at + 1]
  // No command name: this helper is shared, and naming the wrong command
  // sends a reader to the wrong usage line.
  if (value === undefined) throw new Error(`${name} needs a value`)
  return value
}

/**
 * The issues a pull request promises to close, one per line.
 *
 * Prints nothing and succeeds when it promises none: a chore states no
 * criteria, and whether that is neutral or a failure is the pipeline's call.
 */
async function linkedIssuesCommand(argv: string[], out: Writer, err: Writer): Promise<number> {
  try {
    const bodyPath = flag(argv, '--body')
    if (bodyPath === undefined) throw new Error('qare linked-issues requires --body <path>')
    for (const issue of linkedIssues(await readFile(resolve(bodyPath), 'utf8')))
      out.write(`${issue}\n`)
    return 0
  } catch (error) {
    err.write(`${formatError(error)}\n`)
    return 4
  }
}

/**
 * The acceptance criteria a set of issues state, as the {id, text} list
 * `qare plan --criteria` reads. No model is involved, so the job that reads the
 * issues can decide whether there is anything to plan before a model-key job
 * starts.
 *
 * When no issue has a criteria section, it removes any file at --out and
 * succeeds: a change that states no criteria has nothing to check, and
 * whether that is neutral is the pipeline's call. A criteria section with
 * nothing usable in it is a failure, as is an unreadable file.
 */
async function issueCriteriaCommand(argv: string[], out: Writer, err: Writer): Promise<number> {
  try {
    const paths: string[] = []
    let outPath: string | undefined
    for (let index = 0; index < argv.length; index++) {
      const arg = argv[index] as string
      if (arg === '--out') {
        if (outPath !== undefined) throw new Error('qare issue-criteria takes --out once')
        outPath = flag(argv.slice(index), '--out')
        index++
      } else if (arg.startsWith('-')) throw new Error(`qare issue-criteria does not take ${arg}`)
      else paths.push(arg)
    }
    if (outPath === undefined || paths.length === 0)
      throw new Error('qare issue-criteria requires --out <file> and at least one issue body path')
    const target = resolve(outPath)
    const issues = await Promise.all(
      paths.map(async (path) => ({ name: path, body: await readFile(resolve(path), 'utf8') })),
    )
    const criteria = criteriaFromIssues(issues)
    if (criteria.length === 0) {
      // A file left from before would read as criteria present.
      await rm(target, { force: true })
      out.write('no linked issue states acceptance criteria, so there is nothing to check\n')
      return 0
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, `${JSON.stringify(criteria, null, 2)}\n`, 'utf8')
    out.write(`${criteria.length} criteria; ${target}\n`)
    return 0
  } catch (error) {
    err.write(`${formatError(error)}\n`)
    return 4
  }
}

/**
 * `qare ingest`: read the acceptance criteria issues and pull requests state,
 * propose the ones no ledger entry already carries (#37), and leave the ones
 * no check can prove to a single comment on each source that stated them.
 *
 * The ledger is never written here: what comes out is a payload the delivery
 * turns into a pull request for a human to apply, which is what makes a
 * proposal a proposal. The planner is required, because without one nothing
 * can be told apart from what a check can prove, and nothing would be.
 */
async function ingestCommand(argv: string[], out: Writer, err: Writer): Promise<number> {
  try {
    const sourcesPath = flag(argv, '--sources')
    const outDir = flag(argv, '--out')
    const nare = flag(argv, '--nare')
    if (sourcesPath === undefined) throw new Error('qare ingest requires --sources <manifest.json>')
    if (outDir === undefined) throw new Error('qare ingest requires --out <dir>')
    if (nare === undefined) throw new Error('qare ingest requires --nare <binary> (a planner is how uncheckable wording is told apart)')

    const manifest = parseSourcesManifest(await readFile(resolve(sourcesPath), 'utf8'))
    const bodies = await Promise.all(
      manifest.sources.map(async (source) => ({ ...source, body: await readFile(resolve(source.body), 'utf8') })),
    )
    const ledgerDirFlag = flag(argv, '--ledger') ?? '.qa'
    const ledgerDocument = await new FileLedgerStore(resolve(ledgerDirFlag)).loadDocument()

    const profileDir = flag(argv, '--profile')
    const profile = profileDir === undefined ? undefined : await loadProfile(resolve(profileDir))
    const outcome = await ingestCriteria(bodies, {
      ledger: ledgerDocument.entries,
      changes: ledgerDocument.changes,
      planner: nareRunners(nare).planner,
      ...(profile === undefined ? {} : { suites: profile.suites.map((suite) => suite.name) }),
      ...(profile === undefined || profile.target === undefined ? {} : { target: profile.target.url }),
      ...(profile === undefined || profile.instructions === undefined ? {} : { qaMd: profile.instructions }),
      ...(profile === undefined || profile.redact === undefined ? {} : { redact: profile.redact }),
      ...(profile === undefined || profile.commands === undefined ? {} : { commands: profile.commands }),
    })

    const proposal: LedgerIngestProposal = {
      ledgerPath: join(ledgerDirFlag, LEDGER_FILE),
      baseFingerprint: integrityOf(ledgerDocument.entries),
      ledgerText: outcome.ledgerText,
      branch: `qare-ledger-proposal-${outcome.fingerprint.replace('sha256:', '').slice(0, 8)}`,
      title: `Propose ${outcome.proposals.length} ledger criteria`,
      body: renderProposalBody(manifest.sources, outcome),
      sources: manifest.sources,
    }
    await mkdir(resolve(outDir), { recursive: true })
    const proposalPath = join(resolve(outDir), 'ingest-proposal.json')
    await writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`, 'utf8')
    const comments = outcome.uncheckable.flatMap((criterion) =>
      criterion.sources.map((source) => ({
        issue: source.number,
        marker: ingestCommentMarker(criterion.id),
        body: renderUncheckableComment({ ...criterion, sources: [source] }),
      })),
    )
    const commentsPath = join(resolve(outDir), 'ingest-comments.json')
    await writeFile(commentsPath, `${JSON.stringify(comments, null, 2)}\n`, 'utf8')
    out.write(
      `${outcome.proposals.length} proposed, ${outcome.duplicates.length} already carried, ${outcome.uncheckable.length} uncheckable; ${proposalPath}\n`,
    )
    return 0
  } catch (error) {
    err.write(`${formatError(error)}\n`)
    return 4
  }
}

interface LedgerIngestProposal {
  ledgerPath: string
  baseFingerprint: string
  ledgerText: string
  branch: string
  title: string
  body: string
  sources: { kind: 'issue' | 'pr'; number: number; author: string; link: string }[]
}

/**
 * The manifest names every source ingest reads: the kind, the number, the
 * author of the body, the canonical link back to it, and the path of the body
 * text itself, which the caller has already fetched.
 */
function parseSourcesManifest(text: string): { sources: { kind: 'issue' | 'pr'; number: number; author: string; link: string; body: string }[] } {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { sources?: unknown }).sources))
    throw new Error('ingest: the sources manifest must be a JSON object with a "sources" array')
  const sources = (parsed as { sources: unknown[] }).sources.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new Error(`ingest: sources[${index}] must be an object`)
    const record = entry as Record<string, unknown>
    if (record.kind !== 'issue' && record.kind !== 'pr')
      throw new Error(`ingest: sources[${index}].kind must be "issue" or "pr" (got ${JSON.stringify(record.kind)})`)
    const kind: 'issue' | 'pr' = record.kind
    const number = record.number
    if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0)
      throw new Error(`ingest: sources[${index}].number must be a positive integer`)
    for (const field of ['author', 'link', 'body'] as const) {
      if (typeof record[field] !== 'string' || (record[field] as string).trim() === '')
        throw new Error(`ingest: sources[${index}].${field} must be a non-empty string`)
    }
    return {
      kind,
      number,
      author: record.author as string,
      link: record.link as string,
      body: record.body as string,
    }
  })
  return { sources }
}

function renderProposalBody(
  sources: { kind: 'issue' | 'pr'; number: number; author: string; link: string }[],
  outcome: IngestOutcome,
): string {
  const lines = [
    `Proposes ${outcome.proposals.length} criteria for the criteria ledger, as proposals for a human to apply.`,
    '',
    '## Sources',
    ...sources.map((source) => `- ${source.kind} #${source.number} (@${source.author}): ${source.link}`),
    '',
  ]
  if (outcome.proposals.length > 0) {
    lines.push('## Proposed', ...outcome.proposals.map((entry) => `- \`${entry.criterion}\` (${entry.proof}): ${entry.note ?? ''}`), '')
  }
  if (outcome.duplicates.length > 0) {
    lines.push(
      '## Already carried',
      ...outcome.duplicates.map(
        (duplicate) => `- \`${duplicate.id}\` is ${duplicate.status} in the ledger, so not proposed again`,
      ),
      '',
    )
  }
  if (outcome.uncheckable.length > 0) {
    lines.push(
      '## Uncheckable',
      ...outcome.uncheckable.map(
        (criterion) => `- \`${criterion.id}\`: ${criterion.why} One comment each, on the ${criterion.sources.map((source) => `${source.kind} #${source.number}`).join(', ')} that stated it.`,
      ),
      '',
    )
  }
  lines.push('Nothing here is part of the ledger until a human applies the proposal.')
  lines.push(
    `For how to word a criterion a check can carry, read the criteria guide: ${WRITING_CRITERIA_GUIDE}.`,
  )
  return lines.join('\n')
}

/**
 * Redact an evidence directory in place before it is uploaded (#52), with the
 * profile's rules and the built-in ones.
 *
 * A repository with no usable profile gets the built-in rules alone, which is
 * what its refused run was written with. A profile that is there but broken,
 * or a file redaction cannot vouch for, fails: the caller uploads nothing.
 */
async function redactCommand(argv: string[], out: Writer, err: Writer): Promise<number> {
  try {
    for (const arg of argv.filter((entry) => entry.startsWith('-')))
      if (arg !== '--evidence' && arg !== '--profile') throw new Error(`qare redact does not take ${arg}`)
    const evidence = flag(argv, '--evidence')
    if (evidence === undefined) throw new Error('qare redact requires --evidence <dir>')
    // The result, when the run left one, says which apps ran, and every app's
    // rules sweep the directory they all published into (#55).
    const resultPath = join(resolve(evidence), 'result.json')
    const profiles = existsSync(resultPath)
      ? loadResult(await readFile(resultPath, 'utf8')).profiles
      : undefined
    const rules = await redactionRulesForRun(flag(argv, '--profile'), profiles, out)
    const report = await redactEvidenceDir(resolve(evidence), rules)
    for (const name of report.changed) out.write(`redacted ${name}\n`)
    out.write(
      `${report.changed.length} of ${report.files.length} files redacted; ${report.images.length} images published as captured\n`,
    )
    return 0
  } catch (error) {
    err.write(`${formatError(error)}\n`)
    return 4
  }
}

/**
 * `qare reap [project...]`: tear down compose projects qare booted (#53). With
 * project names, exactly those are downed and a name that is not qare's is
 * refused, so the orchestrator can reap the run that just died while its other
 * runs stay live. With no names, every running compose project qare booted
 * (`qare-*`) is torn down, so this is the quiescent cleanup an orchestrator
 * runs when no qare run is left working — after a canceled or crashed queue —
 * and a stuck run is reaped rather than holding the queue. A project that
 * fails to go down names itself on `err` and fails the command.
 */
async function reapCommand(out: Writer, err: Writer, projects: string[], boot: BootOpts): Promise<number> {
  try {
    const opts = boot.runCompose === undefined ? {} : { runCompose: boot.runCompose }
    const outcome = await reapProjects(projects.length === 0 ? opts : { ...opts, projects })
    for (const project of outcome.reaped) out.write(`reaped ${project}\n`)
    for (const failure of outcome.failures) err.write(`could not reap ${failure.project}: ${failure.reason}\n`)
    out.write(`reaped ${outcome.reaped.length} qare projects, ${outcome.failures.length} failures\n`)
    return outcome.failures.length === 0 ? 0 : 4
  } catch (error) {
    err.write(`${formatError(error)}\n`)
    return 4
  }
}

/**
 * The profile's redaction rules and the built-in ones; the built-in ones alone
 * when there is no profile to read, which is said on `out`. A profile that is
 * there but broken throws: redacting with fewer rules than it asks for would
 * publish what it names.
 */
async function redactionRulesFor(profileDir: string | undefined, out: Writer): Promise<readonly RedactionRule[]> {
  if (profileDir === undefined) return BUILTIN_REDACTION_RULES
  try {
    const profile = await loadProfile(resolve(profileDir))
    // The seeded second-factor secret and any backup code sweep in every path
    // that publishes evidence, judge included: the verifier reads the diff,
    // and the diff carries the profile change that seeds them (#64).
    const login = profile.app?.login
    return [...redactionRules(profile.redact), ...valueRules([login?.totp?.secret, login?.backupCode?.value])]
  } catch (error) {
    if (!(error instanceof ProfileMissingError)) throw error
    out.write(`no usable .qa/ profile at ${profileDir}, so only the built-in redaction rules apply\n`)
    return BUILTIN_REDACTION_RULES
  }
}

/**
 * The rules a result is judged or redacted with, given the profiles the result
 * says it ran (#55). One app is the path above: the rules its --profile names
 * plus the built-in ones. A result of several apps names every app it checked,
 * and each app's rules apply: the verifier reads the diff, and the diff can
 * carry fixture values any app's rules exist for. Every named app's profile is
 * read from under the .qa root the --profile gives, so one that cannot be read
 * fails the command: redacting with fewer rules than the run asks for would
 * publish what it names.
 */
async function redactionRulesForRun(
  profileDir: string | undefined,
  profiles: readonly { name: string; profile?: JobProfileRef }[] | undefined,
  out: Writer,
): Promise<readonly RedactionRule[]> {
  if (profiles === undefined) return redactionRulesFor(profileDir, out)
  if (profileDir === undefined)
    throw new Error(
      'the result names the apps it ran, and judge redacts with the rules of every app it checked; pass --profile <dir>, the .qa root the run resolved them from',
    )
  const rules = [...BUILTIN_REDACTION_RULES]
  try {
    // A monorepo's .qa root carries no profile of its own: the named apps hold
    // the rules, and the loop below reads each of them.
    rules.push(...(await rulesOf(resolve(profileDir))))
  } catch (error) {
    if (!(error instanceof ProfileMissingError)) throw error
  }
  for (const entry of profiles) {
    try {
      // An inline profile travels in the result itself: there is no directory
      // to read, so its rules are applied from the result alone.
      if (entry.profile !== undefined && 'inline' in entry.profile) {
        rules.push(...profileRules(entry.profile.inline))
        continue
      }
      // A path the qa-profile artifact cannot carry is refused rather than
      // silently read from the app's name alone (#55).
      if (entry.profile !== undefined && 'path' in entry.profile && entry.profile.path !== `.qa/${entry.name}`)
        throw new Error(
          `the result names profile path ${JSON.stringify(entry.profile.path)} for app ${JSON.stringify(entry.name)}, which the qa-profile artifact cannot carry: judge and redact read every named profile from the .qa root, so a run keeps them at .qa/${entry.name}`,
        )
      // A named profile shares the .qa root's fixtures and stubs, exactly as
      // the run that produced the result loaded it (issue #55).
      rules.push(...(await rulesOf(resolve(join(profileDir, entry.name)), resolve(profileDir))))
    } catch (error) {
      if (!(error instanceof ProfileMissingError)) throw error
      throw new Error(
        `no usable profile for app ${JSON.stringify(entry.name)} at ${join(profileDir, entry.name)}: judge redacts with the rules of every app the result checked, and this app's rules cannot be read`,
      )
    }
  }
  return rules
}

function profileRules(profile: QaProfile): readonly RedactionRule[] {
  const login = profile.app?.login
  return [...redactionRules(profile.redact), ...valueRules([login?.totp?.secret, login?.backupCode?.value])]
}

async function rulesOf(profileDir: string, resources?: string): Promise<readonly RedactionRule[]> {
  const profile = await loadProfile(profileDir, resources === undefined ? undefined : { resources })
  return profileRules(profile)
}

/**
 * The plan step as a command (#9): criteria and a diff in, plan.json out.
 *
 * It writes nothing unless the whole plan parsed and covered every criterion.
 * A half-written plan.json would be consumed by execute as though it were the
 * whole run. The one exception is the neutral fallback (#64): a plan the
 * loader rejects through its correction round is written with every criterion
 * unplannable, naming why, so execute and judge report the planning gap
 * instead of the pipeline going red.
 */
/**
 * The flow action kinds the change under review introduces (#64), as
 * `--flow-actions a,b`. They widen the planner's schema at the base revision;
 * a base revision whose qare has no such flag yet never reads it, and the run
 * still validates every action against the head revision's own vocabulary.
 */
function flowActionKinds(spec: string | undefined): string[] {
  if (spec === undefined) return []
  const kinds = spec
    .split(',')
    .map((kind) => kind.trim())
    .filter(Boolean)
  for (const kind of kinds)
    if (!/^[A-Za-z][A-Za-z0-9]{0,30}$/.test(kind))
      throw new Error(
        `--flow-actions takes comma-separated kind names (letters and digits, starting with a letter), not ${JSON.stringify(kind)}`,
      )
  if (kinds.length > 12) throw new Error('--flow-actions takes at most 12 kinds')
  return [...new Set(kinds)]
}

/**
 * The neutral fallback for a planner that had its correction round and still
 * produced nothing the loader accepts (#64): every criterion is carried,
 * marked unplannable with the reason, so execute reports it unverified and
 * judge reports it by name. The gap is in the planning vocabulary, and nothing
 * was disproven. Mirrors the one-off check path's `planOrReport`.
 */
function unplannedPlan(criteria: { id: string; text: string }[], reason: string): Plan {
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    criteria: criteria.map((criterion) => ({ ...criterion, unplannable: reason })),
  }
}

/**
 * The plan of a step in which several batches were all lost (#271): every
 * criterion asked about, unplannable for its own batch's reason. Undefined
 * unless the step's error accounts for exactly the criteria asked, in which
 * case the caller falls back to one reason for all of them, so no criterion
 * is ever left out of the plan.
 */
function unplannedByBatch(criteria: { id: string; text: string }[], unplanned: PlanStepError['unplanned']): Plan | undefined {
  if (unplanned === undefined || unplanned.length !== criteria.length) return undefined
  const reasons = new Map(unplanned.map((criterion) => [criterion.id, criterion.unplannable]))
  if (reasons.size !== criteria.length || criteria.some((criterion) => !reasons.has(criterion.id))) return undefined
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    criteria: criteria.map((criterion) => ({ ...criterion, unplannable: reasons.get(criterion.id) ?? '' })),
  }
}

/**
 * The paths the diff adds or changes. A content change carries the new path in
 * its `+++ b/` header; a rename, a binary file and a mode-only change carry it
 * in the git header's b/ side or the rename-to line instead. Deleted files are
 * genuinely gone, so they are not declared (#162).
 */
function touchedPaths(diff: string): string[] {
  const paths: string[] = []
  for (const chunk of diff.split(/^diff --git /m).slice(1)) {
    const lines = chunk.split('\n')
    const added = lines.find((line) => line.startsWith('+++ b/'))
    if (added !== undefined) {
      const path = added.slice('+++ b/'.length).trim()
      if (path !== '') paths.push(path)
      continue
    }
    const renamed = lines.find((line) => line.startsWith('rename to '))
    if (renamed !== undefined) {
      const path = renamed.slice('rename to '.length).trim()
      if (path !== '') paths.push(path)
      continue
    }
    const header = (lines[0] ?? '').match(/ b\/(.+)$/)
    const binary = lines.some((line) => line.startsWith('Binary files ') || line.startsWith('GIT binary patch'))
    const modeOnly = lines.some((line) => line.startsWith('old mode '))
    if ((binary || modeOnly) && header !== null) {
      const path = (header[1] ?? '').trim()
      if (path !== '') paths.push(path)
    }
  }
  return [...new Set(paths)]
}

/**
 * The declared run inputs of the pipeline's plan (#162): the plan file itself,
 * the profile directory, and every path the diff touches. The run's own
 * outputs are never declared — result.json and its siblings are written when
 * the run ends, which is exactly why the doomed checks of #162 looked
 * plannable to a planner that had only the pipeline's own prose to go by.
 */
function declaredRunPaths(outPath: string, profilePath: string | undefined, diff: string): string[] {
  // The plan file is deliberately not among the declared run inputs: it is the
  // output this planning step writes, so a check that reads it would only show
  // what the planner wrote, and plan time refuses such a read (#156).
  const paths: string[] = []
  // The planner only knows repository-relative paths, so an absolute --profile
  // is normalized against the same root as the plan file, and a relative one
  // is kept as the caller wrote it (#162).
  if (profilePath !== undefined) paths.push(relative(process.cwd(), resolve(profilePath)))
  paths.push(...touchedPaths(diff))
  return [...new Set(paths.filter((path) => path !== ''))]
}

async function planCommand(argv: string[], out: Writer, err: Writer): Promise<number> {
  try {
    const criteriaPath = flag(argv, '--criteria')
    const issuePath = flag(argv, '--issue')
    const diffPath = flag(argv, '--diff')
    if ((criteriaPath === undefined && issuePath === undefined) || diffPath === undefined)
      throw new Error('qare plan requires --diff <path> and one of --criteria <path> or --issue <path>')
    if (criteriaPath !== undefined && issuePath !== undefined)
      throw new Error('qare plan takes --criteria or --issue, not both')
    const outPath = resolve(flag(argv, '--out') ?? 'plan.json')
    const suites = flag(argv, '--suites')
      ?.split(',')
      .map((suite) => suite.trim())
      .filter(Boolean)
    const binary = flag(argv, '--nare')
    const flowActions = flowActionKinds(flag(argv, '--flow-actions'))
    const profilePath = flag(argv, '--profile')

    const allowNone = argv.includes('--allow-no-criteria')
    let criteria: { id: string; text: string }[]
    if (issuePath !== undefined) {
      try {
        criteria = criteriaFromIssue(await readFile(resolve(issuePath), 'utf8'))
      } catch (error) {
        // The pipeline asked for neutral rather than red: a change that states
        // no criteria has nothing to check, which is an outcome and not a
        // fault. Nothing is written, so no later step mistakes silence for a
        // plan.
        if (allowNone && error instanceof IssueCriteriaError && error.problem === 'none-stated') {
          out.write(`no acceptance criteria stated, so nothing was planned: ${error.message}\n`)
          return 0
        }
        throw error
      }
    } else {
      const loaded: unknown = JSON.parse(await readFile(resolve(criteriaPath as string), 'utf8'))
      if (!Array.isArray(loaded))
        throw new Error(`${criteriaPath} must hold a JSON array of {id, text} criteria`)
      criteria = loaded as { id: string; text: string }[]
    }
    let diff = await readFile(resolve(diffPath), 'utf8')
    let profile: QaProfile | undefined
    if (profilePath !== undefined) {
      // The diff can be the very change that seeds the profile, so the seeded
      // values sweep from the model-facing text before the planner sees it
      // (#64). No profile means nothing seeded to sweep; a profile that is
      // there but broken throws, as everywhere else.
      try {
        profile = await loadProfile(resolve(profilePath))
        const login = profile.app?.login
        const redacted = redactText(diff, valueRules([login?.totp?.secret, login?.backupCode?.value]))
        if (redacted !== diff) out.write("the profile's seeded values are redacted from the diff before planning\n")
        diff = redacted
      } catch (error) {
        if (!(error instanceof ProfileMissingError)) throw error
        out.write(`no usable .qa/ profile at ${profilePath}, so the diff is not swept for seeded values\n`)
      }
    }

    const runner = new NareAgentRunner(binary === undefined ? {} : { binary })
    // The browser driver is what a plan can assume; the change's own kinds
    // extend it, so a plan may name them even though the browser lacks them.
    // A profile that maps an MCP driver plans against that mapping instead:
    // it is the driver's capability declaration (#94).
    // A profile that names a client plans against that client's driver (#72).
    const declared = flowDriverFor(profile)
    // Unless the image execute will run in ships no browser (#258): then
    // there is no driver to plan against, and the planner is offered suites
    // and commands instead of flows that would end at browserType.launch.
    const browserless = browserlessFlavour(profile)
    const driver: FlowDriverCapabilities | undefined =
      browserless !== undefined
        ? undefined
        : declared !== BROWSER_FLOW_DRIVER || flowActions.length === 0
          ? declared
          : { ...BROWSER_FLOW_DRIVER, actions: [...BROWSER_FLOW_DRIVER.actions, ...flowActions] }
    if (browserless !== undefined)
      out.write(
        `the profile's flavour is ${browserless}, whose image ships no browser, so the plan uses suites and commands: set "flavour: web" in ${join(profilePath ?? '.qa', 'config.yml')} to plan browser checks\n`,
      )
    // The profile's own suites reach the planner with what they run (#258),
    // beside any the caller named that the profile does not declare.
    // A command crosses to the model, so the seeded values are swept from it
    // here, as they are from the diff (#64); the plan step sweeps the
    // built-in and profile rules itself.
    const seeded = valueRules([profile?.app?.login?.totp?.secret, profile?.app?.login?.backupCode?.value])
    const declaredSuites: PlanSuite[] = (profile?.suites ?? []).map((suite) => ({
      name: suite.name,
      kind: suite.kind,
      command: redactText(suite.command, seeded),
    }))
    const plannerSuites: (string | PlanSuite)[] = [
      ...declaredSuites,
      ...(suites ?? []).filter((name) => !declaredSuites.some((suite) => suite.name === name)),
    ]
    const appAddress = profile?.app === undefined ? undefined : plannedAppAddress(profile.app.health.http)
    await mkdir(dirname(outPath), { recursive: true })
    let plan: Plan
    // The profile's registered MCP servers the plan step may look through (#93):
    // started here, served to the planner over one channel, recorded to
    // mcp-calls.jsonl beside the plan, and closed whatever the planning did.
    // How many batches the plan had, as the plan step reported them.
    let batchCount = 0
    const mcpRecords: McpCallRecord[] = []
    let mcpSources: McpSource[] = []
    let mcpServer: McpToolServer | undefined
    try {
      const started = await startRegisteredMcpSources(profile?.mcp ?? [], 'plan', {
        record: (record) => mcpRecords.push(record),
      })
      mcpSources = started.sources
      for (const failure of started.failures)
        out.write(`host mcp server '${failure.server}' is unreachable: ${failure.reason}\n`)
      mcpServer = started.sources.length === 0 ? undefined : await startMcpToolServer(started.sources)
      plan = await planRun(runner, {
        criteria,
        diff,
        ...(driver === undefined ? {} : { driver }),
        ...(browserless === undefined ? {} : { noBrowser: { flavour: browserless } }),
        repoPath: process.cwd(),
        runInputs: { paths: declaredRunPaths(outPath, profilePath, diff) },
        ...(suites === undefined && declaredSuites.length === 0 ? {} : { suites: plannerSuites }),
        // A plan of several turns says where it stands (#259): with a slow
        // model each turn is minutes, and a lost one is named as it happens.
        onBatch: (report) => {
          batchCount = report.of
          if (report.of === 1) return
          const batch = `batch ${report.index} of ${report.of} (${report.criteria.join(', ')})`
          // What the batch cost is what a caller tunes the size and the budget by.
          const cost = report.usage === undefined ? '' : ` [${report.usage.inputTokens} input tokens, ${report.usage.outputTokens} output]`
          out.write(
            report.outcome === 'planned'
              ? `planned ${batch}${cost}\n`
              : `${batch} could not be planned, so its criteria are marked unplannable: ${report.reason ?? 'no reason recorded'}${cost}\n`,
          )
        },
        ...(flowActions.length === 0 ? {} : { flowActions }),
        ...(profile?.client === undefined ? {} : { client: profile.client.driver }),
        // The address of the app the run boots, as a plan may write it (#264).
        ...(appAddress === undefined ? {} : { app: { address: appAddress } }),
        ...(profile?.instructions ? { qaMd: profile.instructions } : {}),
        ...(profile?.redact === undefined ? {} : { redact: profile.redact }),
        ...(profile?.commands === undefined ? {} : { commands: profile.commands }),
        ...(mcpServer === undefined
          ? {}
          : {
              mcp: {
                endpoint: mcpServer.url,
                servers: mcpSources.map((source) => ({
                  name: source.name,
                  tools: source.tools.map((tool) =>
                    tool.description === undefined ? { name: tool.name } : { name: tool.name, description: tool.description },
                  ),
                })),
              },
            }),
      })
    } catch (error) {
      // planRun already gave the planner its one correction round, carrying
      // the loader's reason. Still nothing usable, so the fallback applies
      // (#64): every criterion is marked unplannable naming why, and the
      // pipeline's later jobs report the planning gap instead of going red.
      if (!(error instanceof PlanStepError)) throw error
      const named = `${error.name}: ${error.message}`
      // When several batches were all lost, each criterion keeps its own
      // batch's reason (#271): the step's message names the first batch's
      // only, and that check was never the other criteria's. The batches
      // were each reported as they ended, reason and all.
      const unplanned = unplannedByBatch(criteria, error.unplanned)
      out.write(
        unplanned === undefined
          ? `the planner could not produce a usable plan, so every criterion is marked unplannable: ${named}\n`
          : `none of the ${batchCount} batches could be planned, so every criterion is marked unplannable with its own batch's reason\n`,
      )
      // The turns that failed were still paid for (#259), and the plan says so.
      plan = { ...(unplanned ?? unplannedPlan(criteria, `planning failed (${named})`)), ...(error.usage === undefined ? {} : { usage: error.usage }) }
    } finally {
      await mcpServer?.close().catch(() => {})
      await Promise.all(mcpSources.map((source) => source.close().catch(() => {})))
    if (mcpRecords.length > 0) {
      const mcpPath = join(dirname(outPath), 'mcp-calls.jsonl')
      // The records are evidence, so they leave through the same redaction
      // the rest of the evidence sweeps: built-in rules, the profile's, and
      // the seeded values, before the file is written for the workflow to
      // upload (#93, #52).
      const login = profile?.app?.login
      const rules = [...redactionRules(profile?.redact), ...valueRules([login?.totp?.secret, login?.backupCode?.value])]
      await writeFile(mcpPath, mcpRecordsFile(mcpRecords, rules), 'utf8')
      out.write(`recorded ${mcpRecords.length} host tool calls; ${mcpPath}\n`)
    }
    }
    if (flowActions.length > 0)
      out.write(`planning with the change's flow action kinds: ${flowActions.join(', ')}\n`)

    await writeFile(outPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8')
    const unplannable = plan.criteria.filter((criterion) => 'unplannable' in criterion).length
    out.write(
      `planned ${plan.criteria.length} criteria (${unplannable} unplannable); ${outPath}\n`,
    )
    return 0
  } catch (error) {
    err.write(`${formatError(error)}\n`)
    return 4
  }
}

async function readinessCommand(argv: string[], out: Writer, err: Writer): Promise<number> {
  try {
    let path: string | undefined
    let outSpec: string | undefined
    for (let i = 0; i < argv.length; i += 1) {
      if (argv[i] === '--out') {
        outSpec = argv[i + 1]
        if (outSpec === undefined) throw new Error('qare readiness requires a file value after --out')
        i += 1
        continue
      }
      if (argv[i] === '--help' || argv[i] === '-h') {
        out.write(`qare readiness [path] [--out <file>]\n  inventory a repo for QA readiness; never runs checks, never writes a result\n`)
        return 0
      }
      if (argv[i]!.startsWith('-')) throw new Error(`unknown readiness flag ${JSON.stringify(argv[i])}`)
      if (path !== undefined) throw new Error('qare readiness accepts at most one path argument')
      path = argv[i]
    }
    const repoPath = path === undefined ? process.cwd() : resolve(path)
    const inventory = await readinessInventory(repoPath)
    const report = buildReadinessReport(inventory)
    out.write(report)
    if (outSpec !== undefined) {
      await mkdir(dirname(outSpec), { recursive: true })
      await writeFile(outSpec, report, 'utf8')
      out.write(`report ${outSpec}\n`)
    }
    return 0
  } catch (error) {
    err.write(`${formatError(error)}\n`)
    return 4
  }
}

/**
 * `qare doctor`: what this host has, what the profile needs, and how to
 * install what is missing (#91). The exit codes are the run contract's: 0 the
 * host can run what the profile asks for, 1 a required piece is missing, 4 the
 * invocation is wrong (a broken profile is one, so it is named on `err`).
 */
async function doctorCommand(argv: string[], out: Writer, err: Writer): Promise<number> {
  try {
    for (const arg of argv.filter((entry) => entry.startsWith('-')))
      if (arg !== '--profile' && arg !== '--nare' && arg !== '--json') throw new Error(`qare doctor does not take ${arg}`)
    const profile = flag(argv, '--profile')
    const nare = flag(argv, '--nare')
    const report = await runDoctor({
      ...(profile === undefined ? {} : { profilePath: profile }),
      ...(nare === undefined ? {} : { nare }),
    })
    if (argv.includes('--json')) {
      out.write(`${JSON.stringify(report, null, 2)}\n`)
    } else {
      out.write(`execution ${report.execution}\n`)
      for (const finding of report.findings) {
        out.write(`${finding.required && !finding.ok ? 'missing' : 'ok'} ${finding.name}: ${finding.detail}\n`)
        if (finding.install !== undefined) out.write(`  ${finding.install}\n`)
      }
      out.write(report.ready ? 'this host can run qare natively\n' : 'this host is missing what the run needs\n')
    }
    return report.ready ? 0 : 1
  } catch (error) {
    err.write(`${formatError(error)}\n`)
    return 4
  }
}

/**
 * `qare profiles`: say which `.qa/` profiles a run would select, before any
 * check runs. Reads the same selection a several-profile run does (#55): all
 * profiles when no diff or paths are given, the profiles whose areas (or own
 * directory) a change touches otherwise. A repository without `.qa/` is not
 * an error here — the report says so; a malformed profile is (#107).
 */
async function profilesCommand(argv: string[], out: Writer, err: Writer): Promise<number> {
  try {
    let path: string | undefined
    let outSpec: string | undefined
    let qaDir: string | undefined
    let diffSpec: string | undefined
    let paths: string[] | undefined
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i]
      if (arg === '--out') {
        outSpec = argv[i + 1]
        if (outSpec === undefined) throw new Error('qare profiles requires a file value after --out')
        i += 1
        continue
      }
      if (arg === '--diff') {
        diffSpec = argv[i + 1]
        if (diffSpec === undefined) throw new Error('qare profiles requires a file value after --diff')
        i += 1
        continue
      }
      if (arg === '--paths') {
        const spec = argv[i + 1]
        if (spec === undefined) throw new Error('qare profiles requires a comma-separated list after --paths')
        paths = spec.split(',').filter(entry => entry !== '')
        i += 1
        continue
      }
      if (arg === '--qa') {
        qaDir = argv[i + 1]
        if (qaDir === undefined) throw new Error('qare profiles requires a directory value after --qa')
        i += 1
        continue
      }
      if (arg === '--help' || arg === '-h') {
        out.write('qare profiles [path] [--diff <path> | --paths a,b] [--out <file>]\n  report which .qa/ profiles a run would select; never runs checks\n')
        return 0
      }
      if (arg!.startsWith('-')) throw new Error(`unknown profiles flag ${JSON.stringify(arg)}`)
      if (path !== undefined) throw new Error('qare profiles accepts at most one path argument')
      path = arg
    }
    if (diffSpec !== undefined && paths !== undefined)
      throw new Error('qare profiles takes --diff or --paths, not both: one change selects profiles one way')
    const repoPath = path === undefined ? process.cwd() : resolve(path)
    const qa = resolve(qaDir ?? join(repoPath, '.qa'))
    const all = await discoverProfiles(qa)
    // Without a diff or paths this reports every profile the repository
    // holds; with one, it reports the profiles a change touching those
    // paths would run (#55).
    const selected =
      diffSpec === undefined && paths === undefined
        ? all
        : selectProfiles(all, diffSpec !== undefined ? touchedPathsFromDiff(await readFile(resolve(diffSpec), 'utf8')) : (paths ?? []))
    const lines =
      selected.length === 0
        ? ['no .qa/ profile matches what this change touches']
        : selected.map(profile => `${profile.name}\t${profile.dir}`)
    const report = `${lines.join('\n')}\n`
    out.write(report)
    if (outSpec !== undefined) {
      await mkdir(dirname(outSpec), { recursive: true })
      await writeFile(outSpec, report, 'utf8')
      out.write(`report ${outSpec}\n`)
    }
    return 0
  } catch (error) {
    err.write(`${formatError(error)}\n`)
    return 4
  }
}

async function judgeCommand(argv: string[], out: Writer, err: Writer): Promise<number> {
  try {
    const resultFlag = argv.indexOf('--result')
    const resultSpec = resultFlag === -1 ? undefined : argv[resultFlag + 1]
    if (resultSpec === undefined)
      throw new Error('qare judge requires --result <path> (the result.json written by qare run)')
    const outDirFlag = argv.indexOf('--outDir')
    const outDirSpec = outDirFlag === -1 ? undefined : argv[outDirFlag + 1]
    if (outDirFlag !== -1 && outDirSpec === undefined)
      throw new Error('qare judge requires a directory value after --outDir')
    const runnerFlag = argv.indexOf('--runner')
    const runnerSpec = runnerFlag === -1 ? 'nare' : argv[runnerFlag + 1]
    if (runnerSpec !== 'nare' && runnerSpec !== 'none')
      throw new Error(`unknown --runner ${JSON.stringify(runnerSpec)} (expected "nare" or "none")`)

    const binary = flag(argv, '--nare')
    const planPath = flag(argv, '--plan')
    const diffPath = flag(argv, '--diff')
    const flowActions = flowActionKinds(flag(argv, '--flow-actions'))

    const resultPath = resolve(resultSpec)
    const outDir = outDirSpec === undefined ? dirname(resultPath) : resolve(outDirSpec)
    const loaded = loadResult(await readFile(resultPath, 'utf8'))
    // Everything judge writes is published, and the verifier's reasons are
    // model text about evidence and a diff that can carry fixture data. The
    // rules are read once the result is: a result of several apps is swept
    // with the rules of every app it checked (#55).
    const rules = await redactionRulesForRun(flag(argv, '--profile'), loaded.profiles, out)
    // Nothing ran on a refused run, so there is no evidence for the verifier
    // to read and a model call would be spent on nothing.
    const verify = runnerSpec === 'nare' && loaded.verdict !== 'refused'
    if (verify && (planPath === undefined || diffPath === undefined))
      throw new Error(
        'qare judge checks proven criteria with the verifier, which needs --plan <path> (for the criteria text) and --diff <path>; pass --runner none to judge without it',
      )
    const plan = verify ? loadPlan(await readFile(resolve(planPath as string), 'utf8'), flowActions) : undefined
    // Evidence paths in result.json are relative to its directory, and that
    // directory is all the verifier's read tool can reach.
    const evidenceDir = dirname(resultPath)
    const texts = Object.fromEntries((plan?.criteria ?? []).map((criterion) => [criterion.id, criterion.text]))
    const { result: judged, changed } = await judgeExecuted(loaded, {
      texts,
      // The verifier reads the diff, and the diff can carry the seeded values
      // the profile rules exist for: the model-facing text is swept like any
      // evidence (#64).
      diff: verify ? redactText(await readFile(resolve(diffPath as string), 'utf8'), rules) : '',
      rules,
      ...(verify ? { verifier: nareRunners(binary).verifier(evidenceDir) } : {}),
    })
    for (const criterion of changed)
      err.write(`verifier: ${criterion.criterionId} ${criterion.outcome}: ${redactText(criterion.reason, rules)}\n`)
    // The verdict is decided. The advisory UX review (#150) comes after it and
    // is handed the judged result only to copy it: the check run and the
    // verdict line below are written from `judged`, which the review never
    // touches, and the review's findings ride the comment and the `advisory`
    // key alone.
    const result = verify
      ? await reviewAdvisory(judged, { argv, binary, evidenceDir, texts, rules, profiles: loaded.profiles, err })
      : judged
    await mkdir(outDir, { recursive: true })
    await writeFile(join(outDir, 'judged-result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    await writeFile(join(outDir, 'comment.md'), `${renderComment(result)}\n`, 'utf8')
    await writeFile(join(outDir, 'checkrun.json'), `${JSON.stringify(renderCheckRun(judged), null, 2)}\n`, 'utf8')
    out.write(`verdict ${judged.verdict}; artifacts ${outDir}\n`)
    return 0
  } catch (error) {
    err.write(`${formatError(error)}\n`)
    return 4
  }
}

/**
 * The advisory UX review of a judged run (#150), through nare, read-only and
 * confined to the evidence exactly as the verifier is. Nothing here can stop
 * or change a judgement: the reviewer fails to `unavailable` inside
 * `reviewJudged`, and anything that goes wrong around it (a profile that will
 * not load, a dismissed list that will not parse) is said on `err` and the
 * judged result is returned as it came.
 */
async function reviewAdvisory(
  judged: RunResult,
  opts: {
    argv: string[]
    binary: string | undefined
    evidenceDir: string
    texts: Record<string, string>
    rules: readonly RedactionRule[]
    profiles: readonly { name: string; criteria: string[]; profile?: JobProfileRef }[] | undefined
    err: Writer
  },
): Promise<RunResult> {
  try {
    const context = await uxContextFor(flag(opts.argv, '--profile'), opts.profiles)
    const dismissed = await dismissedFindings(flag(opts.argv, '--dismissed'), opts.err)
    const reviewed = await reviewJudged(judged, {
      reviewer: nareRunners(opts.binary).verifier(opts.evidenceDir),
      texts: opts.texts,
      rules: opts.rules,
      dismissed,
      ...context,
    })
    const advisory = reviewed.advisory
    if (advisory?.status === 'unavailable') opts.err.write(`advisory: the UX review did not answer: ${advisory.reason ?? ''}\n`)
    else if (advisory !== undefined)
      opts.err.write(`advisory: ${advisory.findings.length} finding(s) on ${advisory.screens.length} screen(s); the verdict was decided without them\n`)
    return reviewed
  } catch (error) {
    opts.err.write(`advisory: no UX review was made (${formatError(error)}); the verdict does not depend on it\n`)
    return judged
  }
}

/**
 * What the profile gives the reviewer: QA.md, the house rules, and the
 * criteria whose screens are left out because their profile turned the review
 * off. A run of several apps reads each app's profile the way the redaction
 * rules are read, and names each rule for its app.
 */
async function uxContextFor(
  profileDir: string | undefined,
  profiles: readonly { name: string; criteria: string[]; profile?: JobProfileRef }[] | undefined,
): Promise<{ qaMd?: string; houseRules?: string[]; skip?: (criterionId: string) => boolean; appOf?: (criterionId: string) => string | undefined }> {
  if (profileDir === undefined) return {}
  if (profiles === undefined) {
    let profile: QaProfile
    try {
      profile = await loadProfile(resolve(profileDir))
    } catch (error) {
      if (!(error instanceof ProfileMissingError)) throw error
      return {}
    }
    return {
      ...(profile.instructions === undefined ? {} : { qaMd: profile.instructions }),
      ...(profile.ux?.rules === undefined ? {} : { houseRules: profile.ux.rules }),
      ...(profile.ux?.review === false ? { skip: () => true } : {}),
    }
  }
  const off = new Set<string>()
  const apps = new Map<string, string>()
  const instructions: string[] = []
  const houseRules: string[] = []
  for (const entry of profiles) {
    const profile =
      entry.profile !== undefined && 'inline' in entry.profile
        ? entry.profile.inline
        : await loadProfile(resolve(join(profileDir, entry.name)), { resources: resolve(profileDir) })
    for (const id of entry.criteria) apps.set(id, entry.name)
    if (profile.ux?.review === false) for (const id of entry.criteria) off.add(id)
    if (profile.instructions !== undefined) instructions.push(`# ${entry.name}\n\n${profile.instructions}`)
    for (const rule of profile.ux?.rules ?? []) houseRules.push(`${entry.name}: ${rule}`)
  }
  return {
    ...(instructions.length === 0 ? {} : { qaMd: instructions.join('\n\n') }),
    ...(houseRules.length === 0 ? {} : { houseRules }),
    skip: (criterionId) => off.has(criterionId),
    // Each screen is handed over naming its app, so a rule that opens with an
    // app's name is held to that app's screens alone.
    appOf: (criterionId) => apps.get(criterionId),
  }
}

/**
 * The findings a person dismissed on this change, as the pipeline read them
 * off the pull request (`--dismissed <path>`). A list that cannot be read is
 * said and treated as empty: it is advisory input, and never a reason to stop
 * a judgement.
 */
async function dismissedFindings(path: string | undefined, err: Writer): Promise<DismissedFinding[]> {
  if (path === undefined) return []
  try {
    const parsed: unknown = JSON.parse(await readFile(resolve(path), 'utf8'))
    const list = typeof parsed === 'object' && parsed !== null && 'dismissed' in parsed ? parsed.dismissed : undefined
    if (!Array.isArray(list)) throw new Error('it must be a JSON object with a dismissed array')
    return list.map((entry: unknown, index): DismissedFinding => {
      if (typeof entry !== 'object' || entry === null) throw new Error(`dismissed[${index}] must be a JSON object`)
      const { id, screen, category, saw, element } = entry as Record<string, unknown>
      if (typeof id !== 'string' || typeof screen !== 'string' || typeof category !== 'string' || typeof saw !== 'string')
        throw new Error(`dismissed[${index}] must carry id, screen, category and saw as strings`)
      return { id, screen, category, saw, ...(typeof element === 'string' ? { element } : {}) }
    })
  } catch (error) {
    err.write(`advisory: the dismissed list at ${path} could not be read (${error instanceof Error ? error.message : String(error)}), so nothing is treated as dismissed\n`)
    return []
  }
}

/**
 * Re-run a verdict from its artifacts (#54): an evidence directory in, the
 * verdict recomputed from plan.json and result.json with no model and no
 * network. Byte-identical with the stored judged-result.json when the verdict
 * is exactly what judge wrote, and a clear per-criterion diff when it is not.
 * Exit 0 reproduces the verdict (or the run was never judged), 1 it differs,
 * 4 the artifacts are unusable.
 */
async function replayCommand(argv: string[], out: Writer, err: Writer): Promise<number> {
  try {
    if (argv.some((arg) => arg.startsWith('-'))) throw new Error('qare replay takes no flags')
    if (argv.length !== 1) throw new Error('qare replay takes exactly one run directory')
    const dir = resolve(argv[0] as string)
    const plan = loadPlan(await readArtifact(dir, 'plan.json'))
    const executed = loadResult(await readArtifact(dir, 'result.json'))
    const stored = await readStoredVerdict(dir)
    const report = await replayRun({ plan, executed, ...(stored === undefined ? {} : { stored }) })
    out.write(`verdict ${report.result.verdict}; replayed ${dir}\n`)
    if (stored === undefined) {
      out.write('no judged-result.json stored with the run, so there is nothing to compare\n')
      return 0
    }
    if (report.identical) {
      out.write('byte-identical with the stored judged verdict\n')
      return 0
    }
    for (const difference of report.differences) out.write(`${describeDifference(difference)}\n`)
    if (report.explanation !== undefined) out.write(`${report.explanation}\n`)
    return 1
  } catch (error) {
    err.write(`${formatError(error)}\n`)
    return 4
  }
}

/**
 * The judged-result.json a run stored, when it is there at all: a run judged
 * by an older qare, or one that was never judged, is still replayable.
 */
async function readStoredVerdict(dir: string) {
  let bytes: string
  try {
    bytes = await readFile(join(dir, 'judged-result.json'), 'utf8')
  } catch (error) {
    if (!isEnoent(error)) throw error
    try {
      bytes = await readFile(join(dir, 'evidence', 'judged-result.json'), 'utf8')
    } catch (nested) {
      if (isEnoent(nested)) return undefined
      throw nested
    }
  }
  return { bytes, result: loadResult(bytes) }
}

/**
 * One artifact of the run: plan.json, result.json and judged-result.json sit
 * beside each other when judge writes beside the result, and the pipeline's
 * judge workspace keeps plan.json and judged-result.json at its root with the
 * executed result.json below evidence/, so both layouts replay.
 */
async function readArtifact(dir: string, name: string): Promise<string> {
  try {
    return await readFile(join(dir, name), 'utf8')
  } catch (error) {
    if (!isEnoent(error)) throw error
  }
  try {
    return await readFile(join(dir, 'evidence', name), 'utf8')
  } catch (error) {
    if (isEnoent(error))
      throw new Error(`qare replay reads the artifacts of a run; ${dir} has no ${name} in the directory or its evidence subdirectory`)
    throw error
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function describeDifference(difference: ReplayDifference): string {
  if (difference.field === 'verdict')
    return `verdict: stored ${difference.stored}, replayed ${difference.replayed}`
  if (difference.field === 'reason')
    return `criterion ${difference.criterionId} reason: stored "${difference.stored}", replayed "${difference.replayed}"`
  return `criterion ${difference.criterionId}: stored ${difference.stored}, replayed ${difference.replayed}`
}

export async function runLedgerCommand(argv: string[], out: Writer, err: Writer): Promise<number> {
  try {
    const ledgerFlag = argv.indexOf('--ledger')
    const ledgerSpec = ledgerFlag === -1 ? undefined : argv[ledgerFlag + 1]
    if (ledgerFlag !== -1 && ledgerSpec === undefined)
      throw new Error('qare ledger requires a directory value after --ledger')
    const rest =
      ledgerFlag === -1 ? argv : [...argv.slice(0, ledgerFlag), ...argv.slice(ledgerFlag + 2)]
    const [sub, ...subArgs] = rest
    const dir = resolve(ledgerSpec ?? '.qa')
    if (sub === undefined)
      throw new Error(
        'qare ledger requires a subcommand; usage: qare ledger <list|show|diff|status|contradict|resolve|decide|export|import|publish|migrate> [--ledger <dir>]',
      )
    if (sub === 'list') return await ledgerList(dir, out)
    if (sub === 'show') return await ledgerShow(dir, subArgs[0], out)
    if (sub === 'diff') return await ledgerDiff(dir, subArgs, out)
    if (sub === 'status') return await ledgerStatus(dir, out, err)
    if (sub === 'contradict') return await ledgerContradict(subArgs, dir, out)
    if (sub === 'resolve') return await ledgerResolve(subArgs, dir, out)
    if (sub === 'decide') return await ledgerDecide(subArgs, dir, out)
    if (sub === 'export') return await ledgerExport(subArgs, dir, out)
    if (sub === 'import') return await ledgerImport(subArgs, dir, out)
    if (sub === 'publish') return await ledgerPublish(subArgs, dir, out)
    if (sub === 'migrate') return await ledgerMigrate(subArgs, dir, out)
    throw new Error(
      `unknown ledger subcommand ${JSON.stringify(sub)}; usage: qare ledger <list|show|diff|status|contradict|resolve|decide|export|import|publish|migrate> [--ledger <dir>]`,
    )
  } catch (error) {
    err.write(`${formatError(error)}\n`)
    return 1
  }
}

function byCriterion(a: LedgerEntry, b: LedgerEntry): number {
  return a.criterion < b.criterion ? -1 : a.criterion > b.criterion ? 1 : 0
}

async function ledgerList(dir: string, out: Writer): Promise<number> {
  const entries = await new FileLedgerStore(dir).load()
  for (const entry of [...entries].sort(byCriterion))
    out.write(`${entry.criterion}  ${entry.status}  ${entry.proof}\n`)
  return 0
}

async function ledgerShow(dir: string, criterion: string | undefined, out: Writer): Promise<number> {
  if (criterion === undefined) throw new Error('qare ledger show requires a criterion id')
  const entries = await new FileLedgerStore(dir).load()
  const entry = entries.find((candidate) => candidate.criterion === criterion)
  if (entry === undefined)
    throw new Error(`ledger: show: no entry for criterion ${JSON.stringify(criterion)}`)
  out.write(`criterion: ${entry.criterion}\n`)
  out.write(`status: ${entry.status}\n`)
  out.write(`proof: ${entry.proof}\n`)
  for (const link of entry.source) out.write(`source: ${link}\n`)
  if (entry.note !== undefined) out.write(`note: ${entry.note}\n`)
  return 0
}

async function ledgerDiff(dir: string, subArgs: string[], out: Writer): Promise<number> {
  const againstFlag = subArgs.indexOf('--against')
  const againstSpec = againstFlag === -1 ? undefined : subArgs[againstFlag + 1]
  if (againstSpec === undefined)
    throw new Error('qare ledger diff requires --against <other-ledger-dir>')
  const base = await new FileLedgerStore(dir).load()
  const other = await new FileLedgerStore(resolve(againstSpec)).load()
  const baseByCriterion = new Map(base.map((entry) => [entry.criterion, entry]))
  const otherByCriterion = new Map(other.map((entry) => [entry.criterion, entry]))
  const criteria = [...new Set([...baseByCriterion.keys(), ...otherByCriterion.keys()])]
  criteria.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  for (const criterion of criteria) {
    const from = baseByCriterion.get(criterion)
    const to = otherByCriterion.get(criterion)
    if (from === undefined && to !== undefined) out.write(`+ ${criterion} ${to.status} ${to.proof}\n`)
    else if (from !== undefined && to === undefined) out.write(`- ${criterion} ${from.status} ${from.proof}\n`)
    else if (
      from !== undefined &&
      to !== undefined &&
      (from.status !== to.status || from.proof !== to.proof || from.note !== to.note)
    )
      out.write(`~ ${criterion} ${changedEntry(from, to)} → ${changedEntry(to, from)}\n`)
  }
  return 0
}

function changedEntry(side: LedgerEntry, other: LedgerEntry): string {
  let text = side.status
  if (side.proof !== other.proof) text += ` proof=${side.proof}`
  if (side.note !== undefined && side.note !== other.note) text += ` note="${side.note}"`
  return text
}

async function ledgerStatus(dir: string, out: Writer, err: Writer): Promise<number> {
  let entries
  try {
    entries = await new FileLedgerStore(dir).load()
  } catch (error) {
    err.write(`integrity: tampered (${formatError(error)})\n`)
    return 1
  }
  const counts = { proposed: 0, active: 0, superseded: 0, retired: 0 }
  for (const entry of entries) counts[entry.status] += 1
  out.write(
    `proposed: ${counts.proposed} active: ${counts.active} superseded: ${counts.superseded} retired: ${counts.retired} total: ${entries.length}\n`,
  )
  out.write('integrity: ok\n')
  // The quarantine (#50): what the runs wrote when a check failed and passed
  // across attempts, and the checks a later run skips until it is cleared.
  const quarantine = await readQuarantine(dir)
  if (quarantine.unreadable !== undefined) out.write(`quarantine: unreadable (${quarantine.unreadable})\n`)
  else if (quarantine.records.length === 0) out.write('quarantine: none\n')
  else {
    out.write(`quarantine: ${quarantine.records.length}\n`)
    for (const record of quarantine.records)
      out.write(`quarantined check ${record.check} of criterion ${record.criterion} at ${record.quarantinedAt}: ${record.reason}\n`)
  }
  // What the runs amount to over time (#51), from the metrics store beside
  // the ledger. A repository that has recorded no runs says so by its
  // absence; a store that cannot be read is named with why, and a store of
  // malformed lines alone is not mistaken for an empty one, because metrics
  // describe runs and do not gate the ledger.
  let metrics: MetricsStore | undefined
  let metricsError: unknown
  try {
    metrics = await readMetricsStore(join(dir, 'metrics'))
  } catch (error) {
    metricsError = error
  }
  if (metricsError !== undefined) out.write(`metrics: unreadable (${formatError(metricsError)})\n`)
  else if (metrics !== undefined && (metrics.runs.length > 0 || metrics.notes.length > 0 || metrics.malformed > 0)) {
    for (const line of metricsSummaryLines(summarizeMetrics(metrics))) out.write(`metrics: ${line}\n`)
    if (metrics.malformed > 0) out.write(`metrics: ${metrics.malformed} store line(s) were not valid and were skipped\n`)
  } else {
    out.write('metrics: none\n')
  }
  return 0
}

/**
 * `qare ledger export`: write the whole ledger, entries and history, as plain
 * files anyone can read with no QARE installed (#58): `ledger.json` carries
 * the document that imports back with no loss, `CRITERIA.md` the current
 * state, and `HISTORY.md` the recorded changes. It runs at any time and
 * writes nothing to the store.
 */
async function ledgerExport(argv: string[], ledgerDir: string, out: Writer): Promise<number> {
  const outFlag = flag(argv, '--out') ?? 'ledger-export'
  const target = resolve(outFlag)
  const document = await new FileLedgerStore(ledgerDir).loadDocument()
  const quarantined = await heldCriteriaIn(ledgerDir, document.entries)
  await mkdir(target, { recursive: true })
  await writeFile(join(target, LEDGER_FILE), serializeLedgerDocument(document.entries, document.changes), 'utf8')
  await writeFile(join(target, 'CRITERIA.md'), renderCriteriaMarkdown(document, quarantined), 'utf8')
  await writeFile(join(target, 'HISTORY.md'), renderHistoryMarkdown(document.changes), 'utf8')
  out.write(
    `exported ${document.entries.length} entries and ${document.changes.length} change records to ${target}\n`,
  )
  return 0
}

/**
 * `qare ledger import`: read an exported ledger through the strict loader —
 * the chain must verify — and save it whole, so an exported ledger imports
 * back with no loss (#58). The import itself is a recorded change: it names
 * who imported, when, and why, and the target's own history must be carried
 * forward intact by what is imported, or the import is refused. The
 * published view is refreshed, because the published state follows the
 * ledger whenever it changes.
 */
async function ledgerImport(argv: string[], ledgerDir: string, out: Writer): Promise<number> {
  const from = flag(argv, '--from')
  if (from === undefined) throw new Error('qare ledger import requires --from <export dir>')
  const by = flag(argv, '--by')
  if (by === undefined) throw new Error('qare ledger import requires --by <who made this change>')
  const why = flag(argv, '--why')
  if (why === undefined) throw new Error('qare ledger import requires --why <reason>')
  const at = flag(argv, '--at') ?? new Date().toISOString()
  const store = new FileLedgerStore(ledgerDir)
  const imported = parseLedgerDocument(
    JSON.parse(await readFile(join(resolve(from), LEDGER_FILE), 'utf8')),
  )
  const current = await store.loadDocument()
  if (
    current.changes.length > 0 &&
    JSON.stringify(imported.changes.slice(0, current.changes.length)) !== JSON.stringify(current.changes)
  )
    throw new Error(
      'ledger import: the imported history does not carry the ledger history forward; importing it would rewrite what is recorded',
    )
  const changes = appendChange(imported.changes, {
    kind: 'import',
    actor: by,
    timestamp: at,
    reason: why,
    criteria: [],
  })
  await store.saveDocument(imported.entries, changes)
  const publishFlag = flag(argv, '--publish') ?? 'CRITERIA.md'
  await writeFile(resolve(publishFlag), renderCriteriaMarkdown(
    { entries: imported.entries, changes },
    await heldCriteriaIn(ledgerDir, imported.entries),
  ), 'utf8')
  out.write(
    `imported ${imported.entries.length} entries with ${changes.length} change records: history intact\n`,
  )
  out.write(`published view refreshed: ${resolve(publishFlag)}\n`)
  return 0
}

/**
 * A count read the way a person writes it: one entry, two entries.
 */
function counted(n: number, singular: string, plural: string): string {
  return n === 1 ? `1 ${singular}` : `${n} ${plural}`
}

/**
 * `qare ledger migrate`: move a ledger between the two backends (#59). The
 * document travels whole, entries and hash-chained history, so ids and
 * history arrive exactly as they left. `--dry-run` reports what would move
 * and writes nothing, and a migration onto a backend that already holds a
 * ledger is refused unless `--force` names the replacement. A source that
 * holds nothing is refused too, because a typo in the flags would otherwise
 * look like a migration of nothing, and the write onto the destination is
 * checked against the state the migration observed, so a ledger that moved
 * under the run is never clobbered.
 */
async function ledgerMigrate(argv: string[], ledgerDir: string, out: Writer): Promise<number> {
  const to = flag(argv, '--to')
  if (to === undefined) throw new Error('qare ledger migrate requires --to <branch|files>')
  if (to !== 'branch' && to !== 'files')
    throw new Error(`ledger migrate: --to must be "branch" or "files", not ${JSON.stringify(to)}`)
  const repo = resolve(flag(argv, '--repo') ?? '.')
  const branch = flag(argv, '--branch') ?? 'qare-ledger'
  const dryRun = argv.includes('--dry-run')
  const force = argv.includes('--force')
  const files = resolve(ledgerDir)
  const source =
    to === 'branch'
      ? { backend: `files (${files})`, store: new FileLedgerStore(ledgerDir) }
      : { backend: `branch (${branch} in ${repo})`, store: new BranchLedgerStore(repo, branch) }
  const destination =
    to === 'branch'
      ? { backend: `branch (${branch} in ${repo})`, store: new BranchLedgerStore(repo, branch) }
      : { backend: `files (${files})`, store: new FileLedgerStore(ledgerDir) }
  const document = await source.store.loadDocument()
  if (document.entries.length === 0 && document.changes.length === 0)
    throw new Error(
      `ledger migrate: the ${source.backend} holds no ledger (0 entries and 0 change records); check the --ledger, --repo and --branch flags`,
    )
  const destinationHead = await destination.store.head()
  const settled = await destination.store.loadDocument()
  const occupied = settled.entries.length > 0 || settled.changes.length > 0
  const what = `${counted(document.entries.length, 'entry', 'entries')} and ${counted(
    document.changes.length,
    'change record',
    'change records',
  )}`
  if (dryRun) {
    out.write(`migrate: ${what} would move from ${source.backend} to ${destination.backend}\n`)
    if (occupied && !force)
      out.write('migrate: the destination is non-empty, so the migration would be refused without --force\n')
    return 0
  }
  if (occupied && !force)
    throw new Error(
      `ledger migrate: the ${destination.backend} backend already holds a ledger (${counted(
        settled.entries.length,
        'entry',
        'entries',
      )}, ${counted(settled.changes.length, 'change record', 'change records')}); pass --force to replace it`,
    )
  await destination.store.saveDocumentIfUnchanged(document.entries, document.changes, destinationHead)
  out.write(`migrate: ${what} moved from ${source.backend} to ${destination.backend}\n`)
  return 0
}

/**
 * `qare ledger publish`: write the current state where the team already
 * looks, as a plain markdown file, naming the criteria that are unverified,
 * stale or quarantined (#58). A web application is out of scope; this is a
 * file in the repository, refreshed whenever the ledger changes.
 */
async function ledgerPublish(argv: string[], ledgerDir: string, out: Writer): Promise<number> {
  const outFlag = flag(argv, '--out') ?? 'CRITERIA.md'
  const document = await new FileLedgerStore(ledgerDir).loadDocument()
  const quarantined = await heldCriteriaIn(ledgerDir, document.entries)
  await writeFile(resolve(outFlag), renderCriteriaMarkdown(document, quarantined), 'utf8')
  out.write(`published ${document.entries.length} criteria to ${resolve(outFlag)}\n`)
  return 0
}

/**
 * The criteria a held result names as quarantined, when resolve wrote one
 * into the ledger directory (`--hold-out <dir>/held-result.json`). A missing
 * file is an ordinary no: an open question is only knowable from the report
 * the resolution wrote. Anything else — an unreadable or malformed report —
 * fails the command, because publishing a guessed-at quarantine state is
 * worse than publishing none. A held criterion whose question has been
 * answered and whose entry has since been promoted to active is no longer
 * quarantined; the ledger, not the stale report, says where it stands.
 */
/**
 * `qare sweep`: classify the whole ledger and report it (#49). This is the
 * standing picture of what is proven, stale, unverified, quarantined and
 * refused, written for the scheduled job to publish as the one standing
 * status issue. A sweep that cannot read the ledger or its configuration
 * reports that as a finding and still exits clean: a scheduled sweep has no
 * pull request to break, so its problems are filed where a person reads
 * them, through #154's flow, one issue per problem.
 */
async function sweepCommand(argv: string[], out: Writer, err: Writer): Promise<number> {
  try {
    const ledgerFlag = argv.indexOf('--ledger')
    const ledgerSpec = ledgerFlag === -1 ? undefined : argv[ledgerFlag + 1]
    if (ledgerFlag !== -1 && ledgerSpec === undefined)
      throw new Error('qare sweep requires a directory value after --ledger')
    const rest = ledgerFlag === -1 ? argv : [...argv.slice(0, ledgerFlag), ...argv.slice(ledgerFlag + 2)]
    const dir = resolve(ledgerSpec ?? '.qa')
    const json = rest.includes('--json')
    const outFlag = flag(rest, '--out')
    const payload: SweepPayload = await sweepLedger(dir, new Date())
    if (json) {
      out.write(`${JSON.stringify(payload, null, 2)}\n`)
    } else {
      const counts = payload.classification
      out.write(
        `proven: ${counts.proven.length} stale: ${counts.stale.length} unverified: ${counts.unverified.length} quarantined: ${counts.quarantined.length} refused: ${counts.refused.length}\n`,
      )
      for (const line of sweepBucketLines(counts)) out.write(`${line}\n`)
      for (const finding of payload.findings) out.write(`finding: ${finding.fingerprint} ${finding.reason}\n`)
    }
    if (outFlag !== undefined) await writeFile(resolve(outFlag), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    return 0
  } catch (error) {
    err.write(`${formatError(error)}\n`)
    return 1
  }
}

/**
 * `qare metrics` (#51): record what one run cost and decided, and note what
 * the runs cannot see. The data lives in the repository — one JSON line per
 * record in the metrics store beside the ledger — so the numbers can be read
 * for the whole pilot, not only in this run's logs.
 */
async function metricsCommand(argv: string[], out: Writer, err: Writer): Promise<number> {
  try {
    if (argv[0] === 'record') return await metricsRecord(argv.slice(1), out)
    if (argv[0] === 'note') return await metricsNote(argv.slice(1), out)
    throw new Error('qare metrics requires a subcommand: record (what one run cost and decided) or note (a human note)')
  } catch (error) {
    err.write(`${formatError(error)}\n`)
    return 1
  }
}

/**
 * `qare metrics record`: join one result's wall clock and verdict with the
 * plan's and the verifier's model spend into one line of the metrics store.
 * The judge command has already stamped the verifier's spend on the judged
 * result; this reads both sides back and stores what the run amounted to.
 */
async function metricsRecord(argv: string[], out: Writer): Promise<number> {
  const resultFlag = argv.indexOf('--result')
  const resultSpec = resultFlag === -1 ? undefined : argv[resultFlag + 1]
  if (resultSpec === undefined) throw new Error('qare metrics record requires --result <path> (the judged-result.json the judge wrote)')
  const storeFlag = argv.indexOf('--store')
  const storeSpec = storeFlag === -1 ? undefined : argv[storeFlag + 1]
  if (storeFlag !== -1 && storeSpec === undefined) throw new Error('qare metrics record requires a directory after --store')
  const store = storeSpec === undefined ? undefined : resolve(storeSpec)
  const outFlag = flag(argv, '--out')

  const loaded = loadResult(await readFile(resolve(resultSpec), 'utf8'))
  if (loaded.startedAt === undefined || loaded.finishedAt === undefined)
    throw new Error('the result has no startedAt/finishedAt timestamps; record metrics from a run made with the version that writes them')
  const runFlag = flag(argv, '--run')
  const planFlag = flag(argv, '--plan')
  const plan = planFlag === undefined ? undefined : loadPlan(await readFile(resolve(planFlag), 'utf8'))
  const context = contextOf(argv)
  const counts: Record<string, number> = {}
  for (const criterion of loaded.criteria) counts[criterion.outcome] = (counts[criterion.outcome] ?? 0) + 1
  // A record that does not name its run cannot be joined to anything later,
  // so a result without a job id is refused rather than recorded as '' (#51):
  // the caller who knows the id passes --run.
  const runId = loaded.job?.id ?? runFlag
  if (runId === undefined || runId === '')
    throw new Error('the result carries no job id; pass --run <id> so the record names the run it describes')
  const record = {
    schemaVersion: METRICS_SCHEMA_VERSION,
    recordedAt: new Date().toISOString(),
    runId,
    startedAt: loaded.startedAt,
    finishedAt: loaded.finishedAt,
    wallMs: Math.max(0, Date.parse(loaded.finishedAt) - Date.parse(loaded.startedAt)),
    verdict: loaded.verdict,
    criteria: {
      selected: loaded.criteria.map((criterion) => ({ id: criterion.id, outcome: criterion.outcome })),
      counts,
    },
    model: {
      ...(plan?.usage === undefined ? {} : { plan: plan.usage }),
      ...(loaded.judgeUsage === undefined ? {} : { judge: loaded.judgeUsage }),
    },
    ...(Object.keys(context).length === 0 ? {} : { context }),
  }
  if (outFlag !== undefined) await writeFile(resolve(outFlag), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  if (store !== undefined) await appendRunMetrics(store, record)
  out.write(`recorded run ${record.runId} (${record.verdict}, ${record.wallMs} ms)\n`)
  return 0
}

/**
 * `qare metrics note`: one human line the runs cannot see — a defect that
 * escaped to production, a block that was wrong, or the minutes a person
 * spent on QA that QARE did not.
 */
async function metricsNote(argv: string[], out: Writer): Promise<number> {
  const kind = flag(argv, '--kind')
  if (kind === undefined) throw new Error('qare metrics note requires --kind <escape|false-block|qa-minutes>')
  const store = flag(argv, '--store')
  if (store === undefined) throw new Error('qare metrics note requires --store <dir> (the metrics store beside the ledger)')
  const minutesFlag = flag(argv, '--minutes')
  const minutes = minutesFlag === undefined ? undefined : Number(minutesFlag)
  if (minutesFlag !== undefined && !Number.isFinite(minutes)) throw new Error('--minutes must be a number')
  await appendMetricsNote(resolve(store), {
    kind: kind as MetricsNoteKind,
    text: flag(argv, '--text'),
    minutes,
    criterion: flag(argv, '--criterion'),
    runId: flag(argv, '--run'),
  })
  out.write(`recorded a ${kind} note\n`)
  return 0
}

/** The run's where, as the caller said it: the pull request number, the refs. */
function contextOf(argv: string[]): { pr?: number; base?: string; head?: string } {
  const pr = flag(argv, '--pr')
  if (pr !== undefined && !/^\d+$/.test(pr)) throw new Error('--pr must be a pull request number')
  const base = flag(argv, '--base')
  const head = flag(argv, '--head')
  return {
    ...(pr === undefined ? {} : { pr: Number(pr) }),
    ...(base === undefined ? {} : { base }),
    ...(head === undefined ? {} : { head }),
  }
}

function sweepBucketLines(counts: SweepPayload['classification']): string[] {
  const lines: string[] = []
  const buckets: Array<[string, string[]]> = [
    ['proven', counts.proven],
    ['stale', counts.stale],
    ['unverified', counts.unverified],
    ['quarantined', counts.quarantined],
    ['refused', counts.refused],
  ]
  for (const [name, criteria] of buckets) {
    if (criteria.length === 0) continue
    lines.push(`${name}: ${criteria.join(', ')}`)
  }
  return lines
}

async function heldCriteriaIn(ledgerDir: string, entries: LedgerEntry[]): Promise<string[]> {
  let held: unknown
  try {
    held = JSON.parse(await readFile(join(ledgerDir, 'held-result.json'), 'utf8'))
  } catch (error) {
    if (
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
    )
      return []
    throw new Error(`ledger publish: held-result.json is unreadable: ${formatError(error)}`)
  }
  const criteria = (held as { criteria?: unknown }).criteria
  if (!Array.isArray(criteria))
    throw new Error('ledger publish: held-result.json must carry a "criteria" array')
  const heldIds = criteria
    .filter((criterion): criterion is { id: string; outcome: string; reason: string } =>
      typeof criterion === 'object' &&
      criterion !== null &&
      typeof (criterion as Record<string, unknown>).id === 'string' &&
      typeof (criterion as Record<string, unknown>).outcome === 'string' &&
      typeof (criterion as Record<string, unknown>).reason === 'string')
    .filter((criterion) => criterion.outcome === 'unverified' && criterion.reason.startsWith('held for an open question'))
    .map((criterion) => criterion.id)
  const stillHeld = new Set(heldIds)
  const kept: string[] = []
  for (const entry of entries) {
    if (stillHeld.has(entry.criterion) && entry.status === 'proposed') kept.push(entry.criterion)
  }
  return kept
}

/**
 * `qare ledger contradict`: read the evidence a judged run produced, detect
 * the active ledger rules the change contradicts (#40), and classify each one
 * with executed evidence first and the model second. The ledger is never
 * written here: what comes out is a proposal a review applies, which is what
 * makes a supersede a proposal.
 */
async function ledgerContradict(argv: string[], ledgerDir: string, out: Writer): Promise<number> {
  const resultPath = flag(argv, '--result')
  const criteriaPath = flag(argv, '--criteria')
  if (resultPath === undefined) throw new Error('qare ledger contradict requires --result <judged-result.json>')
  if (criteriaPath === undefined) throw new Error('qare ledger contradict requires --criteria <criteria.json>')
  const diffPath = flag(argv, '--diff')
  const nare = flag(argv, '--nare')
  const outPath = flag(argv, '--out')
  const runIdFlag = flag(argv, '--run-id')

  const result: unknown = JSON.parse(await readFile(resolve(resultPath), 'utf8'))
  const introduced = parseIntroducedCriteria(JSON.parse(await readFile(resolve(criteriaPath), 'utf8')))
  const ledger = await new FileLedgerStore(ledgerDir).load()
  const diff = diffPath === undefined ? undefined : await readFile(resolve(diffPath), 'utf8')
  const report = await detectContradictions({
    runId: runIdFlag ?? jobIdOf(result) ?? 'unknown',
    executed: executedFromResult(result),
    introduced,
    ledger,
    ...(nare === undefined ? {} : { classifier: new NareAgentRunner({ binary: nare }) }),
    ...(diff === undefined ? {} : { diff }),
  })

  for (const contradiction of report.contradictions) {
    const replacement =
      contradiction.replacement === undefined ? '' : ` → ${contradiction.replacement}`
    out.write(
      `${contradiction.classification}  ${contradiction.criterion}${replacement}  (${contradiction.basis})\n`,
    )
  }
  if (report.contradictions.length === 0) out.write('no contradictions detected\n')
  if (outPath !== undefined) {
    const target = resolve(outPath)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    out.write(`proposal: ${target}\n`)
  }
  return 0
}

function parseIntroducedCriteria(input: unknown): IntroducedCriterion[] {
  if (!Array.isArray(input)) throw new Error('contradiction: the criteria file must be a JSON array of {id, text}')
  const criteria: IntroducedCriterion[] = []
  for (const [index, entry] of input.entries()) {
    const field = `contradiction: criteria[${index}]`
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
      throw new Error(`${field} must be a JSON object`)
    const record = entry as Record<string, unknown>
    if (typeof record.id !== 'string' || record.id.trim() === '')
      throw new Error(`${field}.id must be a criterion id`)
    if (typeof record.text !== 'string' || record.text.trim() === '')
      throw new Error(`${field}.text must be the criterion's wording`)
    criteria.push({ id: record.id, text: record.text })
  }
  return criteria
}

/**
 * Where a question may go, from `--place`: a pull request's conflicts ride
 * that PR's evidence comment; a conflict in the criteria themselves goes to
 * the linked issue, mentioning its author; a sweep's conflict goes to the
 * finding's issue, mentioning the person the finding blames (#41).
 */
function resolutionSourceOf(argv: string[]): ResolutionSource {
  const place = flag(argv, '--place') ?? 'pull-request'
  if (place === 'pull-request') return { kind: 'pull-request' }
  if (place === 'issue') {
    const issue = flag(argv, '--issue')
    const author = flag(argv, '--author')
    if (issue === undefined || !/^\d+$/.test(issue))
      throw new Error('qare ledger resolve: --place issue requires --issue <issue number>')
    if (author === undefined || author.trim() === '')
      throw new Error('qare ledger resolve: --place issue requires --author <login>, the issue author the question mentions')
    return { kind: 'criteria-issue', issue: Number(issue), author }
  }
  if (place === 'sweep') {
    const finding = flag(argv, '--finding')
    if (finding === undefined || !/^\d+$/.test(finding))
      throw new Error('qare ledger resolve: --place sweep requires --finding <issue number of the finding>')
    const blame = flag(argv, '--blame')
    return { kind: 'sweep', finding: Number(finding), ...(blame === undefined ? {} : { blame }) }
  }
  throw new Error(`qare ledger resolve: unknown --place ${JSON.stringify(place)} (expected "pull-request", "issue" or "sweep")`)
}

/**
 * `qare ledger resolve`: run the resolution order over the conflicts the
 * change introduces (#41) — executed evidence settles first, the ledger's own
 * recorded answers settle second, and what is still open becomes one question
 * per conflict, in one place, with QARE's recommendation attached. The
 * affected criteria are held `unverified` in the held result this writes, so
 * an open question blocks its own criteria and nothing else. The ledger is
 * never written here.
 */
async function ledgerResolve(argv: string[], ledgerDir: string, out: Writer): Promise<number> {
  const resultPath = flag(argv, '--result')
  const criteriaPath = flag(argv, '--criteria')
  if (resultPath === undefined) throw new Error('qare ledger resolve requires --result <judged-result.json>')
  if (criteriaPath === undefined) throw new Error('qare ledger resolve requires --criteria <criteria.json>')
  const outPath = flag(argv, '--out')
  const holdOut = flag(argv, '--hold-out')

  const resultText = await readFile(resolve(resultPath), 'utf8')
  const introduced = parseIntroducedCriteria(JSON.parse(await readFile(resolve(criteriaPath), 'utf8')))
  const ledger = await new FileLedgerStore(ledgerDir).load()
  const parsed: unknown = JSON.parse(resultText)
  const diffPath = flag(argv, '--diff')
  const nare = flag(argv, '--nare')
  const contradictionReport = await detectContradictions({
    runId: flag(argv, '--run-id') ?? jobIdOf(parsed) ?? 'unknown',
    executed: executedFromResult(parsed),
    introduced,
    ledger,
    ...(nare === undefined ? {} : { classifier: new NareAgentRunner({ binary: nare }) }),
    ...(diffPath === undefined ? {} : { diff: await readFile(resolve(diffPath), 'utf8') }),
  })
  const resolution = resolveContradictions(contradictionReport.contradictions, ledger, resolutionSourceOf(argv))
  const judged: RunResult = loadResult(resultText)
  const held = holdForQuestions(judged, resolution.questions)
  const heldCriteria = [
    ...new Set(resolution.questions.flatMap((question) => (question.replacement === undefined ? [question.criterion] : [question.criterion, question.replacement]))),
  ].filter((id) => {
    const criterion = held.criteria.find((entry) => entry.id === id)
    return criterion !== undefined && criterion.outcome === 'unverified' && criterion.reason?.includes('held for an open question')
  })

  for (const settled of resolution.settled) {
    const pair = settled.replacement === undefined ? '' : ` → ${settled.replacement}`
    out.write(`settled  ${settled.classification}  ${settled.criterion}${pair}  (${settled.basis})\n`)
  }
  for (const question of resolution.questions) {
    const pair = question.replacement === undefined ? '' : ` → ${question.replacement}`
    out.write(`question  ${question.id}  ${question.criterion}${pair}  recommends ${question.recommendation}\n`)
  }
  if (resolution.questions.length === 0) out.write('no questions: every conflict is settled\n')
  if (heldCriteria.length > 0) out.write(`held: ${heldCriteria.join(', ')}\n`)
  out.write(`verdict with open questions held: ${held.verdict}\n`)
  if (outPath !== undefined) {
    const target = resolve(outPath)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(
      target,
      `${JSON.stringify({ schemaVersion: '1', settled: resolution.settled, questions: resolution.questions, held: { criteria: heldCriteria, verdict: held.verdict } }, null, 2)}\n`,
      'utf8',
    )
    out.write(`report: ${target}\n`)
  }
  if (holdOut !== undefined) {
    const target = resolve(holdOut)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, `${JSON.stringify(held, null, 2)}\n`, 'utf8')
    out.write(`held result: ${target}\n`)
  }
  return 0
}

/**
 * `qare ledger decide`: record the answer to a conflict question with who
 * decided and why (#41). The answer lands as a proposal, never as a silent
 * edit: an answer of `supersede` folds the replacement in over the old rule,
 * and an answer of `regression` records why the failure stands. The ledger
 * file is never written here; what comes out is a ledger a review applies.
 */
async function ledgerDecide(argv: string[], ledgerDir: string, out: Writer): Promise<number> {
  const criterion = flag(argv, '--criterion')
  const replacement = flag(argv, '--replacement')
  const classification = flag(argv, '--classification')
  const by = flag(argv, '--by')
  const why = flag(argv, '--why')
  const questionFlag = flag(argv, '--question')
  const at = flag(argv, '--at') ?? new Date().toISOString().slice(0, 10)
  const outPath = flag(argv, '--out')
  if (criterion === undefined || criterion.trim() === '')
    throw new Error('qare ledger decide requires --criterion <criterion id>, the rule the question is about')
  const answer = classification === 'supersede' || classification === 'regression' ? classification : undefined
  if (answer === undefined)
    throw new Error('qare ledger decide requires --classification <supersede|regression>')
  if (answer === 'supersede' && (replacement === undefined || replacement.trim() === ''))
    throw new Error('qare ledger decide: an answer of supersede requires --replacement <criterion id>')
  if (by === undefined || by.trim() === '') throw new Error('qare ledger decide requires --by <login>, who decided')
  if (why === undefined || why.trim() === '') throw new Error('qare ledger decide requires --why <reason>')
  if (/[\r\n]/.test(why)) throw new Error('qare ledger decide: --why must not contain newlines')
  if (/[\r\n]/.test(by)) throw new Error('qare ledger decide: --by must not contain newlines')

  const question = questionIdFor(criterion, replacement)
  if (questionFlag !== undefined && questionFlag !== question)
    throw new Error(`qare ledger decide: --question ${JSON.stringify(questionFlag)} does not name this conflict; its id is ${question}`)

  const ledgerDocument = await new FileLedgerStore(ledgerDir).loadDocument()
  const ledger = ledgerDocument.entries
  const oldEntry = ledger.find((entry) => entry.criterion === criterion)
  if (oldEntry === undefined) throw new Error(`ledger: decide: no entry for criterion ${JSON.stringify(criterion)}`)
  if (oldEntry.status !== 'active')
    throw new Error(`ledger: decide: criterion ${JSON.stringify(criterion)} is ${oldEntry.status}, not active; nothing to decide`)
  const resolved: LedgerResolution = { question, classification: answer, by, why, at }
  let folded: LedgerEntry[]
  if (answer === 'supersede') {
    if (replacement !== undefined) {
      const existing = ledger.find((entry) => entry.criterion === replacement)
      if (existing !== undefined && existing.status !== 'proposed' && existing.status !== 'active')
        throw new Error(`ledger: decide: replacement ${JSON.stringify(replacement)} is ${existing.status}; a replacement must be proposed or active`)
    }
    folded = ledger.map((entry) => {
      if (entry.criterion === replacement) {
        // A replacement already admitted stays at its own status; one that is
        // not in the ledger is proposed by this fold.
        const status = entry.status
        return { ...entry, status, supersedes: [...new Set([...(entry.supersedes ?? []), criterion])], resolution: resolved }
      }
      if (entry.criterion === criterion) return { ...entry, status: 'superseded' as const }
      return entry
    })
    if (replacement !== undefined && !ledger.some((entry) => entry.criterion === replacement)) {
      const text = flag(argv, '--text')
      if (text === undefined || text.trim() === '')
        throw new Error('qare ledger decide: the replacement is not in the ledger yet; --text <wording> states the criterion it proposes')
      folded.push({ criterion: replacement, status: 'proposed', source: [`question:${question}`], proof: 'review', note: text, supersedes: [criterion], resolution: resolved })
    }
  } else {
    folded = ledger.map((entry) => (entry.criterion === criterion ? { ...entry, resolution: resolved } : entry))
  }
  // The fold is only as good as the ledger it proposes: the same strict
  // loader a run reads with judges the proposal before it is written out.
  // The answer is itself a change to the ledger, so it is recorded in the
  // history with who decided, when, and why (#58).
  const changes = appendChange(ledgerDocument.changes, {
    kind: answer,
    actor: by,
    timestamp: at,
    reason: why,
    criteria: answer === 'supersede' && replacement !== undefined ? [criterion, replacement] : [criterion],
  })
  const entries = parseLedgerDocument(JSON.parse(serializeLedgerDocument(folded, changes))).entries
  const text = serializeLedgerDocument(entries, changes)
  if (outPath === undefined) out.write(text)
  else {
    const target = resolve(outPath)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, text, 'utf8')
    out.write(`proposal: ${target}\n`)
    out.write(`fingerprint: ${integrityOf(entries)}\n`)
  }
  return 0
}

function jobIdOf(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  const job = (result as { job?: unknown }).job
  if (typeof job !== 'object' || job === null) return undefined
  const id = (job as { id?: unknown }).id
  return typeof id === 'string' && id.trim() !== '' ? id : undefined
}


/**
 * `qare select`: the criteria a change could affect, from the ledger's own
 * mapping (#45). The diff in, a selection out: what a check's code path
 * covers, the standing smoke suite, and everything the ledger maps to
 * nothing. Runs no check and no model, so the orchestrator can see what a
 * run would cover before it asks for one.
 */
const SELECT_FLAGS: readonly string[] = ['--ledger', '--diff', '--paths', '--budget', '--smoke', '--out']

/**
 * Every select flag takes a value, so the values are consumed positionally:
 * a missing value, a stray positional argument, and an unknown flag are all
 * invocation errors rather than a quietly misread selection.
 */
function selectFlagsOf(argv: string[]): Record<string, string> {
  const options: Record<string, string> = {}
  let at = 0
  while (at < argv.length) {
    const arg = argv[at]
    if (arg === undefined) break
    if (!arg.startsWith('--')) throw new Error(`qare select takes flags, not ${JSON.stringify(arg)}`)
    if (!SELECT_FLAGS.includes(arg)) throw new Error(`qare select does not take ${arg}`)
    const value = argv[at + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`qare select ${arg} needs a value`)
    options[arg] = value
    at += 2
  }
  return options
}

async function selectCommand(argv: string[], out: Writer, err: Writer): Promise<number> {
  try {
    const options = selectFlagsOf(argv)
    const diffSpec = options['--diff']
    const pathsSpec = options['--paths']
    if (diffSpec === undefined && pathsSpec === undefined)
      throw new Error('qare select requires --diff <path> or --paths a,b: selection picks the criteria a change could affect')
    if (diffSpec !== undefined && pathsSpec !== undefined)
      throw new Error('qare select takes --diff or --paths, not both: one change selects criteria one way')
    const budgetSpec = options['--budget']
    if (
      budgetSpec !== undefined &&
      (!/^\d+$/.test(budgetSpec) || !Number.isSafeInteger(Number(budgetSpec)) || Number(budgetSpec) <= 0)
    )
      throw new Error(`--budget takes a positive whole number of milliseconds, not ${JSON.stringify(budgetSpec)}`)
    const touched =
      diffSpec !== undefined
        ? touchedPathsFromDiff(await readFile(resolve(diffSpec), 'utf8'))
        : (pathsSpec ?? '').split(',').filter((entry) => entry !== '')
    if (pathsSpec !== undefined && touched.length === 0)
      throw new Error(`--paths takes a comma-separated list of repository paths, not ${JSON.stringify(pathsSpec)}`)
    const report = selectCriteria(await new FileLedgerStore(resolve(options['--ledger'] ?? '.qa')).load(), {
      touched,
      ...(budgetSpec === undefined ? {} : { budgetMs: Number(budgetSpec) }),
      ...(options['--smoke'] === undefined ? {} : { smokeSuite: options['--smoke'] }),
    })
    out.write(
      `selected ${report.selected.length} of ${report.selected.length + report.notSelected.length} criteria; estimated ${report.estimatedMs} ms of a ${report.budgetMs} ms budget; ${report.touched.length} touched paths\n`,
    )
    for (const item of report.selected)
      out.write(`+ ${item.criterion}\t${item.reason}\t${item.text ?? ''}\n`)
    for (const item of report.notSelected)
      out.write(`- ${item.criterion}\t${item.reason}${item.detail === undefined ? '' : ` ${item.detail}`}\t${item.text ?? ''}\n`)
    if (report.selected.length === 0) out.write('no criteria selected, so a run of this selection checks nothing\n')
    const outSpec = options['--out']
    if (outSpec !== undefined) {
      const target = resolve(outSpec)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
      out.write(`report ${target}\n`)
    }
    return 0
  } catch (error) {
    err.write(`${formatError(error)}\n`)
    return 4
  }
}

async function runCommand(
  argv: string[],
  out: Writer,
  err: Writer,
  boot: BootOpts,
  stdin: Readable,
): Promise<number> {
  try {
    const jobFlag = argv.indexOf('--job')
    const jobSpec = jobFlag === -1 ? undefined : argv[jobFlag + 1]
    const planSpec = flag(argv, '--plan')
    const criteriaSpec = flag(argv, '--criteria')
    if (jobSpec === undefined && planSpec === undefined && criteriaSpec === undefined)
      throw new Error(
        'qare run requires --job <path|-> (pass "-" for stdin), --plan <path>, or --criteria <ids>, with the run context',
      )
    const sources = [jobSpec, planSpec, criteriaSpec].filter((spec) => spec !== undefined)
    if (sources.length > 1)
      throw new Error('qare run takes one of --job, --plan or --criteria; pass exactly one')
    let job: Job
    if (planSpec !== undefined) {
      // A plan is the same wherever it runs; these are the facts about this
      // run, and they come from the caller rather than from the model.
      const missing = ['--id', '--repo', '--base', '--head', '--evidence'].filter(
        (name) => flag(argv, name) === undefined,
      )
      if (missing.length > 0)
        throw new Error(`qare run --plan also requires ${missing.join(', ')}`)
      // The plan loads against the driver the profile maps (#94): a plan
      // naming only mapped intents is refused before anything runs.
      const singleProfile = flag(argv, '--profile')
      const plan = loadPlan(await readFile(resolve(planSpec), 'utf8'), [], await driverForPlan(singleProfile))
      // A plan that names its profiles carries them (repo-relative), so the
      // single-profile flag has nothing to attach to (#55).
      if (singleProfile !== undefined && plan.profiles !== undefined)
        throw new Error(
          'this plan already names the profiles it is planned against; qare run --plan takes no --profile',
        )
      if (singleProfile === undefined && plan.profiles === undefined)
        throw new Error('qare run --plan also requires --profile')
      const built = jobFromPlan(plan, runContextFrom(argv, singleProfile))
      // On stderr, not swallowed: a criterion nothing can check still has to
      // be visible to whoever reads the run.
      for (const note of built.notes) err.write(`${note}\n`)
      job = built.job
    } else if (criteriaSpec !== undefined) {
      // A named subset (#46): the orchestrator hands over the criterion ids
      // one card is responsible for, the ledger says what they are, and the
      // run asks for exactly those. Unknown, retired and superseded ids fail
      // loudly (all-or-nothing) rather than being skipped.
      const ids = criteriaSpec.split(',').map((id) => id.trim())
      const empty = ids.find((id) => id === '')
      if (empty !== undefined)
        throw new Error('qare run --criteria takes comma-separated criterion ids, and one of them is empty')
      const missing = ['--id', '--repo', '--base', '--head', '--evidence', '--profile'].filter(
        (name) => flag(argv, name) === undefined,
      )
      if (missing.length > 0)
        throw new Error(`qare run --criteria also requires ${missing.join(', ')}`)
      const repoPath = resolve(flag(argv, '--repo') as string)
      // The ledger lives in the repository the run checks, unless the caller
      // points at one elsewhere, as qare's own ledger commands do.
      const ledgerDir = resolve(flag(argv, '--ledger') ?? join(repoPath, '.qa'))
      const entries = await new FileLedgerStore(ledgerDir).load()
      const resolved = resolveCriteriaSubset(entries, ids)
      const built = jobFromPlan(criteriaSubsetPlan(resolved), runContextFrom(argv, flag(argv, '--profile')))
      for (const note of built.notes) err.write(`${note}\n`)
      job = built.job
    } else {
      job = jobSpec === '-' ? loadJobFromText(await readStdin(stdin)) : await loadJobFromFile(jobSpec as string)
    }
    // A run caches when the caller names a directory for it (#47), resolved
    // like every other path the run carries. Off by default: an uncached run
    // re-runs every check. A run also repeats a failing check as many times
    // as --flake-attempts says (#50), one by default, and quarantines the
    // unstable ones into the store --quarantine names.
    const cacheFlag = flag(argv, '--cache')
    // A run shards its independent criteria across the workers it is given
    // (#48); one worker is the serial run, which is the default.
    const workersFlag = flag(argv, '--workers')
    const workers = parseWorkers(workersFlag)
    const quarantineFlag = flag(argv, '--quarantine')
    const flakeFlag = flag(argv, '--flake-attempts')
    let flakeAttempts: number | undefined
    if (flakeFlag !== undefined) {
      flakeAttempts = Number(flakeFlag)
      if (!Number.isInteger(flakeAttempts) || flakeAttempts < 1)
        throw new Error(`--flake-attempts takes a whole number of attempts, one or more, not ${JSON.stringify(flakeFlag)}`)
    }
    // A run of a profile that boots an app checks the base revision too
    // (#147), so a criterion that worked there and fails at the head is named
    // a regression. The base tree is a checkout the caller already has
    // (--base-repo), or a git worktree of --base the run makes for itself.
    const baseRepoFlag = flag(argv, '--base-repo')
    const runOpts: RunJobOpts = { ...boot, base: baseRepoFlag === undefined ? {} : { repoPath: resolve(baseRepoFlag) } }
    if (cacheFlag !== undefined) runOpts.cacheDir = resolve(cacheFlag)
    if (quarantineFlag !== undefined) runOpts.quarantineDir = resolve(quarantineFlag)
    if (flakeAttempts !== undefined) runOpts.flakeAttempts = flakeAttempts
    if (workers !== undefined) runOpts.workers = workers
    const { result } = await runJob(job, runOpts)
    const code = exitCodeFor(result.verdict)
    // A base side that did not run is said out loud: the verdict is the
    // head's either way, but nobody should read it as a comparison.
    if (result.base?.status === 'not-executed') err.write(`base ${result.base.ref} not checked, so nothing was compared: ${result.base.reason ?? ''}\n`)
    for (const criterion of result.criteria)
      if (criterion.regression === true) out.write(`regression ${criterion.id}: proven at the base, failed at the head\n`)
    // A run refused for where it landed (#76) says why where the person who
    // started it reads it: nothing ran, so the reason is the whole outcome,
    // and it is one reason however many criteria carry it.
    if (result.verdict === 'refused') {
      const placed = result.criteria.flatMap((criterion) =>
        criterion.outcome === 'unverified' && /^refused: (unmet requirement|placement): /.test(criterion.reason) ? [criterion.reason] : [],
      )
      for (const reason of new Set(placed)) err.write(`${reason}\n`)
    }
    out.write(`verdict ${result.verdict}; evidence ${job.evidenceDir}\n`)
    return code
  } catch (error) {
    err.write(`${formatError(error)}\n`)
    return 4
  }
}

/**
 * The worker count a run shards its independent criteria across (#48). An
 * integer of at least one: zero workers is nothing running, and a fraction is
 * nothing the scheduler can deal out.
 */
function parseWorkers(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const count = Number(value)
  if (!Number.isInteger(count) || count < 1)
    throw new Error(`qare run --workers takes an integer of at least 1, and ${JSON.stringify(value)} is not one`)
  return count
}

/**
 * The facts about this run that a plan does not carry, whether the plan was
 * handed in (--plan) or built from the ledger's own criteria (--criteria).
 */
function runContextFrom(argv: string[], singleProfile: string | undefined): RunContext {
  return {
    id: flag(argv, '--id') as string,
    repoPath: resolve(flag(argv, '--repo') as string),
    baseRef: flag(argv, '--base') as string,
    headRef: flag(argv, '--head') as string,
    ...(singleProfile === undefined ? {} : { profile: { path: resolve(singleProfile) } }),
    evidenceDir: resolve(flag(argv, '--evidence') as string),
    ...(flag(argv, '--post') === undefined ? {} : { post: flag(argv, '--post') as string }),
  }
}

/**
 * The driver a run --plan validates against: the profile's MCP mapping when
 * it maps one (#94), the browser otherwise. A profile that is simply absent
 * changes nothing here — the plan's own diagnostics are the first thing the
 * caller sees, and the run still refuses on the profile when it starts.
 */
async function driverForPlan(profilePath: string | undefined): Promise<FlowDriverCapabilities> {
  if (profilePath === undefined) return BROWSER_FLOW_DRIVER
  let profile: QaProfile
  try {
    profile = await loadProfile(resolve(profilePath))
  } catch (error) {
    if (!(error instanceof ProfileMissingError)) throw error
    return BROWSER_FLOW_DRIVER
  }
  return flowDriverFor(profile)
}

export function exitCodeFor(verdict: RunVerdict): number {
  switch (verdict) {
    case 'passed':
      return 0
    case 'failed':
      return 1
    case 'blocked':
      return 2
    case 'refused':
      return 3
    case 'waived':
      return 5
    default:
      throw new Error(`verdict ${JSON.stringify(verdict)} has no exit code mapping`)
  }
}

async function readStdin(stdin: Readable = process.stdin): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
  return Buffer.concat(chunks).toString('utf8')
}

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      process.stderr.write(`${formatError(error)}\n`)
      process.exitCode = 4
    })
}
