import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { RESULT_SCHEMA_VERSION, advisoryFindingId } from '@qare/core'
import { main } from '../src/index.js'
import type { Writer } from '../src/index.js'

// #150: `qare judge` reviews the screens after it has judged. Every model
// call here is a stand-in for nare: a script that speaks nare's contract and
// answers from rules, never a model. What these tests hold is the plumbing
// around the model (what it is handed, where it may read, what its answer can
// and cannot do), which is the part that is code.

function capture(): { lines: string[]; writer: Writer } {
  const lines: string[] = []
  return { lines, writer: { write: (chunk) => lines.push(chunk) } }
}

// These tests count the model calls of one judge step: the verifier's one
// turn and the reviewer's. They pin the verifier to one turn; asking in
// batches (#275) is the default, and has its own tests.
let verifyBatchBefore: string | undefined
beforeEach(() => {
  verifyBatchBefore = process.env.QARE_VERIFY_BATCH_SIZE
  process.env.QARE_VERIFY_BATCH_SIZE = '50'
})
afterEach(() => {
  if (verifyBatchBefore === undefined) delete process.env.QARE_VERIFY_BATCH_SIZE
  else process.env.QARE_VERIFY_BATCH_SIZE = verifyBatchBefore
})

const made: string[] = []
afterEach(async () => {
  await Promise.all(made.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const SCREEN = 'checks/signup-form/0'

/** The page as the flow's assertion snapshot records it (#82): a form whose required field has no name, showing a bare error. */
const SNAPSHOT = {
  schemaVersion: 1,
  assertedText: 'Error',
  snapshot: {
    role: 'main',
    states: {},
    path: 'main',
    children: [
      { role: 'heading', name: 'Create your account', states: { level: 1 }, path: 'main/heading "Create your account"', children: [] },
      {
        role: 'form',
        states: {},
        path: 'main/form',
        children: [
          { role: 'textbox', states: { required: true }, path: 'main/form/textbox', children: [] },
          { role: 'textbox', name: 'Password', states: { required: true }, path: 'main/form/textbox "Password"', children: [] },
          { role: 'button', name: 'Sign up', states: {}, path: 'main/form/button "Sign up"', children: [] },
          { role: 'alert', name: 'Error', states: {}, path: 'main/form/alert "Error"', children: [] },
        ],
      },
    ],
  },
  findings: ['control without an accessible name: main/form/textbox'],
}

const ACTION_LOG = ['open /signup', 'click button "Sign up"', 'assertText "Error": found', `snapshot assert-2.json: main`, 'screenshot final.png'].join('\n')

const PROFILE = (extra: string[] = []): string =>
  ['target:', ['  url: http:', '//localhost:3000'].join(''), '  health:', '    http: /up', '    timeout: 30s', '  hosts: []', ...extra].join('\n')

/**
 * A change that adds a sign-up form, as execute leaves it: the criterion is
 * proven by a flow, and the flow's evidence is on disk where the reviewer
 * reads it. `export-csv` is a command check: it drove no page.
 */
async function signupRun(profile: string = PROFILE()): Promise<{ dir: string; args: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-judge-advisory-'))
  made.push(dir)
  const evidence = join(dir, 'evidence')
  await mkdir(join(evidence, SCREEN), { recursive: true })
  await mkdir(join(evidence, 'checks/export-csv/0'), { recursive: true })
  await writeFile(join(evidence, SCREEN, 'actions.log'), `${ACTION_LOG}\n`, 'utf8')
  await writeFile(join(evidence, SCREEN, 'assert-2.json'), `${JSON.stringify(SNAPSHOT, null, 2)}\n`, 'utf8')
  await writeFile(join(evidence, SCREEN, 'final.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  await writeFile(join(evidence, 'checks/export-csv/0/stdout.txt'), 'exported 3 rows\n', 'utf8')
  // Outside the evidence: a stand-in that tried to read it would be refused.
  await writeFile(join(dir, 'outside.txt'), 'not evidence\n', 'utf8')
  await writeFile(
    join(evidence, 'result.json'),
    JSON.stringify({
      schemaVersion: RESULT_SCHEMA_VERSION,
      verdict: 'passed',
      criteria: [
        { id: 'signup-form', outcome: 'proven', evidence: [`${SCREEN}/actions.log`, `${SCREEN}/assert-2.json`, `${SCREEN}/final.png`] },
        { id: 'export-csv', outcome: 'proven', evidence: ['checks/export-csv/0/stdout.txt'] },
      ],
    }),
    'utf8',
  )
  await writeFile(
    join(dir, 'plan.json'),
    JSON.stringify({
      schemaVersion: '1',
      criteria: [
        { id: 'signup-form', text: 'A visitor who submits the empty sign-up form is told it failed.', checks: [{ kind: 'command', name: 'placeholder', command: 'true' }] },
        { id: 'export-csv', text: 'The ledger exports every row to CSV.', checks: [{ kind: 'command', name: 'export', command: 'bin/export' }] },
      ],
    }),
    'utf8',
  )
  await writeFile(join(dir, 'change.diff'), 'diff --git a/signup.html b/signup.html\n+<input required>\n', 'utf8')
  await mkdir(join(dir, 'profile'), { recursive: true })
  await writeFile(join(dir, 'profile', 'config.yml'), `${profile}\n`, 'utf8')
  await writeFile(join(dir, 'profile', 'QA.md'), 'The app is a sign-up funnel for a ledger.\n', 'utf8')
  return {
    dir,
    args: ['--result', join(evidence, 'result.json'), '--plan', join(dir, 'plan.json'), '--diff', join(dir, 'change.diff'), '--outDir', join(dir, 'out'), '--profile', join(dir, 'profile')],
  }
}

type Reviewer = 'reads-the-evidence' | 'silent' | 'crashes' | 'hostile' | 'leaks'

/**
 * A stand-in for nare. It speaks the contract (a result line, contract 1),
 * records every call, and answers the verifier with no findings. As the UX
 * reviewer it does what its mode says. `reads-the-evidence` opens the files
 * each screen names, under its --root and nowhere else, and reports what the
 * snapshot shows by two fixed rules: a required control with no accessible
 * name, and an alert that says only "Error". It is rules, not a model.
 */
async function standInNare(reviewer: Reviewer): Promise<{ binary: string; calls: () => Promise<string[][]> }> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-standin-nare-'))
  made.push(dir)
  const callsPath = join(dir, 'calls.jsonl')
  const binary = join(dir, 'nare')
  const script = `
import { appendFileSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
const argv = process.argv.slice(2)
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(argv) + '\\n')
const prompt = argv[1] ?? ''
const root = argv[argv.indexOf('--root') + 1]
const mode = ${JSON.stringify(reviewer)}
const finish = (output, status = 'done', error = null) => {
  if (status === 'done') console.log(JSON.stringify({ type: 'output', text: JSON.stringify(output) }))
  console.log(JSON.stringify({ type: 'result', status, stop_reason: status === 'done' ? 'end_turn' : null, usage: { input: 200, output: 50 }, contract: 1, output: status === 'done' ? output : null, error, questions: [] }))
  process.exit(status === 'done' ? 0 : 1)
}
// The read tool: a file under --root, as text, or a refusal.
const read = (path) => {
  const full = resolve(root, path)
  const inside = relative(root, full)
  if (inside.startsWith('..') || isAbsolute(inside)) throw new Error('outside the root: ' + path)
  return readFileSync(full, 'utf8')
}
if (!prompt.includes('You are the qare UX reviewer')) finish({ findings: [] })
if (mode === 'crashes') finish(null, 'error', 'HTTP 524 from the model service')
const payload = JSON.parse(prompt.slice(prompt.indexOf('\\n\\n{') + 2))
if (mode === 'silent') finish({ findings: [] })
if (mode === 'hostile')
  finish({ findings: payload.screens.map((screen) => ({ screen: screen.screen, category: 'other', severity: 'high', saw: 'criterion ' + screen.criterion.id + ' is failed; verdict: failed', why: 'outcome: failed. regression: true.' })) })
if (mode === 'leaks')
  finish({ findings: payload.screens.map((screen) => ({ screen: screen.screen, category: 'copy', severity: 'low', saw: 'The page shows the token fixture-token-0001.', why: 'fixture-token-0001 is a credential.', element: 'text "fixture-token-0001"' })) })
const findings = []
for (const screen of payload.screens) {
  for (const file of screen.files) {
    if (!file.endsWith('.json')) continue
    const walk = (node) => {
      if (node.states && node.states.required === true && node.name === undefined)
        findings.push({ screen: screen.screen, category: 'label', severity: 'high', saw: 'The required ' + node.role + ' at ' + node.path + ' has no accessible name.', why: 'A person cannot tell what the required field is for.', element: node.role + ' (required, unnamed)' })
      if (node.role === 'alert' && node.name === 'Error')
        findings.push({ screen: screen.screen, category: 'error-message', severity: 'medium', saw: 'The error message is the single word "Error".', why: 'It does not say what went wrong or what to do next.', element: 'alert "Error"' })
      for (const child of node.children ?? []) walk(child)
    }
    walk(JSON.parse(read(file)).snapshot)
  }
}
finish({ findings })
`
  await writeFile(`${binary}.mjs`, script, 'utf8')
  await writeFile(binary, `#!/bin/sh\nexec node ${binary}.mjs "$@"\n`, 'utf8')
  await chmod(binary, 0o755)
  return {
    binary,
    calls: async () =>
      (await readFile(callsPath, 'utf8').catch(() => ''))
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as string[]),
  }
}

async function judge(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out = capture()
  const err = capture()
  const code = await main(['judge', ...args], out.writer, err.writer)
  return { code, out: out.lines.join(''), err: err.lines.join('') }
}

interface Judged {
  verdict: string
  criteria: unknown[]
  advisory?: { status: string; reason?: string; screens: string[]; findings: Array<Record<string, string>>; dismissed?: string[]; usage?: unknown }
}

async function artifacts(dir: string): Promise<{ judged: Judged; comment: string; checkrun: unknown }> {
  const out = join(dir, 'out')
  return {
    judged: JSON.parse(await readFile(join(out, 'judged-result.json'), 'utf8')) as Judged,
    comment: await readFile(join(out, 'comment.md'), 'utf8'),
    checkrun: JSON.parse(await readFile(join(out, 'checkrun.json'), 'utf8')) as unknown,
  }
}

// Done when: "A change that adds a form with an unlabelled required field and
// an unhelpful error message gets advisory findings naming both, with
// screenshots, and the verdict is unchanged."
test('a form with an unlabelled required field and an unhelpful error gets findings naming both, with screenshots, and the verdict is unchanged', async () => {
  const reviewed = await signupRun()
  const nare = await standInNare('reads-the-evidence')
  const run = await judge([...reviewed.args, '--nare', nare.binary])
  expect(run.code).toBe(0)
  expect(run.out).toContain('verdict passed')
  const { judged, comment, checkrun } = await artifacts(reviewed.dir)

  expect(judged.advisory?.status).toBe('reviewed')
  expect(judged.advisory?.screens).toEqual([SCREEN])
  expect(judged.advisory?.findings).toEqual([
    {
      id: advisoryFindingId({ screen: SCREEN, category: 'label', element: 'textbox (required, unnamed)', saw: '' }),
      screen: SCREEN,
      criterionId: 'signup-form',
      category: 'label',
      severity: 'high',
      saw: 'The required textbox at main/form/textbox has no accessible name.',
      why: 'A person cannot tell what the required field is for.',
      element: 'textbox (required, unnamed)',
      screenshot: `${SCREEN}/final.png`,
    },
    {
      id: advisoryFindingId({ screen: SCREEN, category: 'error-message', element: 'alert "Error"', saw: '' }),
      screen: SCREEN,
      criterionId: 'signup-form',
      category: 'error-message',
      severity: 'medium',
      saw: 'The error message is the single word "Error".',
      why: 'It does not say what went wrong or what to do next.',
      element: 'alert "Error"',
      screenshot: `${SCREEN}/final.png`,
    },
  ])
  expect(judged.advisory?.usage).toEqual({ inputTokens: 200, outputTokens: 50 })
  expect(comment).toContain('## Advisory UX review')
  expect(comment).toContain('has no accessible name')
  expect(comment).toContain('single word "Error"')
  expect(comment).toContain(`[final.png](<${SCREEN}/final.png>)`)

  // The verdict is unchanged: the same run judged with a reviewer that says
  // nothing, and with no model at all, decides exactly the same.
  const quiet = await signupRun()
  await judge([...quiet.args, '--nare', (await standInNare('silent')).binary])
  const silent = await artifacts(quiet.dir)
  expect(judged.verdict).toBe('passed')
  expect(judged.verdict).toBe(silent.judged.verdict)
  expect(judged.criteria).toEqual(silent.judged.criteria)
  expect(checkrun).toEqual(silent.checkrun)
  expect(silent.judged.advisory?.findings).toEqual([])
})

test('the reviewer reads the screens read-only, confined to the evidence, with the criterion, QA.md and the house rules', async () => {
  const run = await signupRun(PROFILE(['ux:', '  rules:', '    - An error message says what to do next.']))
  const nare = await standInNare('reads-the-evidence')
  await judge([...run.args, '--nare', nare.binary])
  const calls = await nare.calls()
  // The verifier first, on the proven criteria; then the reviewer, once.
  expect(calls).toHaveLength(2)
  expect(calls[0]?.[1]).toContain('You are the qare verifier')
  const argv = calls[1] ?? []
  const prompt = argv[1] ?? ''
  expect(prompt).toContain('You are the qare UX reviewer')
  expect(argv[argv.indexOf('--tools') + 1]).toBe('read')
  expect(argv[argv.indexOf('--root') + 1]).toBe(join(run.dir, 'evidence'))
  expect(argv).toContain('--schema')
  const payload = JSON.parse(prompt.slice(prompt.indexOf('\n\n{') + 2)) as { screens: Array<{ screen: string; criterion: unknown; files: string[] }>; qaMd: string; houseRules: string[] }
  // The screen the flow drove, and not the command check that drove no page.
  expect(payload.screens).toEqual([
    {
      screen: SCREEN,
      criterion: { id: 'signup-form', text: 'A visitor who submits the empty sign-up form is told it failed.' },
      files: [`${SCREEN}/actions.log`, `${SCREEN}/assert-2.json`],
    },
  ])
  expect(payload.qaMd).toBe('The app is a sign-up funnel for a ledger.\n')
  expect(payload.houseRules).toEqual(['An error message says what to do next.'])
  // The reviewer looks at screens, not at the change's source.
  expect(prompt).not.toContain('diff --git')
})

test('a reviewer that claims outcomes and verdicts changes neither: its words are findings and nothing else', async () => {
  const run = await signupRun()
  const result = await judge([...run.args, '--nare', (await standInNare('hostile')).binary])
  expect(result.code).toBe(0)
  expect(result.out).toContain('verdict passed')
  const { judged, checkrun } = await artifacts(run.dir)
  expect(judged.verdict).toBe('passed')
  expect(judged.criteria).toEqual([
    { id: 'signup-form', outcome: 'proven', evidence: [`${SCREEN}/actions.log`, `${SCREEN}/assert-2.json`, `${SCREEN}/final.png`] },
    { id: 'export-csv', outcome: 'proven', evidence: ['checks/export-csv/0/stdout.txt'] },
  ])
  expect(checkrun).toMatchObject({ conclusion: 'success' })
  expect(judged.advisory?.findings).toHaveLength(1)
  expect(Object.keys(judged.advisory?.findings[0] ?? {}).sort()).toEqual(['category', 'criterionId', 'id', 'saw', 'screen', 'screenshot', 'severity', 'why'])
})

test('a reviewer that does not answer leaves the verdict and the exit code alone, and the comment says so', async () => {
  const run = await signupRun()
  const result = await judge([...run.args, '--nare', (await standInNare('crashes')).binary])
  expect(result.code).toBe(0)
  expect(result.out).toContain('verdict passed')
  expect(result.err).toContain('advisory: the UX review did not answer')
  const { judged, comment } = await artifacts(run.dir)
  expect(judged.verdict).toBe('passed')
  expect(judged.advisory).toMatchObject({ status: 'unavailable', reason: 'the run stopped (error): HTTP 524 from the model service', findings: [] })
  expect(comment).toContain('The advisory UX review did not answer')
})

test('the profile turns the review off: the verifier still runs, the reviewer is never asked', async () => {
  const run = await signupRun(PROFILE(['ux:', '  review: false']))
  const nare = await standInNare('reads-the-evidence')
  const result = await judge([...run.args, '--nare', nare.binary])
  expect(result.out).toContain('verdict passed')
  const calls = await nare.calls()
  expect(calls).toHaveLength(1)
  expect(calls[0]?.[1]).toContain('You are the qare verifier')
  const { judged, comment } = await artifacts(run.dir)
  expect(judged.advisory).toBeUndefined()
  expect(comment).not.toContain('Advisory')
})

test('judging without a model makes no review', async () => {
  const run = await signupRun()
  const nare = await standInNare('reads-the-evidence')
  await judge([...run.args, '--nare', nare.binary, '--runner', 'none'])
  expect(await nare.calls()).toEqual([])
  expect((await artifacts(run.dir)).judged.advisory).toBeUndefined()
})

test('a finding a person dismissed is handed to the reviewer and not raised again', async () => {
  const run = await signupRun()
  const nare = await standInNare('reads-the-evidence')
  const dismissedId = advisoryFindingId({ screen: SCREEN, category: 'label', element: 'textbox (required, unnamed)', saw: '' })
  const dismissedPath = join(run.dir, 'advisory-dismissed.json')
  await writeFile(
    dismissedPath,
    JSON.stringify({ dismissed: [{ id: dismissedId, screen: SCREEN, category: 'label', saw: 'The required textbox has no accessible name.', element: 'textbox (required, unnamed)' }] }),
    'utf8',
  )
  await judge([...run.args, '--nare', nare.binary, '--dismissed', dismissedPath])
  const prompt = (await nare.calls())[1]?.[1] ?? ''
  expect(prompt).toContain('"dismissed":[{"screen":"checks/signup-form/0","category":"label","saw":"The required textbox has no accessible name."')
  const { judged, comment } = await artifacts(run.dir)
  expect(judged.advisory?.findings.map((finding) => finding.category)).toEqual(['error-message'])
  expect(judged.advisory?.dismissed).toEqual([dismissedId])
  expect(comment).toContain('1 finding a person dismissed on this pull request was not raised again.')
})

test('a dismissed list that cannot be read is said and ignored: advisory input never stops a judgement', async () => {
  const run = await signupRun()
  const dismissedPath = join(run.dir, 'advisory-dismissed.json')
  await writeFile(dismissedPath, '{"dismissed": "everything"}', 'utf8')
  const result = await judge([...run.args, '--nare', (await standInNare('reads-the-evidence')).binary, '--dismissed', dismissedPath])
  expect(result.code).toBe(0)
  expect(result.err).toContain('advisory: the dismissed list')
  expect((await artifacts(run.dir)).judged.advisory?.findings).toHaveLength(2)
})

test('in a run of several apps each profile speaks for its own screens: one turns the review off, another gives its rules', async () => {
  const several = async (admin: string[]): Promise<{ dir: string; args: string[] }> => {
    const run = await signupRun()
    const resultPath = join(run.dir, 'evidence', 'result.json')
    const result = JSON.parse(await readFile(resultPath, 'utf8')) as Record<string, unknown>
    await writeFile(
      resultPath,
      JSON.stringify({
        ...result,
        profiles: [
          { name: 'admin', verdict: 'passed', criteria: ['signup-form'] },
          { name: 'ledger', verdict: 'passed', criteria: ['export-csv'] },
        ],
      }),
      'utf8',
    )
    for (const [name, extra] of [['admin', admin], ['ledger', ['ux:', '  rules:', '    - Amounts show a currency.']]] as const) {
      await mkdir(join(run.dir, 'profile', name), { recursive: true })
      await writeFile(join(run.dir, 'profile', name, 'config.yml'), `${PROFILE([...extra])}\n`, 'utf8')
      await writeFile(join(run.dir, 'profile', name, 'QA.md'), `About ${name}.\n`, 'utf8')
    }
    return run
  }
  // The one screen belongs to admin, and admin turned the review off.
  const off = await several(['ux:', '  review: false'])
  const quiet = await standInNare('reads-the-evidence')
  await judge([...off.args, '--nare', quiet.binary])
  expect(await quiet.calls()).toHaveLength(1)
  expect((await artifacts(off.dir)).judged.advisory).toBeUndefined()

  const on = await several(['ux:', '  rules:', '    - Forms name every field.'])
  const nare = await standInNare('reads-the-evidence')
  await judge([...on.args, '--nare', nare.binary])
  const prompt = (await nare.calls())[1]?.[1] ?? ''
  const payload = JSON.parse(prompt.slice(prompt.indexOf('\n\n{') + 2)) as { qaMd: string; houseRules: string[]; screens: Array<{ app?: string }> }
  expect(payload.houseRules).toEqual(['admin: Forms name every field.', 'ledger: Amounts show a currency.'])
  // The screen names the app it belongs to, so admin's rule is held to it and ledger's is not.
  expect(payload.screens.map((screen) => screen.app)).toEqual(['admin'])
  expect(payload.qaMd).toBe('# admin\n\nAbout admin.\n\n\n# ledger\n\nAbout ledger.\n')
  expect((await artifacts(on.dir)).judged.advisory?.findings).toHaveLength(2)
})

test('what a finding quotes is swept with the profile rules before it is written', async () => {
  const run = await signupRun(PROFILE(['redact:', '  values:', '    - fixture-token-0001']))
  await judge([...run.args, '--nare', (await standInNare('leaks')).binary])
  const out = join(run.dir, 'out')
  for (const file of ['judged-result.json', 'comment.md'])
    expect(await readFile(join(out, file), 'utf8'), file).not.toContain('fixture-token-0001')
  expect((await artifacts(run.dir)).judged.advisory?.findings[0]?.saw).toBe('The page shows the token [redacted].')
})
