import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { parse } from 'yaml'

// #310: what the workflows trust, and what they are allowed to do. An action
// named by a tag is whatever that tag points at today, so every action is
// named by its commit. pnpm is the one package.json names, by version and
// hash. A job holds a write permission only where it writes, and a workflow
// that tags and releases starts for the default branch alone.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const workflowDir = join(repoRoot, '.github', 'workflows')

interface Step {
  name?: string
  uses?: string
  run?: string
  if?: string
  env?: Record<string, string>
  with?: Record<string, unknown>
  'working-directory'?: string
}
interface Job {
  name?: string
  if?: string
  uses?: string
  permissions?: Record<string, string>
  steps?: Step[]
}
interface Workflow {
  on: Record<string, unknown>
  permissions?: Record<string, string>
  jobs: Record<string, Job>
}

const files = readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name)).sort()
const text = (name: string): string => readFileSync(join(workflowDir, name), 'utf8')
const load = (name: string): Workflow => parse(text(name)) as Workflow

test('every workflow file is read: none is left out of these checks', () => {
  expect(files).toEqual(['auto-tag.yml', 'benchmark.yml', 'ci.yml', 'pipeline.yml', 'qare.yml', 'release.yml', 'skills.yml', 'sweep.yml'])
})

test('every action outside this repository is named by a full commit, with its version beside it', () => {
  let seen = 0
  for (const name of files) {
    // Read as text, line by line: the version is a comment, which a parser drops.
    for (const [index, line] of text(name).split('\n').entries()) {
      const match = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/.exec(line)
      if (match === null) continue
      const [, target = '', rest = ''] = match
      const where = `${name}:${index + 1} ${target}`
      // A workflow or an action of this repository travels with the commit that names it.
      if (target.startsWith('./')) continue
      seen += 1
      expect(target, `${where} must name a commit, never a tag or a branch`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/)
      expect(rest, `${where} must carry its version as a trailing comment`).toMatch(/^\s+# v\d+\.\d+\.\d+$/)
    }
    // And nothing names one where the line reader would not see it.
    const uses = JSON.stringify(load(name)).match(/"uses":"[^"]+"/g) ?? []
    for (const entry of uses) expect(entry, name).toMatch(/^"uses":"(\.\/[^"]+|[\w.-]+\/[\w./-]+@[0-9a-f]{40})"$/)
  }
  expect(seen).toBeGreaterThan(40)
})

test('one action is one commit everywhere: no two workflows run different code under one name', () => {
  const commits = new Map<string, Set<string>>()
  for (const name of files)
    for (const match of text(name).matchAll(/uses:\s*([\w.-]+\/[\w./-]+)@([0-9a-f]{40})/g)) {
      const [, action = '', commit = ''] = match
      commits.set(action, (commits.get(action) ?? new Set()).add(commit))
    }
  for (const [action, set] of commits) expect([...set], action).toHaveLength(1)
})

const ENABLE = 'Enable the pnpm package.json names'
const temporaryDirectories: string[] = []
const temporaryDirectory = (prefix: string): string => {
  const path = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(path)
  return path
}
afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

test('pnpm is the one package.json names, by version and hash, and no action installs it', () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { packageManager?: string }
  // The hash is what corepack checks the download against.
  expect(manifest.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/)
  // The image reads the same manifest through Corepack, including its hash.
  const recipe = readFileSync(join(repoRoot, 'images', 'core', 'Dockerfile'), 'utf8')
  expect(recipe).toContain('COPY package.json')
  expect(recipe).toContain('corepack enable')
  expect(recipe).not.toContain('npm install --global pnpm')
  for (const name of files) {
    expect(text(name), name).not.toMatch(/pnpm\/action-setup/)
    for (const [id, job] of Object.entries(load(name).jobs)) {
      const steps = job.steps ?? []
      const first = steps.findIndex((step) => /(^|\s)pnpm\s/.test(step.run ?? '') && step.name !== ENABLE)
      if (first === -1) continue
      const enable = steps.findIndex((step) => step.name === ENABLE)
      expect(enable, `${name} ${id} runs pnpm and never enables it`).toBeGreaterThan(-1)
      expect(enable, `${name} ${id}`).toBeLessThan(first)
      // corepack ships with node, so node is set up first.
      const setup = steps.findIndex((step) => step.uses?.startsWith('actions/setup-node@'))
      expect(setup, `${name} ${id} must set up node`).toBeGreaterThan(-1)
      expect(setup, `${name} ${id}`).toBeLessThan(enable)
      const run = steps[enable]?.run ?? ''
      expect(run, `${name} ${id}`).toContain('corepack enable')
      // The version that resolved is held to the one package.json names.
      expect(run.replace(/\s+/g, ' '), `${name} ${id}`).toContain('if [ "$found" != "$wanted" ]; then')
      // Where qare is checked out beside another tree, pnpm runs in qare's
      // directory: corepack reads the nearest package.json, and the other
      // tree's is not qare's to obey.
      const beside = steps.some((step) => step.with?.path === '.qare-pipeline')
      for (const step of steps.filter((candidate) => /(^|\s)pnpm\s/.test(candidate.run ?? '')))
        expect(step['working-directory'], `${name} ${id}: ${step.name ?? step.run ?? ''}`).toBe(beside ? '.qare-pipeline' : undefined)
    }
  }
})

