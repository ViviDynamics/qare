#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import {
  FileLedgerStore,
  buildReadinessReport,
  loadJobFromFile,
  loadJobFromText,
  jobFromPlan,
  checkCriteria,
  defaultCheckEvidenceDir,
  judgeExecuted,
  nareRunners,
  loadPlan,
  loadResult,
  NareAgentRunner,
  ProfileMissingError,
  BUILTIN_REDACTION_RULES,
  loadProfile,
  redactEvidenceDir,
  redactText,
  redactionRules,
  valueRules,
  criteriaFromIssue,
  criteriaFromIssues,
  IssueCriteriaError,
  linkedIssues,
  planRun,
  renderCheckRun,
  renderComment,
  readinessInventory,
  runJob,
  VERSION,
} from '@qare/core'
import type {
  BootOpts,
  Job,
  LedgerEntry,
  RedactionRule,
  RunVerdict,
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
  if (argv[0] === 'ledger') return runLedgerCommand(argv.slice(1), out, err)
  if (argv[0] === 'readiness') return readinessCommand(argv.slice(1), out, err)
  if (argv[0] === 'redact') return redactCommand(argv.slice(1), out, err)
  out.write(
    `qare ${VERSION}\nusage: qare --version | qare check "<criterion>"... [--file <path>] [--profile <dir>] [--repo <dir>] [--evidence <dir>] [--nare <binary> | --runner none] | qare linked-issues --body <path> | qare issue-criteria --out <file> <issue.md>... | qare plan (--issue <path> | --criteria <path>) --diff <path> [--allow-no-criteria] [--out <file>] [--suites a,b] [--nare <binary>] | qare run (--job <path|-> | --plan <path> --id <id> --repo <dir> --base <ref> --head <ref> --profile <dir> --evidence <dir>) | qare judge --result <path> (--plan <path> --diff <path> [--nare <binary>] | --runner none) [--outDir <dir>] [--profile <dir>] | qare ledger <list|show|diff|status> [--ledger <dir>] | qare readiness [path] [--out <file>] | qare redact --evidence <dir> [--profile <dir>]\n`,
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
    const rules = await redactionRulesFor(flag(argv, '--profile'), out)
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
 * The plan step as a command (#9): criteria and a diff in, plan.json out.
 *
 * It writes nothing unless the whole plan parsed and covered every criterion.
 * A half-written plan.json would be consumed by execute as though it were the
 * whole run.
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
    if (profilePath !== undefined) {
      // The diff can be the very change that seeds the profile, so the seeded
      // values sweep from the model-facing text before the planner sees it
      // (#64). No profile means nothing seeded to sweep; a profile that is
      // there but broken throws, as everywhere else.
      try {
        const profile = await loadProfile(resolve(profilePath))
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
    const plan = await planRun(runner, {
      criteria,
      diff,
      ...(suites === undefined ? {} : { suites }),
      ...(flowActions.length === 0 ? {} : { flowActions }),
    })
    if (flowActions.length > 0)
      out.write(`planning with the change's flow action kinds: ${flowActions.join(', ')}\n`)

    await mkdir(dirname(outPath), { recursive: true })
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
    // Everything judge writes is published, and the verifier's reasons are
    // model text about evidence and a diff that can carry fixture data.
    const rules = await redactionRulesFor(flag(argv, '--profile'), out)

    const resultPath = resolve(resultSpec)
    const outDir = outDirSpec === undefined ? dirname(resultPath) : resolve(outDirSpec)
    const loaded = loadResult(await readFile(resultPath, 'utf8'))
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
    const { result, changed } = await judgeExecuted(loaded, {
      texts: Object.fromEntries((plan?.criteria ?? []).map((criterion) => [criterion.id, criterion.text])),
      // The verifier reads the diff, and the diff can carry the seeded values
      // the profile rules exist for: the model-facing text is swept like any
      // evidence (#64).
      diff: verify ? redactText(await readFile(resolve(diffPath as string), 'utf8'), rules) : '',
      rules,
      ...(verify ? { verifier: nareRunners(binary).verifier(evidenceDir) } : {}),
    })
    for (const criterion of changed)
      err.write(`verifier: ${criterion.criterionId} ${criterion.outcome}: ${redactText(criterion.reason, rules)}\n`)
    await mkdir(outDir, { recursive: true })
    await writeFile(join(outDir, 'judged-result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    await writeFile(join(outDir, 'comment.md'), `${renderComment(result)}\n`, 'utf8')
    await writeFile(join(outDir, 'checkrun.json'), `${JSON.stringify(renderCheckRun(result), null, 2)}\n`, 'utf8')
    out.write(`verdict ${result.verdict}; artifacts ${outDir}\n`)
    return 0
  } catch (error) {
    err.write(`${formatError(error)}\n`)
    return 4
  }
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
      throw new Error('qare ledger requires a subcommand; usage: qare ledger <list|show|diff|status> [--ledger <dir>]')
    if (sub === 'list') return await ledgerList(dir, out)
    if (sub === 'show') return await ledgerShow(dir, subArgs[0], out)
    if (sub === 'diff') return await ledgerDiff(dir, subArgs, out)
    if (sub === 'status') return await ledgerStatus(dir, out, err)
    throw new Error(
      `unknown ledger subcommand ${JSON.stringify(sub)}; usage: qare ledger <list|show|diff|status> [--ledger <dir>]`,
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
  return 0
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
    if (jobSpec === undefined && planSpec === undefined)
      throw new Error(
        'qare run requires --job <path|-> (pass "-" for stdin), or --plan <path> with the run context',
      )
    let job: Job
    if (planSpec !== undefined) {
      // A plan is the same wherever it runs; these are the facts about this
      // run, and they come from the caller rather than from the model.
      const missing = ['--id', '--repo', '--base', '--head', '--profile', '--evidence'].filter(
        (name) => flag(argv, name) === undefined,
      )
      if (missing.length > 0)
        throw new Error(`qare run --plan also requires ${missing.join(', ')}`)
      const plan = loadPlan(await readFile(resolve(planSpec), 'utf8'))
      const built = jobFromPlan(plan, {
        id: flag(argv, '--id') as string,
        repoPath: resolve(flag(argv, '--repo') as string),
        baseRef: flag(argv, '--base') as string,
        headRef: flag(argv, '--head') as string,
        profile: { path: resolve(flag(argv, '--profile') as string) },
        evidenceDir: resolve(flag(argv, '--evidence') as string),
        ...(flag(argv, '--post') === undefined ? {} : { post: flag(argv, '--post') as string }),
      })
      // On stderr, not swallowed: a criterion nothing can check still has to
      // be visible to whoever reads the run.
      for (const note of built.notes) err.write(`${note}\n`)
      job = built.job
    } else {
      job = jobSpec === '-' ? loadJobFromText(await readStdin(stdin)) : await loadJobFromFile(jobSpec as string)
    }
    const { result } = await runJob(job, boot)
    const code = exitCodeFor(result.verdict)
    out.write(`verdict ${result.verdict}; evidence ${job.evidenceDir}\n`)
    return code
  } catch (error) {
    err.write(`${formatError(error)}\n`)
    return 4
  }
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
