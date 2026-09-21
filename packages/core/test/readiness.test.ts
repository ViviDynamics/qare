import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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
    'a.md': `calls ${url('api.billing-vendor.example', '/v1')}`,
  })
  await withProfile(dir)
  const inventory = await readinessInventory(dir)
  expect(inventory.profile.present).toBe(true)
  expect(inventory.profile.healthUrl).toBe(['http:', '//localhost:3000/up'].join(''))
  expect(inventory.coverage).toEqual([{ origin: url('api.billing-vendor.example'), coveredBy: 'billing' }])
  expect(inventory.gaps).toEqual(['stub "mail" lists host "api.mailgun.net" that the scan never observed'])
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
