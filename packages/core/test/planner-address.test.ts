import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  checkCriteria,
  flowDriverFor,
  ingestCriteria,
  loadProfile,
  plannerAddress,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRunner,
} from '../src/index.js'

// #267: the plan step can be told how the app is addressed in three ways (a
// running target, a client build, an app the run boots), and each caller that
// plans passed only the ones its author thought of. One helper reads all
// three from the profile, and every caller uses it.

const TARGET_URL = ['https:', '//wiki.example.test'].join('')
const APP_ADDRESS = ['http:', '//localhost:{{run.app_port}}'].join('')

async function profileDir(config: string[]): Promise<{ dir: string; profile: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-planner-address-'))
  const profile = join(dir, '.qa')
  await mkdir(join(profile, 'fixtures'), { recursive: true })
  await mkdir(join(profile, 'stubs'), { recursive: true })
  await writeFile(join(profile, 'QA.md'), '# QA\n')
  await writeFile(join(profile, 'fixtures', 'users.yml'), '')
  await writeFile(join(profile, 'config.yml'), [...config, ''].join('\n'))
  return { dir, profile }
}

const TARGET_CONFIG = ['target:', `  url: ${TARGET_URL}`, '  health: { http: /health, timeout: 1s }']

function appConfig(health: string): string[] {
  return [
    'app:',
    '  boot: { compose: compose.qa.yaml, service: web }',
    `  health: { http: "${health}", timeout: 1s }`,
    '  seed: { command: "true" }',
    '  login: { fixture: fixtures/users.yml, role: admin }',
    'stubs: []',
    'visual:',
    '  widths: [390]',
    '  themes: [light]',
    'suites: []',
  ]
}

/** A planner that keeps every prompt it is handed and marks every criterion it is asked about unplannable. */
function recordingPlanner(): { runner: AgentRunner; prompts: string[] } {
  const prompts: string[] = []
  const runner: AgentRunner = {
    run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
      prompts.push(request.prompt)
      const list = request.prompt.split('Criteria:\n')[1]?.split('\n\n')[0] ?? ''
      const criteria = [...list.matchAll(/^- ([^:\s]+): (.*)$/gm)].map((match) => ({ id: match[1], text: match[2], unplannable: 'nothing here can show it' }))
      return { status: 'completed', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, output: JSON.stringify({ schemaVersion: '1', criteria }) }
    },
  }
  return { runner, prompts }
}

test('a profile that names a target gives the planner its URL, and nothing else', async () => {
  const { profile } = await profileDir(TARGET_CONFIG)
  expect(plannerAddress(await loadProfile(profile))).toEqual({ target: TARGET_URL })
})

test.each([
  ['the run port by name', ['http:', '//localhost:{{run.app_port}}/up'].join('')],
  ['a fixed local port, which the run pins to its own', ['http:', '//localhost:3000/up'].join('')],
])('a profile that boots its app gives the planner the address a plan may write, for a health check that names %s', async (_label, health) => {
  const { profile } = await profileDir(appConfig(health))
  expect(plannerAddress(await loadProfile(profile))).toEqual({ app: { address: APP_ADDRESS } })
})

test('a client build gives the planner its driver, and an app whose health check names no origin gives nothing', () => {
  expect(plannerAddress({ client: { driver: 'electron' } } as Parameters<typeof plannerAddress>[0])).toEqual({ client: 'electron' })
  expect(plannerAddress({ app: { health: { http: '/up' } } } as Parameters<typeof plannerAddress>[0])).toEqual({})
  expect(plannerAddress(undefined)).toEqual({})
  expect(plannerAddress({})).toEqual({})
})

