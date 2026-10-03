import { cp, chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
  READINESS_MAX_FILES,
  buildReadinessReport,
  normalizeOrigin,
  parseComposeServices,
  readinessInventory,
} from '../src/index.js'

const URL_API = ['http:', '//api.example.com/v1'].join('')
const url = (host: string, path = '') => ['http:', `//${host}${path}`].join('')

// The compose file the fixture profile boots from (#146): readiness checks
// that the file, the app service and every stub's service are really there.
const QA_COMPOSE = 'services:\n  admin: {}\n  billing-stub: {}\n  mailpit: {}\n  cdn-stub: {}\n'

async function repoWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-readiness-'))
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, content, 'utf8')
  }
  return dir
}

async function withProfile(dir: string, config?: string): Promise<void> {
  await cp(fileURLToPath(new URL('../fixtures/qa-valid/.qa', import.meta.url)), join(dir, '.qa'), { recursive: true })
  if (config !== undefined) await writeFile(join(dir, '.qa', 'config.yml'), config, 'utf8')
}

test('boot inventory finds root and subdirectory compose files and parses services', async () => {
  const dir = await repoWith({
    'docker-compose.yml': [
      'services:',
      '  admin:',
      '    image: admin:latest',
      '    healthcheck:',
      '      test: ["CMD", "true"]',
      '    command: ["bundle", "exec", "up"]',
      '  worker:',
      '    image: worker:latest',
    ].join('\n'),
    'app/compose.yaml': 'services:\n  db:\n    image: postgres:16\n',
  })
  const inventory = await readinessInventory(dir)
  expect(inventory.boot).toHaveLength(2)
  expect(inventory.boot[0].file).toBe('./docker-compose.yml')
  expect(inventory.boot[0].services).toEqual([
    { name: 'admin', image: 'admin:latest', healthcheck: true, command: 'bundle exec up' },
    { name: 'worker', image: 'worker:latest', healthcheck: false, command: undefined },
  ])
  expect(inventory.boot[1].file).toBe('./app/compose.yaml')
  expect(inventory.gaps).toContain('service "worker" in ./docker-compose.yml has no healthcheck')
  expect(inventory.gaps).toContain('service "db" in ./app/compose.yaml has no healthcheck')
})

test('no compose file yields a named gap and empty boot', async () => {
  const dir = await repoWith({ 'README.md': 'hello' })
  const inventory = await readinessInventory(dir)
  expect(inventory.boot).toEqual([])
  expect(inventory.gaps).toContain('no compose file found: qare cannot boot this repo for a QA run')
})

test('unparseable compose throws a named error', async () => {
  const dir = await repoWith({ 'docker-compose.yml': 'services: [unclosed' })
  await expect(readinessInventory(dir)).rejects.toThrow(/not valid YAML/)
})

test('compose with a non-mapping services key throws a named error', async () => {
  const dir = await repoWith({ 'compose.yml': 'services: 12' })
  await expect(readinessInventory(dir)).rejects.toThrow(/services key that is not a mapping/)
})

test('parseComposeServices tolerates a missing services key', () => {
  expect(parseComposeServices('x.yml', 'version: "3"\n')).toEqual([])
})

test('outbound origins are summarized per origin with deterministic ordering', async () => {
  const dir = await repoWith({
    'a.md': `see ${URL_API} and ${URL_API} again`,
    'b.md': `posts to ${URL_API}`,
    'c.md': `uses ${url('other.example.net', '/v9')}`,
  })
  const inventory = await readinessInventory(dir)
  expect(inventory.origins).toHaveLength(2)
  expect(inventory.origins[0].origin).toBe(url('api.example.com'))
  expect(inventory.origins[0].totalHits).toBe(3)
  expect(inventory.origins[0].files).toEqual([
    { file: './a.md', count: 2 },
    { file: './b.md', count: 1 },
  ])
  expect(inventory.origins[1].origin).toBe(url('other.example.net'))
})

