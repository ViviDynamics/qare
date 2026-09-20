#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { loadJobFromFile, loadJobFromText, runJob, VERSION } from '@qare/core'
import type { BootOpts, RunVerdict } from '@qare/core'

export interface Writer {
  write(chunk: string): void
}

export async function main(
  argv: string[],
  out: Writer = process.stdout,
  err: Writer = process.stderr,
  boot: BootOpts = {},
): Promise<number> {
  if (argv.includes('--version') || argv.includes('-v')) {
    out.write(`${VERSION}\n`)
    return 0
  }
  if (argv[0] === 'run') return runCommand(argv.slice(1), out, err, boot)
  out.write(`qare ${VERSION}\nusage: qare --version | qare run --job <path|->\n`)
  return 0
}

async function runCommand(argv: string[], out: Writer, err: Writer, boot: BootOpts): Promise<number> {
  try {
    const jobFlag = argv.indexOf('--job')
    const jobSpec = jobFlag === -1 ? undefined : argv[jobFlag + 1]
    if (jobSpec === undefined)
      throw new Error('qare run requires --job <path|->; pass "-" to read the job from stdin')
    const job = jobSpec === '-' ? loadJobFromText(await readStdin()) : await loadJobFromFile(jobSpec)
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

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
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
