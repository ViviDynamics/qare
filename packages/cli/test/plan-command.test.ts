import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { expect, test } from 'vitest'
import { criterionIdFor } from '@qare/core'
import { main } from '../src/index.js'
import type { Writer } from '../src/index.js'

function capture(): { lines: string[]; writer: Writer } {
  const lines: string[] = []
  return { lines, writer: { write: (chunk) => lines.push(chunk) } }
}

const CRITERIA = [
  { id: 'c1', text: 'the login form rejects an empty password' },
  { id: 'c2', text: 'the dashboard renders on a phone' },
]

const PLAN = {
  schemaVersion: '1',
  criteria: [
    { id: 'c1', text: CRITERIA[0].text, checks: [{ kind: 'command', name: 'login', command: 'npm test -- login' }] },
    { id: 'c2', text: CRITERIA[1].text, unplannable: 'no visual baseline yet' },
  ],
}

/**
 * A nare stand-in on disk: the CLI spawns whatever --nare names, so the command
 * is exercised through its real path rather than through an injected object.
 */
async function fakeNare(answer: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-plan-'))
  const binary = join(dir, 'nare')
  const script = [
    '#!/usr/bin/env node',
    `const answer = ${JSON.stringify(JSON.stringify(answer))}`,
    `console.log(JSON.stringify({ type: 'output', text: answer, detail: {} }))`,
    `console.log(JSON.stringify({ type: 'result', status: 'done', questions: [], usage: { input: 1, output: 1 },`,
    `  stop_reason: 'end_turn', turns: 1, contract: 1, output: JSON.parse(answer), error: null }))`,
  ].join('\n')
  await writeFile(`${binary}.mjs`, script, 'utf8')
  await writeFile(binary, `#!/bin/sh\nexec node ${binary}.mjs "$@"\n`, 'utf8')
  const { chmod } = await import('node:fs/promises')
  await chmod(binary, 0o755)
  return binary
}

async function inputs(): Promise<{ criteriaPath: string; diffPath: string; outPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-plan-in-'))
  const criteriaPath = join(dir, 'criteria.json')
  const diffPath = join(dir, 'change.diff')
  await writeFile(criteriaPath, JSON.stringify(CRITERIA), 'utf8')
  await writeFile(diffPath, 'diff --git a/login.ts b/login.ts', 'utf8')
  return { criteriaPath, diffPath, outPath: join(dir, 'plan.json') }
}

test('qare plan writes a plan.json the plan loader accepts', async () => {
  const { criteriaPath, diffPath, outPath } = await inputs()
  const out = capture()

  const code = await main(
    ['plan', '--criteria', criteriaPath, '--diff', diffPath, '--out', outPath, '--nare', await fakeNare(PLAN)],
    out.writer,
    capture().writer,
  )

  expect(code).toBe(0)
  expect(existsSync(outPath)).toBe(true)
  expect(JSON.parse(await readFile(outPath, 'utf8'))).toEqual(PLAN)
  expect(out.lines.join('')).toContain('2 criteria')
})

test('qare plan reports the unplannable criteria it wrote', async () => {
  const { criteriaPath, diffPath, outPath } = await inputs()
  const out = capture()

  await main(
    ['plan', '--criteria', criteriaPath, '--diff', diffPath, '--out', outPath, '--nare', await fakeNare(PLAN)],
    out.writer,
    capture().writer,
  )

  expect(out.lines.join('')).toContain('1 unplannable')
})

test('a plan the loader rejects after its correction round marks every criterion unplannable, not red (#159)', async () => {
  const { criteriaPath, diffPath, outPath } = await inputs()
  const out = capture()

  const code = await main(
    [
      'plan',
      '--criteria',
      criteriaPath,
      '--diff',
      diffPath,
      '--out',
      outPath,
      '--nare',
      await fakeNare({ schemaVersion: '1', criteria: [PLAN.criteria[0]] }),
    ],
    out.writer,
    capture().writer,
  )

  expect(code).toBe(0)
  const plan = JSON.parse(await readFile(outPath, 'utf8'))
  expect(plan.criteria).toEqual([
    { id: 'c1', text: CRITERIA[0].text, unplannable: expect.stringContaining('it left out c2') },
    { id: 'c2', text: CRITERIA[1].text, unplannable: expect.stringContaining('it left out c2') },
  ])
  expect(out.lines.join('')).toContain('could not produce a usable plan')
})

