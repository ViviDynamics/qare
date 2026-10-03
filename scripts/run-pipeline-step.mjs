// Run one step of the reusable pipeline (.github/workflows/pipeline.yml) as
// the shell script it is, outside a workflow run (#209).
//
// The pipeline's steps are bash that reads its inputs from the environment,
// so a step can be exercised for real by setting that environment and running
// the script the workflow file carries. CI does this with the execute step
// against a profile that boots a compose app: what runs is the step every
// caller gets, not a copy of it that could drift.
//
//   node scripts/run-pipeline-step.mjs <job> <step name>          run it
//   node scripts/run-pipeline-step.mjs <job> <step name> --print  print it
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
// yaml is a dependency of the core package, not of the workspace root.
const { parse } = createRequire(new URL('../packages/core/package.json', import.meta.url))('yaml')

/** The `run` script of a named step in a job of the pipeline. Throws, by name, when it cannot be run as plain bash. */
export function pipelineStep(job, stepName, workflowPath = `${rootDir}.github/workflows/pipeline.yml`) {
  const workflow = parse(readFileSync(workflowPath, 'utf8'))
  const steps = workflow?.jobs?.[job]?.steps
  if (!Array.isArray(steps)) throw new Error(`the pipeline has no job named ${job}`)
  const step = steps.find((entry) => entry?.name === stepName)
  if (step === undefined) throw new Error(`the pipeline's ${job} job has no step named ${JSON.stringify(stepName)}`)
  if (typeof step.run !== 'string') throw new Error(`the step ${JSON.stringify(stepName)} of ${job} runs an action, not a script`)
  // An expression is filled in by the workflow run; outside one it would
  // reach bash as text. A step that carries one cannot be run from here.
  if (step.run.includes('${{'))
    throw new Error(`the step ${JSON.stringify(stepName)} of ${job} carries a workflow expression in its script, so it cannot run outside a workflow`)
  return { run: step.run, env: Object.keys(step.env ?? {}) }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [job, stepName, flag] = process.argv.slice(2)
  if (job === undefined || stepName === undefined) {
    console.error('usage: node scripts/run-pipeline-step.mjs <job> <step name> [--print]')
    process.exit(4)
  }
  let step
  try {
    step = pipelineStep(job, stepName)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(4)
  }
  if (flag === '--print') {
    process.stdout.write(step.run)
    process.exit(0)
  }
  // The workflow fills these from its own context; here the caller does.
  const missing = [...step.env, 'RUNNER_TEMP', 'GITHUB_STEP_SUMMARY'].filter((name) => process.env[name] === undefined)
  if (missing.length > 0) {
    console.error(`the step reads ${missing.join(', ')} from its environment: set them`)
    process.exit(4)
  }
  // The shell GitHub runs a `shell: bash` step with.
  const outcome = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run], { stdio: 'inherit' })
  process.exit(outcome.status ?? 1)
}
