import { generateKeyPairSync } from 'node:crypto'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { GitHubApiError, GitHubClient, GitHubClientError } from '../src/github.js'
import {
  ACTIONS_LOGIN,
  AppInstallationIdentity,
  resolveIdentity,
  type GitHubIdentity,
} from '../src/identity.js'
import { FAKE_TOKEN, startFakeGithub, type FakeGithub } from './fake-github.js'

// #61: qare posts as a GitHub App installation or as a personal access
// token, and which one is the install's choice, made by the credentials it
// configures. These tests hold the interface, its resolution, and the App
// path against the fake's copy of GitHub's App endpoints. No real App exists
// yet (#155), so nothing here has met real GitHub.

const REPOSITORY = 'octocat/qare'
const PAT = 'github_pat_fake_user'

function keyPair(): { privateKey: string; publicKey: string } {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return {
    // PKCS#1, the form GitHub hands out: "BEGIN RSA PRIVATE KEY".
    privateKey: pair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
}

const KEY = keyPair()
const OTHER_KEY = keyPair()

let fake: FakeGithub

beforeEach(async () => {
  fake = await startFakeGithub()
  fake.app = { id: '4242', publicKey: KEY.publicKey, slug: 'qare', installationId: 77, installed: true }
  fake.tokens.set(PAT, { login: 'jason', kind: 'user' })
})

afterEach(async () => {
  await fake.close()
})

function resolve(env: Record<string, string | undefined>, extra: { tokenEnv?: string; token?: string; now?: () => number } = {}): GitHubIdentity {
  return resolveIdentity({ repository: REPOSITORY, apiRoot: fake.url, env, ...extra })
}

const APP_ENV = { QARE_APP_ID: '4242', QARE_APP_PRIVATE_KEY: KEY.privateKey }

test('the install chooses its identity by what it configures: the App, then a personal token, then the Actions token', () => {
  expect(resolve({ ...APP_ENV, QARE_GITHUB_TOKEN: PAT, GITHUB_TOKEN: FAKE_TOKEN }).kind).toBe('app')
  expect(resolve({ QARE_GITHUB_TOKEN: PAT, GITHUB_TOKEN: FAKE_TOKEN }).kind).toBe('token')
  expect(resolve({ GITHUB_TOKEN: FAKE_TOKEN }).kind).toBe('actions')
  // An empty value is what a workflow expression gives for a secret that is
  // not set: it is unset, never an empty credential.
  expect(resolve({ QARE_APP_ID: '', QARE_APP_PRIVATE_KEY: '', QARE_GITHUB_TOKEN: '', GITHUB_TOKEN: FAKE_TOKEN }).kind).toBe('actions')
  // A token handed over by name is that caller's explicit choice.
  expect(resolve({ ...APP_ENV, MY_TOKEN: PAT }, { tokenEnv: 'MY_TOKEN' }).kind).toBe('token')
  expect(resolve({ ...APP_ENV }, { token: PAT }).kind).toBe('token')
})

test('half an App stops by name rather than falling through to a weaker identity', () => {
  expect(() => resolve({ QARE_APP_ID: '4242', GITHUB_TOKEN: FAKE_TOKEN })).toThrow(GitHubClientError)
  expect(() => resolve({ QARE_APP_ID: '4242', GITHUB_TOKEN: FAKE_TOKEN })).toThrow(/QARE_APP_PRIVATE_KEY/)
  expect(() => resolve({ QARE_APP_PRIVATE_KEY: KEY.privateKey, QARE_GITHUB_TOKEN: PAT })).toThrow(/QARE_APP_ID/)
})

test('no credential at all names every way to configure one', () => {
  expect(() => resolve({})).toThrow(GitHubClientError)
  expect(() => resolve({})).toThrow(/GitHub token/)
  for (const name of ['QARE_APP_ID', 'QARE_APP_PRIVATE_KEY', 'QARE_GITHUB_TOKEN', 'GITHUB_TOKEN'])
    expect(() => resolve({})).toThrow(new RegExp(name))
  expect(() => resolve({}, { tokenEnv: 'MY_TOKEN' })).toThrow(/MY_TOKEN/)
})

test('the App identity signs in as the App and posts with a token for this repository alone', async () => {
  const client = new GitHubClient({ repository: REPOSITORY, apiRoot: fake.url, identity: resolve(APP_ENV) })
  fake.issues.set(9, { number: 9, title: 't', body: 'b', comments: [] })
  await client.postIssueComment(9, 'posted as the App')

  // The fake verified the JSON web token against the App's public key, its
  // issuer against the App id, and its lifetime against GitHub's ten minutes.
  expect(fake.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
    'GET /repos/octocat/qare/installation',
    'POST /app/installations/77/access_tokens',
    'POST /repos/octocat/qare/issues/9/comments',
  ])
  expect(fake.minted).toEqual([{ token: 'ghs_fake_installation_1', body: { repositories: ['qare'] } }])
  expect(fake.calls[2]?.authorization).toBe('Bearer ghs_fake_installation_1')
  expect(fake.commentRecords[0]?.author).toBe('qare[bot]')
})

