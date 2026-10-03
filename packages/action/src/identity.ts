import { createPrivateKey, createSign, type KeyObject } from 'node:crypto'
import { GitHubApiError, GitHubClientError } from './errors.js'

/**
 * Who qare is on GitHub (#61, ADR-0003). Everything qare writes, a comment,
 * an issue, a check run, a branch, a pull request, is written as one
 * identity, and which one is the install's choice, made by the credentials it
 * configures and never by code:
 *
 * - a GitHub App installation: `QARE_APP_ID` and `QARE_APP_PRIVATE_KEY`
 * - a personal access token: `QARE_GITHUB_TOKEN`
 * - the Actions token every workflow run is handed: `GITHUB_TOKEN`
 *
 * in that order, so an install that sets the App's two secrets posts as the
 * App with no other change. The posting code is written against the
 * interface and never learns which it was given.
 */
export interface GitHubIdentity {
  readonly kind: 'app' | 'token' | 'actions'
  /** The token a request is made with. Asked for each request, so it may be renewed. */
  token(): Promise<string>
  /**
   * The token a check run is written with. GitHub lets only an App write
   * one, so a personal token hands this to the Actions token beside it.
   */
  checksToken(): Promise<string>
  /** The login what it writes is attributed to, which is how qare finds its own comment again. */
  login(): Promise<string>
}

export const APP_ID_ENV = 'QARE_APP_ID'
export const APP_PRIVATE_KEY_ENV = 'QARE_APP_PRIVATE_KEY'
export const PERSONAL_TOKEN_ENV = 'QARE_GITHUB_TOKEN'
export const ACTIONS_TOKEN_ENV = 'GITHUB_TOKEN'

/** The login the Actions token writes as. */
export const ACTIONS_LOGIN = 'github-actions[bot]'

export const DEFAULT_API_ROOT = ['https:', '//api.github.com'].join('')

export interface IdentityOptions {
  /** "owner/name": an App is installed per repository, and its token is scoped to this one. */
  repository: string
  apiRoot?: string | undefined
  fetchImpl?: typeof fetch | undefined
  /** Where the credentials are read from. The process environment unless a test says otherwise. */
  env?: Record<string, string | undefined> | undefined
  /** A token handed over directly: the caller's explicit choice, above everything in the environment. */
  token?: string | undefined
  /** A variable named on the command line (`--token-env`): the same explicit choice, by name. */
  tokenEnv?: string | undefined
  /** The clock, in milliseconds. A test moves it to reach a token's expiry. */
  now?: (() => number) | undefined
}

/**
 * Choose the identity from what is configured. Fails closed (rule 6): half an
 * App is an error and never a quiet fall to a weaker identity, and no
 * credential at all names every way there is to configure one.
 */
export function resolveIdentity(options: IdentityOptions): GitHubIdentity {
  const env = options.env ?? process.env
  const set = (name: string): string | undefined => {
    const value = env[name]
    return value === undefined || value.trim() === '' ? undefined : value
  }
  const transport = {
    apiRoot: (options.apiRoot ?? DEFAULT_API_ROOT).replace(/\/+$/, ''),
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
  }

  if (options.token !== undefined && options.token !== '') return new TokenIdentity(options.token, set(ACTIONS_TOKEN_ENV), transport)
  if (options.tokenEnv !== undefined) {
    const named = set(options.tokenEnv)
    if (named === undefined)
      throw new GitHubClientError(`qare-action needs a GitHub token: set ${options.tokenEnv} in the environment (or pass { token } to GitHubClient)`)
    return new TokenIdentity(named, set(ACTIONS_TOKEN_ENV), transport)
  }

  const appId = set(APP_ID_ENV)
  const privateKey = set(APP_PRIVATE_KEY_ENV)
  if (appId !== undefined || privateKey !== undefined) {
    if (appId === undefined || privateKey === undefined) {
      const missing = appId === undefined ? APP_ID_ENV : APP_PRIVATE_KEY_ENV
      const present = appId === undefined ? APP_PRIVATE_KEY_ENV : APP_ID_ENV
      throw new GitHubClientError(
        `qare-action was given half a GitHub App: ${present} is set and ${missing} is not. Set both to post as the App, or neither to post with a token`,
      )
    }
    return new AppInstallationIdentity({ appId, privateKey, repository: options.repository, now: options.now, ...transport })
  }

  const personal = set(PERSONAL_TOKEN_ENV)
  if (personal !== undefined) return new TokenIdentity(personal, set(ACTIONS_TOKEN_ENV), transport)

  const actions = set(ACTIONS_TOKEN_ENV)
  if (actions !== undefined) return new ActionsTokenIdentity(actions)

  throw new GitHubClientError(
    `qare-action needs a GitHub token: set ${APP_ID_ENV} and ${APP_PRIVATE_KEY_ENV} to post as a GitHub App, ${PERSONAL_TOKEN_ENV} to post with a personal access token, or ${ACTIONS_TOKEN_ENV} to post as the workflow run`,
  )
}