test('scan skips .git, node_modules, dist and .qa directories, binary files and oversized files', async () => {
  const dir = await repoWith({
    'node_modules/x.md': url('hidden.example.com'),
    'dist/y.md': url('hidden.example.com'),
    '.qa/config.yml': 'app: [broken',
    'bin.dat': `ok\u0000${url('binary.example.com')}`,
  })
  await writeFile(join(dir, 'big.md'), `x${'y'.repeat(1024 * 1024)}\n${url('big.example.com')}\n`)
  const inventory = await readinessInventory(dir)
  expect(inventory.scan.filesScanned).toBe(0)
  expect(inventory.scan.skippedOversized).toBe(1)
  expect(inventory.scan.skippedBinary).toBe(1)
  expect(inventory.origins).toEqual([])
})

test('scan is capped at maxFiles with a note', async () => {
  const dir = await repoWith({
    'a.md': url('a.example.com'),
    'b.md': url('b.example.com'),
    'c.md': url('c.example.com'),
  })
  const inventory = await readinessInventory(dir, { maxFiles: 2 })
  expect(inventory.scan.filesScanned).toBe(2)
  expect(inventory.scan.capped).toBe(true)
  expect(inventory.origins.map((hit) => hit.origin)).toEqual([url('a.example.com'), url('b.example.com')])
})

test('scan cap default is the exported limit', async () => {
  expect(READINESS_MAX_FILES).toBe(2000)
})

test('no .qa profile is a gap, not an error', async () => {
  const dir = await repoWith({ 'docker-compose.yml': 'services:\n  admin:\n    image: admin\n' })
  const inventory = await readinessInventory(dir)
  expect(inventory.profile.present).toBe(false)
  expect(inventory.profile.stubs).toEqual([])
  expect(inventory.gaps).toContain(
    'no .qa/ profile: there is nothing for qare to check yet (write a profile in .qa/ to enable QA)',
  )
})

test('present but broken profile is a named gap', async () => {
  const dir = await repoWith({})
  await withProfile(dir, 'app: [broken')
  const inventory = await readinessInventory(dir)
  expect(inventory.profile.present).toBe(true)
  expect(inventory.profile.loadError).toMatch(/app/)
  expect(inventory.gaps.some((gap) => gap.startsWith('.qa/ profile could not be loaded: '))).toBe(true)
})

test('stub coverage compares reached origins against profile stub hosts', async () => {
  const dir = await repoWith({
    'docker-compose.yml': 'services:\n  admin:\n    image: admin\n    healthcheck: {}\n',
    'compose.qa.yaml': QA_COMPOSE,
    'a.md': `calls ${url('api.billing-vendor.example', '/v1')}`,
  })
  await withProfile(dir)
  const inventory = await readinessInventory(dir)
  expect(inventory.profile.present).toBe(true)
  expect(inventory.profile.healthUrl).toBe(['http:', '//localhost:3000/up'].join(''))
  expect(inventory.coverage).toEqual([{ origin: url('api.billing-vendor.example'), coveredBy: 'billing' }])
  expect(inventory.gaps).toEqual(['stub "mail" lists host "api.mailgun.net" that the scan never observed'])
})

test('stub matching strips ports from reached origins', async () => {
  const dir = await repoWith({
    'docker-compose.yml': 'services:\n  admin:\n    image: admin\n    healthcheck: {}\n',
    'compose.qa.yaml': QA_COMPOSE,
    'a.md': `calls ${url('api.billing-vendor.example', ':8443/v1')}`,
  })
  await withProfile(dir)
  const inventory = await readinessInventory(dir)
  expect(inventory.coverage).toEqual([{ origin: url('api.billing-vendor.example:8443'), coveredBy: 'billing' }])
  expect(inventory.gaps).toEqual(['stub "mail" lists host "api.mailgun.net" that the scan never observed'])
})

test('wildcard stub hosts match observed origins in both directions', async () => {
  const config = [
    'app:',
    '  boot: { compose: compose.qa.yaml, service: admin }',
    `  health: { http: ${JSON.stringify(['http:', '//localhost:3000/up'].join(''))}, timeout: 120s }`,
    '  seed: { command: "bin/rails db:seed:qa" }',
    '  login: { fixture: fixtures/users.yml, role: admin }',
    'stubs:',
    '  - service: cdn',
    '    hosts: ["*.cdn.example"]',
    '    provided_by: { compose_service: cdn-stub }',
    'visual:',
    '  widths: [1440, 390]',
    '  themes: [light, dark]',
    'suites:',
    '  - { name: browser-e2e, command: "npm --prefix e2e test", kind: flow }',
  ].join('\n')
  const dir = await repoWith({
    'docker-compose.yml': 'services:\n  admin:\n    image: admin\n    healthcheck: {}\n',
    'compose.qa.yaml': QA_COMPOSE,
    'a.md': `calls ${url('a.cdn.example', '/static')}`,
  })
  await withProfile(dir, config)
  const inventory = await readinessInventory(dir)
  expect(inventory.coverage).toEqual([{ origin: url('a.cdn.example'), coveredBy: 'cdn' }])
  expect(inventory.gaps).toEqual([])
})

