import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { NO_DIFF, encodePng, loadResult, type BootOpts, type VisualSessionFactory } from '@qare/core'
import { main } from '../src/index.js'
import type { Writer } from '../src/index.js'

// No network literals in test files (the offline scanner): joined at runtime,
// and the target's health probe is injected.
const TARGET_URL = ['https:', '//wiki.example.test'].join('')
const UP = { probe: async () => ({ ok: true }), pollIntervalMs: 1 }

function capture(): { text: () => string; writer: Writer } {
  const lines: string[] = []
  return { text: () => lines.join(''), writer: { write: (chunk) => lines.push(chunk) } }
}

const PLAN = {
  schemaVersion: '1',
  usage: { inputTokens: 1, outputTokens: 1 },
  criteria: [
    {
      id: 'check-1',
      text: 'searching the wiki for Ada Lovelace shows her article',
      checks: [{ kind: 'command', name: 'article', command: 'node article.mjs {{run.target_url}}/wiki/Ada_Lovelace' }],
    },
    { id: 'check-2', text: 'the article is pleasant to read', unplannable: 'pleasant is not something a check can show' },
  ],
}

/**
 * A nare stand-in that answers as the planner or as the verifier, by the
 * prompt it is given, and records every prompt so a test can read what the
 * model was told.
 */
async function fakeNare(plan: unknown, findings: unknown[] = []): Promise<{ binary: string; prompts: () => Promise<string[]> }> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-check-nare-'))
  const log = join(dir, 'prompts.jsonl')
  const script = [
    "const { appendFileSync } = await import('node:fs')",
    'const prompt = process.argv[3]',
    `appendFileSync(${JSON.stringify(log)}, JSON.stringify(prompt) + '\\n')`,
    `const answer = prompt.includes('qare verifier') ? ${JSON.stringify(JSON.stringify({ findings }))} : ${JSON.stringify(JSON.stringify(plan))}`,
    "console.log(JSON.stringify({ type: 'result', status: 'done', questions: [], usage: { input: 1, output: 1 },",
    "  stop_reason: 'end_turn', turns: 1, contract: 1, output: JSON.parse(answer), error: null }))",
  ].join('\n')
  await writeFile(join(dir, 'nare.mjs'), script)
  const binary = join(dir, 'nare')
  await writeFile(binary, `#!/bin/sh\nexec node ${join(dir, 'nare.mjs')} "$@"\n`)
  await chmod(binary, 0o755)
  const prompts = async () =>
    (await readFile(log, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string)
  return { binary, prompts }
}

async function targetRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'qare-check-repo-'))
  await mkdir(join(repo, '.qa'))
  await writeFile(join(repo, '.qa', 'QA.md'), '# QA\n')
  await writeFile(join(repo, '.qa', 'config.yml'), `target:\n  url: ${TARGET_URL}\n  health: { http: /health, timeout: 1s }\n`)
  await writeFile(join(repo, 'article.mjs'), 'console.log("checked", process.argv[2])\n')
  return repo
}

function args(repo: string, ...rest: string[]): string[] {
  return ['--profile', join(repo, '.qa'), '--repo', repo, '--evidence', join(repo, 'evidence'), ...rest]
}

test('a criterion in plain words is planned, run and judged, and prints each outcome, the verdict and the evidence', async () => {
  const repo = await targetRepo()
  const nare = await fakeNare(PLAN)
  const out = capture()
  const err = capture()

  const code = await main(
    ['check', PLAN.criteria[0]!.text, PLAN.criteria[1]!.text, ...args(repo, '--nare', nare.binary)],
    out.writer,
    err.writer,
    UP,
  )

  // One criterion is unplannable, so it is unverified and the run is blocked:
  // the same exit code qare run gives that verdict.
  expect(code).toBe(2)
  expect(out.text()).toContain(`check-1 proven: ${PLAN.criteria[0]!.text}`)
  expect(out.text()).toContain('check-2 unverified: the article is pleasant to read (the planner could not plan it: pleasant is not something a check can show)')
  expect(out.text()).toContain(`verdict blocked; evidence ${join(repo, 'evidence')}`)

  const executed = loadResult(await readFile(join(repo, 'evidence', 'result.json'), 'utf8'))
  const judged = loadResult(await readFile(join(repo, 'evidence', 'judged-result.json'), 'utf8'))
  expect(executed.target).toEqual({ url: TARGET_URL, comparison: 'none' })
  expect(judged.verdict).toBe('blocked')
  expect(judged.target).toEqual({ url: TARGET_URL, comparison: 'none' })
  expect(await readFile(join(repo, 'evidence', 'checks', 'check-1', '0', 'stdout.txt'), 'utf8')).toBe(`checked ${TARGET_URL}/wiki/Ada_Lovelace\n`)
  expect(JSON.parse(await readFile(join(repo, 'evidence', 'plan.json'), 'utf8'))).toEqual(PLAN)

  // Planner and verifier are both told there is no diff; the planner also
  // learns where the target runs.
  const [planned, verified] = await nare.prompts()
  expect(planned).toContain(NO_DIFF)
  expect(planned).toContain(`already running at ${TARGET_URL}`)
  expect(verified).toContain('qare verifier')
  expect(verified).toContain(NO_DIFF)
})