/** The token a workflow run is handed. It writes as github-actions[bot], and a pull request it opens triggers no workflows. */
export class ActionsTokenIdentity implements GitHubIdentity {
  readonly kind = 'actions' as const

  constructor(private readonly value: string) {}

  token(): Promise<string> {
    return Promise.resolve(this.value)
  }

  checksToken(): Promise<string> {
    return Promise.resolve(this.value)
  }

  login(): Promise<string> {
    return Promise.resolve(ACTIONS_LOGIN)
  }
}

interface Transport {
  apiRoot: string
  fetchImpl: typeof fetch
}

/** A personal access token: what it writes is that user's. */
export class TokenIdentity implements GitHubIdentity {
  readonly kind = 'token' as const
  private known: string | undefined

  constructor(
    private readonly value: string,
    /** The Actions token of the run it is used in, when there is one: the only one of the two that may write a check run. */
    private readonly actionsToken: string | undefined,
    private readonly transport: Transport,
  ) {}

  token(): Promise<string> {
    return Promise.resolve(this.value)
  }

  checksToken(): Promise<string> {
    return Promise.resolve(this.actionsToken ?? this.value)
  }

  async login(): Promise<string> {
    if (this.known !== undefined) return this.known
    const response = await this.transport.fetchImpl(new URL(`${this.transport.apiRoot}/user`), {
      method: 'GET',
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.value}` },
    })
    if (response.status === 403) {
      // Not a user: a token handed over by name that belongs to an
      // installation. The one a pipeline hands qare is the Actions token.
      this.known = ACTIONS_LOGIN
      return this.known
    }
    if (!response.ok) throw new GitHubApiError(response.status, 'GET /user', await response.text())
    const login = ((await response.json()) as { login?: unknown }).login
    if (typeof login !== 'string' || login === '')
      throw new GitHubClientError('GitHub did not say which user the token belongs to, so qare cannot find its own comments')
    this.known = login
    return login
  }
}

/** How long a JSON web token lives. GitHub accepts at most ten minutes; nine leaves room for a clock that runs fast. */
const JWT_LIFETIME_SECONDS = 9 * 60
/** A JSON web token is dated a minute back, so a runner whose clock is ahead of GitHub's is not refused. */
const JWT_BACKDATE_SECONDS = 60
/** An installation token this close to its expiry is replaced, so no request outlives it. */
const RENEW_BEFORE_MS = 60 * 1000

export interface AppInstallationOptions extends Transport {
  appId: string
  /** PEM, as GitHub hands it out. Newlines may arrive escaped, as a secret pasted on one line. */
  privateKey: string
  repository: string
  now?: (() => number) | undefined
}

/**
 * A GitHub App, as installed on one repository. The App proves who it is
 * with a JSON web token signed by its private key, asks which installation
 * covers the repository, and is given a token for that installation, scoped
 * here to the one repository, that expires within the hour. The token is
 * kept for the run and replaced when it nears its expiry.
 *
 * Built against GitHub's documented REST API ("Authenticating as a GitHub
 * App installation") and tested against a fake of it.
 */
export class AppInstallationIdentity implements GitHubIdentity {
  readonly kind = 'app' as const
  private readonly appId: string
  private readonly pem: string
  private readonly repository: string
  private readonly transport: Transport
  private readonly now: () => number
  private key: KeyObject | undefined
  private installation: number | undefined
  private current: { token: string; expiresAt: number } | undefined
  private slug: string | undefined

  constructor(options: AppInstallationOptions) {
    // A numeric App id or a client id ("Iv23li..."): either is a valid issuer.
    if (!/^[A-Za-z0-9._-]+$/.test(options.appId.trim()))
      throw new GitHubClientError(`${APP_ID_ENV} must be the App's id or its client id, with no spaces`)
    this.appId = options.appId.trim()
    this.pem = options.privateKey.includes('\\n') ? options.privateKey.replace(/\\n/g, '\n') : options.privateKey
    this.repository = options.repository
    this.transport = { apiRoot: options.apiRoot, fetchImpl: options.fetchImpl }
    this.now = options.now ?? Date.now
  }

  async token(): Promise<string> {
    if (this.current !== undefined && this.current.expiresAt - this.now() > RENEW_BEFORE_MS) return this.current.token
    const installation = await this.installationId()
    const name = this.repository.split('/')[1] ?? ''
    const granted = await this.asApp<{ token?: unknown; expires_at?: unknown }>(
      'POST',
      `/app/installations/${installation}/access_tokens`,
      // This repository alone, whatever else the App is installed on.
      { repositories: [name] },
    )
    const expiresAt = typeof granted.expires_at === 'string' ? Date.parse(granted.expires_at) : Number.NaN
    if (typeof granted.token !== 'string' || granted.token === '' || Number.isNaN(expiresAt))
      throw new GitHubClientError('GitHub answered the request for an installation token without a token and its expiry')
    this.current = { token: granted.token, expiresAt }
    return granted.token
  }

  checksToken(): Promise<string> {
    return this.token()
  }

  async login(): Promise<string> {
    if (this.slug === undefined) {
      const app = await this.asApp<{ slug?: unknown }>('GET', '/app')
      if (typeof app.slug !== 'string' || app.slug === '')
        throw new GitHubClientError('GitHub did not say what the App is called, so qare cannot find its own comments')
      this.slug = app.slug
    }
    return `${this.slug}[bot]`
  }

  private async installationId(): Promise<number> {
    if (this.installation !== undefined) return this.installation
    try {
      const found = await this.asApp<{ id?: unknown }>('GET', `/repos/${this.repository}/installation`)
      if (typeof found.id !== 'number') throw new GitHubClientError(`GitHub did not name the App's installation on ${this.repository}`)
      this.installation = found.id
      return found.id
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404)
        throw new GitHubClientError(
          `the GitHub App ${APP_ID_ENV} names is not installed on ${this.repository}: install it on the repository, or unset ${APP_ID_ENV} and ${APP_PRIVATE_KEY_ENV} to post with a token`,
        )
      throw error
    }
  }

