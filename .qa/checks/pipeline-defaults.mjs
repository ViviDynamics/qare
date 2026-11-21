import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import './source.mjs'

// qare-action's source too, the same way source.mjs loads core's: its
// `@qare/core` is the checkout's core source, never the image's build.
const actionSource = new URL('../../packages/action/src/', import.meta.url).href
const coreIndex = new URL('../../packages/core/src/index.ts', import.meta.url).href
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@qare/core') return next(coreIndex, context)
    if (specifier.endsWith('.js') && context.parentURL?.startsWith(actionSource)) {
      const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL)
      if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context)
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (!url.startsWith(actionSource) || !url.endsWith('.ts')) return next(url, context)
    return { format: 'module', shortCircuit: true, source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), { mode: 'transform', sourceUrl: url }) }
  },
})
const posted = async (result, opts) => {
  const { postEvidence } = await import('../../packages/action/src/post-evidence.ts')
  const out = { comments: [], checkRuns: [] }
  await postEvidence({ postComment: async (body) => { out.comments.push(body) }, createCheckRun: async (run) => { out.checkRuns.push(run) } }, result, opts)
  return out
}

// Executable checks of the pipeline defaults (#380), run against the
// checkout without a build: the workflow's own step scripts with docker and
// git stubbed, and the checkout's core source through source.mjs. Each prints
// what it observed. Scratch is restricted to .qa/checks/scratch.

const root = fileURLToPath(new URL('../../', import.meta.url))
const scratch = fileURLToPath(new URL('./scratch/', import.meta.url))
mkdirSync(scratch, { recursive: true })
const { parse } = await import('yaml')
const workflow = parse(readFileSync(join(root, '.github/workflows/pipeline.yml'), 'utf8'))
const inputs = workflow.on.workflow_call.inputs
const stepOf = (job, name) => {
  const found = workflow.jobs[job].steps.find((step) => step.name === name)
  assert.ok(found, `${job} has no step ${name}`)
  return found.run
}
// The stubs are bash functions handed down in the environment, not files:
// the scratch directory a contained check gets may not be executable.
const stubs = {}
const tool = (_dir, name, body) => {
  stubs[`BASH_FUNC_${name}%%`] = `() { ${body}\n}`
}
const runScript = (script, dir, env) =>
  spawnSync('bash', ['-c', script], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: join(dir, 'summary'), ...stubs, ...env } })
const after = (args, flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)

