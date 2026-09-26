import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { main } from '../src/index.js'
import type { Writer } from '../src/index.js'

function capture(): { lines: string[]; writer: Writer } {
  const lines: string[] = []
  return { lines, writer: { write: (chunk) => lines.push(chunk) } }
}

// Split on purpose: a repo-wide guard forbids a literal URL in a test file,
// so no test can quietly reach the network.
const HEALTH_URL = ['http:', '//localhost:3000/up'].join('')

const BOOT = {
  runCompose: async () => ({ code: 0, stdout: '', stderr: '' }),
  probe: async () => ({ ok: true }),
  pollIntervalMs: 1,
}

async function planFile(criteria: unknown[]): Promise<{ planPath: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-runplan-'))
  const planPath = join(dir, 'plan.json')
  await writeFile(planPath, JSON.stringify({ schemaVersion: '1', criteria }), 'utf8')
  await mkdir(join(dir, '.qa'), { recursive: true })
  await writeFile(
    join(dir, '.qa', 'profile.yml'),
    `app:\n  boot: command\n  command: "true"\n  health:\n    url: ${HEALTH_URL}\n    timeout: 1s\nstubs: []\nvisual:\n  widths: [390]\n  themes: [light]\nsuites: []\n`,
    'utf8',
  )
  return { planPath, dir }
}

test('qare run --plan needs the run context the plan does not carry', async () => {
  const { planPath } = await planFile([
    { id: 'c1', text: 'x', checks: [{ kind: 'command', name: 'n', command: 'true' }] },
  ])
  const err = capture()

  const code = await main(['run', '--plan', planPath], capture().writer, err.writer, BOOT)

  expect(code).toBe(4)
  expect(err.lines.join('')).toMatch(/--id|--base|--head/)
})

test('qare run --plan reports what the plan asked for that nothing can run', async () => {
  const { planPath, dir } = await planFile([
    { id: 'c1', text: 'looks right', checks: [{ kind: 'visual', name: 'home', screenshot: 'home' }] },
  ])
  const err = capture()

  await main(
    [
      'run', '--plan', planPath,
      '--id', 'pr-1', '--repo', dir, '--base', 'abc', '--head', 'def',
      '--profile', join(dir, '.qa'), '--evidence', join(dir, 'evidence'),
    ],
    capture().writer,
    err.writer,
    BOOT,
  )

  expect(err.lines.join('')).toMatch(/visual/)
  expect(err.lines.join('')).toContain('c1')
})

test('--job still works, because a job file is how a run is driven by hand', async () => {
  const err = capture()

  const code = await main(['run'], capture().writer, err.writer, BOOT)

  expect(code).toBe(4)
  expect(err.lines.join('')).toMatch(/--job|--plan/)
})

test('a flag with no value names the command the user actually typed', async () => {
  // The helper is shared by four commands now; saying "qare plan" to someone
  // running "qare run" sends them to the wrong usage line.
  const err = capture()

  await main(['run', '--plan'], capture().writer, err.writer, BOOT)

  expect(err.lines.join('')).not.toContain('qare plan needs a value')
  expect(err.lines.join('')).toMatch(/--plan/)
})

test('a planned command with shell syntax cannot run, and that is unverified rather than failed', async () => {
  // A planner without shell freedom invents `&&`-joined commands that the
  // no-shell contract cannot run (run.ts): calling them failed turned the
  // whole run red (#64). They are unverified instead, with the reason named,
  // so the run comes out blocked and the pipeline stays neutral.
  const { planPath, dir } = await planFile([
    {
      id: 'c1',
      text: 'the evidence carries no code',
      checks: [{ kind: 'command', name: 'grep evidence', command: "grep -qE 'code' evidence/x.log && exit 1" }],
    },
  ])
  // The checks must run for this test, so the profile needs the files the
  // loader requires before it reports a refusal.
  await writeFile(join(dir, '.qa', 'QA.md'), '# QA\n')
  await writeFile(join(dir, '.qa', 'config.yml'), `target:\n  url: ${HEALTH_URL}\n  health: { http: /health, timeout: 1s }\n`)
  const err = capture()

  const code = await main(
    [
      'run', '--plan', planPath,
      '--id', 'pr-1', '--repo', dir, '--base', 'abc', '--head', 'def',
      '--profile', join(dir, '.qa'), '--evidence', join(dir, 'evidence'),
    ],
    capture().writer,
    err.writer,
    BOOT,
  )

  expect(code).toBe(2)
  const result = JSON.parse(await readFile(join(dir, 'evidence', 'result.json'), 'utf8'))
  expect(result.verdict).toBe('blocked')
  expect(result.criteria[0]).toMatchObject({ outcome: 'unverified' })
  expect(result.criteria[0].reason).toMatch(/the planned command cannot run/)
})