test('the enabling step stops when the pnpm that resolved is not the one package.json names', () => {
  const runs = new Set(files.flatMap((name) => Object.values(load(name).jobs).flatMap((job) =>
    (job.steps ?? []).filter((step) => step.name === ENABLE).map((step) => step.run ?? 'exit 99'))))
  const attempt = (run: string, resolved: string, packageManager: string | undefined, corepackExit = 0, allocationExit?: number) => {
    const cwd = temporaryDirectory('qare-pnpm-')
    const bin = temporaryDirectory('qare-pnpm-bin-')
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'x', ...(packageManager === undefined ? {} : { packageManager }) }))
    writeFileSync(join(bin, 'corepack'), `#!/bin/sh\nexit ${corepackExit}\n`, { mode: 0o755 })
    if (allocationExit !== undefined) writeFileSync(join(bin, 'mktemp'), `#!/bin/sh\nexit ${allocationExit}\n`, { mode: 0o755 })
    writeFileSync(join(cwd, 'github-env'), '')
    writeFileSync(join(bin, 'pnpm'), `#!/bin/sh\necho ${resolved}\n`, { mode: 0o755 })
    return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', run], {
      cwd,
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, RUNNER_TEMP: cwd, GITHUB_ENV: join(cwd, 'github-env') },
      encoding: 'utf8',
    })
  }
  expect(runs.size).toBeGreaterThan(0)
  for (const run of runs) {
    expect(attempt(run, '12.5.1', `pnpm@12.5.1+sha512.${'a'.repeat(128)}`).status).toBe(0)
    expect(attempt(run, '12.5.1', 'pnpm@12.5.1').status).toBe(0)
    const other = attempt(run, '9.0.0', `pnpm@12.5.1+sha512.${'a'.repeat(128)}`)
    expect(other.status).toBe(1)
    expect(other.stdout).toMatch(/^::error::.*pnpm@9\.0\.0.*pnpm@12\.5\.1/m)
    expect(attempt(run, '12.5.1', undefined).status).toBe(1)
    expect(attempt(run, '12.5.1', 'pnpm@12.5.1', 17).status).toBe(17)
    expect(attempt(run, '12.5.1', 'pnpm@12.5.1', 0, 23).status).toBe(23)
  }
})

test('each pnpm job uses a fresh corepack directory and hands it to later steps', () => {
  for (const name of files)
    for (const [id, job] of Object.entries(load(name).jobs)) {
      const step = job.steps?.find((candidate) => candidate.name === ENABLE)
      if (step === undefined) continue
      const cwd = temporaryDirectory('qare-corepack-')
      const bin = temporaryDirectory('qare-corepack-bin-')
      const envFile = join(cwd, 'github-env')
      writeFileSync(envFile, '')
      writeFileSync(join(cwd, 'package.json'), JSON.stringify({ packageManager: 'pnpm@12.5.1' }))
      writeFileSync(join(bin, 'corepack'), '#!/bin/sh\n[ -d "$COREPACK_HOME" ] && [ "$COREPACK_HOME" != "$RUNNER_TEMP/old-cache" ]\n', { mode: 0o755 })
      writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\necho 12.5.1\n', { mode: 0o755 })
      const homes: string[] = []
      for (let attempt = 0; attempt < 2; attempt += 1) {
        writeFileSync(envFile, '')
        const ran = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run ?? 'exit 99'], {
          cwd,
          env: { PATH: `${bin}:${process.env.PATH ?? ''}`, RUNNER_TEMP: cwd, GITHUB_ENV: envFile, COREPACK_HOME: join(cwd, 'old-cache') },
          encoding: 'utf8',
        })
        expect(ran.status, `${name} ${id}: ${ran.stderr}`).toBe(0)
        const home = /^COREPACK_HOME=(.+)$/m.exec(readFileSync(envFile, 'utf8'))?.[1]
        expect(home, `${name} ${id}`).toMatch(new RegExp(`^${cwd}/qare-corepack\\.`))
        homes.push(home ?? '')
      }
      expect(homes[0], `${name} ${id}`).not.toBe(homes[1])
    }
})