const check = process.argv[2]
const dir = mkdtempSync(join(scratch, `defaults-${check}-`))
try {
  if (check === 'flake') {
    // The defaults: one retry, a store in the ledger directory.
    assert.equal(inputs['flake-attempts'].default, '2')
    assert.equal(inputs.quarantine.default, '.qa')
    // The execute step hands both to qare run, and reads the base's store, not the pull request's.
    tool(dir, 'docker', 'printf "%s\\n" "$@" > "$RUNNER_TEMP/calls"; mkdir -p evidence; echo "{}" > evidence/result.json')
    tool(dir, 'git', 'if [ "$1" = worktree ]; then mkdir -p "$4/.qa"; echo base > "$4/.qa/quarantine.json"; fi; return 0')
    writeFileSync(join(dir, 'qare-docker-access'), '')
    mkdirSync(join(dir, '.qa'))
    writeFileSync(join(dir, '.qa/quarantine.json'), 'pull request\n')
    const ran = runScript(stepOf('execute', 'Run the plan'), dir, {
      IMAGE_REF: 'image', IMAGE_DIGEST: 'image', IMAGE_TAG_REF: 'tag', BASE_SHA: 'a'.repeat(40), HEAD_SHA: 'b'.repeat(40),
      PR_NUMBER: '1', PROFILE: '.qa', FLAKE_ATTEMPTS: inputs['flake-attempts'].default, QUARANTINE: inputs.quarantine.default,
    })
    assert.equal(ran.status, 0, ran.stderr)
    const args = readFileSync(join(dir, 'calls'), 'utf8').split('\n')
    assert.equal(after(args, '--flake-attempts'), '2')
    assert.equal(after(args, '--quarantine'), join(dir, 'qare-quarantine'))
    const uploaded = readFileSync(join(dir, 'evidence/quarantine.json'), 'utf8').trim()
    assert.equal(uploaded, 'base')
    // And what one retry does, on the checkout's own runner: a check that
    // fails then passes is quarantined and unverified, never proven; a check
    // that fails every attempt still fails.
    const { runJob } = await import('../../packages/core/src/run.ts')
    const outcomes = {}
    for (const [name, script] of [
      ['fails-then-passes', "import { existsSync, writeFileSync } from 'node:fs'\nif (existsSync('flipped')) process.exit(0)\nwriteFileSync('flipped', 'x')\nprocess.exit(1)\n"],
      ['always-fails', 'process.exit(1)\n'],
    ]) {
      const repo = mkdtempSync(join(dir, `${name}-`))
      writeFileSync(join(repo, 'check.mjs'), script)
      const { result } = await runJob(
        {
          id: name, repoPath: repo, baseRef: 'main', headRef: 'HEAD', post: 'none', evidenceDir: join(repo, 'evidence'),
          profile: { inline: { app: { boot: { compose: 'compose.qa.yaml', service: 'app' }, health: { http: ['http:', '//localhost:3000/up'].join(''), timeout: '120s' }, seed: { command: 'true' }, login: { fixture: 'f.yml', role: 'admin' } }, stubs: [], visual: { widths: [], themes: [] }, suites: [] } },
          criteria: [{ id: name, text: name, checks: [{ kind: 'command', run: 'node check.mjs' }] }],
        },
        { runCompose: async () => ({ code: 0, stdout: '', stderr: '' }), probe: async () => ({ ok: true }), pollIntervalMs: 1, execution: 'native', flakeAttempts: 2, quarantineDir: join(repo, 'store') },
      )
      const criterion = result.criteria[0]
      outcomes[name] = { outcome: criterion.outcome, reason: criterion.reason, attempt2: existsSync(join(repo, 'evidence/checks', name, '0-attempt2')) }
    }
    assert.equal(outcomes['fails-then-passes'].outcome, 'unverified')
    assert.match(outcomes['fails-then-passes'].reason, /^quarantined \(.*\): unstable: the check failed and passed across 2 attempts/)
    assert.equal(outcomes['fails-then-passes'].attempt2, true)
    assert.equal(outcomes['always-fails'].outcome, 'failed')
    console.log(JSON.stringify({ check, defaults: { 'flake-attempts': '2', quarantine: '.qa' }, qareRun: { flakeAttempts: '2', quarantine: 'runner temp', storeRead: uploaded }, outcomes }))
  } else if (check === 'exclude') {
    assert.equal(inputs['planner-diff-default-exclude'].default, 'true')
    // The collect step's default pathspecs, applied the way it applies them.
    const collect = stepOf('collect', 'Read the linked issue and the diff')
    const list = /default_excludes=\(\n([\s\S]*?)\n\s*\)/.exec(collect)[1]
    const patterns = [...list.matchAll(/'([^']+)'/g)].map((found) => found[1])
    // The image carries no git, so git's default pathspec rule is applied
    // here: `*` and `?` match across `/`, and a name without either matches
    // that path or anything under it. The cli suite runs the same list
    // through git itself (pipeline-defaults.test.ts).
    const matches = (pattern, path) => {
      if (!/[*?[]/.test(pattern)) return path === pattern || path.startsWith(`${pattern}/`)
      const body = pattern.replace(/[.+^${}()|\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.')
      return new RegExp(`^${body}$`).test(path)
    }
    const excluded = ['pnpm-lock.yaml', 'apps/web/package-lock.json', 'go.sum', 'services/api/poetry.lock', 'public/app.min.js', 'public/app.js.map', 'dist/index.js', 'packages/core/dist/index.js', 'node_modules/left-pad/index.js']
    const kept = ['src/app.ts', 'packages/core/src/lockfile.ts', 'docs/dist-notes.md', 'package.json']
    const planner = [...excluded, ...kept].filter((path) => !patterns.some((pattern) => matches(pattern, path))).sort()
    assert.deepEqual(planner, [...kept].sort())
    // The record is uploaded with the QA inputs, and publish hands it to the comment.
    assert.ok(collect.includes('> planner-diff-excluded.json'))
    assert.ok(stepOf('publish', 'Post the evidence on the pull request').includes('--planner-diff-excluded qa-inputs/planner-diff-excluded.json'))
    // The comment post-evidence writes from that record lists the pathspecs and the paths.
    const leftOut = [...excluded, ...kept].filter((path) => !planner.includes(path))
    const result = { schemaVersion: '1', verdict: 'passed', criteria: [{ id: 'c', outcome: 'proven', evidence: [] }] }
    const { comments } = await posted(result, { plannerDiffExcluded: { patterns, paths: leftOut } })
    const comment = comments[0]
    const section = comment.slice(comment.indexOf('## Planner diff'))
    assert.ok(comment.includes('## Planner diff'))
    for (const path of leftOut) assert.ok(section.includes(`\`${path}\``), path)
    for (const path of kept) assert.ok(!section.includes(`\`${path}\``), path)
    console.log(JSON.stringify({ check, patterns: patterns.length, plannerSaw: planner, leftOut }))
    console.log(section)
  } else if (check === 'blocked') {
    assert.equal(inputs['blocked-check'].default, 'neutral')
    // The check run post-evidence posts for a blocked verdict, by default and on opt-in.
    const blocked = { schemaVersion: '1', verdict: 'blocked', criteria: [{ id: 'c', outcome: 'unverified', reason: 'environment: down', evidence: [] }] }
    const byDefault = (await posted(blocked, {})).checkRuns[0]
    const optIn = (await posted(blocked, { blockedConclusion: 'failure' })).checkRuns[0]
    const conclusions = { default: byDefault.conclusion, optIn: optIn.conclusion, optInSummary: optIn.summary }
    assert.equal(conclusions.default, 'neutral')
    assert.equal(conclusions.optIn, 'failure')
    // The publish step passes the opt-in through, passes nothing for neutral, and refuses a typo.
    tool(dir, 'docker', 'if [ "$1" = run ] && printf "%s\\n" "$@" | grep -qx grep; then return 0; fi; printf "%s\\n" "$@" > "$RUNNER_TEMP/calls"')
    const post = stepOf('publish', 'Post the evidence on the pull request')
    const seen = {}
    for (const value of ['neutral', 'failure', 'red']) {
      rmSync(join(dir, 'calls'), { force: true })
      const ran = runScript(post, dir, { IMAGE_REF: 'image', PR_NUMBER: '1', HEAD_SHA: 'b'.repeat(40), EVIDENCE_URL: '', BLOCKED_CHECK: value, GITHUB_OUTPUT: join(dir, 'out') })
      const args = existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').split('\n') : []
      seen[value] = { status: ran.status, flag: after(args, '--blocked-conclusion') ?? null }
    }
    assert.deepEqual(seen, { neutral: { status: 0, flag: null }, failure: { status: 0, flag: 'failure' }, red: { status: 1, flag: null } })
    console.log(JSON.stringify({ check, conclusions, publish: seen }))
  } else {
    throw new Error(`unknown check ${JSON.stringify(check)}: flake, exclude or blocked`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
