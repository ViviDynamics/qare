// Mint the GitHub App's installation token for one job of a workflow (#305).
//
// The App's private key is the long-lived credential of the whole App, and
// the steps that post only ever need a token for one repository that expires
// within the hour. So the key is used here and nowhere else: in one step per
// job, on the runner, before anything else of the run is on the machine. The
// step is this file run by node, with nothing installed and nothing built: it
// imports node's own modules alone, so no dependency, cache or image stands
// between the checkout of the pinned qare and the key.
//
// What it reads, all from the environment the step hands it:
//   QARE_APP_ID            the App's id or client id (the secret app-id)
//   QARE_APP_PRIVATE_KEY   a private key of that App, PEM (app-private-key)
//   QARE_APP_PERMISSIONS   what the token may do, as JSON: {"issues":"write"}
//   GITHUB_REPOSITORY      "owner/name": the one repository the token is for
//   GITHUB_API_URL         GitHub's API; api.github.com unless the runner says
//   GITHUB_OUTPUT          where a step's outputs are written
//
// What it writes: the outputs `token`, `slug` and `expires-at`. The token is
// masked in the log before anything else is said and is never printed.
//
// With neither half of an App passed it mints nothing and succeeds: the
// posting steps then use the personal access token or the Actions token.
// Half an App, no list of permissions, or a refusal from GitHub stops the
// step by name (rule 6): it never falls through to a weaker identity, and it
// never mints a token that holds everything the App does.
//
// packages/action/src/identity.ts signs in the same way for a qare-action
// run outside a workflow. This file repeats that on purpose, so that it can
// run before any build exists.
import { createPrivateKey, createSign } from 'node:crypto'
import { appendFileSync } from 'node:fs'

/** GitHub accepts a JSON web token for at most ten minutes; nine leaves room for a clock that runs fast. */
const JWT_LIFETIME_SECONDS = 9 * 60
/** Dated a minute back, so a runner whose clock is ahead of GitHub's is not refused. */
const JWT_BACKDATE_SECONDS = 60

class MintError extends Error {}

function set(name) {
  const value = process.env[name]
  return value === undefined || value.trim() === '' ? undefined : value
}

/** The permissions the job named: a non-empty object of GitHub's permission names to read or write. */
function permissionsFrom(text) {
  const problem = (why) =>
    new MintError(
      `QARE_APP_PERMISSIONS must name what the token may do, as JSON such as {"issues":"write"} (${why}): a token is never minted with everything the App holds`,
    )
  if (text === undefined) throw problem('it is not set')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw problem('it is not JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw problem('it is not an object')
  const entries = Object.entries(parsed)
  if (entries.length === 0) throw problem('it names no permission')
  for (const [name, level] of entries) {
    if (!/^[a-z][a-z_]*$/.test(name)) throw problem(`${JSON.stringify(name)} is not a permission name`)
    if (level !== 'read' && level !== 'write') throw problem(`${name} must be read or write`)
  }
  return Object.fromEntries(entries)
}

function signingKey(pem) {
  let key
  try {
    key = createPrivateKey(pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem)
  } catch {
    // Whatever the parser said may quote what it was given: say only which secret is wrong.
    throw new MintError(
      'app-private-key is not a private key qare can read: it must be the whole .pem file GitHub generated for the App, from "-----BEGIN" to "-----END"',
    )
  }
  if (key.asymmetricKeyType !== 'rsa') throw new MintError('app-private-key must be the RSA private key GitHub generated for the App')
  return key
}

/** RS256 over the App id and a short lifetime: the only thing the private key is ever used for. */
function jwt(appId, key) {
  const issuedAt = Math.floor(Date.now() / 1000) - JWT_BACKDATE_SECONDS
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const claims = { iat: issuedAt, exp: issuedAt + JWT_BACKDATE_SECONDS + JWT_LIFETIME_SECONDS, iss: appId }
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}`
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(key).toString('base64url')}`
}

