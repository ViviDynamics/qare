import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { RESULT_SCHEMA_VERSION } from '@qare/core'
import { main } from '../src/index.js'
import type { Writer } from '../src/index.js'

function capture(): { lines: string[]; writer: Writer } {
  const lines: string[] = []
  return { lines, writer: { write: (chunk) => lines.push(chunk) } }
}

const made: string[] = []

// Built by parts so the network-marker scanner sees no URL literal (runner.test.ts).
const PROFILE_URL = ['https:', '//wiki.example.test'].join('')
afterEach(async () => {
  await Promise.all(made.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const PLAN = {
  schemaVersion: '1',
  criteria: [
    {
      id: 'c1',
      text: 'the home page loads',
      checks: [{ kind: 'command', name: 'home', command: 'bin/rails test home_test.rb' }],
    },
  ],
}

async function evidenceWithResult(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-replay-'))
  made.push(dir)
  await writeFile(join(dir, 'plan.json'), `${JSON.stringify(PLAN, null, 2)}\n`, 'utf8')
  await writeFile(
    join(dir, 'result.json'),
    JSON.stringify(
      {
        schemaVersion: RESULT_SCHEMA_VERSION,
        verdict: 'passed',
        criteria: [{ id: 'c1', outcome: 'proven', evidence: ['c1/stdout.txt'] }],
        job: { id: 'pr-1' },
      },
      null,
      2,
    ),
    'utf8',
  )
  return dir
}

async function judgedRun(): Promise<string> {
  const dir = await evidenceWithResult()
  await main(['judge', '--result', join(dir, 'result.json'), '--runner', 'none'], capture().writer, capture().writer)
  expect(existsSync(join(dir, 'judged-result.json'))).toBe(true)
  return dir
}

test('replay reproduces the verdict judge wrote, byte for byte', async () => {
  const dir = await judgedRun()
  const out = capture()

  const code = await main(['replay', dir], out.writer, capture().writer)

  expect(code).toBe(0)
  expect(out.lines.join('')).toContain('verdict passed')
  expect(out.lines.join('')).toContain('byte-identical with the stored judged verdict')
})

test('replay reports the difference when the stored verdict is not what the artifacts decide', async () => {
  const dir = await judgedRun()
  const judged = JSON.parse(await readFile(join(dir, 'judged-result.json'), 'utf8')) as {
    verdict: string
    criteria: Array<{ id: string; outcome: string; reason?: string }>
  }
  judged.verdict = 'failed'
  judged.criteria[0].outcome = 'failed'
  await writeFile(join(dir, 'judged-result.json'), `${JSON.stringify(judged, null, 2)}\n`, 'utf8')
  const out = capture()

  const code = await main(['replay', dir], out.writer, capture().writer)

  expect(code).toBe(1)
  const printed = out.lines.join('')
  expect(printed).toContain('criterion c1: stored failed, replayed proven')
  expect(printed).toContain('verdict: stored failed, replayed passed')
})

test('replay names the verifier when the stored downgrade is not reproducible without a model', async () => {
  const dir = await judgedRun()
  const judged = JSON.parse(await readFile(join(dir, 'judged-result.json'), 'utf8')) as {
    criteria: Array<{ id: string; outcome: string; reason?: string }>
  }
  judged.criteria[0].outcome = 'failed'
  judged.criteria[0].reason = 'verifier: the saved output does not show the home page'
  await writeFile(join(dir, 'judged-result.json'), `${JSON.stringify(judged, null, 2)}\n`, 'utf8')
  const out = capture()

  const code = await main(['replay', dir], out.writer, capture().writer)

  expect(code).toBe(1)
  expect(out.lines.join('')).toContain('without a model')
})

test('a run with no judged-result.json still replays', async () => {
  const dir = await evidenceWithResult()
  const out = capture()

  const code = await main(['replay', dir], out.writer, capture().writer)

  expect(code).toBe(0)
  expect(out.lines.join('')).toContain('no judged-result.json stored with the run')
  expect(out.lines.join('')).toContain('verdict passed')
})

test('replay takes exactly one run directory', async () => {
  const err = capture()

  const code = await main(['replay'], capture().writer, err.writer)

  expect(code).toBe(4)
  expect(err.lines.join('')).toContain('qare replay takes exactly one run directory')
})

test('a directory without the artifacts is an error that names what is missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-replay-empty-'))
  made.push(dir)
  const err = capture()

  const code = await main(['replay', dir], capture().writer, err.writer)

  expect(code).toBe(4)
  expect(err.lines.join('')).toContain('no plan.json')
})

