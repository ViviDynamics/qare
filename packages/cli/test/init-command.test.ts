import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { VERSION, loadProfile, loadResult, readinessInventory, type StubIssueDraft } from '@qare/core'
import { main } from '../src/index.js'
import type { Writer } from '../src/index.js'
import { initCommand } from '../src/init.js'

// #146: `qare init [path]` onboards a repository in one command. Test files
// carry no network literals (the offline scanner), so URLs are joined here.
const url = (scheme: string, rest: string) => [`${scheme}:`, `//${rest}`].join('')
const UP = { probe: async () => ({ ok: true }), pollIntervalMs: 1 }

afterEach(() => {
  vi.unstubAllEnvs()
})

function capture(): { text: () => string; writer: Writer } {
  const lines: string[] = []
  return { text: () => lines.join(''), writer: { write: (chunk) => lines.push(chunk) } }
}

async function repoWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-cli-init-'))
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true })
    await writeFile(join(dir, name), content, 'utf8')
  }
  return dir
}

const COMPOSE = [
  'services:',
  '  web:',
  '    build: .',
  '    ports: ["3000:3000"]',
  `    healthcheck: { test: "curl -f ${url('http', 'localhost:3000/up')}" }`,
].join('\n')

function composeRepo(extra: Record<string, string> = {}): Promise<string> {
  return repoWith({
    'docker-compose.yml': COMPOSE,
    'app/pay.rb': `get ${url('https', 'api.billing-vendor.example/v1')}`,
    ...extra,
  })
}

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out = capture()
  const err = capture()
  const code = await main(argv, out.writer, err.writer)
  return { code, out: out.text(), err: err.text() }
}

test('on a repository with a compose file, init writes a profile that loads, the workflow, and the remaining gaps', async () => {
  const repo = await composeRepo()
  const { code, out, err } = await run(['init', repo])
  expect(err).toBe('')
  expect(code).toBe(0)
  for (const path of ['.qa/config.yml', '.qa/QA.md', '.qa/fixtures/users.yml', '.qa/stubs/.gitkeep', '.github/workflows/qare.yml']) {
    expect(out).toContain(`wrote ${path}\n`)
    expect(existsSync(join(repo, path)), path).toBe(true)
  }

  const profile = await loadProfile(join(repo, '.qa'))
  expect(profile.app?.boot).toEqual({ compose: 'docker-compose.yml', service: 'web' })
  expect(profile.app?.health.http).toBe(url('http', 'localhost:3000/up'))
  expect(await readFile(join(repo, '.github/workflows/qare.yml'), 'utf8')).toContain(`pipeline.yml@${VERSION}`)

  // Every gap readiness finds in what was written is a next step, and
  // nothing else is: the two lists are the same list.
  const inventory = await readinessInventory(repo)
  expect(inventory.gaps.length).toBeGreaterThan(0)
  const steps = out.slice(out.indexOf('next steps\n'), out.indexOf('stub issues'))
  expect(steps.split('\n').filter((line) => line.startsWith('- '))).toEqual([
    ...inventory.gaps.map((gap) => `- ${gap}`),
    '- add the repository secret OPENAI_API_KEY: the workflow reads the model key from it',
  ])
  const readiness = await run(['readiness', repo])
  for (const gap of inventory.gaps) expect(readiness.out).toContain(`- ${gap}\n`)

  // The stub gap is named as the issue it becomes, with the key a refused
  // run files under (#31), and nothing is filed unasked.
  expect(out).toContain('stub issues to file (qare init --file-issues <owner/name> files them)\n')
  expect(out).toContain('- Stub needed for api.billing-vendor.example (qare-stub: api.billing-vendor.example)\n')
})