  private async asApp<T>(method: string, path: string, payload?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.jwt()}` }
    if (payload !== undefined) headers['Content-Type'] = 'application/json'
    const response = await this.transport.fetchImpl(new URL(`${this.transport.apiRoot}${path}`), {
      method,
      headers,
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    })
    if (response.status === 401)
      throw new GitHubClientError(
        `GitHub refused to sign qare in as the App: ${APP_ID_ENV} and ${APP_PRIVATE_KEY_ENV} must be the id and a private key of the same App, and this machine's clock must be right`,
      )
    if (!response.ok) throw new GitHubApiError(response.status, `${method} ${path}`, await response.text())
    return (await response.json()) as T
  }

  /** RS256 over the App id and a short lifetime: the only thing the private key is ever used for. */
  private jwt(): string {
    const key = this.signingKey()
    const issuedAt = Math.floor(this.now() / 1000) - JWT_BACKDATE_SECONDS
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const claims = { iat: issuedAt, exp: issuedAt + JWT_BACKDATE_SECONDS + JWT_LIFETIME_SECONDS, iss: this.appId }
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}`
    return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(key).toString('base64url')}`
  }

  private signingKey(): KeyObject {
    if (this.key !== undefined) return this.key
    let key: KeyObject
    try {
      key = createPrivateKey(this.pem)
    } catch {
      // Whatever the parser said may quote what it was given: say only which
      // variable is wrong.
      throw new GitHubClientError(
        `${APP_PRIVATE_KEY_ENV} is not a private key qare can read: it must be the whole .pem file GitHub generated for the App, from "-----BEGIN" to "-----END"`,
      )
    }
    if (key.asymmetricKeyType !== 'rsa')
      throw new GitHubClientError(`${APP_PRIVATE_KEY_ENV} must be the RSA private key GitHub generated for the App`)
    this.key = key
    return key
  }
}