test('a command check the no-shell loader rejects twice comes out neutral, not red (#159)', async () => {
  const { criteriaPath, diffPath, outPath } = await inputs()
  const answer = {
    schemaVersion: '1',
    criteria: [
      {
        id: 'c1',
        text: CRITERIA[0].text,
        checks: [{ kind: 'command', name: 'login', command: 'npm test -- "an argument with spaces"' }],
      },
      { id: 'c2', text: CRITERIA[1].text, unplannable: 'no phone layout yet' },
    ],
  }
  const out = capture()

  const code = await main(
    ['plan', '--criteria', criteriaPath, '--diff', diffPath, '--out', outPath, '--nare', await fakeNare(answer)],
    out.writer,
    capture().writer,
  )

  expect(code).toBe(0)
  const plan = JSON.parse(await readFile(outPath, 'utf8'))
  expect(plan.criteria[0].unplannable).toContain('quoting is not interpreted')
  expect(plan.criteria[0].unplannable).toContain('planning failed')
  expect(plan.criteria[1].unplannable).toContain('planning failed')
})

test('a schema-invalid plan the loader rejects twice comes out neutral, not red (#159)', async () => {
  const { criteriaPath, diffPath, outPath } = await inputs()
  const answer = {
    schemaVersion: '1',
    criteria: [
      {
        id: 'c1',
        text: CRITERIA[0].text,
        checks: [{ kind: 'command', name: 'login', command: 'npm test' }],
        unplannable: 'both carried',
      },
    ],
  }
  const out = capture()

  const code = await main(
    ['plan', '--criteria', criteriaPath, '--diff', diffPath, '--out', outPath, '--nare', await fakeNare(answer)],
    out.writer,
    capture().writer,
  )

  expect(code).toBe(0)
  const plan = JSON.parse(await readFile(outPath, 'utf8'))
  expect(plan.criteria[0].unplannable).toContain('planned or unplannable, not both')
  expect(plan.criteria[1].unplannable).toContain('planned or unplannable, not both')
  expect(out.lines.join('')).toContain('could not produce a usable plan')
})

test('qare plan needs criteria and a diff', async () => {
  const err = capture()

  const code = await main(['plan'], capture().writer, err.writer)

  expect(code).toBe(4)
  expect(err.lines.join('')).toMatch(/--criteria/)
})

test('qare plan reads criteria straight from an issue body', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-plan-issue-'))
  const issuePath = join(dir, 'issue.md')
  const diffPath = join(dir, 'change.diff')
  const outPath = join(dir, 'plan.json')
  await writeFile(issuePath, '## Acceptance criteria\n\n- [ ] the login form rejects an empty password\n', 'utf8')
  await writeFile(diffPath, 'diff --git a/login.ts b/login.ts', 'utf8')
  // The id is derived from the wording, so the fixture derives it the same way
  // rather than hard-coding a guess that would drift.
  const text = 'the login form rejects an empty password'
  const answer = {
    schemaVersion: '1',
    criteria: [{ id: criterionIdFor(text), text, checks: [{ kind: 'command', name: 'login', command: 'npm test' }] }],
  }
  const out = capture()

  const code = await main(
    ['plan', '--issue', issuePath, '--diff', diffPath, '--out', outPath, '--nare', await fakeNare(answer)],
    out.writer,
    capture().writer,
  )

  expect(code).toBe(0)
  expect(out.lines.join('')).toContain('1 criteria')
})