test("qare check tells the planner the booted app's address for a profile that boots its app", async () => {
  const { dir, profile } = await profileDir(appConfig(['http:', '//localhost:3000/up'].join('')))
  const planner = recordingPlanner()

  await checkCriteria({
    criteria: ['the home page loads'],
    profileDir: profile,
    repoPath: dir,
    evidenceDir: join(dir, 'evidence'),
    planner: planner.runner,
    verifier: 'none',
    run: { runCompose: async () => ({ code: 0, stdout: '', stderr: '' }), probe: async () => ({ ok: true }), pollIntervalMs: 1 },
  })

  expect(planner.prompts).toHaveLength(1)
  expect(planner.prompts[0]).toContain(`The run boots the app itself and publishes it on a port chosen for the run, so its address is ${APP_ADDRESS}.`)
  expect(planner.prompts[0]).toContain(`{"action":"open","url":"${APP_ADDRESS}/some/page"}`)
  // The number the profile wrote is not where this run's app will be.
  expect(planner.prompts[0]).not.toContain('localhost:3000')
  expect(planner.prompts[0]).not.toContain('The app is already running at')
})

test('qare check still tells the planner where a running target is', async () => {
  const { dir, profile } = await profileDir(TARGET_CONFIG)
  const planner = recordingPlanner()

  await checkCriteria({
    criteria: ['the home page loads'],
    profileDir: profile,
    repoPath: dir,
    evidenceDir: join(dir, 'evidence'),
    planner: planner.runner,
    verifier: 'none',
    run: { probe: async () => ({ ok: true }), pollIntervalMs: 1 },
  })

  expect(planner.prompts[0]).toContain(`The app is already running at ${TARGET_URL}.`)
  expect(planner.prompts[0]).not.toContain('The run boots the app itself')
})

// The address is built from the parts that cannot carry a secret (scheme,
// host and port) and from nothing else, so there is no spelling of a
// credential that a removal rule could have failed to think of.
const SECRETS = ['SECRETUSER', 'SECRETPASS', 'SECRETPATH', 'SECRETPARAM', 'SECRETQUERY', 'SECRETFRAG']
const TARGET_HOST = 'wiki.example.test:8443'
const TARGET_ORIGIN = ['https:', `//${TARGET_HOST}`].join('')
/** A target URL with a secret in every part a URL has besides its origin. */
const LOADED_URL = ['https:', `//SECRETUSER:SECRETPASS@${TARGET_HOST}/t/SECRETPATH;sid=SECRETPARAM/app?sig=SECRETQUERY&expires=9#token=SECRETFRAG`].join('')

function expectNoSecret(text: string, label: string): void {
  for (const secret of SECRETS) expect(text.toLowerCase(), `${label} must not carry ${secret}`).not.toContain(secret.toLowerCase())
}

test('the planner is told the origin of a target and no other part of its URL', () => {
  const told = (url: string): string => plannerAddress({ target: { url } } as Parameters<typeof plannerAddress>[0]).target ?? ''

  expect(told(LOADED_URL)).toBe(TARGET_ORIGIN)
  // However the URL is spelt: every one of these is the same origin to the parser the profile loader uses.
  const spellings = [
    `  ${LOADED_URL}  `,
    LOADED_URL.replace('https:', 'HTTPS:'),
    // A password that itself holds an @, a userinfo with no password, and a backslash where a slash would be.
    ['https:', `//SECRETUSER:SECRET@PASS@${TARGET_HOST}/SECRETPATH`].join(''),
    ['https:', `//SECRETUSER@${TARGET_HOST}?SECRETQUERY`].join(''),
    ['https:', `\\\\SECRETUSER:SECRETPASS@${TARGET_HOST}\\SECRETPATH`].join(''),
    ['https:', `//${TARGET_HOST}/#SECRETFRAG`].join(''),
    ['https:', `//${TARGET_HOST}//SECRETPATH@elsewhere.test/`].join(''),
  ]
  for (const spelling of spellings) {
    expect(told(spelling), spelling).toBe(TARGET_ORIGIN)
    expectNoSecret(told(spelling), spelling)
  }
  // The default port is no part of an origin, and a URL with no path is its own origin.
  expect(told(TARGET_URL)).toBe(TARGET_URL)
  expect(told(['https:', '//wiki.example.test:443/base'].join(''))).toBe(TARGET_URL)
  // What is not an http(s) URL has no origin to tell: it is not written at all.
  for (const unread of ['SECRETUSER:SECRETPASS@nowhere', 'not a url SECRETPATH', ['https:', '//{{SECRETPASS}}/app'].join(''), ['https:', '//wiki.example.test:SECRETPASS/app'].join(''),['ftp:', '//SECRETUSER:SECRETPASS@files.example.test/'].join('')]) {
    expect(plannerAddress({ target: { url: unread } } as Parameters<typeof plannerAddress>[0]), unread).toEqual({})
  }
})