const WRITES = /secrets\.|github\.token/

test('no job that holds a write permission or reads a secret restores a dependency cache', () => {
  for (const name of files) {
    const workflow = load(name)
    for (const [id, job] of Object.entries(workflow.jobs)) {
      const permissions = job.permissions ?? workflow.permissions ?? {}
      const writes = Object.values(permissions).includes('write')
      if (!writes && !WRITES.test(JSON.stringify(job))) continue
      for (const step of job.steps ?? []) {
        expect(step.uses ?? '', `${name} ${id}`).not.toMatch(/^actions\/cache(\/|@)/)
        expect(Object.keys(step.with ?? {}), `${name} ${id}: ${step.name ?? step.uses ?? ''} restores a cache`).not.toContain('cache')
      }
    }
  }
})

test('the release workflow reads by default, and only the job that creates the release may write the repository', () => {
  const release = load('release.yml')
  expect(release.permissions).toEqual({ contents: 'read' })
  const writers = Object.entries(release.jobs)
    .filter(([, job]) => job.permissions?.contents === 'write')
    .map(([id]) => id)
  expect(writers).toEqual(['release'])
  expect(release.jobs.release?.permissions).toEqual({ contents: 'write' })
  // The images job pushes packages and nothing else.
  expect(release.jobs.images?.permissions).toEqual({ contents: 'read', packages: 'write' })
  // No checkout leaves a token in .git/config: nothing here pushes with git.
  let checkouts = 0
  for (const [id, job] of Object.entries(release.jobs))
    for (const step of job.steps ?? []) {
      if (!step.uses?.startsWith('actions/checkout@')) continue
      checkouts += 1
      expect(step.with?.['persist-credentials'], `release.yml ${id}`).toBe(false)
      expect(JSON.stringify(job.steps), `release.yml ${id} pushes with git`).not.toMatch(/git push/)
    }
  expect(checkouts).toBe(3)
})

test('a manual run of auto-tag starts the tagging job for main alone', () => {
  const condition = (load('auto-tag.yml').jobs.tag?.if ?? '').replace(/\s+/g, ' ').trim()
  expect(condition).toBe(
    "(github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main') || ( github.event_name == 'workflow_run' && github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch == 'main' && github.event.workflow_run.head_repository.full_name == github.repository )",
  )
})

test('auto-tag holds the version it read to CalVer before anything is written to the job\'s environment', () => {
  const step = load('auto-tag.yml').jobs.tag?.steps?.find((candidate) => candidate.name === 'Read the version package.json carries')
  const attempt = (version: unknown) => {
    const cwd = temporaryDirectory('qare-auto-tag-')
    const env = join(cwd, 'github-env')
    writeFileSync(env, '')
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'x', version }))
    const ran = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step?.run ?? 'exit 99'], {
      cwd,
      env: { PATH: process.env.PATH ?? '', GITHUB_ENV: env },
      encoding: 'utf8',
    })
    return { status: ran.status, stdout: ran.stdout, written: readFileSync(env, 'utf8') }
  }
  expect(attempt('2026.10.44')).toMatchObject({ status: 0, written: 'version=2026.10.44\n' })
  for (const version of ['1.2.3', '2026.10', '2026.10.44-rc1', '2026.10.44\ntagged=true', '2026.10.44\nGH_TOKEN=x', ' 2026.10.44', '', undefined, 20261044]) {
    const refused = attempt(version)
    expect(refused.status, JSON.stringify(version)).toBe(1)
    expect(refused.written, JSON.stringify(version)).toBe('')
    expect(refused.stdout, JSON.stringify(version)).toMatch(/^::error::.*not a CalVer version/m)
  }
})