test('one installation token serves a whole run, and a token near its expiry is replaced', async () => {
  let now = Date.now()
  const identity = resolve(APP_ENV, { now: () => now })
  expect(await identity.token()).toBe('ghs_fake_installation_1')
  expect(await identity.token()).toBe('ghs_fake_installation_1')
  expect(fake.minted).toHaveLength(1)
  // The fake's tokens last an hour. Two minutes before that is still good.
  now += 58 * 60 * 1000
  fake.nowMs = now
  expect(await identity.token()).toBe('ghs_fake_installation_1')
  // Inside the last minute a request could outlive it: a new one is minted.
  now += 90 * 1000
  fake.nowMs = now
  expect(await identity.token()).toBe('ghs_fake_installation_2')
  // The installation is looked up once; only the token is asked for again.
  expect(fake.calls.filter((call) => call.path === '/repos/octocat/qare/installation')).toHaveLength(1)
})

test('a private key stored with escaped newlines is still a key', async () => {
  const flattened = KEY.privateKey.trim().replace(/\n/g, '\\n')
  expect(await resolve({ QARE_APP_ID: '4242', QARE_APP_PRIVATE_KEY: flattened }).token()).toBe('ghs_fake_installation_1')
})

test('an App that is not installed on the repository is named, with what to do', async () => {
  fake.app = { ...fake.app!, installed: false }
  const failure = await resolve(APP_ENV).token().catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(GitHubClientError)
  expect((failure as Error).message).toMatch(/not installed on octocat\/qare/)
  expect((failure as Error).message).toMatch(/QARE_APP_ID/)
})

test('a key that is not the App\'s is named, and the key itself is never repeated', async () => {
  const failure = await resolve({ QARE_APP_ID: '4242', QARE_APP_PRIVATE_KEY: OTHER_KEY.privateKey }).token().catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(GitHubClientError)
  expect((failure as Error).message).toMatch(/QARE_APP_ID and QARE_APP_PRIVATE_KEY/)
  expect((failure as Error).message).not.toContain(OTHER_KEY.privateKey.split('\n')[1])
})

test('a private key that is not a key at all stops before anything is sent', async () => {
  const secret = 'not-a-pem-but-still-secret'
  const failure = await resolve({ QARE_APP_ID: '4242', QARE_APP_PRIVATE_KEY: secret }).token().catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(GitHubClientError)
  expect((failure as Error).message).toMatch(/QARE_APP_PRIVATE_KEY/)
  expect((failure as Error).message).not.toContain(secret)
  expect(fake.calls).toEqual([])
})

test('an App id that could not be one is refused when the identity is chosen', () => {
  expect(() => resolve({ QARE_APP_ID: '42 42', QARE_APP_PRIVATE_KEY: KEY.privateKey })).toThrow(/QARE_APP_ID/)
})

