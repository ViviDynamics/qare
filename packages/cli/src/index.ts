#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import {
  FileLedgerStore,
  RESULT_SCHEMA_VERSION,
  buildReadinessReport,
  loadJobFromFile,
  loadJobFromText,
  jobFromPlan,
  judgeRun,
  loadPlan,
  loadResult,
  NareAgentRunner,
  criteriaFromIssue,
  IssueCriteriaError,
  linkedIssues,
  planRun,
  prepareVerifierInputs,
  renderCheckRun,
  renderComment,
  readinessInventory,
  runJob,
  runVerifier,
  toSideResults,
  VERSION,
} from '@qare/core'
import type { BootOpts, CriterionResult, CriterionVerdict, Job, LedgerEntry, RunResult, RunVerdict } from '@qare/core'

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
  if (argv[0] === 'linked-issues') return linkedIssuesCommand(argv.slice(1), out, err)
  if (argv[0] === 'issue-criteria') return issueCriteriaCommand(argv.slice(1), out, err)
  if (argv[0] === 'plan') return planCommand(argv.slice(1), out, err)
  if (argv[0] === 'judge') return judgeCommand(argv.slice(1), out, err)
  if (argv[0] === 'ledger') return runLedgerCommand(argv.slice(1), out, err)
  if (argv[0] === 'readiness') return readinessCommand(argv.slice(1), out, err)
  out.write(
    `qare ${VERSION}\nusage: qare --version | qare linked-issues --body <path> | qare issue-criteria --out <file> <issue.md>... | qare plan (--issue <path> | --criteria <path>) --diff <path> [--allow-no-criteria] [--out <file>] [--suites a,b] [--nare <binary>] | qare run (--job <path|-> | --plan <path> --id <id> --repo <dir> --base <ref> --head <ref> --profile <dir> --evidence <dir>) | qare judge --result <path> | qare ledger <list|show|diff|status> [--ledger <dir>] | qare readiness [path] [--out <file>]\n`,
  )
  return 0
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
 * The plan step as a command (#9): criteria and a diff in, plan.json out.
 *
 * It writes nothing unless the whole plan parsed and covered every criterion.
 * A half-written plan.json would be consumed by execute as though it were the
 * whole run.
 */
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
 * Each issue is read on its own. One that states no criteria contributes
 * nothing; when none do, nothing is written and it succeeds, because a change
 * that states no criteria has nothing to check, and whether that is neutral is
 * the pipeline's call. An unreadable file is still a failure.
 */
async function issueCriteriaCommand(argv: string[], out: Writer, err: Writer): Promise<number> {
  try {
    const outPath = flag(argv, '--out')
    const at = argv.indexOf('--out')
    const paths = argv.filter((_, index) => index !== at && index !== at + 1)
    if (outPath === undefined || paths.length === 0)
      throw new Error('qare issue-criteria requires --out <file> and at least one issue body path')
    const criteria = new Map<string, { id: string; text: string }>()
    for (const path of paths) {
      const body = await readFile(resolve(path), 'utf8')
      try {
        for (const criterion of criteriaFromIssue(body))
          if (!criteria.has(criterion.id)) criteria.set(criterion.id, criterion)
      } catch (error) {
        if (!(error instanceof IssueCriteriaError)) throw error
        out.write(`${path}: ${error.message}\n`)
      }
    }
    if (criteria.size === 0) {
      out.write('no linked issue states acceptance criteria, so nothing was written\n')
      return 0
    }
    await writeFile(resolve(outPath), `${JSON.stringify([...criteria.values()], null, 2)}\n`, 'utf8')
    out.write(`${criteria.size} criteria; ${resolve(outPath)}\n`)
    return 0
  } catch (error) {
    err.write(`${formatError(error)}\n`)
    return 4
  }
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
        if (allowNone && error instanceof IssueCriteriaError) {
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
    const diff = await readFile(resolve(diffPath), 'utf8')

    const runner = new NareAgentRunner(binary === undefined ? {} : { binary })
    const plan = await planRun(runner, {
      criteria,
      diff,
      ...(suites === undefined ? {} : { suites }),
    })

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

    const resultPath = resolve(resultSpec)
    const outDir = outDirSpec === undefined ? dirname(resultPath) : resolve(outDirSpec)
    const loaded = loadResult(await readFile(resultPath, 'utf8'))
    const judged = judgeRun({
      base: [],
      head: toSideResults(loaded),
      waived: loaded.waived?.map((entry) => entry.criterionId),
    })
    // Nothing ran on a refused run, so there is no evidence for the verifier
    // to read and a model call would be spent on nothing.
    if (runnerSpec === 'nare' && loaded.verdict !== 'refused') {
      try {
        const runner = new NareAgentRunner()
        await runVerifier(
          runner,
          prepareVerifierInputs({ criteria: judged.criteria, diff: '', evidence: evidencePaths(loaded) }),
        )
      } catch (error) {
        err.write(`verifier skipped: ${formatError(error)}\n`)
      }
    }
    // A refused run executed nothing, so there is nothing to judge: the
    // verdict stays refused. Recomputing it from all-unverified criteria read
    // it back as blocked, and the stub-issue step that acts on refused never
    // fired.
    const verdict = loaded.verdict === 'refused' ? 'refused' : judged.verdict
    const result = mergeJudged(loaded, verdict, judged.criteria)
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

function evidencePaths(result: RunResult): string[] {
  return result.criteria.flatMap((criterion) => ('evidence' in criterion ? criterion.evidence ?? [] : []))
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

function mergeJudged(loaded: RunResult, verdict: RunVerdict, criteria: CriterionVerdict[]): RunResult {
  const evidenceById = new Map(loaded.criteria.map((criterion) => [criterion.id, evidenceOf(criterion)]))
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    verdict,
    criteria: criteria.map((criterion) => {
      const evidence = evidenceById.get(criterion.criterionId) ?? []
      if (criterion.outcome === 'unverified')
        return {
          id: criterion.criterionId,
          outcome: 'unverified',
          reason: criterion.reason,
          ...(evidence.length === 0 ? {} : { evidence }),
        }
      return { id: criterion.criterionId, outcome: criterion.outcome, evidence }
    }),
    ...(loaded.job === undefined ? {} : { job: { id: loaded.job.id } }),
    ...(loaded.waived === undefined ? {} : { waived: loaded.waived }),
  }
}

function evidenceOf(criterion: CriterionResult): string[] {
  return 'evidence' in criterion ? criterion.evidence ?? [] : []
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