test('qare plan refuses an issue that states no criteria', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-plan-nocrit-'))
  const issuePath = join(dir, 'issue.md')
  const diffPath = join(dir, 'change.diff')
  await writeFile(issuePath, '## Problem\n\nnothing stated\n', 'utf8')
  await writeFile(diffPath, 'diff', 'utf8')
  const err = capture()

  const code = await main(
    ['plan', '--issue', issuePath, '--diff', diffPath, '--out', join(dir, 'plan.json')],
    capture().writer,
    err.writer,
  )

  expect(code).toBe(4)
  expect(err.lines.join('')).toMatch(/acceptance criteria|done when/i)
})

test('--flow-actions takes kind names, not free-form text', async () => {
  const { criteriaPath, diffPath } = await inputs()
  const err = capture()

  const code = await main(
    ['plan', '--criteria', criteriaPath, '--diff', diffPath, '--flow-actions', 'totp login'],
    capture().writer,
    err.writer,
  )

  expect(code).toBe(4)
  expect(err.lines.join('')).toContain('--flow-actions takes comma-separated kind names')
})

test('planning hands the planner the change\'s own flow action kinds, and the plan the loader accepts', async () => {
  const { criteriaPath, diffPath, outPath } = await inputs()
  const answer = {
    schemaVersion: '1',
    criteria: [
      {
        id: 'c1',
        text: CRITERIA[0].text,
        checks: [{ kind: 'flow', name: 'magic login', actions: [{ action: 'magicLink', element: { testId: 'sign-in' } }] }],
      },
      { id: 'c2', text: CRITERIA[1].text, unplannable: 'no phone layout yet' },
    ],
  }
  const out = capture()

  const code = await main(
    ['plan', '--criteria', criteriaPath, '--diff', diffPath, '--out', outPath, '--nare', await fakeNare(answer), '--flow-actions', 'magicLink'],
    out.writer,
    capture().writer,
  )

  expect(code).toBe(0)
  const plan = JSON.parse(await readFile(outPath, 'utf8'))
  expect(plan.criteria[0]).toMatchObject({ checks: [{ actions: [{ action: 'magicLink' }] }] })
  expect(out.lines.join('')).toContain('magicLink')
})

test('the planner never sees the seeded values the diff carries (#64)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-plan-in-'))
  const secret = 'totp-seed-secret-9876'
  const criteriaPath = join(dir, 'criteria.json')
  const diffPath = join(dir, 'change.diff')
  await writeFile(criteriaPath, JSON.stringify(CRITERIA), 'utf8')
  // The diff is the very change that seeds the profile: the planner gets the
  // profile path, so the seeded values sweep from the model-facing text (#64).
  await writeFile(diffPath, `diff --git a/.qa/config.yml b/.qa/config.yml\n+      secret: ${secret}\n`, 'utf8')
  const { mkdir } = await import('node:fs/promises')
  const { chmod } = await import('node:fs/promises')
  const healthUrl = ['http:', '//127.0.0.1:1/health'].join('')
  await mkdir(join(dir, '.qa', 'fixtures'), { recursive: true })
  await mkdir(join(dir, '.qa', 'stubs'), { recursive: true })
  await writeFile(join(dir, '.qa', 'QA.md'), '# QA\n', 'utf8')
  await writeFile(join(dir, '.qa', 'fixtures', 'seed.sql'), '', 'utf8')
  await writeFile(
    join(dir, '.qa', 'config.yml'),
    `app:\n  boot: { compose: compose.yml, service: app }\n  health: { http: ${healthUrl}, timeout: 1s }\n  seed: { command: "true" }\n  login:\n    fixture: seed.sql\n    role: admin\n    totp:\n      secret: ${secret}\nstubs: []\nvisual:\n  widths: [390]\n  themes: [light]\nsuites: []\n`,
    'utf8',
  )
  const argvPath = join(dir, 'argv.json')
  const binary = join(dir, 'nare')
  const script = [
    '#!/usr/bin/env node',
    `import { writeFileSync } from 'node:fs'`,
    `writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)))`,
    `const answer = ${JSON.stringify(JSON.stringify(PLAN))}`,
    `console.log(JSON.stringify({ type: 'output', text: answer, detail: {} }))`,
    `console.log(JSON.stringify({ type: 'result', status: 'done', questions: [], usage: { input: 1, output: 1 },`,
    `  stop_reason: 'end_turn', turns: 1, contract: 1, output: JSON.parse(answer), error: null }))`,
  ].join('\n')
  await writeFile(`${binary}.mjs`, script, 'utf8')
  await writeFile(binary, `#!/bin/sh\nexec node ${binary}.mjs "$@"\n`, 'utf8')
  await chmod(binary, 0o755)
  const out = capture()

  const code = await main(
    [
      'plan',
      '--criteria',
      criteriaPath,
      '--diff',
      diffPath,
      '--out',
      join(dir, 'plan.json'),
      '--nare',
      binary,
      '--profile',
      join(dir, '.qa'),
    ],
    out.writer,
    capture().writer,
  )

  expect(code).toBe(0)
  expect(out.lines.join('')).toContain("the profile's seeded values are redacted from the diff before planning")
  const argv = JSON.parse(await readFile(argvPath, 'utf8')) as string[]
  expect(argv[1]).not.toContain(secret)
  expect(argv[1]).toContain('[redacted]')
})