test('userinfo URLs normalize to the bare host', async () => {
  const dir = await repoWith({ 'a.md': `db at ${['http:', '//user:pass@db.example.net/db'].join('')}` })
  const inventory = await readinessInventory(dir)
  expect(inventory.origins).toEqual([
    { origin: url('db.example.net'), totalHits: 1, files: [{ file: './a.md', count: 1 }] },
  ])
})

test('skipped files do not consume the cap budget', async () => {
  const dir = await repoWith({ 'a.md': url('a.example.com') })
  await writeFile(join(dir, 'big.md'), `x${'y'.repeat(1024 * 1024)}\n`)
  const inventory = await readinessInventory(dir, { maxFiles: 2 })
  expect(inventory.scan.capped).toBe(false)
  expect(inventory.scan.skippedOversized).toBe(1)
  expect(inventory.scan.filesScanned).toBe(1)
  expect(inventory.origins.map((hit) => hit.origin)).toEqual([url('a.example.com')])
})

test('unreadable files are counted, not silent', async () => {
  const dir = await repoWith({ 'a.md': url('a.example.com'), 'locked.md': url('locked.example.com') })
  await chmod(join(dir, 'locked.md'), 0o000)
  try {
    const inventory = await readinessInventory(dir)
    expect(inventory.scan.skippedUnreadable).toBe(1)
    expect(inventory.scan.filesScanned).toBe(1)
    expect(inventory.origins.map((hit) => hit.origin)).toEqual([url('a.example.com')])
  } finally {
    await chmod(join(dir, 'locked.md'), 0o644)
  }
})

test('uncovered reached origin is a named gap when a profile exists', async () => {
  const dir = await repoWith({ 'a.md': `calls ${url('uncovered.example.net', '/v1')}` })
  await withProfile(dir)
  const inventory = await readinessInventory(dir)
  expect(inventory.coverage).toEqual([{ origin: url('uncovered.example.net'), coveredBy: undefined }])
  expect(inventory.gaps).toContain(
    `outbound origin ${url('uncovered.example.net')} is reached but not stubbed by the .qa/ profile`,
  )
  expect(inventory.gaps.some((gap) => gap.includes('lists host "api.mailgun.net" that the scan never observed'))).toBe(
    true,
  )
})

test('normalizeOrigin trims trailing punctuation and lowercases scheme and host', async () => {
  expect(normalizeOrigin(['https:', '//Host.Example.com:8443'].join(''))).toBe(
    ['https:', '//host.example.com:8443'].join(''),
  )
  expect(normalizeOrigin(['HTTP:', '//A.example.com.'].join(''))).toBe(url('a.example.com'))
  expect(normalizeOrigin('nonsense://a.example.com')).toBe('')
  expect(normalizeOrigin(['http:', '//'].join(''))).toBe('')
})

test('report is deterministic markdown with no verdict', async () => {
  const dir = await repoWith({
    'docker-compose.yml': 'services:\n  admin:\n    image: admin\n    healthcheck: {}\n',
    'compose.qa.yaml': QA_COMPOSE,
    'a.md': `calls ${url('api.billing-vendor.example', '/v1')}`,
  })
  await withProfile(dir)
  const inventory = await readinessInventory(dir)
  const first = buildReadinessReport(inventory)
  const again = buildReadinessReport(inventory)
  expect(first).toBe(again)
  expect(first).toContain('# QARE readiness report')
  expect(first).toContain('## Boot')
  expect(first).toContain('## Outbound origins')
  expect(first).toContain('## Stub coverage')
  expect(first).toContain('## Gaps')
  expect(first).toContain('covered by stub billing')
  expect(first.toLowerCase()).not.toContain('verdict')
  expect(first).not.toContain('result.json')
})

