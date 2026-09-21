#!/usr/bin/env node
// qare Claude Code Stop hook.
//
// Reads qare's result.json and maps its verdict to this process's exit code.
// It never computes, re-weighs or changes a verdict: verdicts are decided by
// qare's code. Fail closed: anything that is not a clean "passed" result
// blocks the stop with a named message.
//
// Result path resolution order (first hit wins):
//   1. first CLI argument
//   2. QARE_RESULT_PATH environment variable
//   3. "result_path" field of the JSON on stdin
//   4. default: <project>/.qare/result.json
//
// Exit semantics (exit 2 is the only code that blocks a Stop; exit 1 is a
// non-blocking error, so a gate that meant to gate would not gate):
//   verdict passed             -> exit 0 (stop proceeds)
//   verdict failed             -> exit 2, QARE_FAILED
//   verdict blocked            -> exit 2, QARE_BLOCKED
//   verdict refused            -> exit 2, QARE_REFUSED
//   verdict waived             -> exit 2, QARE_WAIVED (a waiver is not a pass)
//   missing / malformed result -> exit 2 with a named QARE_RESULT_* error

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const VERDICTS = ['passed', 'failed', 'blocked', 'refused', 'waived']
const OUTCOMES = ['proven', 'failed', 'unverified']

function resultPathFrom(argv, env, stdinJson) {
  const fromArg = argv[2]
  if (fromArg !== undefined) return resolve(fromArg)
  const fromEnv = env.QARE_RESULT_PATH
  if (fromEnv !== undefined && fromEnv.trim() !== '') return resolve(fromEnv)
  if (stdinJson !== null && typeof stdinJson === 'object' && !Array.isArray(stdinJson)) {
    const fromStdin = stdinJson.result_path
    if (typeof fromStdin === 'string' && fromStdin.trim() !== '') return resolve(fromStdin)
  }
  const projectDir = env.CLAUDE_PROJECT_DIR ?? process.cwd()
  return resolve(projectDir, '.qare', 'result.json')
}

async function readStdinText() {
  if (process.stdin.isTTY) return ''
  let text = ''
  for await (const chunk of process.stdin) text += String(chunk)
  return text
}

function block(name, detail) {
  process.stderr.write(`QARE_${name}: ${detail}\n`)
  process.exit(2)
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function main() {
  const stdinText = await readStdinText()
  let stdinJson = null
  if (stdinText.trim() !== '') {
    try {
      stdinJson = JSON.parse(stdinText)
    } catch {
      stdinJson = null
    }
  }

  const resultPath = resultPathFrom(process.argv, process.env, stdinJson)

  let text
  try {
    text = await readFile(resultPath, 'utf8')
  } catch {
    block('RESULT_MISSING', `no result.json readable at ${resultPath}; run qare first or point the hook at the evidence directory`)
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    block('RESULT_INVALID_JSON', `${resultPath} is not valid JSON (${error instanceof Error ? error.message : String(error)})`)
  }

  if (!isRecord(parsed)) block('RESULT_INVALID', `${resultPath} must be a JSON object`)

  if (parsed.schemaVersion !== '1')
    block('RESULT_SCHEMA_VERSION', `${resultPath} carries schemaVersion ${JSON.stringify(parsed.schemaVersion ?? null)}; this hook understands "1"`)

  const verdict = parsed.verdict
  if (typeof verdict !== 'string' || !VERDICTS.includes(verdict))
    block('RESULT_VERDICT', `${resultPath} carries unknown verdict ${JSON.stringify(parsed.verdict ?? null)}; expected one of ${VERDICTS.map((v) => `"${v}"`).join(', ')}`)

  if (!Array.isArray(parsed.criteria))
    block('RESULT_CRITERIA', `${resultPath} must carry a criteria array`)

  for (const [index, entry] of parsed.criteria.entries()) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id.trim() === '')
      block('RESULT_CRITERIA', `${resultPath} criteria[${index}] must be an object with a non-empty id`)
    if (typeof entry.outcome !== 'string' || !OUTCOMES.includes(entry.outcome))
      block('RESULT_CRITERIA', `${resultPath} criteria[${index}].outcome ${JSON.stringify(entry.outcome ?? null)} is not one of ${OUTCOMES.map((o) => `"${o}"`).join(', ')}`)
  }

  if (verdict === 'passed') {
    const notProven = parsed.criteria.filter((entry) => entry.outcome !== 'proven').map((entry) => entry.id)
    if (parsed.criteria.length === 0 || notProven.length > 0)
      block('RESULT_INVALID', `${resultPath} verdict is passed but qare never passes without every criterion proven (offending: ${notProven.join(', ') || 'empty run'}); fix the result with qare, never by hand`)
    const job = isRecord(parsed.job) && typeof parsed.job.id === 'string' ? ` (job ${parsed.job.id})` : ''
    process.stdout.write(`QARE_PASS: qare verdict passed${job}; evidence in ${resultPath}\n`)
    process.exit(0)
  }

  if (verdict === 'failed') {
    const failed = parsed.criteria.filter((entry) => entry.outcome === 'failed').map((entry) => entry.id)
    block('FAILED', `qare verdict failed: criteria not proven ${failed.join(', ') || '(none)'}; read the evidence and fix the change, then rerun qare`)
  }

  if (verdict === 'blocked')
    block('BLOCKED', 'qare verdict blocked: the run could not produce evidence (boot, stub or schema failure); fix the run setup and rerun qare')

  if (verdict === 'refused')
    block('REFUSED', 'qare verdict refused: the run declined to QA this change as asked; read result.json for the named reason')

  block('WAIVED', 'qare verdict waived: a human waiver is recorded, which is not a pass; confirm the waiver out of band before stopping')
}

main().catch((error) => {
  process.stderr.write(`QARE_HOOK_ERROR: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(2)
})
