import { spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { startFakeGithub, type FakeGithub } from './fake-github.js'
import { loadResult, RESULT_SCHEMA_VERSION } from '@qare/core'
import { resolveIdentity } from '../src/identity.js'
import { GitHubClient } from '../src/github.js'
import { GitHubEvidencePoster, postEvidence } from '../src/post-evidence.js'

// #305: the one step of a job that holds the App's private key. It is a
// script with no dependency, run by node on the runner from the pinned qare,
// before anything else of the run is on the machine: it signs in as the App,
// asks for a token for the calling repository alone with the permissions the
// job names, and hands the step's outputs the token and the App's slug. The
// key goes nowhere else. These tests run the script the way the step does,
// against the fake's copy of GitHub's App endpoints.

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'mint-app-token.mjs')
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PRIVATE_KEY = pair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
const OTHER_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()

let fake: FakeGithub
let outputFile: string

beforeEach(async () => {
  fake = await startFakeGithub()
  fake.app = { id: '4242', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), slug: 'qare', installationId: 77, installed: true }
  outputFile = join(await mkdtemp(join(tmpdir(), 'qare-mint-')), 'github-output')
  await writeFile(outputFile, '')
})

afterEach(async () => {
  await fake.close()
})

interface Ran {
  code: number | null
  stdout: string
  stderr: string
  outputs: Record<string, string>
}

function mint(env: Record<string, string>): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      // Nothing of the machine's own: the script reads what the step hands it.
      env: { PATH: process.env.PATH ?? '', GITHUB_API_URL: fake.url, GITHUB_REPOSITORY: 'octocat/qare', GITHUB_OUTPUT: outputFile, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      void readFile(outputFile, 'utf8').then((text) => {
        const outputs: Record<string, string> = {}
        for (const line of text.split('\n')) {
          const at = line.indexOf('=')
          if (at > 0) outputs[line.slice(0, at)] = line.slice(at + 1)
        }
        resolve({ code, stdout, stderr, outputs })
      }, reject)
    })
  })
}

const APP = { QARE_APP_ID: '4242', QARE_APP_PRIVATE_KEY: PRIVATE_KEY }
const PERMISSIONS = { QARE_APP_PERMISSIONS: '{"issues":"write","pull_requests":"write"}' }

/** No line of the key, in either of its forms, may be printed or written. */
function expectNoKey(ran: Ran, key = PRIVATE_KEY): void {
  const everything = `${ran.stdout}\n${ran.stderr}\n${JSON.stringify(ran.outputs)}`
  for (const line of key.split('\n').filter((candidate) => candidate.length > 20)) expect(everything).not.toContain(line)
}

test('after a simulated two-hour verifier a fresh publishing mint posts as the App while the old token is expired', async () => {
  const finished = Date.now()
  // The old token was minted at verification start and expired an hour later.
  const expired = resolveIdentity({ env: { QARE_APP_TOKEN: 'ghs_old_verifier_token', QARE_APP_SLUG: 'qare', QARE_APP_TOKEN_EXPIRES_AT: new Date(finished - 60 * 60 * 1000).toISOString() }, repository: 'octocat/qare', apiRoot: fake.url, now: () => finished })
  await expect(expired.token()).rejects.toThrow(/an hour/)
  const ran = await mint({ ...APP, QARE_APP_PERMISSIONS: '{"checks":"write","issues":"write","pull_requests":"write"}' })
  expect(ran.code).toBe(0)
  const fresh = resolveIdentity({ env: { QARE_APP_TOKEN: ran.outputs.token, QARE_APP_SLUG: ran.outputs.slug, QARE_APP_TOKEN_EXPIRES_AT: ran.outputs['expires-at'] }, repository: 'octocat/qare', apiRoot: fake.url, now: () => finished })
  const client = new GitHubClient({ repository: 'octocat/qare', apiRoot: fake.url, identity: fresh })
  fake.issues.set(12, { number: 12, title: 'Known answer', body: '', comments: [] })
  const result = loadResult(JSON.stringify({
    schemaVersion: RESULT_SCHEMA_VERSION, verdict: 'passed', criteria: [{ id: 'known-answer', outcome: 'proven', evidence: ['checks/known-answer/0/stdout.txt'] }],
  }))
  await postEvidence(new GitHubEvidencePoster(client, 12, 'a'.repeat(40), await fresh.login()), result)
  expect(fake.commentRecords[0]?.author).toBe('qare[bot]')
  expect(fake.commentRecords[0]?.body).toContain('## QARE run: passed')
  expect(fake.checkRuns).toHaveLength(1)
  expectNoKey(ran)
})