test('qare plan declares the run contract paths to the planner (#162)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-plan-decl-'))
  const criteriaPath = join(dir, 'criteria.json')
  const diffPath = join(dir, 'change.diff')
  const outPath = join(dir, 'plan.json')
  await writeFile(criteriaPath, JSON.stringify(CRITERIA), 'utf8')
  await writeFile(diffPath, 'diff --git a/login.ts b/login.ts\n+++ b/login.ts\n+export {}', 'utf8')
  await mkdir(join(dir, '.qa'), { recursive: true })
  await writeFile(join(dir, '.qa', 'QA.md'), '# QA\n', 'utf8')
  const argvPath = join(dir, 'argv.json')
  const binary = join(dir, 'nare')
  const script = [
    '#!/usr/bin/env node',
    `import { writeFileSync } from 'node:fs'`,
    `writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)))`,
    `const answer = ${JSON.stringify(JSON.stringify(PLAN))}`,
    `console.log(JSON.stringify({ type: 'output', text: answer, detail: {} }))`,
    `console.log(JSON.stringify({ type: 'result', status: 'done', questions: [], usage: { input: 1, output: 1 },`,
    `  stop_reason: 'end_turn', turns: 1, contract: 1, output: JSON.parse(answer), error: null }))`,
  ].join('\n')
  await writeFile(`${binary}.mjs`, script, 'utf8')
  await writeFile(binary, `#!/bin/sh\nexec node ${binary}.mjs "$@"\n`, 'utf8')
  const { chmod } = await import('node:fs/promises')
  await chmod(binary, 0o755)
  const out = capture()

  const code = await main(
    [
      'plan',
      '--criteria',
      criteriaPath,
      '--diff',
      diffPath,
      '--out',
      outPath,
      '--nare',
      binary,
      '--profile',
      join(dir, '.qa'),
    ],
    out.writer,
    capture().writer,
  )

  expect(code).toBe(0)
  const argv = JSON.parse(await readFile(argvPath, 'utf8')) as string[]
  expect(argv[1]).toContain('declared run inputs')
  expect(argv[1]).toContain('plan.json')
  expect(argv[1]).toContain(relative(process.cwd(), resolve(join(dir, '.qa'))))
  expect(argv[1]).toContain('login.ts')
  expect(argv[1]).toContain('result.json, judged-result.json')
})

