import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { parse } from 'yaml'

// #305: how the posting identity reaches the jobs. The App's private key is
// the long-lived credential of the whole App, so it is used in one step per
// job and nowhere else: a step that runs a dependency-free script on the
// runner, before anything else of the run is on the machine, and mints a
// token for the calling repository alone with the permissions that job
// declares. The steps that post are handed that token. And no job that
// holds a secret builds from a cache it did not write.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

interface Step {
  name?: string
  id?: string
  if?: string
  uses?: string
  run?: string
  env?: Record<string, string>
  with?: Record<string, unknown>
}
interface Job {
  permissions?: Record<string, string>
  steps?: Step[]
}
interface Workflow {
  permissions?: Record<string, string>
  jobs: Record<string, Job>
}

function load(path: string): Workflow {
  return parse(readFileSync(join(repoRoot, path), 'utf8')) as Workflow
}

const pipeline = load('.github/workflows/pipeline.yml')
const sweep = load('.github/workflows/sweep.yml')

const MINT = 'Mint the App token for this job'
const REVOKE = 'Revoke the App token this job minted'
// Names the token's variable to look for it in the image, and holds no token.
const IMAGE_CHECK = 'Check that the image reads the minted token'
// The key under any name it could be read by: the caller's secret, qare's
// own secret, the variable, and whichever way an expression spells them.
const KEY = /app-private-key|QARE_APP_PRIVATE_KEY/
const TOKEN = /QARE_APP_TOKEN|steps\.app\.outputs/

/** Every job that posts, with the secrets its workflow names the App by and where its checkout of qare is. */
const MINTING: { where: string; job: Job; workflow: Workflow; id: string; key: string; script: string }[] = [
  ...['collect', 'publish', 'report', 'advisory', 'requeue', 'main_publish'].map((id) => ({
    where: `pipeline.yml ${id}`,
    job: pipeline.jobs[id] as Job,
    workflow: pipeline,
    id: '${{ secrets.app-id }}',
    key: '${{ secrets.app-private-key }}',
    // report and advisory check qare out as the whole workspace; the others beside something else.
    script: id === 'report' || id === 'advisory' ? 'scripts/mint-app-token.mjs' : '.qare-pipeline/scripts/mint-app-token.mjs',
  })),
  {
    where: 'sweep.yml sweep',
    job: sweep.jobs.sweep as Job,
    workflow: sweep,
    id: '${{ secrets.QARE_APP_ID }}',
    key: '${{ secrets.QARE_APP_PRIVATE_KEY }}',
    script: 'scripts/mint-app-token.mjs',
  },
]

const everyStep = (): { where: string; step: Step }[] => [
  ...Object.entries(pipeline.jobs).flatMap(([id, job]) => (job.steps ?? []).map((step) => ({ where: `pipeline.yml ${id}`, step }))),
  ...Object.entries(sweep.jobs).flatMap(([id, job]) => (job.steps ?? []).map((step) => ({ where: `sweep.yml ${id}`, step }))),
]

test('the private key is read by one step of each job that posts, and by nothing else in either workflow', () => {
  const holders = everyStep()
    .filter(({ step }) => KEY.test(JSON.stringify(step)))
    .map(({ where, step }) => `${where}: ${step.name ?? step.uses ?? ''}`)
  expect(holders).toEqual(MINTING.map(({ where }) => `${where}: ${MINT}`))
  // Nor is the App's id handed anywhere else: with the token minted, no other step has a use for it.
  const ids = everyStep()
    .filter(({ step }) => /secrets\.(app-id|QARE_APP_ID)|QARE_APP_ID/.test(JSON.stringify(step)))
    .map(({ where, step }) => `${where}: ${step.name ?? step.uses ?? ''}`)
  expect(ids).toEqual(holders)
})

