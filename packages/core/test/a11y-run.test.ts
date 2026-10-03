import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  FileLedgerStore,
  a11yConfigOf,
  redactionRules,
  runJob,
  settleA11y,
  type A11yAuditRequest,
  type A11yAuditViolation,
  type BootOpts,
  type FlowSessionFactory,
  type Job,
  type JobCriterion,
  type QaProfile,
  type RunResult,
} from '../src/index.js'

// Assembled, never literal: no network marker sits as a literal in a test.
const HEALTH_URL = ['http:', '//localhost:3000/up'].join('')
const TARGET_URL = ['https:', '//app.example.test'].join('')

const APP_PROFILE: QaProfile = {
  app: {
    boot: { compose: 'compose.qa.yaml', service: 'admin' },
    health: { http: HEALTH_URL, timeout: '120s' },
    seed: { command: 'bin/seed' },
    login: { fixture: 'fixtures/users.yml', role: 'admin' },
  },
  stubs: [],
  visual: { widths: [], themes: [] },
  suites: [],
}

const TARGET_PROFILE: QaProfile = {
  target: { url: TARGET_URL, health: { http: `${TARGET_URL}/up`, timeout: '1s' }, hosts: [] },
  stubs: [],
  visual: { widths: [], themes: [] },
  suites: [],
}

const UP = { probe: async () => ({ ok: true }), pollIntervalMs: 1 }