test('init never overwrites: an existing profile and workflow are left alone, and init says what it would have written', async () => {
  const repo = await composeRepo()
  expect((await run(['init', repo])).code).toBe(0)
  await writeFile(join(repo, '.qa', 'QA.md'), 'mine\n')
  await writeFile(join(repo, '.github/workflows/qare.yml'), 'name: mine\n')
  const before = await readFile(join(repo, '.qa', 'config.yml'), 'utf8')

  const { code, out } = await run(['init', repo, '--model', 'another-model'])
  expect(code).toBe(0)
  expect(out).not.toContain('wrote ')
  expect(await readFile(join(repo, '.qa', 'QA.md'), 'utf8')).toBe('mine\n')
  expect(await readFile(join(repo, '.qa', 'config.yml'), 'utf8')).toBe(before)
  expect(await readFile(join(repo, '.github/workflows/qare.yml'), 'utf8')).toBe('name: mine\n')
  expect(out).toContain('kept .qa/ (it exists, and init never overwrites); it would have written:\n')
  expect(out).toContain('--- .qa/config.yml\n  # The starting profile `qare init` wrote.')
  expect(out).toContain('    boot: { compose: "docker-compose.yml", service: "web" }\n')
  expect(out).toContain('kept .github/workflows/qare.yml (it exists, and init never overwrites); it would have written:\n')
  expect(out).toContain('        nare-model: another-model\n')
  // The gaps are those of the profile that is there, not of the one init would write.
  expect(out).toContain('next steps\n')
  expect(out).not.toContain('- .qa/QA.md is not filled in')
})

test('a profile is written beside an existing workflow, and a caller under another name counts as the workflow', async () => {
  const repo = await composeRepo({
    '.github/workflows/quality.yaml': 'jobs:\n  qa:\n    uses: ViviDynamics/qare/.github/workflows/pipeline.yml@2026.9.0\n',
  })
  const { code, out } = await run(['init', repo])
  expect(code).toBe(0)
  expect(out).toContain('wrote .qa/config.yml\n')
  expect(out).toContain('kept .github/workflows/quality.yaml (it already calls the qare pipeline); init would have written .github/workflows/qare.yml:\n')
  expect(await readdir(join(repo, '.github/workflows'))).toEqual(['quality.yaml'])
  // The secret is a step of the workflow init writes, not of one it left alone.
  expect(out).not.toContain('add the repository secret')
})

test('on a repository with no compose file, init --target writes a target profile that qare check runs', async () => {
  const target = url('https', 'app.example.test')
  const repo = await repoWith({ 'smoke.mjs': 'console.log("up", process.argv[2])\n' })
  const init = await run(['init', repo, '--target', target, '--health', '/up'])
  expect(init.err).toBe('')
  expect(init.code).toBe(0)
  expect(init.out).toContain('wrote .qa/config.yml\n')
  expect(existsSync(join(repo, '.qa', 'stubs'))).toBe(false)
  expect(init.out).not.toContain('stub issues')
  const workflow = await readFile(join(repo, '.github/workflows/qare.yml'), 'utf8')
  expect(workflow).not.toContain('push:')

  // A planner stand-in, as in check-command.test.ts: the profile is the part under test.
  const plan = {
    schemaVersion: '1',
    usage: { inputTokens: 1, outputTokens: 1 },
    criteria: [{ id: 'check-1', text: 'the app answers', checks: [{ kind: 'command', name: 'smoke', command: 'node smoke.mjs {{run.target_url}}' }] }],
  }
  const nareDir = await mkdtemp(join(tmpdir(), 'qare-init-nare-'))
  const script = [
    `const answer = process.argv[3].includes('qare verifier') ? { findings: [] } : ${JSON.stringify(plan)}`,
    "console.log(JSON.stringify({ type: 'result', status: 'done', questions: [], usage: { input: 1, output: 1 },",
    "  stop_reason: 'end_turn', turns: 1, contract: 1, output: answer, error: null }))",
  ].join('\n')
  await writeFile(join(nareDir, 'nare.mjs'), script)
  await writeFile(join(nareDir, 'nare'), `#!/bin/sh\nexec node ${join(nareDir, 'nare.mjs')} "$@"\n`)
  await chmod(join(nareDir, 'nare'), 0o755)

  const out = capture()
  const err = capture()
  const code = await main(
    ['check', 'the app answers', '--profile', join(repo, '.qa'), '--repo', repo, '--evidence', join(repo, 'evidence'), '--nare', join(nareDir, 'nare')],
    out.writer,
    err.writer,
    UP,
  )
  expect(err.text()).toBe('')
  expect(code).toBe(0)
  expect(out.text()).toContain('check-1 proven: the app answers')
  const judged = loadResult(await readFile(join(repo, 'evidence', 'judged-result.json'), 'utf8'))
  expect(judged.verdict).toBe('passed')
  expect(judged.target).toEqual({ url: target, comparison: 'none' })
})

