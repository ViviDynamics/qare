import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { callExplorationTool, type FlowPage, type SnapshotNode } from '@qare/core'
import { main } from '../src/index.js'
import type { Writer } from '../src/index.js'

const FIXTURE = fileURLToPath(new URL('../../core/fixtures/qa-valid/.qa', import.meta.url))
const url = (rest: string): string => ['http:', '//', rest].join('')

function capture(): { text: () => string; writer: Writer } {
  const lines: string[] = []
  return { text: () => lines.join(''), writer: { write: (chunk) => lines.push(chunk) } }
}

/** The fixture profile, booted by compose, with extra lines appended to its config. */
async function profile(extra: string, runPort = false): Promise<{ repo: string; dir: string }> {
  const repo = await mkdtemp(join(tmpdir(), 'qare-explore-'))
  const dir = join(repo, '.qa')
  await cp(FIXTURE, dir, { recursive: true })
  // A seed the test can run: the fixture's own names a Rails task.
  let config = (await readFile(join(dir, 'config.yml'), 'utf8')).replace('bin/rails db:seed:qa', 'true')
  if (runPort) config = config.replace('localhost:3000/up', 'localhost:{{run.app_port}}/up')
  await writeFile(join(dir, 'config.yml'), `${config}\n${extra}\n`)
  return { repo, dir }
}

function composeRecorder(up = 0): { calls: string[][]; probed: string[]; boot: { runCompose: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>; probe: (url: string) => Promise<{ ok: boolean }>; pollIntervalMs: number } } {
  const calls: string[][] = []
  const probed: string[] = []
  return {
    calls,
    probed,
    boot: {
      runCompose: async (args) => {
        calls.push(args)
        return { code: args.includes('up') ? up : 0, stdout: '', stderr: up !== 0 && args.includes('up') ? 'port is already allocated' : '' }
      },
      probe: async (target) => {
        probed.push(target)
        return { ok: true }
      },
      pollIntervalMs: 1,
    },
  }
}

test('explore boot brings the base app up from the base tree, seeds it and says where it answers (#377)', async () => {
  // base.image is named, and still not used: exploration builds the base tree.
  // The health check names the run's port by name, as examples/compose-app's does.
  const { repo, dir } = await profile('flavour: web\nexplore: base\nbase: { image: "ghcr.io/example/app:{base}" }', true)
  const out = join(repo, 'explore-out')
  const compose = composeRecorder()
  const said = capture()
  const code = await main(['explore', 'boot', '--profile', dir, '--repo', repo, '--out', out], said.writer, capture().writer, compose.boot)
  expect(code, said.text()).toBe(0)
  const app = JSON.parse(await readFile(join(out, 'app.json'), 'utf8')) as { origin: string; project: string }
  const isolation = JSON.parse(await readFile(join(out, 'isolation.json'), 'utf8')) as { project: string; port: number }
  // The health check's fixed port is pinned to the one the boot allocated.
  expect(app.origin).toBe(url(`localhost:${isolation.port}`))
  // The boot proves the app on the run's own port, with the run's values filled in.
  expect(compose.probed.length).toBeGreaterThan(0)
  expect(new Set(compose.probed)).toEqual(new Set([url(`localhost:${isolation.port}/up`)]))
  expect(app.project).toBe(isolation.project)
  expect(compose.calls.every((args) => args.includes(isolation.project))).toBe(true)
  // No override stands an image in for the base tree's build.
  expect(compose.calls.flat().some((arg) => arg.includes('base-image'))).toBe(false)
  expect(said.text()).toContain(isolation.project)
})

test('explore boot refuses a profile that does not explore, and boots nothing (#377)', async () => {
  const { repo, dir } = await profile('flavour: web')
  const compose = composeRecorder()
  const err = capture()
  const code = await main(['explore', 'boot', '--profile', dir, '--out', join(repo, 'out')], capture().writer, err.writer, compose.boot)
  expect(code).toBe(1)
  expect(err.text()).toContain('does not explore')
  expect(compose.calls).toEqual([])
})

test('a base app that does not come up stops exploration by name, and leaves its project to reap (#377)', async () => {
  const { repo, dir } = await profile('flavour: web\nexplore: base')
  const out = join(repo, 'out')
  const err = capture()
  const code = await main(['explore', 'boot', '--profile', dir, '--out', out], capture().writer, err.writer, composeRecorder(1).boot)
  expect(code).toBe(1)
  expect(err.text()).toContain('did not come up for exploration')
  expect(existsSync(join(out, 'isolation.json'))).toBe(true)
  expect(existsSync(join(out, 'app.json'))).toBe(false)
  expect(await readFile(join(out, 'explore-boot.log'), 'utf8')).toContain('port is already allocated')
})

test('explore serve drives the page on the app and serves the channel until it is stopped (#377)', async () => {
  const opened: string[] = []
  let disposed = false
  const tree: SnapshotNode = { role: 'document', states: {}, path: 'document', children: [] }
  const page: FlowPage = {
    open: async (target) => void opened.push(target),
    click: async () => {},
    type: async () => {},
    choose: async () => {},
    waitFor: async () => {},
    assertText: async () => {},
    assertElement: async () => {},
    screenshot: async () => {},
    observe: async () => ({ url: opened.at(-1) ?? '', title: 'App' }),
    snapshot: async () => tree,
  }
  let stop: () => void = () => {}
  const stopped = new Promise<void>((resolve) => (stop = resolve))
  const dir = await mkdtemp(join(tmpdir(), 'qare-explore-serve-'))
  const ready = join(dir, 'ready.json')
  const { exploreCommand } = await import('../src/explore.js')
  const app = url('127.0.0.1:41377')
  const serving = exploreCommand(['serve', '--app', app, '--port', '0', '--ready', ready], capture().writer, capture().writer, {
    session: async () => ({ page, dispose: async () => void (disposed = true) }),
    stopped,
  })
  for (let tries = 0; !existsSync(ready) && tries < 200; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10))
  const { endpoint } = JSON.parse(await readFile(ready, 'utf8')) as { endpoint: string }
  // The page already stands on the app when the channel first answers.
  expect(opened).toEqual([`${app}/`])
  expect(await callExplorationTool(endpoint, 'observe')).toContain(`${app}/`)
  await expect(callExplorationTool(endpoint, 'navigate', { url: url('169.254.169.254/') })).rejects.toThrow(/stays on the app/)
  stop()
  expect(await serving).toBe(0)
  expect(disposed).toBe(true)
})