test("a booted app's address leaves out its health check's credentials, a password with an @ in it included", () => {
  const address = (health: string): string => plannerAddress({ app: { health: { http: health } } } as Parameters<typeof plannerAddress>[0]).app?.address ?? ''
  for (const health of [
    ['http:', '//SECRETUSER:SECRETPASS@localhost:3000/up?SECRETQUERY#SECRETFRAG'].join(''),
    ['http:', '//SECRETUSER:SECRET@PASS@localhost:{{run.app_port}}/SECRETPATH'].join(''),
  ]) {
    expect(address(health), health).toBe(APP_ADDRESS)
    expectNoSecret(address(health), health)
  }
  // A health check is any non-empty string to the profile loader, so the
  // address is rebuilt from what a URL parser reads as scheme, host and port.
  // Whatever does not read as such a URL tells the planner nothing at all.
  const malformed = [
    ['http:', '//SECRETUSER:SECRETPASS\\@localhost:3000/up'].join(''),
    ['http:', '//SECRETUSER:SECRETPASS\\\\@localhost:3000/up'].join(''),
    ['http:', '//localhost:SECRETPASS/up'].join(''),
    ['http:', '//SECRETUSER:SECRETPASS'].join(''),
    ['http:', '//localhost:{{run.app_port}}SECRETPASS/up'].join(''),
    ['http:', '//SECRETPASS{{run.app_port}}:3000/up'].join(''),
    ['http:', '//{{run.SECRETPASS}}:3000/up'].join(''),
    ['http:', '//localhost:3000:SECRETPASS/up'].join(''),
    'SECRETUSER:SECRETPASS@localhost:3000',
  ]
  for (const health of malformed) expectNoSecret(address(health), health)
  // A run value is taken as the port and nowhere else, and a port a parser drops as the default is still the run's.
  expect(address(['http:', '//127.0.0.1:{{ run.app_port }}/up'].join(''))).toBe(['http:', '//127.0.0.1:{{run.app_port}}'].join(''))
  expect(address(['http:', '//localhost:{{run.other_port}}/up'].join(''))).toBe('')
  expect(address(['http:', '//localhost:80/up'].join(''))).toBe(APP_ADDRESS)
  expect(address(['https:', '//staging.example.test:8443/up'].join(''))).toBe(['https:', '//staging.example.test:8443'].join(''))
  expect(address(['https:', '//staging.example.test/up'].join(''))).toBe(['https:', '//staging.example.test'].join(''))
})

