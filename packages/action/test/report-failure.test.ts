import { afterEach, beforeEach, expect, test } from 'vitest'
import { GitHubClient } from '../src/github.js'
import { main } from '../src/index.js'
import { CHECK_RUN_NAME, EVIDENCE_MARKER } from '../src/post-evidence.js'
import { FAKE_TOKEN, startFakeGithub, type FakeGithub } from './fake-github.js'

const SHA = 'b'.repeat(40)
const RUN_URL = ['https:', '//github.com/octocat/qare/actions/runs/77'].join('')

// dettmore-platform run 37086848535 (#203), as the jobs API lists it.
const nareInstallFailed = [
  { name: 'collect (GitHub token only)', conclusion: 'success', steps: [{ name: 'Read the linked issue and the diff', conclusion: 'success' }] },
  {
    name: 'plan (model key only)',
    conclusion: 'failure',
    steps: [
      { name: 'Build qare', conclusion: 'success' },
      { name: 'Install nare at the pinned release', conclusion: 'failure' },
    ],
  },
  { name: 'execute (no secrets)', conclusion: 'skipped', steps: [] },
  { name: 'judge (model key + GitHub token only)', conclusion: 'skipped', steps: [] },
  { name: 'report (GitHub token only)', conclusion: null, steps: [] },
]

let fake: FakeGithub
let out: string[]
let err: string[]

beforeEach(async () => {
  fake = await startFakeGithub()
  fake.issues.set(12, { number: 12, title: 'a pull request', body: '', comments: [] })
  out = []
  err = []
})

afterEach(async () => {
  await fake.close()
})

function run(argv: string[]): Promise<number> {
  return main(
    [...argv, '--repository', 'octocat/qare', '--api-root', fake.url],
    { write: (chunk) => out.push(chunk) },
    { write: (chunk) => err.push(chunk) },
  )
}

test('lists every job of a run attempt across pages', async () => {
  const many = Array.from({ length: 130 }, (_, index) => ({ name: `job ${index}`, conclusion: 'success', steps: [] }))
  fake.runJobs.set('77/2', many)
  const client = new GitHubClient({ repository: 'octocat/qare', token: FAKE_TOKEN, apiRoot: fake.url })

  const jobs = await client.listRunJobs(77, 2)

  expect(jobs).toHaveLength(130)
  expect(jobs[129]?.name).toBe('job 129')
})

test('a pipeline that failed before a verdict posts a not-evaluated comment and a failing check', async () => {
  fake.runJobs.set('77/1', nareInstallFailed)
  process.env.QARE_TEST_TOKEN = FAKE_TOKEN

  const code = await run([
    'report-failure', '--run-id', '77', '--attempt', '1', '--pr', '12', '--sha', SHA,
    '--run-url', RUN_URL, '--token-env', 'QARE_TEST_TOKEN',
  ])

  expect(err.join('')).toBe('')
  expect(code).toBe(0)
  const [comment] = fake.issues.get(12)?.comments ?? []
  // The same sticky comment a verdict uses, so a stale verdict from an older
  // commit is replaced rather than left beside it.
  expect(comment?.startsWith(`${EVIDENCE_MARKER}\n## QARE run: not evaluated (qare or its environment failed)`)).toBe(true)
  expect(comment).toContain('`Install nare at the pinned release`')
  expect(comment).toContain(`\`${RUN_URL}\``)
  expect(comment).toContain(`qare checked ${SHA}`)
  expect(fake.checkRuns).toEqual([
    {
      name: CHECK_RUN_NAME,
      head_sha: SHA,
      status: 'completed',
      conclusion: 'failure',
      output: {
        title: 'QARE: not evaluated (qare or environment failure)',
        summary:
          'No acceptance criterion was evaluated: plan (model key only) failed at Install nare at the pinned release. This is not a verdict on the pull request.',
      },
    },
  ])
  expect(out.join('')).toContain('reported plan (model key only) failing at Install nare at the pinned release on pull request #12')
})

test('a run with no failed job posts nothing', async () => {
  fake.runJobs.set('77/1', [{ name: 'plan', conclusion: 'success', steps: [] }])
  process.env.QARE_TEST_TOKEN = FAKE_TOKEN

  const code = await run(['report-failure', '--run-id', '77', '--attempt', '1', '--pr', '12', '--sha', SHA, '--token-env', 'QARE_TEST_TOKEN'])

  expect(code).toBe(0)
  expect(fake.issues.get(12)?.comments).toEqual([])
  expect(fake.checkRuns).toEqual([])
  expect(out.join('')).toContain('no job in run 77 failed: nothing to report')
})

test('report-failure names each flag it needs', async () => {
  process.env.QARE_TEST_TOKEN = FAKE_TOKEN
  expect(await run(['report-failure', '--pr', '12', '--sha', SHA, '--token-env', 'QARE_TEST_TOKEN'])).toBe(1)
  expect(err.join('')).toContain('qare-action report-failure needs --run-id <workflow run id>')
  err.length = 0
  expect(await run(['report-failure', '--run-id', '77', '--sha', SHA, '--token-env', 'QARE_TEST_TOKEN'])).toBe(1)
  expect(err.join('')).toContain('qare-action report-failure needs --pr <pull request number>')
  err.length = 0
  expect(await run(['report-failure', '--run-id', '77', '--pr', '12', '--token-env', 'QARE_TEST_TOKEN'])).toBe(1)
  expect(err.join('')).toContain('qare-action report-failure needs --sha <head commit>')
  err.length = 0
  expect(
    await run(['report-failure', '--run-id', '77', '--pr', '12', '--sha', SHA, '--run-url', 'javascript:alert(1)', '--token-env', 'QARE_TEST_TOKEN']),
  ).toBe(1)
  expect(err.join('')).toContain('--run-url must be an https URL')
})
