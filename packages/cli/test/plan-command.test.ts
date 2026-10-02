import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  usage: { inputTokens: 1, outputTokens: 1 },
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

/**
 * A nare stand-in whose answer depends on the round: the first call answers
 * one plan, the second the correction. The round count rides on a marker
 * file, because each invocation is a fresh process.
 */
async function twoRoundNare(first: unknown, second: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-plan-'))
  const binary = join(dir, 'nare')
  const script = [
    '#!/usr/bin/env node',
    'import { existsSync, writeFileSync } from "node:fs"',
    `const marker = ${JSON.stringify(join(dir, 'round'))}`,
    `const first = ${JSON.stringify(JSON.stringify(first))}`,
    `const second = ${JSON.stringify(JSON.stringify(second))}`,
    'const text = existsSync(marker) ? second : first',
    'writeFileSync(marker, "2")',
    `console.log(JSON.stringify({ type: 'output', text, detail: {} }))`,
    `console.log(JSON.stringify({ type: 'result', status: 'done', questions: [], usage: { input: 1, output: 1 },`,
    `  stop_reason: 'end_turn', turns: 1, contract: 1, output: JSON.parse(text), error: null }))`,
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

/** A host MCP server over stdio: the real JSON-RPC handshake, on the wire. */
async function fakeMcpBinary(dir: string, published: { name: string; description?: string }[]): Promise<string> {
  const script = [
    `import { createInterface } from 'node:readline'`,
    `const published = ${JSON.stringify(published)}`,
    `createInterface({ input: process.stdin }).on('line', (line) => {`,
    `  let message`,
    `  try { message = JSON.parse(line) } catch { return }`,
    `  const id = typeof message.id === 'number' ? message.id : undefined`,
    `  if (id === undefined) return`,
    `  let answer`,
    `  if (message.method === 'initialize' || message.method === 'tools/list') answer = { tools: published }`,
    `  else if (message.method === 'tools/call')`,
    `    answer = { content: [{ type: 'text', text: message.params.name + ' saw ' + JSON.stringify(message.params.arguments ?? {}) }] }`,
    `  else answer = {}`,
    `  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: answer }) + '\\n')`,
    `})`,
  ].join('\n')
  // The profile's command names this script directly (node <script>), so it
  // needs no executable bit and no shim: the path is absolute because the
  // server starts in the harness's working directory.
  const scriptPath = join(dir, 'rig.mjs')
  await writeFile(scriptPath, script, 'utf8')
  return scriptPath
}

async function profileWithMcp(dir: string, configLines: string[]): Promise<string> {
  const healthUrl = ['http:', '//127.0.0.1:1/health'].join('')
  await mkdir(join(dir, '.qa', 'fixtures'), { recursive: true })
  await mkdir(join(dir, '.qa', 'stubs'), { recursive: true })
  await writeFile(join(dir, '.qa', 'QA.md'), '# QA\n', 'utf8')
  await writeFile(join(dir, '.qa', 'fixtures', 'seed.sql'), '', 'utf8')
  await writeFile(
    join(dir, '.qa', 'config.yml'),
    [
      'app:',
      '  boot: { compose: compose.yml, service: app }',
      `  health: { http: ${healthUrl}, timeout: 1s }`,
      '  seed: { command: "true" }',
      '  login: { fixture: seed.sql, role: admin }',
      'stubs: []',
      'visual:',
      '  widths: [390]',
      '  themes: [light]',
      'suites: []',
      ...configLines,
    ].join('\n'),
    'utf8',
  )
  return join(dir, '.qa')
}

test('a registered host MCP server reaches the planner as an environment, and its calls land beside the plan (#93)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-plan-mcp-'))
  const criteriaPath = join(dir, 'criteria.json')
  const diffPath = join(dir, 'change.diff')
  const outPath = join(dir, 'plan.json')
  await writeFile(criteriaPath, JSON.stringify(CRITERIA), 'utf8')
  await writeFile(diffPath, 'diff --git a/login.ts b/login.ts', 'utf8')
  const profilePath = await profileWithMcp(dir, [
    'mcp:',
    `  - name: rig`,
    `    command: node ${await fakeMcpBinary(dir, [{ name: 'power_on', description: 'turn the rig on' }])}`,
    '    tools: [power_on]',
    '    steps: [plan]',
  ])

  const seenPath = join(dir, 'seen.json')
  // The nare stand-in is a static fixture: it reads the MCP environment, calls
  // one tool through the channel, records what it saw, and answers with PLAN.
  const nareFixture = fileURLToPath(new URL('./fixtures/fake-nare-mcp.mjs', import.meta.url))
  const binary = join(dir, 'nare')
  await writeFile(binary, `#!/bin/sh\nexec node ${nareFixture} ${seenPath} '${JSON.stringify(PLAN)}' rig.power_on '{"volts":5}' "$@"\n`, 'utf8')
  const { chmod } = await import('node:fs/promises')
  await chmod(binary, 0o755)
  const out = capture()

  const code = await main(
    ['plan', '--criteria', criteriaPath, '--diff', diffPath, '--out', outPath, '--nare', binary, '--profile', profilePath],
    out.writer,
    capture().writer,
  )

  expect(code).toBe(0)
  const seen = JSON.parse(await readFile(seenPath, 'utf8')) as { tools?: string; endpoint?: string; exploration?: string; tool: string }
  expect(seen.tools).toBe('rig.power_on')
  expect(seen.endpoint).toMatch(/^http:/)
  // Only the MCP channel is on: this is not the exploration channel (#87).
  expect(seen.exploration).toBeUndefined()
  expect(seen.tool).toBe('power_on saw {"volts":5}')
  const callsPath = join(dir, 'mcp-calls.jsonl')
  const records = (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({ server: 'rig', tool: 'power_on', arguments: { volts: 5 }, result: 'power_on saw {"volts":5}' })
  expect(out.lines.join('')).toContain(`recorded 1 host tool calls; ${callsPath}`)
})