test('no part of a target URL but its origin reaches the prompt of qare check or of ledger ingest', async () => {
  const { dir, profile } = await profileDir(['target:', `  url: "${LOADED_URL}"`, '  health: { http: /health, timeout: 1s }'])
  const loaded = await loadProfile(profile)
  // The profile holds the URL whole: the run needs every part of it.
  expect(loaded.target?.url).toBe(LOADED_URL)

  const checking = recordingPlanner()
  await checkCriteria({
    criteria: ['the home page loads'],
    profileDir: profile,
    repoPath: dir,
    evidenceDir: join(dir, 'evidence'),
    planner: checking.runner,
    verifier: 'none',
    run: { probe: async () => ({ ok: true }), pollIntervalMs: 1 },
  })
  expect(checking.prompts).toHaveLength(1)
  expect(checking.prompts[0]).toContain(`The app is already running at ${TARGET_ORIGIN}.`)
  expectNoSecret(checking.prompts[0] ?? '', 'the prompt of qare check')

  const ingesting = recordingPlanner()
  const source = { kind: 'issue' as const, number: 7, author: 'someone', link: ['https:', '//example.test/issues/7'].join(''), body: '## Acceptance criteria\n\n- [ ] the payouts page shows the notice\n' }
  await ingestCriteria([source], { ledger: [], planner: ingesting.runner, address: plannerAddress(loaded) })
  expect(ingesting.prompts[0]).toContain(`The app is already running at ${TARGET_ORIGIN}.`)
  expectNoSecret(ingesting.prompts[0] ?? '', 'the prompt of ledger ingest')
})

test('ledger ingest holds a plan to the driver the profile names, so a client build is not told one thing and offered another', async () => {
  const body = '## Acceptance criteria\n\n- [ ] the settings window looks right\n'
  const source = { kind: 'issue' as const, number: 7, author: 'someone', link: ['https:', '//example.test/issues/7'].join(''), body }
  const profile = { client: { driver: 'electron' } } as Parameters<typeof flowDriverFor>[0]
  const prompts: string[] = []
  // A planner that answers a client build with a visual check, which the electron driver does not capture.
  const planner: AgentRunner = {
    run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
      prompts.push(request.prompt)
      const list = request.prompt.split('Criteria:\n')[1]?.split('\n\n')[0] ?? ''
      const criteria = [...list.matchAll(/^- ([^:\s]+): (.*)$/gm)].map((match) => ({ id: match[1], text: match[2], checks: [{ kind: 'visual', name: 'settings', screenshot: 'settings' }] }))
      return { status: 'completed', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, output: JSON.stringify({ schemaVersion: '1', criteria }) }
    },
  }

  const refused = ingestCriteria([source], { ledger: [], planner, address: plannerAddress(profile), driver: flowDriverFor(profile) })

  // The plan step corrects it once and then refuses it: no proposal is made for proof the profile cannot run.
  await expect(refused).rejects.toThrow(/visual/)
  expect(prompts).toHaveLength(2)
  expect(prompts[0]).toContain('The app is a desktop build launched by the run through the electron driver.')
  expect(prompts[1]).toContain('Your previous answer was rejected')

  // With no driver named, ingest plans against the browser, as it always did, and the same answer stands.
  const browser: string[] = []
  await ingestCriteria([source], { ledger: [], planner: { run: async (request) => (browser.push(request.prompt), planner.run(request)) } })
  expect(browser).toHaveLength(1)
})

test('ledger ingest hands the planner whatever address the helper read from the profile', async () => {
  const source = (body: string) => ({ kind: 'issue' as const, number: 7, author: 'someone', link: ['https:', '//example.test/issues/7'].join(''), body })
  const body = '## Acceptance criteria\n\n- [ ] the payouts page shows the notice\n'

  const onTarget = recordingPlanner()
  await ingestCriteria([source(body)], { ledger: [], planner: onTarget.runner, address: plannerAddress({ target: { url: TARGET_URL } } as Parameters<typeof plannerAddress>[0]) })
  expect(onTarget.prompts[0]).toContain(`The app is already running at ${TARGET_URL}.`)

  const booted = recordingPlanner()
  const { profile } = await profileDir(appConfig(['http:', '//localhost:3000/up'].join('')))
  await ingestCriteria([source(body)], { ledger: [], planner: booted.runner, address: plannerAddress(await loadProfile(profile)) })
  expect(booted.prompts[0]).toContain(`its address is ${APP_ADDRESS}.`)

  const none = recordingPlanner()
  await ingestCriteria([source(body)], { ledger: [], planner: none.runner })
  expect(none.prompts[0]).not.toContain('The app is already running at')
  expect(none.prompts[0]).not.toContain('The run boots the app itself')
})