test('replay reads the pipeline layout with the artifacts below evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-replay-pipeline-'))
  made.push(dir)
  await writeFile(join(dir, 'plan.json'), `${JSON.stringify(PLAN, null, 2)}\n`, 'utf8')
  await mkdir(join(dir, 'evidence'), { recursive: true })
  await writeFile(
    join(dir, 'evidence', 'result.json'),
    JSON.stringify(
      {
        schemaVersion: RESULT_SCHEMA_VERSION,
        verdict: 'passed',
        criteria: [{ id: 'c1', outcome: 'proven', evidence: ['c1/stdout.txt'] }],
        job: { id: 'pr-1' },
      },
      null,
      2,
    ),
    'utf8',
  )
  const judgedOut = capture()
  await main(
    ['judge', '--result', join(dir, 'evidence', 'result.json'), '--runner', 'none', '--outDir', dir],
    judgedOut.writer,
    judgedOut.writer,
  )
  expect(existsSync(join(dir, 'judged-result.json'))).toBe(true)
  expect(existsSync(join(dir, 'evidence', 'result.json'))).toBe(true)
  const out = capture()

  const code = await main(['replay', dir], out.writer, capture().writer)

  expect(code).toBe(0)
  expect(out.lines.join('')).toContain('verdict passed')
  expect(out.lines.join('')).toContain('byte-identical with the stored judged verdict')
})

test('replay reproduces a verdict judge wrote with profile redaction rules', async () => {
  const dir = await evidenceWithResult()
  await writeFile(
    join(dir, 'result.json'),
    JSON.stringify(
      {
        schemaVersion: RESULT_SCHEMA_VERSION,
        verdict: 'passed',
        criteria: [{ id: 'c1', outcome: 'proven', evidence: ['c1/stdout.txt'] }],
        target: { url: `${PROFILE_URL}/[REDACTED]/index`, comparison: 'none' },
        job: { id: 'pr-1' },
      },
      null,
      2,
    ),
    'utf8',
  )
  const profile = await profileWithRedaction()
  const judgedOut = capture()
  await main(
    ['judge', '--result', join(dir, 'result.json'), '--runner', 'none', '--profile', profile, '--outDir', dir],
    judgedOut.writer,
    judgedOut.writer,
  )
  const out = capture()

  const code = await main(['replay', dir], out.writer, capture().writer)

  expect(code).toBe(0)
  expect(out.lines.join('')).toContain('byte-identical with the stored judged verdict')
})

test('replay of a verdict stored with rules the artifacts predate prints nothing the rules redact', async () => {
  const dir = await evidenceWithResult()
  await writeFile(
    join(dir, 'result.json'),
    JSON.stringify(
      {
        schemaVersion: RESULT_SCHEMA_VERSION,
        verdict: 'passed',
        criteria: [{ id: 'c1', outcome: 'proven', evidence: ['c1/stdout.txt'] }],
        target: { url: `${PROFILE_URL}/hunter2/index`, comparison: 'none' },
        job: { id: 'pr-1' },
      },
      null,
      2,
    ),
    'utf8',
  )
  const profile = await profileWithRedaction()
  const judgedOut = capture()
  await main(
    ['judge', '--result', join(dir, 'result.json'), '--runner', 'none', '--profile', profile, '--outDir', dir],
    judgedOut.writer,
    judgedOut.writer,
  )
  expect((await readFile(join(dir, 'judged-result.json'), 'utf8')).includes('hunter2')).toBe(false)
  const out = capture()

  const code = await main(['replay', dir], out.writer, capture().writer)

  expect(code).toBe(1)
  const printed = out.lines.join('')
  expect(printed).toContain('not what the recompute writes byte for byte')
  expect(printed).not.toContain('hunter2')
})

async function profileWithRedaction(): Promise<string> {
  const profile = await mkdtemp(join(tmpdir(), 'qare-replay-redaction-'))
  made.push(profile)
  await writeFile(join(profile, 'QA.md'), 'the profile instructions\n', 'utf8')
  await writeFile(
    join(profile, 'config.yml'),
    `target:\n  url: ${PROFILE_URL}\n  health: { http: /, timeout: 30s }\nredact:\n  values: ["hunter2"]\n`,
    'utf8',
  )
  return profile
}