/** No request waits longer than this: a connection that stalls must not hold the job for hours. */
const REQUEST_TIMEOUT_MS = 30_000

async function ask(apiRoot, bearer, method, path, payload) {
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${bearer}` }
  if (payload !== undefined) headers['Content-Type'] = 'application/json'
  const response = await fetch(new URL(`${apiRoot}${path}`), {
    method,
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  })
  return { status: response.status, ok: response.ok, text: await response.text() }
}

/**
 * One question asked as the App, asked once more when GitHub was briefly
 * away (a 5xx, or a connection that failed or stalled). A refusal is an
 * answer and is never asked again. Only a question is asked twice: the
 * request that creates the token is made once, because a first answer lost
 * on the way would leave a token nobody holds.
 */
async function asApp(apiRoot, bearer, method, path, payload) {
  try {
    const first = await ask(apiRoot, bearer, method, path, payload)
    if (first.status < 500) return first
  } catch {
    // Asked once more below; a second failure is the error that is reported.
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000))
  return ask(apiRoot, bearer, method, path, payload)
}

const RANK = new Map([
  ['read', 1],
  ['write', 2],
])

/**
 * Whether what GitHub says the token holds is within what was asked for.
 * The repositories it lists must be this one and no other. GitHub adds
 * `metadata: read` to every token; anything else it names that was not asked
 * for, or names at a higher level, is more than this job needs. A level that
 * is neither read nor write counts as more than either.
 */
function withinWhatWasAsked(answer, permissions, repository) {
  const reach = answer.repositories
  if (!Array.isArray(reach) || reach.length !== 1) return false
  const only = reach[0]
  if (only === null || typeof only !== 'object' || typeof only.full_name !== 'string') return false
  if (only.full_name.toLowerCase() !== repository.toLowerCase()) return false
  for (const [name, level] of Object.entries(answer.permissions)) {
    if (name === 'metadata' && level === 'read') continue
    const asked = Object.hasOwn(permissions, name) ? (RANK.get(permissions[name]) ?? 0) : 0
    if ((RANK.get(level) ?? 3) > asked) return false
  }
  return true
}

function json(text) {
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** What GitHub said, on one line and short: it is quoted in an error, never trusted. */
function said(text) {
  const message = json(text).message
  return (typeof message === 'string' ? message : text).replace(/\s+/g, ' ').slice(0, 300)
}

async function main() {
  const appId = set('QARE_APP_ID')
  const pem = set('QARE_APP_PRIVATE_KEY')
  if (appId === undefined && pem === undefined) {
    console.log('no GitHub App was passed (app-id and app-private-key are both empty): nothing is minted, and qare posts with the personal access token or the Actions token')
    return
  }
  if (appId === undefined || pem === undefined) {
    const [present, missing] = appId === undefined ? ['app-private-key', 'app-id'] : ['app-id', 'app-private-key']
    throw new MintError(
      `half a GitHub App was passed: ${present} is set and ${missing} is not. Pass both to post as the App, or neither to post with a token`,
    )
  }
  if (!/^[A-Za-z0-9._-]+$/.test(appId.trim())) throw new MintError("app-id must be the App's id or its client id, with no spaces")
  const permissions = permissionsFrom(set('QARE_APP_PERMISSIONS'))
  const repository = set('GITHUB_REPOSITORY') ?? ''
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository))
    throw new MintError(`GITHUB_REPOSITORY must be the calling repository as "owner/name" (got ${JSON.stringify(repository)})`)
  const output = set('GITHUB_OUTPUT')
  if (output === undefined) throw new MintError('GITHUB_OUTPUT is not set, so there is nowhere to hand the token on: it is never printed instead')
  const apiRoot = (set('GITHUB_API_URL') ?? ['https:', '//api.github.com'].join('')).replace(/\/+$/, '')

  const bearer = jwt(appId.trim(), signingKey(pem))
  const refused = new MintError(
    "GitHub refused to sign qare in as the App: app-id and app-private-key must be the id and a private key of the same App, and this machine's clock must be right",
  )

  const found = await asApp(apiRoot, bearer, 'GET', `/repos/${repository}/installation`)
  if (found.status === 401) throw refused
  if (found.status === 404)
    throw new MintError(
      `the GitHub App that app-id names is not installed on ${repository}: install it on the repository, or pass neither app-id nor app-private-key to post with a token`,
    )
  if (!found.ok) throw new MintError(`GitHub would not say where the App is installed (${found.status}): ${said(found.text)}`)
  const installation = json(found.text)
  if (typeof installation.id !== 'number') throw new MintError(`GitHub did not name the App's installation on ${repository}`)
  const slug = installation.app_slug
  if (typeof slug !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(slug))
    throw new MintError('GitHub did not say what the App is called, so qare could not find its own comments again')

  const names = Object.entries(permissions)
    .map(([name, level]) => `${name}: ${level}`)
    .join(', ')
  // This repository alone, whatever else the App is installed on, and what
  // this job needs alone, whatever else the App may do.
  const granted = await ask(apiRoot, bearer, 'POST', `/app/installations/${installation.id}/access_tokens`, {
    repositories: [repository.split('/')[1]],
    permissions,
  })
  if (granted.status === 401) throw refused
  if (granted.status === 422)
    throw new MintError(
      `GitHub would not give the App a token for ${repository} with ${names}: the App must hold each of these as a repository permission, and its installation must cover the repository (${said(granted.text)})`,
    )
  if (!granted.ok) throw new MintError(`GitHub would not give the App a token (${granted.status}): ${said(granted.text)}`)
  const answer = json(granted.text)
  const token = answer.token
  const expiresAt = answer.expires_at
  if (typeof token !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(token) || typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt)))
    throw new MintError('GitHub answered the request for an installation token without a token and its expiry')
  // Checked, never assumed: the token is handed on only when GitHub says it
  // holds no more than was asked for. One that holds more is given back.
  const scoped = answer.permissions !== null && typeof answer.permissions === 'object' && !Array.isArray(answer.permissions)
  if (!scoped || !withinWhatWasAsked(answer, permissions, repository)) {
    // Said only when GitHub confirmed it: otherwise the token is still out there until it expires.
    const revoked = await ask(apiRoot, token, 'DELETE', '/installation/token').then(
      (response) => response.status === 204,
      () => false,
    )
    const fate = revoked ? 'it was given back' : `it could not be given back and expires at ${new Date(Date.parse(expiresAt)).toISOString()}`
    throw new MintError(
      scoped
        ? `GitHub answered with a token that holds more than this job asked for (${names}, for ${repository} alone): ${fate}, and nothing is handed on`
        : `GitHub did not say what the token holds, so it cannot be shown to hold no more than this job asked for: ${fate}, and nothing is handed on`,
    )
  }

  // Masked before anything else is said, so no later line of any step can show it.
  console.log(`::add-mask::${token}`)
  appendFileSync(output, `token=${token}\nslug=${slug}\nexpires-at=${new Date(Date.parse(expiresAt)).toISOString()}\n`)
  console.log(`minted a token for ${repository} alone, as ${slug}[bot], with ${names}; it expires at ${new Date(Date.parse(expiresAt)).toISOString()}`)
}

main().catch((error) => {
  // Only what this file wrote is said: an unexpected error may quote what it
  // was handed, so it is named by its kind and its system code alone.
  const code = error instanceof Error && typeof error.cause?.code === 'string' && /^[A-Z0-9_]+$/.test(error.cause.code) ? ` (${error.cause.code})` : ''
  console.error(error instanceof MintError ? error.message : `the App's token could not be minted: ${error instanceof Error ? error.name : 'unknown error'}${code}`)
  process.exitCode = 1
})