test('a registered server that cannot be started is reported, and the plan is still written (#93)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-plan-mcp-'))
  const criteriaPath = join(dir, 'criteria.json')
  const diffPath = join(dir, 'change.diff')
  const outPath = join(dir, 'plan.json')
  await writeFile(criteriaPath, JSON.stringify(CRITERIA), 'utf8')
  await writeFile(diffPath, 'diff --git a/login.ts b/login.ts', 'utf8')
  const profilePath = await profileWithMcp(dir, [
    'mcp:',
    '  - name: ghost',
    '    command: qare-no-such-mcp-binary-here',
    '    tools: [power_on]',
    '    steps: [plan]',
  ])
  const out = capture()

  const code = await main(
    ['plan', '--criteria', criteriaPath, '--diff', diffPath, '--out', outPath, '--nare', await fakeNare(PLAN), '--profile', profilePath],
    out.writer,
    capture().writer,
  )

  expect(code).toBe(0)
  expect(out.lines.join('')).toContain("host mcp server 'ghost' is unreachable")
  expect(JSON.parse(await readFile(outPath, 'utf8'))).toEqual(PLAN)
  // Even the failure is evidence: the declared-but-unreachable server leaves a
  // record, so the run shows what the host tried and why nothing answered.
  const records = (await readFile(join(dir, 'mcp-calls.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(records).toEqual([{ server: 'ghost', error: expect.stringContaining('unreachable') }])
})

test('the mcp call records are redacted like the evidence they are (#93)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qare-plan-mcp-'))
  const criteriaPath = join(dir, 'criteria.json')
  const diffPath = join(dir, 'change.diff')
  const outPath = join(dir, 'plan.json')
  await writeFile(criteriaPath, JSON.stringify(CRITERIA), 'utf8')
  await writeFile(diffPath, 'diff --git a/login.ts b/login.ts', 'utf8')
  const profilePath = await profileWithMcp(dir, [
    'redact:',
    '  values: [hunter2]',
    'mcp:',
    `  - name: rig`,
    `    command: node ${await fakeMcpBinary(dir, [{ name: 'power_on' }])}`,
    '    tools: [power_on]',
    '    steps: [plan]',
  ])
  const seenPath = join(dir, 'seen.json')
  // The nare stand-in calls the tool with a secret in the arguments, the way
  // a model session's look could: what the model saw, and what the published
  // record keeps, are two different things.
  const nareFixture = fileURLToPath(new URL('./fixtures/fake-nare-mcp.mjs', import.meta.url))
  const binary = join(dir, 'nare')
  await writeFile(
    binary,
    [
      '#!/bin/sh',
      `exec node ${nareFixture} ${seenPath} '${JSON.stringify(PLAN)}' rig.power_on '{"password":"hunter2","note":"the hunter2 vault"}' "$@"`,
    ].join('\n'),
    'utf8',
  )
  const { chmod } = await import('node:fs/promises')
  await chmod(binary, 0o755)
  const out = capture()

  const code = await main(
    ['plan', '--criteria', criteriaPath, '--diff', diffPath, '--out', outPath, '--nare', binary, '--profile', profilePath],
    out.writer,
    capture().writer,
  )

  expect(code).toBe(0)
  const seen = JSON.parse(await readFile(seenPath, 'utf8')) as { tool: string }
  // The model session read the tool's real answer; redaction is for what is
  // published, not for the session.
  expect(seen.tool).toBe('power_on saw {"password":"hunter2","note":"the hunter2 vault"}')
  const records = (await readFile(join(dir, 'mcp-calls.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(records[0]).toMatchObject({
    server: 'rig',
    tool: 'power_on',
    arguments: { password: '[redacted]', note: 'the [redacted] vault' },
  })
  // The result is free text, so the rules compose over it; what matters is
  // that no secret survives into the published record.
  const result = String((records[0] as { result?: string }).result)
  expect(result).not.toContain('hunter2')
  expect(result).toContain('[redacted]')
})