test('neither the key nor the minted token is held by a job itself, only by its steps, and no secret is handed over wholesale', () => {
  for (const [path, workflow] of [['pipeline.yml', pipeline], ['sweep.yml', sweep]] as const) {
    // What is left of a workflow with its steps taken out: job and workflow
    // `env`, a job's `outputs`, a job's `container` and `services`. None of
    // it may carry the key, the App's id, or the token a step minted, which
    // a job output would hand to another job.
    const jobs = Object.fromEntries(Object.entries(workflow.jobs).map(([id, job]) => [id, { ...job, steps: undefined }]))
    const outside = JSON.stringify({ ...workflow, on: undefined, jobs })
    expect(outside, path).not.toMatch(KEY)
    expect(outside, path).not.toMatch(TOKEN)
    expect(outside, path).not.toMatch(/app-id|QARE_APP_ID/)
    // Every secret by name: nothing reads them all at once.
    expect(JSON.stringify(workflow), path).not.toMatch(/toJSON\(\s*secrets\s*\)|"secrets":"inherit"|secrets\[/)
  }
})

test('the minting step runs a script on the runner: no container, no action, and nothing but the key and what to ask for', () => {
  for (const { where, job, id, key, script } of MINTING) {
    const step = (job.steps ?? []).find((candidate) => candidate.name === MINT)
    expect(step, `${where} has no minting step`).toBeDefined()
    expect(step?.id, where).toBe('app')
    expect(step?.uses, `${where}: no action holds the key (ADR-0003)`).toBeUndefined()
    expect(step?.if, `${where}: the step runs whatever was passed, and decides for itself`).toBeUndefined()
    const run = step?.run ?? ''
    expect(run, where).not.toMatch(/docker|pnpm|npm|npx|curl/)
    if (where.startsWith('sweep.yml')) {
      // The sweep runs the script of its own checkout, which always carries it.
      expect(run.trim(), where).toBe(`node ${script}`)
    } else {
      expect(run, where).toContain(`script=${script}\n`)
      expect(run.trim().split('\n').pop()?.trim(), where).toBe('node "$script"')
    }
    // What it is handed: the two halves of the App and the list of permissions. No other secret, nothing of the run.
    expect(Object.keys(step?.env ?? {}).sort(), where).toEqual(['QARE_APP_ID', 'QARE_APP_PERMISSIONS', 'QARE_APP_PRIVATE_KEY'])
    expect(step?.env?.QARE_APP_ID, where).toBe(id)
    expect(step?.env?.QARE_APP_PRIVATE_KEY, where).toBe(key)
  }
})

// A pinned qare older than the script (a caller's qare-ref, or the base of
// the pull request that adds it) has nothing to mint with, and its image
// would not read a minted token either. With no App passed that is nothing
// lost. With one it stops by name (rule 6) and never posts as something
// weaker. The step's own script is run here, as bash runs it in a workflow.
test('a pinned qare older than the minting script mints nothing when no App was passed, and stops by name when one was', () => {
  for (const { where, job, script } of MINTING.filter((minting) => minting.where.startsWith('pipeline.yml'))) {
    const run = (job.steps ?? []).find((candidate) => candidate.name === MINT)?.run ?? ''
    const attempt = (env: Record<string, string>, withScript: boolean) => {
      const cwd = mkdtempSync(join(tmpdir(), 'qare-mint-step-'))
      if (withScript) {
        mkdirSync(dirname(join(cwd, script)), { recursive: true })
        writeFileSync(join(cwd, script), 'console.log(`the script ran with ${process.env.QARE_APP_ID}`)\n')
      }
      return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', run], {
        cwd,
        env: { PATH: process.env.PATH ?? '', QARE_APP_PERMISSIONS: '{"issues":"write"}', ...env },
        encoding: 'utf8',
      })
    }
    const nothing = attempt({ QARE_APP_ID: '', QARE_APP_PRIVATE_KEY: '' }, false)
    expect(nothing.status, where).toBe(0)
    expect(nothing.stdout, where).toMatch(/nothing to mint/)
    for (const half of [{ QARE_APP_ID: '4242', QARE_APP_PRIVATE_KEY: '' }, { QARE_APP_ID: '', QARE_APP_PRIVATE_KEY: 'a key' }, { QARE_APP_ID: '4242', QARE_APP_PRIVATE_KEY: 'a key' }]) {
      const refused = attempt(half, false)
      expect(refused.status, where).toBe(1)
      expect(refused.stdout, where).toMatch(/^::error::.*cannot post as the GitHub App that was passed/m)
      expect(`${refused.stdout}${refused.stderr}`, where).not.toContain('a key')
    }
    // With the script there, the script decides everything, whatever was passed.
    const ran = attempt({ QARE_APP_ID: '4242', QARE_APP_PRIVATE_KEY: 'a key' }, true)
    expect(ran.status, where).toBe(0)
    expect(ran.stdout, where).toBe('the script ran with 4242\n')
    expect(attempt({ QARE_APP_ID: '', QARE_APP_PRIVATE_KEY: '' }, true).stdout, where).toBe('the script ran with \n')
  }
})