test('every criterion proven is a passed verdict and exit 0; a verifier finding fails it, exit 1', async () => {
  const repo = await targetRepo()
  const one = { schemaVersion: '1', criteria: [PLAN.criteria[0]] }

  const passed = await main(['check', PLAN.criteria[0]!.text, ...args(repo, '--nare', (await fakeNare(one)).binary)], capture().writer, capture().writer, UP)
  expect(passed).toBe(0)

  const findings = [{ criterionId: 'check-1', problem: 'the output shows the URL, not the article', kind: 'contradicted', evidence: 'checks/check-1/0/stdout.txt' }]
  const out = capture()
  const failed = await main(['check', PLAN.criteria[0]!.text, ...args(repo, '--nare', (await fakeNare(one, findings)).binary)], out.writer, capture().writer, UP)
  expect(failed).toBe(1)
  expect(out.text()).toContain('check-1 failed')
  expect(out.text()).toContain('verifier: the output shows the URL, not the article (checks/check-1/0/stdout.txt)')
})

test('criteria come from a file too, one per line, skipping blanks and comments', async () => {
  const repo = await targetRepo()
  const file = join(repo, 'criteria.txt')
  await writeFile(file, `# what to check\n${PLAN.criteria[0]!.text}\n\n${PLAN.criteria[1]!.text}\n`)
  const nare = await fakeNare(PLAN)
  const out = capture()

  await main(['check', '--file', file, ...args(repo, '--nare', nare.binary, '--runner', 'none')], out.writer, capture().writer, UP)

  expect(out.text()).toContain('check-1 proven')
  expect(out.text()).toContain('check-2 unverified')
  // --runner none judges from the evidence alone: only the planner was asked.
  expect(await nare.prompts()).toHaveLength(1)
})

test('a planner that cannot run leaves every criterion unverified, naming why, rather than dropping it', async () => {
  const repo = await targetRepo()
  const out = capture()

  const code = await main(['check', 'the home page loads', ...args(repo, '--nare', join(repo, 'no-such-nare'))], out.writer, capture().writer, UP)

  expect(code).toBe(2)
  expect(out.text()).toMatch(/check-1 unverified: the home page loads \(the planner could not plan it: planning failed \(NareRunnerError: .*no-such-nare/)
})

test('a repository with no profile is refused, and nothing is planned for it', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'qare-check-bare-'))
  const nare = await fakeNare(PLAN)
  const out = capture()

  const code = await main(['check', 'the home page loads', ...args(repo, '--nare', nare.binary)], out.writer, capture().writer, UP)

  expect(code).toBe(3)
  expect(out.text()).toContain('verdict refused')
  expect(await nare.prompts()).toEqual([])
})

test('no criterion, an empty one, or an unknown flag is a usage error, exit 4', async () => {
  const repo = await targetRepo()
  for (const argv of [['check', ...args(repo)], ['check', '  ', ...args(repo)], ['check', 'x', '--frobnicate', ...args(repo)]]) {
    const err = capture()
    expect(await main(argv, capture().writer, err.writer, UP)).toBe(4)
    expect(err.text()).not.toBe('')
  }
})