test('renamed, mode-only and binary diff paths are declared; deletions are not (#162)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-plan-decl-'))
  const criteriaPath = join(dir, 'criteria.json')
  const diffPath = join(dir, 'change.diff')
  const outPath = join(dir, 'plan.json')
  await writeFile(criteriaPath, JSON.stringify(CRITERIA), 'utf8')
  await writeFile(
    diffPath,
    [
      'diff --git a/old.ts b/new.ts',
      'similarity index 90%',
      'rename from old.ts',
      'rename to new.ts',
      'diff --git a/mode.txt b/mode.txt',
      'old mode 100644',
      'new mode 100755',
      'diff --git a/logo.png b/logo.png',
      'index 123..456 100644',
      'Binary files a/logo.png and b/logo.png differ',
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
    ].join('\n'),
    'utf8',
  )
  await mkdir(join(dir, '.qa'), { recursive: true })
  await writeFile(join(dir, '.qa', 'QA.md'), '# QA\n', 'utf8')
  const argvPath = join(dir, 'argv.json')
  const binary = join(dir, 'nare')
  const script = [
    '#!/usr/bin/env node',
    `import { writeFileSync } from 'node:fs'`,
    `writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)))`,
    `const answer = ${JSON.stringify(JSON.stringify(PLAN))}`,
    `console.log(JSON.stringify({ type: 'output', text: answer, detail: {} }))`,
    `console.log(JSON.stringify({ type: 'result', status: 'done', questions: [], usage: { input: 1, output: 1 },`,
    `  stop_reason: 'end_turn', turns: 1, contract: 1, output: JSON.parse(answer), error: null }))`,
  ].join('\n')
  await writeFile(`${binary}.mjs`, script, 'utf8')
  await writeFile(binary, `#!/bin/sh\nexec node ${binary}.mjs "$@"\n`, 'utf8')
  const { chmod } = await import('node:fs/promises')
  await chmod(binary, 0o755)
  const out = capture()

  const code = await main(
    [
      'plan',
      '--criteria',
      criteriaPath,
      '--diff',
      diffPath,
      '--out',
      outPath,
      '--nare',
      binary,
      '--profile',
      join(dir, '.qa'),
    ],
    out.writer,
    capture().writer,
  )

  expect(code).toBe(0)
  const argv = JSON.parse(await readFile(argvPath, 'utf8')) as string[]
  expect(argv[1]).toContain('- new.ts\n')
  expect(argv[1]).toContain('- mode.txt\n')
  expect(argv[1]).toContain('- logo.png\n')
  expect(argv[1]).not.toContain('- gone.ts')
})

test('a command check that reads a run output is corrected, then neutral, not red (#162)', async () => {
  const { criteriaPath, diffPath, outPath } = await inputs()
  const answer = {
    schemaVersion: '1',
    criteria: [
      {
        id: 'c1',
        text: CRITERIA[0].text,
        checks: [{ kind: 'command', name: 'profiles', command: 'grep profiles result.json' }],
      },
      { id: 'c2', text: CRITERIA[1].text, unplannable: 'no phone layout yet' },
    ],
  }
  const out = capture()

  const code = await main(
    ['plan', '--criteria', criteriaPath, '--diff', diffPath, '--out', outPath, '--nare', await fakeNare(answer)],
    out.writer,
    capture().writer,
  )

  expect(code).toBe(0)
  const plan = JSON.parse(await readFile(outPath, 'utf8'))
  expect(plan.criteria[0].unplannable).toContain('result.json is an output the run writes when it ends')
  expect(plan.criteria[0].unplannable).toContain('planning failed')
  expect(plan.criteria[1].unplannable).toContain('planning failed')
})

test('a plan whose command checks read only the declared run inputs is written as planned (#162)', async () => {
  const { criteriaPath, diffPath, outPath } = await inputs()
  await writeFile(
    diffPath,
    'diff --git a/login.ts b/login.ts\n+++ b/login.ts\n+export the login form',
    'utf8',
  )
  const answer = {
    schemaVersion: '1',
    criteria: [
      {
        id: 'c1',
        text: CRITERIA[0].text,
        checks: [{ kind: 'command', name: 'login', command: 'grep login login.ts' }],
      },
      { id: 'c2', text: CRITERIA[1].text, unplannable: 'no phone layout yet' },
    ],
  }
  const out = capture()

  const code = await main(
    ['plan', '--criteria', criteriaPath, '--diff', diffPath, '--out', outPath, '--nare', await fakeNare(answer)],
    out.writer,
    capture().writer,
  )

  expect(code).toBe(0)
  const plan = JSON.parse(await readFile(outPath, 'utf8'))
  expect(plan.criteria[0]).toMatchObject({ checks: [{ command: 'grep login login.ts' }] })
  expect(out.lines.join('')).toContain('1 unplannable')
})
