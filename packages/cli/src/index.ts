#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import {
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
import type { BootOpts, CriterionResult, CriterionVerdict, RunResult, RunVerdict } from '@qare/core'

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
  out.write(
    `qare ${VERSION}\nusage: qare --version | qare run --job <path|-> | qare judge --result <path>\n`,
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
    const judged = judgeRun({ base: [], head: toSideResults(loaded) })
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

function exitCodeFor(verdict: RunVerdict): number {
  switch (verdict) {
    case 'passed':
      return 0
    case 'failed':
      return 1
    case 'blocked':
      return 2
    case 'refused':
      return 3
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