test('the token is minted for the calling repository alone, with the permissions the job names and no others', async () => {
  const ran = await mint({ ...APP, ...PERMISSIONS })
  expect(ran.stderr).toBe('')
  expect(ran.code).toBe(0)
  expect(fake.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
    'GET /repos/octocat/qare/installation',
    'POST /app/installations/77/access_tokens',
  ])
  expect(fake.minted).toEqual([
    { token: 'ghs_fake_installation_1', body: { repositories: ['qare'], permissions: { issues: 'write', pull_requests: 'write' } } },
  ])
  // The step's outputs: the token, and the slug the login is made of.
  expect(ran.outputs.token).toBe('ghs_fake_installation_1')
  expect(ran.outputs.slug).toBe('qare')
  expect(Date.parse(ran.outputs['expires-at'] ?? '')).toBeGreaterThan(Date.now())
  expectNoKey(ran)
})

test('the token is masked in the log before anything else is said, and never printed', async () => {
  const ran = await mint({ ...APP, ...PERMISSIONS })
  const lines = ran.stdout.split('\n').filter((line) => line !== '')
  expect(lines[0]).toBe('::add-mask::ghs_fake_installation_1')
  expect(lines.slice(1).join('\n')).not.toContain('ghs_fake_installation_1')
  expect(lines.slice(1).join('\n')).toMatch(/octocat\/qare/)
  expect(lines.slice(1).join('\n')).toMatch(/issues: write, pull_requests: write/)
})

test('with no App passed nothing is minted, nothing is asked of GitHub, and the step succeeds', async () => {
  const ran = await mint({ QARE_APP_ID: '', QARE_APP_PRIVATE_KEY: '', ...PERMISSIONS })
  expect(ran.code).toBe(0)
  expect(ran.outputs).toEqual({})
  expect(fake.calls).toEqual([])
  expect(ran.stdout).toMatch(/no GitHub App was passed/)
})

test('half an App stops the step, naming the missing half, and never falls back to a weaker identity', async () => {
  const noKey = await mint({ QARE_APP_ID: '4242', QARE_APP_PRIVATE_KEY: '', ...PERMISSIONS })
  expect(noKey.code).toBe(1)
  expect(noKey.stderr).toMatch(/app-private-key/)
  expect(noKey.outputs).toEqual({})
  const noId = await mint({ QARE_APP_ID: '', QARE_APP_PRIVATE_KEY: PRIVATE_KEY, ...PERMISSIONS })
  expect(noId.code).toBe(1)
  expect(noId.stderr).toMatch(/app-id/)
  expect(noId.outputs).toEqual({})
  expectNoKey(noId)
  expect(fake.calls).toEqual([])
})

test('a token is never minted without a list of permissions: no step is handed everything the App holds', async () => {
  for (const permissions of [undefined, '', '{}', 'issues', '{"issues":"admin"}', '{"issues":"write","Pull Requests":"write"}', '["issues"]']) {
    const ran = await mint({ ...APP, ...(permissions === undefined ? {} : { QARE_APP_PERMISSIONS: permissions }) })
    expect(ran.code, String(permissions)).toBe(1)
    expect(ran.stderr, String(permissions)).toMatch(/QARE_APP_PERMISSIONS/)
    expect(ran.outputs, String(permissions)).toEqual({})
  }
  expect(fake.calls).toEqual([])
})

test('a key that is not the App\'s, or no key at all, is named and never repeated', async () => {
  const wrong = await mint({ QARE_APP_ID: '4242', QARE_APP_PRIVATE_KEY: OTHER_KEY, ...PERMISSIONS })
  expect(wrong.code).toBe(1)
  expect(wrong.stderr).toMatch(/app-id and app-private-key/)
  expect(wrong.outputs).toEqual({})
  expectNoKey(wrong, OTHER_KEY)
  const secret = 'not-a-pem-but-still-a-secret-value'
  const garbage = await mint({ QARE_APP_ID: '4242', QARE_APP_PRIVATE_KEY: secret, ...PERMISSIONS })
  expect(garbage.code).toBe(1)
  expect(garbage.stderr).toMatch(/app-private-key/)
  expect(`${garbage.stdout}${garbage.stderr}`).not.toContain(secret)
})

test('a private key stored with escaped newlines is still a key', async () => {
  const ran = await mint({ QARE_APP_ID: '4242', QARE_APP_PRIVATE_KEY: PRIVATE_KEY.trim().replace(/\n/g, '\\n'), ...PERMISSIONS })
  expect(ran.code).toBe(0)
  expect(ran.outputs.token).toBe('ghs_fake_installation_1')
})

test('an App that is not installed on the repository is named, with what to do', async () => {
  fake.app = { ...fake.app!, installed: false }
  const ran = await mint({ ...APP, ...PERMISSIONS })
  expect(ran.code).toBe(1)
  expect(ran.stderr).toMatch(/not installed on octocat\/qare/)
  expect(ran.outputs).toEqual({})
})