test('the script the minting step runs needs nothing installed: it imports node\'s own modules alone', () => {
  const source = readFileSync(join(repoRoot, 'scripts', 'mint-app-token.mjs'), 'utf8')
  const imported = [...source.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map((match) => match[1] ?? '')
  expect(imported.length).toBeGreaterThan(0)
  for (const name of imported) expect(name, `mint-app-token.mjs imports ${name}`).toMatch(/^node:/)
  expect(source).not.toMatch(/\bimport\(|\brequire\(/)
})

test('the key is used before anything else of the run is on the machine: no artifact, no container, no install comes first', () => {
  for (const { where, job } of MINTING) {
    const steps = job.steps ?? []
    const mint = steps.findIndex((candidate) => candidate.name === MINT)
    expect(mint, where).toBeGreaterThan(-1)
    for (const earlier of steps.slice(0, mint)) {
      const label = `${where}: ${earlier.name ?? earlier.uses ?? ''} runs before the key is used`
      // A checkout and node itself are all the script needs, and all that
      // may come first: no script of any kind runs before the key is used.
      if (where === 'pipeline.yml collect' && earlier.name === "Keep a public repository's run off a self-hosted runner") {
        expect(earlier.run, label).not.toMatch(/secrets\.|pnpm|docker/)
        continue
      }
      expect(earlier.run, label).toBeUndefined()
      expect(earlier.uses ?? '', label).toMatch(/^actions\/(checkout|setup-node)@/)
      expect(Object.keys(earlier.with ?? {}), label).not.toContain('cache')
    }
    const checkouts = steps.slice(0, mint).filter((candidate) => candidate.uses?.startsWith('actions/checkout@'))
    expect(checkouts.length, where).toBeGreaterThan(0)
    // In the pipeline the qare whose script is run is the pinned one, which
    // the change under review cannot alter, and its checkout leaves no token
    // behind. The sweep runs on the default branch alone, from its own tree.
    if (where.startsWith('pipeline.yml')) {
      const pinned = checkouts.filter((checkout) => checkout.with?.repository === 'ViviDynamics/qare' && checkout.with?.ref === '${{ inputs.qare-ref }}')
      expect(pinned, `${where} runs the pinned qare's script`).toHaveLength(1)
      expect(pinned[0]?.with?.['persist-credentials'], where).toBe(false)
    }
    // judge's other checkout is the base commit: nothing of the pull request's tree is on the machine.
    if (where === 'pipeline.yml publish') {
      const others = checkouts.filter((checkout) => checkout.with?.repository === undefined)
      expect(others.map((checkout) => checkout.with?.ref), where).toEqual(['${{ github.event.pull_request.base.sha }}'])
    }
  }
})

test('the token a job mints holds what that job declares, for this repository alone, and nothing more', () => {
  for (const { where, job, workflow } of MINTING) {
    const step = (job.steps ?? []).find((candidate) => candidate.name === MINT)
    const asked = JSON.parse(step?.env?.QARE_APP_PERMISSIONS ?? 'null') as Record<string, string>
    // The job's own permissions, in the names GitHub's API gives them. The
    // run's own jobs are read with the run's own token, so `actions` is
    // never asked of the App.
    const declared = Object.fromEntries(
      Object.entries(job.permissions ?? workflow.permissions ?? {})
        .filter(([scope]) => scope !== 'actions')
        .map(([scope, level]) => [scope.replace(/-/g, '_'), level]),
    )
    expect(Object.keys(declared).length, where).toBeGreaterThan(0)
    expect(asked, where).toEqual(declared)
    // The repository is the runner's own word for where the run is, never an input.
    expect(JSON.stringify(step), where).not.toMatch(/GITHUB_REPOSITORY|github\.repository|inputs\./)
  }
})

test('the steps that post are handed the minted token and the App\'s slug, and a container is handed them by name', () => {
  const holders: string[] = []
  for (const { where, step } of everyStep()) {
    if (step.name === MINT || step.name === REVOKE || step.name === IMAGE_CHECK) continue
    if (!/QARE_APP_TOKEN|QARE_APP_SLUG|steps\.app\.outputs/.test(JSON.stringify(step))) continue
    holders.push(`${where}: ${step.name ?? ''}`)
    expect(step.env?.QARE_APP_TOKEN, `${where}: ${step.name ?? ''}`).toBe('${{ steps.app.outputs.token }}')
    expect(step.env?.QARE_APP_SLUG, `${where}: ${step.name ?? ''}`).toBe('${{ steps.app.outputs.slug }}')
    // And when it expires, so a job that outlives it is told so by name.
    expect(step.env?.QARE_APP_TOKEN_EXPIRES_AT, `${where}: ${step.name ?? ''}`).toBe('${{ steps.app.outputs.expires-at }}')
    const run = step.run ?? ''
    if (run.includes('docker run')) {
      expect(run, `${where}: ${step.name ?? ''}`).toContain('-e QARE_APP_TOKEN ')
      expect(run, `${where}: ${step.name ?? ''}`).toContain('-e QARE_APP_SLUG ')
      expect(run, `${where}: ${step.name ?? ''}`).toContain('-e QARE_APP_TOKEN_EXPIRES_AT ')
    }
    // Its value is never written on a command line, and never beside the model key (rule 7).
    expect(run, `${where}: ${step.name ?? ''}`).not.toMatch(/\$\{?QARE_APP_(TOKEN|SLUG)/)
    expect(JSON.stringify(step), `${where}: ${step.name ?? ''}`).not.toMatch(/model-key|MODEL_KEY|QARE_PLANNER_KEY/)
  }
  expect(holders).toEqual([
    'pipeline.yml collect: Read recorded advisory context',
    'pipeline.yml publish: Carry out the advisory replies',
    'pipeline.yml publish: File stub issues (refused runs only)',
    'pipeline.yml publish: Post the evidence on the pull request',
    'pipeline.yml report: Report the failure on the pull request',
    'pipeline.yml advisory: Carry out the advisory replies',
    'pipeline.yml requeue: Re-queue refused PRs unblocked by the merged stubs',
    'pipeline.yml main_publish: File what the run on main found',
    'sweep.yml sweep: Publish the standing report and file findings',
  ])
  // No container is handed the key or the App's id, under any name.
  for (const { where, step } of everyStep()) expect(step.run ?? '', `${where}: ${step.name ?? ''}`).not.toMatch(/-e QARE_APP_(ID|PRIVATE_KEY)/)
})

// A minted token is only the App's to an image that reads it. One that
// predates it would find no App in its environment and post as something
// weaker without a word (rule 6), so the two jobs that post from the image
// check the image first, and stop by name.
test('judge and main_judge stop by name when the image they pulled cannot read a minted token', () => {
  for (const id of ['publish', 'main_publish']) {
    const steps = pipeline.jobs[id]?.steps ?? []
    const index = steps.findIndex((candidate) => candidate.name === IMAGE_CHECK)
    expect(index, id).toBeGreaterThan(steps.findIndex((candidate) => candidate.name === 'Pull the core image'))
    const first = steps.findIndex((candidate) => candidate.env?.QARE_APP_TOKEN !== undefined)
    expect(index, id).toBeLessThan(first)
    const step = steps[index] as Step
    expect(step.if, id).toBe("steps.app.outputs.token != ''")
    // It holds no token and no secret: only the name of the image.
    expect(step.env, id).toEqual({ IMAGE_REF: '${{ steps.image.outputs.digest }}' })
    const run = (step.run ?? '').replace(/\\\n/g, ' ').replace(/\s+/g, ' ')
    expect(run, id).toContain('docker run --rm --network none --entrypoint grep "$IMAGE_REF" -q QARE_APP_TOKEN /opt/qare/lib/packages/action/dist/identity.js || status=$?')
    // The step's own script, run with a docker that answers as grep would:
    // found, not found, and a docker that could not look at all. Only
    // "found" passes, and the other two are told apart.
    const attempt = (exit: number) => {
      const bin = mkdtempSync(join(tmpdir(), 'qare-image-check-'))
      writeFileSync(join(bin, 'docker'), `#!/bin/sh\nexit ${exit}\n`, { mode: 0o755 })
      return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run ?? ''], {
        env: { PATH: `${bin}:${process.env.PATH ?? ''}`, IMAGE_REF: 'ghcr.io/vividynamics/qare-core:2026.1.0' },
        encoding: 'utf8',
      })
    }
    expect(attempt(0).status, id).toBe(0)
    expect(attempt(0).stdout, id).toBe('')
    const older = attempt(1)
    expect(older.status, id).toBe(1)
    expect(older.stdout, id).toMatch(/^::error::.*is older than the minted token/)
    const broken = attempt(125)
    expect(broken.status, id).toBe(1)
    expect(broken.stdout, id).toMatch(/^::error::.*could not be inspected \(status 125\)/)
    expect(broken.stdout, id).not.toMatch(/is older than/)
  }
})

test('the sweep, which holds the identity, runs on its schedule and otherwise for the default branch alone', () => {
  // A schedule only ever runs the default branch's workflow. A manual run
  // names its branch, and one from another branch is not started.
  expect((sweep.jobs.sweep as { if?: string }).if).toBe(
    "github.event_name == 'schedule' || github.ref == format('refs/heads/{0}', github.event.repository.default_branch)",
  )
})

test('a job that mints runs on the runner itself: it declares no container and no services', () => {
  for (const { where, job } of MINTING) {
    expect(Object.keys(job), where).not.toContain('container')
    expect(Object.keys(job), where).not.toContain('services')
  }
})

test('a job gives its token back when it ends, however it ends, and a failure to do so fails nothing', () => {
  for (const { where, job } of MINTING) {
    const steps = job.steps ?? []
    const revoke = steps.find((candidate) => candidate.name === REVOKE)
    expect(revoke, `${where} never revokes its token`).toBeDefined()
    expect(revoke?.if, where).toBe("always() && steps.app.outputs.token != ''")
    expect(revoke?.env, where).toEqual({ QARE_APP_TOKEN: '${{ steps.app.outputs.token }}' })
    expect(revoke?.run, where).toContain('-X DELETE')
    // The token reaches curl on its standard input, never as an argument another process could read.
    expect(revoke?.run, where).toContain('-H @- <<< "Authorization: Bearer $QARE_APP_TOKEN"')
    expect(revoke?.run?.replace('-H @- <<< "Authorization: Bearer $QARE_APP_TOKEN"', ''), where).not.toContain('QARE_APP_TOKEN')
    expect(revoke?.run, where).toContain('"$GITHUB_API_URL/installation/token"')
    expect(revoke?.run, where).toMatch(/\|\| echo "::warning::/)
    // After every step that posts with it.
    const last = Math.max(...steps.map((candidate, index) => (candidate.env?.QARE_APP_TOKEN !== undefined && candidate.name !== REVOKE ? index : -1)))
    expect(steps.indexOf(revoke as Step), where).toBeGreaterThan(last)
  }
})

test('no job that reads a secret restores a dependency cache', () => {
  for (const [path, workflow] of [['pipeline.yml', pipeline], ['sweep.yml', sweep]] as const) {
    for (const [id, job] of Object.entries(workflow.jobs)) {
      const text = JSON.stringify(job)
      if (!/secrets\.|github\.token/.test(text)) continue
      for (const step of job.steps ?? []) {
        expect(step.uses ?? '', `${path} ${id}`).not.toMatch(/^actions\/cache(\/|@)/)
        expect(Object.keys(step.with ?? {}), `${path} ${id}: ${step.name ?? step.uses ?? ''} restores a cache`).not.toContain('cache')
      }
    }
  }
  // Every job of the pipeline, in fact: the ones that hold nothing set up no node at all.
  expect(readFileSync(join(repoRoot, '.github/workflows/pipeline.yml'), 'utf8')).not.toMatch(/^\s+cache(-dependency-path)?:/m)
})

test('the documentation says where the token is minted, what it is scoped to and how long it lasts', () => {
  const doc = readFileSync(join(repoRoot, 'docs', 'pipeline.md'), 'utf8')
  const start = doc.indexOf('\n## GitHub identity\n')
  const section = doc.slice(start, doc.indexOf('\n## ', start + 1))
  expect(section).toMatch(/one step of each job/)
  expect(section).toMatch(/scripts\/mint-app-token\.mjs/)
  expect(section).toMatch(/the permissions that job declares/)
  expect(section).toMatch(/expires within the hour/)
  expect(section).toMatch(/never (enters|reaches) a container/)
  const adr = readFileSync(join(repoRoot, 'docs', 'decisions', 'adr-0003-posting-identity.md'), 'utf8')
  expect(adr).toMatch(/#305/)
  expect(adr).toMatch(/scripts\/mint-app-token\.mjs/)
  expect(adr).toMatch(/an hour/)
})