test('with no compose file and no target, init writes nothing and names the flag', async () => {
  const repo = await repoWith({ 'README.md': 'hello\n' })
  const { code, out, err } = await run(['init', repo])
  expect(code).toBe(4)
  expect(out).toBe('')
  expect(err).toContain('no compose file found')
  expect(err).toContain('--target <url>')
  expect(await readdir(repo)).toEqual(['README.md'])
})

test('a target profile that is already there is enough to write the workflow it lacks', async () => {
  const target = url('https', 'app.example.test')
  const repo = await repoWith({ '.qa/QA.md': '# QA\n', '.qa/config.yml': `target:\n  url: ${target}\n  health: { http: /, timeout: 30s }\n` })
  const { code, out } = await run(['init', repo])
  expect(code).toBe(0)
  expect(out).toContain('kept .qa/')
  expect(out).toContain('wrote .github/workflows/qare.yml\n')
  expect(out).toContain('- add the repository secret OPENAI_API_KEY')
})

test('--file-issues files each stub gap once, through the poster the pipeline files refusals with', async () => {
  const repo = await composeRepo()
  const filed: StubIssueDraft[] = []
  const asked: string[] = []
  const out = capture()
  const err = capture()
  const code = await initCommand(['--file-issues', 'acme/shop', repo], out.writer, err.writer, {
    poster: (repository) => {
      asked.push(repository)
      return { fileIfMissing: async (draft) => filed.push(draft) + 40 }
    },
  })
  expect(err.text()).toBe('')
  expect(code).toBe(0)
  expect(asked).toEqual(['acme/shop'])
  expect(filed.map((draft) => draft.key)).toEqual(['api.billing-vendor.example'])
  expect(filed[0]?.body).toContain('1 reference(s) in the source: ./app/pay.rb')
  expect(filed[0]?.body).toContain('The profile already declares the stub `api-billing-vendor-example`')
  expect(out.text()).toContain('stub issues in acme/shop\n- #41 Stub needed for api.billing-vendor.example (qare-stub: api.billing-vendor.example)\n')
})

test('--file-issues without a token stops before anything is written', async () => {
  vi.stubEnv('GITHUB_TOKEN', '')
  vi.stubEnv('GH_TOKEN', '')
  const repo = await composeRepo()
  const { code, err } = await run(['init', repo, '--file-issues', 'acme/shop'])
  expect(code).toBe(4)
  expect(err).toContain('GITHUB_TOKEN')
  expect(existsSync(join(repo, '.qa'))).toBe(false)
  expect(existsSync(join(repo, '.github'))).toBe(false)
})

test('init refuses what it does not understand, and says how it is called', async () => {
  const repo = await composeRepo()
  expect((await run(['init', repo, '--force'])).err).toContain('qare init does not take --force')
  expect((await run(['init', repo, 'other'])).err).toContain('at most one path')
  expect((await run(['init', '--target'])).err).toContain('--target needs a value')
  expect(existsSync(join(repo, '.qa'))).toBe(false)
  const help = await run(['init', '--help'])
  expect(help.code).toBe(0)
  expect(help.out).toContain('qare init [path] [--target <url>] [--health <path>] [--service <name>] [--model <name>] [--file-issues <owner/name>]')
  expect((await run([])).out).toContain('qare init [path]')
})