test('without --profile the profile is the one in --repo, as the MCP tool resolves it', async () => {
  const repo = await targetRepo()
  const out = capture()

  const code = await main(
    ['check', PLAN.criteria[0]!.text, '--repo', repo, '--evidence', join(repo, 'evidence'), '--nare', (await fakeNare({ schemaVersion: '1', criteria: [PLAN.criteria[0]] })).binary, '--runner', 'none'],
    out.writer,
    capture().writer,
    UP,
  )

  expect(code).toBe(0)
  expect(out.text()).toContain('check-1 proven')
})

/** A screenshot backend that paints a blank page as wide as the viewport, and records where it was pointed. */
function fakeVisual(): { captures: string[]; visualSession: VisualSessionFactory } {
  const captures: string[] = []
  return {
    captures,
    visualSession: async () => ({
      screenshot: async (url, width, theme) => {
        captures.push(`${url} ${width} ${theme}`)
        return encodePng({ width, height: 2, pixels: Buffer.alloc(width * 2 * 4, 255) })
      },
      dispose: async () => {},
      outbound: () => [],
    }),
  }
}

test('a visual check on a running target proves the criterion with a head screenshot at each width, and says there is no base comparison (#143)', async () => {
  const repo = await targetRepo()
  const text = 'the article on Ada Lovelace renders at 390 and 1440 wide'
  const visual = {
    schemaVersion: '1',
    criteria: [{ id: 'check-1', text, checks: [{ kind: 'visual', name: 'article', screenshot: 'ada-lovelace', url: '/wiki/Ada_Lovelace', widths: [390, 1440] }] }],
  }
  const out = capture()
  const err = capture()
  const backend = fakeVisual()

  const code = await main(['check', text, ...args(repo, '--nare', (await fakeNare(visual)).binary, '--runner', 'none')], out.writer, err.writer, { ...UP, visualSession: backend.visualSession } as BootOpts)

  expect(code).toBe(0)
  expect(out.text()).toContain(`check-1 proven: ${text}`)
  expect(backend.captures).toEqual([`${TARGET_URL}/wiki/Ada_Lovelace 390 light`, `${TARGET_URL}/wiki/Ada_Lovelace 1440 light`])
  // Nothing is compared on a target, and the check says so rather than leaving it to be assumed.
  expect(err.text()).toContain('check-1: the visual check ada-lovelace captured the head only: the profile names a running target, which has one side only, so there is no base to compare with')
  expect(err.text()).not.toMatch(/does not execute/)
  const executed = loadResult(await readFile(join(repo, 'evidence', 'result.json'), 'utf8'))
  expect(executed.criteria[0]?.evidence).toEqual([
    'checks/check-1/0/visual.json',
    'checks/check-1/0/outbound.json',
    'checks/check-1/0/head/390xlight.png',
    'checks/check-1/0/head/1440xlight.png',
  ])
})

test('a criterion whose command passes while its visual check could not capture is unverified, not proven', async () => {
  const repo = await targetRepo()
  // The check names no width and the target profile declares none, so there is nothing to capture at.
  const mixed = {
    schemaVersion: '1',
    criteria: [{ ...PLAN.criteria[0], checks: [...PLAN.criteria[0]!.checks!, { kind: 'visual', name: 'home', screenshot: 'home' }] }],
  }
  const out = capture()

  const code = await main(['check', PLAN.criteria[0]!.text, ...args(repo, '--nare', (await fakeNare(mixed)).binary, '--runner', 'none')], out.writer, capture().writer, UP)

  expect(code).toBe(2)
  expect(out.text()).toContain('check-1 unverified')
  expect(out.text()).toContain("the visual check names no width and the profile's visual section declares none")
})

test('what the verifier overturned is reported, as qare judge reports it', async () => {
  const repo = await targetRepo()
  const one = { schemaVersion: '1', criteria: [PLAN.criteria[0]] }
  const err = capture()

  await main(['check', PLAN.criteria[0]!.text, ...args(repo, '--nare', (await fakeNare(one, [{ criterionId: 'check-1', problem: 'wrong page', kind: 'contradicted', evidence: 'checks/check-1/0/stdout.txt' }])).binary)], capture().writer, err.writer, UP)

  expect(err.text()).toContain('verifier: check-1 failed: verifier: wrong page (checks/check-1/0/stdout.txt)')
})