// #146: `qare init` writes a starting profile, and readiness is what says
// how far it is from ready. So readiness names everything init leaves open.

test('a placeholder qare init wrote and nobody filled in is a gap, by file and by what to do', async () => {
  const dir = await repoWith({ 'compose.qa.yaml': QA_COMPOSE })
  await withProfile(dir)
  await writeFile(join(dir, '.qa', 'QA.md'), '# QA\n\nTODO(qare init): say what this app is\nIt has payouts.\n', 'utf8')
  const inventory = await readinessInventory(dir)
  expect(inventory.gaps).toContain('.qa/QA.md is not filled in: say what this app is')
})

test('a target profile still names its placeholders, though it has no boot or stub gaps', async () => {
  const dir = await repoWith({
    '.qa/QA.md': 'TODO(qare init): say what this app is\n',
    '.qa/config.yml': [
      '# TODO(qare init): confirm the health path',
      'target:',
      `  url: ${url('app.example.test')}`,
      '  health: { http: /, timeout: 30s }',
    ].join('\n'),
  })
  const inventory = await readinessInventory(dir)
  expect(inventory.gaps).toEqual([
    '.qa/QA.md is not filled in: say what this app is',
    '.qa/config.yml is not filled in: confirm the health path',
  ])
})

test('a profile that boots from a compose file the repository does not have is a gap', async () => {
  const dir = await repoWith({ 'docker-compose.yml': 'services:\n  admin:\n    healthcheck: {}\n' })
  await withProfile(dir)
  const inventory = await readinessInventory(dir)
  expect(inventory.gaps).toContain('the profile boots from "compose.qa.yaml", which the repository does not have')
  expect(inventory.stubGaps).toEqual([])
})

test('a boot service or a stub service the compose file does not define is a gap', async () => {
  const secure = (path: string) => ['https:', `//api.billing-vendor.example${path}`].join('')
  const dir = await repoWith({
    'compose.qa.yaml': 'services:\n  web: {}\n  mailpit: {}\n',
    'a.md': `calls ${secure('/v1')} twice: ${secure('/v2')}`,
  })
  await withProfile(dir)
  const inventory = await readinessInventory(dir)
  expect(inventory.gaps).toContain('the profile boots the service "admin", which compose.qa.yaml does not define')
  expect(inventory.gaps).toContain(
    'stub "billing" is provided by the compose service "billing-stub", which compose.qa.yaml does not define',
  )
  expect(inventory.gaps.join('\n')).not.toContain('"mailpit", which')
  // The same gap, in the shape a stub issue is drafted from.
  expect(inventory.stubGaps).toEqual([
    {
      host: 'api.billing-vendor.example',
      port: '443',
      protocol: 'https',
      hits: 2,
      files: ['./a.md'],
      service: 'billing',
      composeService: 'billing-stub',
    },
  ])
})

test('an origin no stub covers is a stub gap with the port it was reached on', async () => {
  const dir = await repoWith({
    'compose.qa.yaml': QA_COMPOSE,
    'a.md': `calls ${url('uncovered.example.net', ':8080/v1')}`,
    'b.md': `calls ${url('uncovered.example.net', ':8080/v2')}`,
  })
  await withProfile(dir)
  const inventory = await readinessInventory(dir)
  expect(inventory.stubGaps).toEqual([
    { host: 'uncovered.example.net', port: '8080', protocol: 'http', hits: 2, files: ['./a.md', './b.md'] },
  ])
})

test('loopback hosts and the compose services themselves are not outbound origins', async () => {
  const dir = await repoWith({
    'docker-compose.yml': 'services:\n  web:\n    healthcheck: {}\n  search:\n    healthcheck: {}\n',
    'a.md': [
      url('localhost', ':3000/up'),
      url('127.0.0.1', ':8080'),
      url('0.0.0.0', ':9000'),
      url('app.localhost'),
      url('search', ':9200/_health'),
      url('search.example.com'),
    ].join(' '),
  })
  const inventory = await readinessInventory(dir)
  expect(inventory.origins.map((hit) => hit.origin)).toEqual([url('search.example.com')])
})
