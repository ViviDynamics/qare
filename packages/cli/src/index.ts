#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import {
  FileLedgerStore,
  RESULT_SCHEMA_VERSION,
  loadJobFromFile,
  loadJobFromText,
  judgeRun,
  loadResult,
  NareAgentRunner,
  prepareVerifierInputs,
  renderCheckRun,
  renderComment,
  runJob,
  runVerifier,
  toSideResults,
  VERSION,
} from '@qare/core'
import type { BootOpts, CriterionResult, CriterionVerdict, LedgerEntry, RunResult, RunVerdict } from '@qare/core'

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
  if (argv[0] === 'judge') return judgeCommand(argv.slice(1), out, err)
  if (argv[0] === 'ledger') return runLedgerCommand(argv.slice(1), out, err)
  out.write(
    `qare ${VERSION}\nusage: qare --version | qare run --job <path|-> | qare judge --result <path> | qare ledger <list|show|diff|status> [--ledger <dir>]\n`,
  )
  return 0
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
    if (runnerSpec === 'nare') {
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
    const result = mergeJudged(loaded, judged.verdict, judged.criteria)
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
    if (jobSpec === undefined)
      throw new Error('qare run requires --job <path|->; pass "-" to read the job from stdin')
    const job = jobSpec === '-' ? loadJobFromText(await readStdin(stdin)) : await loadJobFromFile(jobSpec)
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