test('each identity knows the login its comments carry', async () => {
  expect(await resolve(APP_ENV).login()).toBe('qare[bot]')
  expect(await resolve({ QARE_GITHUB_TOKEN: PAT }).login()).toBe('jason')
  // The Actions token is never asked: GitHub would refuse it the question.
  const before = fake.calls.length
  expect(await resolve({ GITHUB_TOKEN: FAKE_TOKEN }).login()).toBe(ACTIONS_LOGIN)
  expect(fake.calls.slice(before).map((call) => call.path)).not.toContain('/user')
  // A token handed over by name that is no user is an installation's: the
  // login the pipeline has always commented as.
  expect(await resolve({ MY_TOKEN: FAKE_TOKEN }, { tokenEnv: 'MY_TOKEN' }).login()).toBe(ACTIONS_LOGIN)
})

test('a personal token posts as its user, and the check run is written by the Actions token', async () => {
  const client = new GitHubClient({
    repository: REPOSITORY,
    apiRoot: fake.url,
    identity: resolve({ QARE_GITHUB_TOKEN: PAT, GITHUB_TOKEN: FAKE_TOKEN }),
  })
  fake.issues.set(9, { number: 9, title: 't', body: 'b', comments: [] })
  await client.postIssueComment(9, 'posted as a user')
  await client.createCheckRun({
    name: 'QARE verdict',
    head_sha: 'a'.repeat(40),
    status: 'completed',
    conclusion: 'success',
    output: { title: 't', summary: 's' },
  })
  expect(fake.commentRecords[0]?.author).toBe('jason')
  // GitHub lets only an App write a check run, and the fake refuses a user's
  // token as GitHub does: the check run arrived, so it was the Actions token.
  expect(fake.checkRuns).toHaveLength(1)
  expect(fake.calls.find((call) => call.path.endsWith('/check-runs'))?.authorization).toBe(`Bearer ${FAKE_TOKEN}`)
})

test('a personal token with no Actions token beside it says why the check run was refused', async () => {
  const client = new GitHubClient({ repository: REPOSITORY, apiRoot: fake.url, identity: resolve({ QARE_GITHUB_TOKEN: PAT }) })
  const failure = await client
    .createCheckRun({ name: 'QARE verdict', head_sha: 'a'.repeat(40), status: 'completed', conclusion: 'success', output: { title: 't', summary: 's' } })
    .catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(GitHubClientError)
  expect((failure as Error).message).toMatch(/only a GitHub App may write a check run/)
  expect((failure as Error).message).toMatch(/GITHUB_TOKEN/)
  // Known before anything is sent: the request GitHub would refuse is never made.
  expect(fake.calls.filter((call) => call.path.endsWith('/check-runs'))).toEqual([])
})

test('a check run the Actions token is refused is reported as GitHub refused it', async () => {
  // The personal token was never the one used, so it is not the one blamed:
  // the job was not granted checks: write, and the error says what GitHub said.
  fake.tokens.set(FAKE_TOKEN, { login: ACTIONS_LOGIN, kind: 'actions', noChecks: true })
  const client = new GitHubClient({
    repository: REPOSITORY,
    apiRoot: fake.url,
    identity: resolve({ QARE_GITHUB_TOKEN: PAT, GITHUB_TOKEN: FAKE_TOKEN }),
  })
  const failure = await client
    .createCheckRun({ name: 'QARE verdict', head_sha: 'a'.repeat(40), status: 'completed', conclusion: 'success', output: { title: 't', summary: 's' } })
    .catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(GitHubApiError)
  expect((failure as Error).message).toMatch(/not accessible by integration/)
  expect((failure as Error).message).not.toMatch(/personal access token/)
})

test('a token that is an installation\'s writes its own check runs, however it was handed over', async () => {
  const client = new GitHubClient({ repository: REPOSITORY, apiRoot: fake.url, identity: resolve({ MY_TOKEN: FAKE_TOKEN }, { tokenEnv: 'MY_TOKEN' }) })
  await client.createCheckRun({ name: 'QARE verdict', head_sha: 'a'.repeat(40), status: 'completed', conclusion: 'success', output: { title: 't', summary: 's' } })
  expect(fake.checkRuns).toHaveLength(1)
})