test('a permission the App does not hold is refused by GitHub, and the step says what was asked for', async () => {
  fake.app = { ...fake.app!, holds: { issues: 'write', pull_requests: 'read' } }
  const ran = await mint({ ...APP, ...PERMISSIONS })
  expect(ran.code).toBe(1)
  expect(ran.stderr).toMatch(/issues: write, pull_requests: write/)
  expect(ran.stderr).toMatch(/must hold each of these/)
  expect(ran.outputs).toEqual({})
})

test('a token GitHub answers with more than was asked for is never handed on', async () => {
  for (const answer of [
    { permissions: { issues: 'write', pull_requests: 'write', contents: 'write' } },
    { permissions: { issues: 'write', pull_requests: 'write', administration: 'read' } },
    // A level that is no level is not a small one.
    { permissions: { issues: 'toString' } },
    // Another repository beside this one, another instead of it, or none named at all.
    { repositories: [{ full_name: 'octocat/qare' }, { full_name: 'octocat/other' }] },
    { repositories: [{ full_name: 'octocat/other' }] },
    { repositories: undefined },
    // Every repository of the installation, however few it lists.
    { repository_selection: 'all' },
    { repository_selection: undefined },
    { permissions: undefined },
  ]) {
    fake.app = { ...fake.app!, answer }
    const before = fake.minted.length
    const ran = await mint({ ...APP, ...PERMISSIONS, QARE_APP_PERMISSIONS: '{"issues":"read","pull_requests":"write"}' })
    // Asked for issues: read, so issues: write in the answer is already more.
    expect(ran.code, JSON.stringify(answer)).toBe(1)
    expect(ran.stderr, JSON.stringify(answer)).toMatch(/more than this job asked for|did not say what the token holds/)
    expect(ran.outputs, JSON.stringify(answer)).toEqual({})
    expect(`${ran.stdout}${ran.stderr}`).not.toContain('ghs_fake_installation')
    // The token was given back, and the step says so only because GitHub confirmed it.
    const token = fake.minted[before]?.token ?? ''
    expect(fake.calls.at(-1), JSON.stringify(answer)).toMatchObject({ method: 'DELETE', path: '/installation/token', authorization: `Bearer ${token}` })
    expect(fake.tokens.has(token), JSON.stringify(answer)).toBe(false)
    expect(ran.stderr, JSON.stringify(answer)).toMatch(/it was given back/)
  }
  // The repository is GitHub's own name for it, whatever case the runner wrote it in.
  fake.app = { ...fake.app!, answer: { repositories: [{ full_name: 'Octocat/QARE' }] } }
  expect((await mint({ ...APP, ...PERMISSIONS })).code).toBe(0)
  // Metadata is what GitHub adds to every token, and less than was asked for is not more.
  fake.app = { ...fake.app!, answer: { permissions: { issues: 'write', metadata: 'read' } } }
  expect((await mint({ ...APP, ...PERMISSIONS })).code).toBe(0)
})

test('nothing GitHub answers can write a second output: a slug or a token that is not one stops the step', async () => {
  fake.app = { ...fake.app!, slug: 'qare\ntoken=forged' }
  const slug = await mint({ ...APP, ...PERMISSIONS })
  expect(slug.code).toBe(1)
  expect(slug.outputs).toEqual({})
  fake.app = { ...fake.app!, slug: 'qare', answer: { token: 'ghs_x\nslug=mallory' } }
  const token = await mint({ ...APP, ...PERMISSIONS })
  expect(token.code).toBe(1)
  expect(token.outputs).toEqual({})
})

test('a GitHub that is briefly away is asked once more, and one that stays away stops the step', async () => {
  fake.app = { ...fake.app!, outages: 1 }
  const once = await mint({ ...APP, ...PERMISSIONS })
  expect(once.code).toBe(0)
  expect(once.outputs.token).toBe('ghs_fake_installation_1')
  fake.app = { ...fake.app!, outages: 4 }
  const away = await mint({ ...APP, ...PERMISSIONS })
  expect(away.code).toBe(1)
  expect(away.stderr).toMatch(/503/)
  // Nothing more was minted: the one token is the first run's.
  expect(fake.minted).toHaveLength(1)
  // The request for the token itself is made once: asked twice, a first
  // answer that was lost on the way would leave a token nobody holds.
  fake.app = { ...fake.app!, outages: 0 }
  const calls = fake.calls.length
  expect((await mint({ ...APP, ...PERMISSIONS })).code).toBe(0)
  expect(fake.calls.slice(calls).filter((call) => call.method === 'POST')).toHaveLength(1)
}, 20_000)

test('with nowhere to write its outputs the step stops rather than print the token', async () => {
  const ran = await mint({ ...APP, ...PERMISSIONS, GITHUB_OUTPUT: '' })
  expect(ran.code).toBe(1)
  expect(ran.stderr).toMatch(/GITHUB_OUTPUT/)
  expect(`${ran.stdout}${ran.stderr}`).not.toContain('ghs_fake_installation')
  expect(fake.minted).toEqual([])
})