test('qare plan hands its working directory to the plan step, so an invented script path is corrected (#201, #200 review round 2)', async () => {
  const { criteriaPath, diffPath, outPath } = await inputs()
  const root = await mkdtemp(join(tmpdir(), 'qare-plan-root-'))
  await writeFile(join(root, 'check.js'), 'process.exit(0)\n')
  const profileDir = join(root, '.qa')
  await mkdir(profileDir, { recursive: true })
  await writeFile(
    join(profileDir, 'config.yml'),
    'commands:\n  script:\n    run: node {{path}}\n    about: runs a check script the checkout carries\n',
    'utf8',
  )
  const invented = {
    schemaVersion: '1',
    criteria: [
      { id: 'c1', text: CRITERIA[0].text, checks: [{ kind: 'command', name: 'x', command: 'node check-invented.js' }] },
      { id: 'c2', text: CRITERIA[1].text, unplannable: 'no visual baseline yet' },
    ],
  }
  const corrected = {
    schemaVersion: '1',
    criteria: [
      { id: 'c1', text: CRITERIA[0].text, checks: [{ kind: 'command', name: 'x', command: 'node check.js' }] },
      { id: 'c2', text: CRITERIA[1].text, unplannable: 'no visual baseline yet' },
    ],
  }
  const binary = await twoRoundNare(invented, corrected)
  const out = capture()
  const previousCwd = process.cwd()
  try {
    process.chdir(root)
    await main(
      ['plan', '--criteria', criteriaPath, '--diff', diffPath, '--out', outPath, '--profile', profileDir, '--nare', binary],
      out.writer,
    )
  } finally {
    process.chdir(previousCwd)
  }

  const plan = JSON.parse(await readFile(outPath, 'utf8'))
  expect(JSON.stringify(plan)).toContain('check.js')
  expect(JSON.stringify(plan)).not.toContain('check-invented.js')
})