test('each identity knows whether a pull request it opens starts the repository\'s workflows', async () => {
  expect(await resolve(APP_ENV).triggersWorkflows()).toBe(true)
  expect(await resolve({ QARE_GITHUB_TOKEN: PAT }).triggersWorkflows()).toBe(true)
  expect(await resolve({ GITHUB_TOKEN: FAKE_TOKEN }).triggersWorkflows()).toBe(false)
  // What the token is decides, not how it was handed over: the Actions
  // token under another name, or passed directly, is still the Actions token.
  expect(await resolve({ GH_ALIAS: FAKE_TOKEN }, { tokenEnv: 'GH_ALIAS' }).triggersWorkflows()).toBe(false)
  expect(await resolve({}, { token: FAKE_TOKEN }).triggersWorkflows()).toBe(false)
  expect(await resolve({ QARE_GITHUB_TOKEN: FAKE_TOKEN }).triggersWorkflows()).toBe(false)
  expect(await resolve({}, { token: PAT }).triggersWorkflows()).toBe(true)
})

test('the App writes its own check runs', async () => {
  const client = new GitHubClient({ repository: REPOSITORY, apiRoot: fake.url, identity: resolve({ ...APP_ENV, GITHUB_TOKEN: FAKE_TOKEN }) })
  await client.createCheckRun({ name: 'QARE verdict', head_sha: 'a'.repeat(40), status: 'completed', conclusion: 'success', output: { title: 't', summary: 's' } })
  expect(fake.calls.find((call) => call.path.endsWith('/check-runs'))?.authorization).toBe('Bearer ghs_fake_installation_1')
})

test('a client built with no identity resolves one from the environment it runs in', async () => {
  const saved = { ...process.env }
  try {
    for (const name of ['QARE_APP_ID', 'QARE_APP_PRIVATE_KEY', 'QARE_GITHUB_TOKEN', 'GITHUB_TOKEN']) delete process.env[name]
    process.env.QARE_APP_ID = '4242'
    process.env.QARE_APP_PRIVATE_KEY = KEY.privateKey
    process.env.GITHUB_TOKEN = FAKE_TOKEN
    const client = new GitHubClient({ repository: REPOSITORY, apiRoot: fake.url })
    expect(client.identity.kind).toBe('app')
    expect(client.identity).toBeInstanceOf(AppInstallationIdentity)
    fake.issues.set(9, { number: 9, title: 't', body: 'b', comments: [] })
    await client.postIssueComment(9, 'from the environment')
    expect(fake.commentRecords[0]?.author).toBe('qare[bot]')
  } finally {
    for (const name of ['QARE_APP_ID', 'QARE_APP_PRIVATE_KEY', 'QARE_GITHUB_TOKEN', 'GITHUB_TOKEN']) delete process.env[name]
    Object.assign(process.env, saved)
  }
})

test('naming the Actions token on the command line is no choice of identity', () => {
  // `--token-env GITHUB_TOKEN` says nothing the default does not: the App
  // still wins, and alone it is still the Actions token, which a proposal
  // is refused under.
  expect(resolve({ ...APP_ENV, GITHUB_TOKEN: FAKE_TOKEN }, { tokenEnv: 'GITHUB_TOKEN' }).kind).toBe('app')
  expect(resolve({ GITHUB_TOKEN: FAKE_TOKEN }, { tokenEnv: 'GITHUB_TOKEN' }).kind).toBe('actions')
})

test('a token whose user cannot be read for another reason is an error, never a guess', async () => {
  fake.tokens.set(PAT, { login: 'jason', kind: 'user', rateLimited: true })
  await expect(resolve({ QARE_GITHUB_TOKEN: PAT }).login()).rejects.toThrow(/rate limit/)
})
