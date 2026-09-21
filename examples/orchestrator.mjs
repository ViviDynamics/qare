#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

export const SCHEMA_VERSION = '1'

const VERDICTS = ['passed', 'failed', 'blocked', 'refused', 'waived']

export function loadResult(text) {
  let input
  try {
    input = JSON.parse(text)
  } catch (error) {
    throw new Error(`result.json is not valid JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new Error('result.json must be a JSON object')
  if (input.schemaVersion !== SCHEMA_VERSION)
    throw new Error(`result.json: unknown schemaVersion ${JSON.stringify(input.schemaVersion)} (this tool understands ${JSON.stringify(SCHEMA_VERSION)})`)
  if (typeof input.verdict !== 'string' || !VERDICTS.includes(input.verdict))
    throw new Error(`result.json: unknown verdict ${JSON.stringify(input.verdict)} (expected ${VERDICTS.map((v) => JSON.stringify(v)).join(', ')})`)
  if (!Array.isArray(input.criteria))
    throw new Error('result.json must carry a criteria array')
  return input
}

function evidencePathsOf(result) {
  return result.criteria.flatMap((criterion) => criterion.evidence ?? [])
}

function unverifiedReasons(result) {
  return result.criteria
    .filter((criterion) => criterion.outcome === 'unverified')
    .map((criterion) => criterion.reason ?? 'no reason recorded')
}

function jobId(result) {
  return result.job === undefined ? '' : ` (job ${result.job.id})`
}

export function reactToResult(result, { out = process.stdout, err = process.stderr } = {}) {
  switch (result.verdict) {
    case 'passed': {
      out.write(`QARE_PASS: qare verdict passed${jobId(result)}\n`)
      for (const path of evidencePathsOf(result)) out.write(`evidence: ${path}\n`)
      return 0
    }
    case 'failed': {
      const failedIds = result.criteria.filter((criterion) => criterion.outcome === 'failed').map((criterion) => criterion.id)
      err.write(`QARE_FAILED: qare verdict failed${jobId(result)}: criteria failed: ${failedIds.join(', ')}\n`)
      return 1
    }
    case 'blocked': {
      err.write(`QARE_BLOCKED: qare verdict blocked${jobId(result)}: ${unverifiedReasons(result).join('; ') || 'no reasons recorded'}\n`)
      return 2
    }
    case 'refused': {
      err.write(`QARE_REFUSED: qare verdict refused${jobId(result)}: ${unverifiedReasons(result).join('; ') || 'no reasons recorded'}\n`)
      return 3
    }
    case 'waived': {
      const waivers = (result.waived ?? []).map((waiver) => `${waiver.criterionId} by ${waiver.by}`).join(', ')
      err.write(`QARE_WAIVED: qare verdict waived${jobId(result)}: a human waiver is recorded (${waivers}); a waiver is never a pass\n`)
      return 5
    }
    default:
      throw new Error(`result.json: unknown verdict ${JSON.stringify(result.verdict)}`)
  }
}

export async function main(argv, { out = process.stdout, err = process.stderr } = {}) {
  const [jobPath, evidenceDir] = argv
  if (jobPath === undefined || evidenceDir === undefined) {
    err.write('usage: node examples/orchestrator.mjs <job-file> <evidence-dir>\n')
    return 4
  }
  const run = spawnSync(process.env.QARE_BIN ?? 'qare', ['run', '--job', jobPath], { stdio: 'inherit' })
  if (run.error !== undefined) {
    err.write(`${run.error instanceof Error ? `${run.error.name}: ${run.error.message}` : String(run.error)}\n`)
    return 4
  }
  if (run.status === 4) {
    err.write('orchestrator: qare run failed before it could produce a result (exit 4); nothing to react to\n')
    return 4
  }
  const resultPath = join(evidenceDir, 'result.json')
  let text
  try {
    text = await readFile(resultPath, 'utf8')
  } catch {
    err.write(`orchestrator: result.json is missing at ${resultPath}; the run produced no verdict to react to\n`)
    return 4
  }
  let result
  try {
    result = loadResult(text)
  } catch (error) {
    err.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 4
  }
  return reactToResult(result, { out, err })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`)
      process.exitCode = 4
    })
}