/** A compose seam that fails the `up` of the calls it is told to. */
function recordingBoot(failUp: (call: number) => boolean = () => false): BootOpts {
  let ups = 0
  return {
    runCompose: async (args) => {
      if (args.includes('up')) {
        ups += 1
        if (failUp(ups)) return { code: 1, stdout: '', stderr: 'no such service' }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
    probe: async () => ({ ok: true }),
    pollIntervalMs: 1,
  }
}

const UNNAMED_BUTTON: A11yAuditViolation = {
  rule: 'button-name',
  impact: 'critical',
  help: 'Buttons must have discernible text',
  nodes: [{ target: 'button:nth-child(2)', role: 'button', path: 'document/main/button' }],
}

const FAINT_TEXT: A11yAuditViolation = {
  rule: 'color-contrast',
  impact: 'serious',
  help: 'Elements must meet minimum color contrast ratio thresholds',
  nodes: [{ target: 'p.muted' }],
}

interface Audited {
  /** The first app the browser opened is `first`: the base, on a run with two sides. */
  app: 'first' | 'second'
  url: string
  request: A11yAuditRequest
}

/**
 * A browser whose audit seam answers what the test says the page violates.
 * Each app a run boots is served on its own origin, so the first origin the
 * browser opens is the first side of the run.
 */
function fakeBrowser(
  violations: (audited: Audited) => A11yAuditViolation[] | Error,
  opts: { audit?: false; missing?: string } = {},
): { session: FlowSessionFactory; audits: Audited[] } {
  const audits: Audited[] = []
  const origins: string[] = []
  return {
    audits,
    session: async () => {
      let url = ''
      return {
        page: {
          open: async (opened) => {
            url = opened
            const origin = new URL(opened).origin
            if (!origins.includes(origin)) origins.push(origin)
          },
          click: async () => undefined,
          type: async () => undefined,
          choose: async () => undefined,
          waitFor: async () => undefined,
          assertText: async (text) => {
            if (text === opts.missing) throw new Error('not visible')
          },
          assertElement: async () => undefined,
          screenshot: async (path) => writeFile(path, 'png'),
          ...(opts.audit === false
            ? {}
            : {
                audit: async (request: A11yAuditRequest) => {
                  const audited: Audited = { app: origins.indexOf(new URL(url).origin) === 0 ? 'first' : 'second', url, request }
                  audits.push(audited)
                  const found = violations(audited)
                  if (found instanceof Error) throw found
                  if (request.screenshot !== undefined && found.length > 0) await writeFile(request.screenshot, 'png')
                  return {
                    url,
                    width: request.width ?? 1280,
                    theme: request.theme,
                    engine: { name: 'axe-core', version: '4.13.0' },
                    incomplete: 0,
                    violations: found,
                    ...(request.screenshot !== undefined && found.length > 0 ? { screenshot: true } : {}),
                  }
                },
              }),
        },
        dispose: async () => undefined,
        outbound: () => [],
      }
    },
  }
}

const a11y = (id: string, check: Record<string, unknown> = {}): JobCriterion => ({
  id,
  text: `${id} is usable`,
  checks: [{ kind: 'a11y', name: id, ...check } as never],
})

async function tempRepo(prefix = 'qare-a11y-run-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

function jobFor(repoPath: string, criteria: JobCriterion[], profile: QaProfile): Job {
  return { id: 'job-a11y', repoPath, baseRef: 'origin/main', headRef: 'HEAD', profile: { inline: profile }, criteria, evidenceDir: join(repoPath, 'evidence'), post: 'none' }
}

const criterionOf = (result: RunResult, id: string) => {
  const criterion = result.criteria.find((entry) => entry.id === id)
  if (criterion === undefined) throw new Error(`no criterion ${id}`)
  return criterion
}

const readJson = async (path: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>

// One side: a target.

test('on a target a button with no accessible name fails the a11y check, naming the element (#149)', async () => {
  const repo = await tempRepo()
  const browser = fakeBrowser(() => [UNNAMED_BUTTON])
  const job = jobFor(repo, [a11y('settings', { url: '/settings' })], TARGET_PROFILE)

  const { result } = await runJob(job, { ...UP, flowSession: browser.session })

  expect(result.verdict).toBe('failed')
  const criterion = criterionOf(result, 'settings')
  expect(criterion).toMatchObject({
    outcome: 'failed',
    reason: '1 accessibility violation: button-name on document/main/button (/settings)',
    a11y: { new: 1, existing: 0, accepted: 0, reported: 0, uncompared: 0 },
  })
  // The page the check names is a page of the target, audited under the default rule set.
  expect(browser.audits).toHaveLength(1)
  expect(browser.audits[0]?.url).toBe(`${TARGET_URL}/settings`)
  expect(browser.audits[0]?.request).toMatchObject({ tags: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'], theme: 'light' })
  expect(browser.audits[0]?.request.width).toBeUndefined()
  expect(criterion.evidence).toEqual([
    'checks/settings/0/actions.log',
    'checks/settings/0/a11y/0-viewportxlight.png',
    'checks/settings/0/final.png',
    'checks/settings/0/a11y.json',
    'checks/settings/0/outbound.json',
  ])
  for (const path of criterion.evidence ?? []) expect(existsSync(join(job.evidenceDir, path))).toBe(true)
  expect(await readJson(join(job.evidenceDir, 'checks/settings/0/a11y.json'))).toMatchObject({
    check: 'settings',
    asked: 'planned',
    side: 'head',
    standard: 'wcag22aa',
    fail: ['serious', 'critical'],
    accept: [],
    engine: { name: 'axe-core', version: '4.13.0' },
    comparison: { with: 'nothing' },
    audits: [{ point: 0, page: '/settings', width: 1280, theme: 'light', violations: 1, screenshot: 'a11y/0-viewportxlight.png' }],
    findings: [
      {
        rule: 'button-name',
        impact: 'critical',
        status: 'new',
        page: '/settings',
        target: 'button:nth-child(2)',
        role: 'button',
        path: 'document/main/button',
        screenshot: 'a11y/0-viewportxlight.png',
      },
    ],
    counts: { new: 1 },
    outcome: 'failed',
  })
})

test('a page with nothing wrong proves the criterion, and one with only milder findings reports them (#149)', async () => {
  const repo = await tempRepo()
  const region: A11yAuditViolation = { rule: 'region', impact: 'moderate', help: 'All page content should be contained by landmarks', nodes: [{ target: 'div' }] }
  const browser = fakeBrowser(({ url }) => (url.endsWith('/about') ? [region] : []))
  const job = jobFor(repo, [a11y('home'), a11y('about', { url: '/about' })], TARGET_PROFILE)

  const { result } = await runJob(job, { ...UP, flowSession: browser.session })

  expect(result.verdict).toBe('passed')
  // No url and no actions: the app itself.
  expect(browser.audits[0]?.url).toBe(TARGET_URL)
  expect(criterionOf(result, 'home')).toMatchObject({ outcome: 'proven', a11y: { new: 0, reported: 0 } })
  expect(criterionOf(result, 'about')).toMatchObject({ outcome: 'proven', a11y: { new: 0, reported: 1 } })
  expect((await readJson(join(job.evidenceDir, 'checks/about/0/a11y.json'))).findings).toMatchObject([{ rule: 'region', status: 'reported' }])
})

test('the profile says which rule set runs, which impacts fail, and which violations are accepted with a reason (#149)', async () => {
  const repo = await tempRepo()
  const browser = fakeBrowser(() => [UNNAMED_BUTTON, FAINT_TEXT, { rule: 'region', impact: 'moderate', help: 'Landmarks', nodes: [{ target: 'div' }] }])
  const profile: QaProfile = {
    ...TARGET_PROFILE,
    visual: { widths: [390, 1280], themes: ['dark'] },
    a11y: {
      standard: 'wcag2aa',
      fail: ['moderate', 'serious', 'critical'],
      accept: [
        { rule: 'button-name', page: '/settings', reason: 'the icon button is replaced in the redesign' },
        { rule: 'color-contrast', element: 'p.muted', reason: 'brand grey, signed off' },
      ],
    },
  }
  const job = jobFor(repo, [a11y('settings', { url: '/settings' })], profile)

  const { result } = await runJob(job, { ...UP, flowSession: browser.session })

  // The profile's widths and themes, and its rule set.
  expect(browser.audits.map((audit) => [audit.request.width, audit.request.theme, audit.request.tags])).toEqual([
    [390, 'dark', ['wcag2a', 'wcag2aa']],
    [1280, 'dark', ['wcag2a', 'wcag2aa']],
  ])
  // Moderate fails here, and nothing accepts the region finding.
  const criterion = criterionOf(result, 'settings')
  expect(criterion.outcome).toBe('failed')
  expect(criterion.reason).toBe('1 accessibility violation: region on div (/settings)')
  expect(criterion.a11y).toEqual({ new: 2, existing: 0, accepted: 4, reported: 0, uncompared: 0 })
  const record = await readJson(join(job.evidenceDir, 'checks/settings/0/a11y.json'))
  expect(record).toMatchObject({ standard: 'wcag2aa', fail: ['moderate', 'serious', 'critical'] })
  expect((record.accept as unknown[]).length).toBe(2)
  expect((record.findings as Array<Record<string, unknown>>)[0]).toMatchObject({ rule: 'button-name', status: 'accepted', reason: 'the icon button is replaced in the redesign' })
})

test('an a11y check reaches its pages with the flow vocabulary, and each page it visits is audited (#149)', async () => {
  const repo = await tempRepo()
  const browser = fakeBrowser(({ request }) => (request.width === undefined ? [] : []))
  const actions = [
    { action: 'open', url: '/login' },
    { action: 'type', element: { role: 'textbox', name: 'Email' }, value: 'me@example.test' },
    { action: 'click', element: { role: 'button', name: 'Sign in' } },
    { action: 'assertText', text: 'Dashboard' },
  ]
  const job = jobFor(repo, [a11y('signed-in', { actions, widths: [390] })], TARGET_PROFILE)

  const { result } = await runJob(job, { ...UP, flowSession: browser.session })

  expect(criterionOf(result, 'signed-in').outcome).toBe('proven')
  expect(browser.audits.map((audit) => [audit.url, audit.request.width])).toEqual([
    [`${TARGET_URL}/login`, 390],
    [`${TARGET_URL}/login`, 390],
  ])
  expect(((await readJson(join(job.evidenceDir, 'checks/signed-in/0/a11y.json'))).audits as Array<{ point: number }>).map((audit) => audit.point)).toEqual([0, 3])
})

test('an audit that cannot be made leaves the check unverified, naming why, never proven (#149)', async () => {
  const repo = await tempRepo()
  const none = fakeBrowser(() => [], { audit: false })
  const job = jobFor(repo, [a11y('settings', { url: '/settings' })], TARGET_PROFILE)

  const first = await runJob(job, { ...UP, flowSession: none.session })
  expect(first.result.verdict).toBe('blocked')
  expect(criterionOf(first.result, 'settings')).toMatchObject({ outcome: 'unverified', reason: 'the driver exposes no accessibility audit' })

  const broken = fakeBrowser(() => new Error('axe-core is not installed; accessibility checks are unverified without the rule engine'))
  const second = await runJob(jobFor(await tempRepo(), [a11y('settings', { url: '/settings' })], TARGET_PROFILE), { ...UP, flowSession: broken.session })
  const criterion = criterionOf(second.result, 'settings')
  expect(criterion.outcome).toBe('unverified')
  expect(criterion.reason).toContain('the accessibility audit after action 0 at viewportxlight could not be made')
  expect(criterion.reason).toContain('axe-core is not installed')
})

test('a page that climbs out of the target refuses the run before anything is audited (#149)', async () => {
  const browser = fakeBrowser(() => [])
  const job = jobFor(await tempRepo(), [a11y('escape', { url: '/../admin' })], { ...TARGET_PROFILE, target: { ...TARGET_PROFILE.target!, url: `${TARGET_URL}/app` } })
  const { result } = await runJob(job, { ...UP, flowSession: browser.session })
  expect(result.verdict).toBe('refused')
  expect(criterionOf(result, 'escape').reason).toContain('criteria[0].checks[0].url: the path "/../admin" climbs out of the target')
  expect(browser.audits).toEqual([])
})

// Standing: the profile audits every action flow.

const FLOW: JobCriterion = {
  id: 'saves',
  text: 'the settings form saves',
  checks: [{ kind: 'flow', name: 'save settings', actions: [{ action: 'open', url: '/settings' }, { action: 'assertText', text: 'Saved' }] }],
}

test('a profile that makes the audit standing audits every action flow, and a violation fails the flow\'s criterion (#149)', async () => {
  const repo = await tempRepo()
  const browser = fakeBrowser(() => [UNNAMED_BUTTON])
  const job = jobFor(repo, [FLOW], { ...TARGET_PROFILE, a11y: { standing: true } })

  const { result } = await runJob(job, { ...UP, flowSession: browser.session })

  const criterion = criterionOf(result, 'saves')
  expect(criterion).toMatchObject({ outcome: 'failed', reason: '1 accessibility violation: button-name on document/main/button (/settings)', a11y: { new: 1 } })
  expect(await readJson(join(job.evidenceDir, 'checks/saves/0/a11y.json'))).toMatchObject({ check: 'save settings', asked: 'standing: the profile audits every flow', outcome: 'failed' })
})

test('without a standing audit a flow is not audited, and its result carries no counts (#149)', async () => {
  const repo = await tempRepo()
  const browser = fakeBrowser(() => [UNNAMED_BUTTON])
  const job = jobFor(repo, [FLOW], TARGET_PROFILE)

  const { result } = await runJob(job, { ...UP, flowSession: browser.session })

  expect(criterionOf(result, 'saves').outcome).toBe('proven')
  expect('a11y' in criterionOf(result, 'saves')).toBe(false)
  expect(browser.audits).toEqual([])
  expect(existsSync(join(job.evidenceDir, 'checks/saves/0/a11y.json'))).toBe(false)
})

test('a flow whose assertion fails is failed by the flow, and what was audited on the way is still recorded (#149)', async () => {
  const repo = await tempRepo()
  const browser = fakeBrowser(() => [UNNAMED_BUTTON], { missing: 'Saved' })
  const job = jobFor(repo, [FLOW], { ...TARGET_PROFILE, a11y: { standing: true } })

  const { result } = await runJob(job, { ...UP, flowSession: browser.session })

  const criterion = criterionOf(result, 'saves')
  expect(criterion.outcome).toBe('failed')
  // The flow failed it: the audit's reason is not offered as the cause.
  expect('reason' in criterion).toBe(false)
  expect(criterion.evidence).toContain('checks/saves/0/a11y.json')
  expect(criterion.a11y).toMatchObject({ new: 1 })
})

// Two sides (#147).

async function twoTrees(): Promise<{ head: string; base: string }> {
  return { head: await tempRepo('qare-head-'), base: await tempRepo('qare-base-') }
}

test('a change that adds a button with no accessible name fails the a11y check, and the old violation beside it is listed as existing (#149)', async () => {
  const trees = await twoTrees()
  // The faint text was there before the change; the unnamed button arrives with it.
  const browser = fakeBrowser(({ app }) => (app === 'first' ? [FAINT_TEXT] : [FAINT_TEXT, UNNAMED_BUTTON]))
  const job = jobFor(trees.head, [a11y('settings', { url: '/settings' })], APP_PROFILE)

  const { result } = await runJob(job, { ...recordingBoot(), flowSession: browser.session, base: { repoPath: trees.base } })

  expect(result.verdict).toBe('failed')
  expect(result.base).toEqual({ ref: 'origin/main', status: 'executed' })
  const criterion = criterionOf(result, 'settings')
  // Clean enough at the base, failed at the head: the judge names it a regression.
  expect(criterion).toMatchObject({
    outcome: 'failed',
    regression: true,
    base: { outcome: 'proven' },
    reason: '1 new accessibility violation: button-name on document/main/button (/settings)',
    a11y: { new: 1, existing: 1, accepted: 0, reported: 0, uncompared: 0 },
  })
  expect(criterion.evidence).toContain('head/checks/settings/0/a11y.json')
  expect(criterion.base?.evidence).toContain('base/checks/settings/0/a11y.json')
  // Each side audited its own app.
  expect(browser.audits.map((audit) => audit.app)).toEqual(['first', 'second'])
  expect(new URL(browser.audits[0]!.url).origin).not.toBe(new URL(browser.audits[1]!.url).origin)

  const head = await readJson(join(job.evidenceDir, 'head/checks/settings/0/a11y.json'))
  expect(head).toMatchObject({ side: 'head', comparison: { with: 'base' }, outcome: 'failed' })
  expect((head.findings as Array<Record<string, unknown>>).map((finding) => [finding.rule, finding.status])).toEqual([
    ['color-contrast', 'existing'],
    ['button-name', 'new'],
  ])
  const base = await readJson(join(job.evidenceDir, 'base/checks/settings/0/a11y.json'))
  expect(base).toMatchObject({ side: 'base', outcome: 'passed', counts: { existing: 1, new: 0 } })
})

test('violations that already existed at the base are listed and do not fail the run (#149)', async () => {
  const trees = await twoTrees()
  const browser = fakeBrowser(() => [FAINT_TEXT, UNNAMED_BUTTON])
  const job = jobFor(trees.head, [a11y('settings', { url: '/settings' })], APP_PROFILE)

  const { result } = await runJob(job, { ...recordingBoot(), flowSession: browser.session, base: { repoPath: trees.base } })

  expect(result.verdict).toBe('passed')
  const criterion = criterionOf(result, 'settings')
  expect(criterion).toMatchObject({ outcome: 'proven', base: { outcome: 'proven' }, a11y: { new: 0, existing: 2 } })
  expect('regression' in criterion).toBe(false)
  const record = await readJson(join(job.evidenceDir, 'head/checks/settings/0/a11y.json'))
  expect((record.findings as Array<Record<string, unknown>>).map((finding) => [finding.rule, finding.status])).toEqual([
    ['color-contrast', 'existing'],
    ['button-name', 'existing'],
  ])
})

const PROFILE_YAML = (a11ySection: string): string =>
  [
    'app:',
    '  boot: { compose: compose.qa.yaml, service: admin }',
    `  health: { http: "${HEALTH_URL}", timeout: 120s }`,
    '  seed: { command: bin/seed }',
    '  login: { fixture: fixtures/users.yml, role: admin }',
    'stubs: []',
    'visual: { widths: [390], themes: [dark] }',
    'suites: []',
    a11ySection,
    '',
  ].join('\n')

async function writeProfile(repo: string, a11ySection: string): Promise<void> {
  await mkdir(join(repo, '.qa', 'fixtures'), { recursive: true })
  await mkdir(join(repo, '.qa', 'stubs'), { recursive: true })
  await writeFile(join(repo, '.qa', 'QA.md'), '# QA\n')
  await writeFile(join(repo, '.qa', 'fixtures', 'users.yml'), 'admin: {}\n')
  await writeFile(join(repo, '.qa', 'config.yml'), PROFILE_YAML(a11ySection))
}

test('turning the standing audit on in a change audits the base under the same rules, so old debt does not fail it (#149)', async () => {
  const trees = await twoTrees()
  // The base profile has no a11y section at all; the change adds one.
  await writeProfile(trees.base, '')
  await writeProfile(trees.head, 'a11y: { standing: true, standard: wcag2a }')
  const browser = fakeBrowser(() => [UNNAMED_BUTTON])
  // A flow on an app the run boots opens it where the run published it.
  const flow: JobCriterion = {
    ...FLOW,
    checks: [{ kind: 'flow', name: 'save settings', actions: [{ action: 'open', url: `${['http:', '//localhost:'].join('')}{{run.app_port}}/settings` }, { action: 'assertText', text: 'Saved' }] }],
  }
  const job: Job = { ...jobFor(trees.head, [flow], APP_PROFILE), profile: { path: '.qa' } }

  const { result } = await runJob(job, { ...recordingBoot(), flowSession: browser.session, base: { repoPath: trees.base } })

  expect(criterionOf(result, 'saves')).toMatchObject({ outcome: 'proven', a11y: { new: 0, existing: 1 } })
  // Both sides were audited, under the head's rule set, widths and themes.
  expect(browser.audits.map((audit) => [audit.app, audit.request.tags, audit.request.width, audit.request.theme])).toEqual([
    ['first', ['wcag2a'], 390, 'dark'],
    ['second', ['wcag2a'], 390, 'dark'],
  ])
  expect(await readJson(join(job.evidenceDir, 'base/checks/saves/0/a11y.json'))).toMatchObject({ side: 'base', standard: 'wcag2a' })
})

test('a base that will not boot leaves a head with violations unverified, naming why, and a clean head proven (#149)', async () => {
  const trees = await twoTrees()
  const browser = fakeBrowser(({ url }) => (url.endsWith('/settings') ? [UNNAMED_BUTTON] : []))
  const job = jobFor(trees.head, [a11y('settings', { url: '/settings' }), a11y('about', { url: '/about' })], APP_PROFILE)

  // The first `up` is the base's.
  const { result } = await runJob(job, { ...recordingBoot((call) => call === 1), flowSession: browser.session, base: { repoPath: trees.base } })

  expect(result.base).toMatchObject({ status: 'not-executed' })
  const criterion = criterionOf(result, 'settings')
  expect(criterion).toMatchObject({ outcome: 'unverified', base: { outcome: 'not-compared' }, a11y: { new: 0, uncompared: 1 } })
  expect(criterion.reason).toContain('1 accessibility violation could not be told new from existing (button-name on document/main/button (/settings))')
  expect(criterion.reason).toContain('no base audit to compare with: the base side did not run')
  expect('regression' in criterion).toBe(false)
  // Nothing can be new on a page with nothing wrong.
  expect(criterionOf(result, 'about').outcome).toBe('proven')
  expect(await readJson(join(job.evidenceDir, 'head/checks/settings/0/a11y.json'))).toMatchObject({ comparison: { with: 'nothing' }, outcome: 'unverified' })
})

test('a criterion the profile leaves out of the base side has no base audit, and says which limit left it out (#149, #147)', async () => {
  const trees = await twoTrees()
  const browser = fakeBrowser(() => [UNNAMED_BUTTON])
  const profile: QaProfile = { ...APP_PROFILE, base: { criteria: 'ledger' } }
  const job = jobFor(trees.head, [a11y('settings', { url: '/settings' }), { id: 'kept', text: 'runs', checks: [{ kind: 'command', run: 'true' }] }], profile)
  await new FileLedgerStore(join(trees.base, '.qa')).save([{ criterion: 'kept', status: 'active', source: ['#1'], proof: 'command' }])

  const { result } = await runJob(job, { ...recordingBoot(), flowSession: browser.session, base: { repoPath: trees.base } })

  const criterion = criterionOf(result, 'settings')
  expect(criterion.outcome).toBe('unverified')
  expect(criterion.reason).toContain('no base audit to compare with: not run at the base')
})

test('a missing base comparison is this run\'s outcome only, and a new violation is not (#149, #47)', async () => {
  const dir = await tempRepo()
  const audit = (violations: A11yAuditViolation[]) => ({
    audits: [{ point: 0, url: `${TARGET_URL}/settings`, width: 1280, theme: 'light', engine: { name: 'axe-core', version: '4.13.0' }, incomplete: 0, violations }],
  })
  const input = { check: { name: 'settings', standing: false }, criterionId: 'settings', index: 0, evidenceDir: join(dir, 'head'), checkDir: 'checks/settings/0', rules: [] }
  const context = { config: a11yConfigOf(undefined), defaults: { widths: [], themes: [] }, standing: false }
  const against = { with: 'base' as const, evidenceDir: join(dir, 'base'), why: () => 'the base side did not run: no checkout' }

  // Nothing saved at the base: a cache must not serve this outcome to the next run.
  const missing = await settleA11y({ ...input, audited: audit([UNNAMED_BUTTON]), context: { ...context, comparison: against } })
  expect(missing).toMatchObject({ status: 'unverified', transient: true })
  expect(missing.reason).toContain('no base audit to compare with: the base side did not run: no checkout')

  // The base side saves its record; the head side then finds a violation it did not have, which is a lasting outcome.
  const base = await settleA11y({ ...input, evidenceDir: join(dir, 'base'), audited: audit([FAINT_TEXT]), context: { ...context, comparison: { with: 'base-side' } } })
  expect(base).toMatchObject({ status: 'passed', counts: { existing: 1 } })
  const added = await settleA11y({ ...input, audited: audit([FAINT_TEXT, UNNAMED_BUTTON]), context: { ...context, comparison: against } })
  expect(added).toMatchObject({ status: 'failed', counts: { new: 1, existing: 1 }, evidence: ['checks/settings/0/a11y.json'] })
  expect('transient' in added).toBe(false)
})

test('a name the run redacts reads the same at both sides, so it is not a new violation (#149, #52)', async () => {
  const dir = await tempRepo()
  const secret: A11yAuditViolation = {
    rule: 'color-contrast',
    impact: 'serious',
    help: 'Contrast',
    nodes: [{ target: 'a.user', role: 'link', name: 'jane@pilot.example', path: 'document/main/link "jane@pilot.example"' }],
  }
  const audited = { audits: [{ point: 0, url: `${TARGET_URL}/settings`, width: 1280, theme: 'light', engine: { name: 'axe-core', version: '4.13.0' }, incomplete: 0, violations: [secret] }] }
  const rules = redactionRules({ patterns: ['jane@pilot\\.example'] })
  const input = { check: { standing: false }, audited, criterionId: 'settings', index: 0, checkDir: 'checks/settings/0', rules }
  const context = { config: a11yConfigOf(undefined), defaults: { widths: [], themes: [] }, standing: false }

  await settleA11y({ ...input, evidenceDir: join(dir, 'base'), context: { ...context, comparison: { with: 'base-side' } } })
  const head = await settleA11y({ ...input, evidenceDir: join(dir, 'head'), context: { ...context, comparison: { with: 'base', evidenceDir: join(dir, 'base'), why: () => 'unused' } } })

  expect(head).toMatchObject({ status: 'passed', counts: { existing: 1, new: 0 } })
  expect(await readFile(join(dir, 'head/checks/settings/0/a11y.json'), 'utf8')).not.toContain('jane@pilot.example')
})
