import { chmod, cp, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { startExplorationServer, type ExplorationPage, type ExplorationServer, type SnapshotNode } from '@qare/core'
import { main } from '../src/index.js'
import type { Writer } from '../src/index.js'

const FIXTURE = fileURLToPath(new URL('../../core/fixtures/qa-valid/.qa', import.meta.url))
const NARE = fileURLToPath(new URL('./fixtures/fake-nare-explore.mjs', import.meta.url))
const APP = ['http:', '//127.0.0.1:41377'].join('')
const CRITERIA = [{ id: 'c1', text: 'saving the settings shows a confirmation' }]
const SAVE_AT = 'document/main/button "Save"'
const SEEN = { role: 'button', name: 'Save', at: SAVE_AT, page: '/settings' }

function capture(): { text: () => string; writer: Writer } {
  const lines: string[] = []
  return { text: () => lines.join(''), writer: { write: (chunk) => lines.push(chunk) } }
}

function plan(element: Record<string, unknown>): unknown {
  return {
    schemaVersion: '1',
    criteria: [
      {
        id: 'c1',
        text: CRITERIA[0]!.text,
        checks: [{ kind: 'flow', name: 'save settings', actions: [{ action: 'open', url: '/settings' }, { action: 'click', element }, { action: 'assertText', text: 'Saved' }] }],
      },
    ],
  }
}

function app(): ExplorationPage {
  let at = `${APP}/`
  const tree: SnapshotNode = {
    role: 'document',
    states: {},
    path: 'document',
    children: [{ role: 'main', states: {}, path: 'document/main', children: [{ role: 'button', name: 'Save', states: {}, path: SAVE_AT, children: [] }] }],
  }
  return {
    observe: async () => ({ url: at, title: 'Settings' }),
    snapshot: async () => tree,
    navigate: async (target) => void (at = target),
    capture: async () => Buffer.from('png'),
  }
}

const servers: ExplorationServer[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

async function setUp(extra: string, answer: unknown): Promise<{ args: string[]; seenPath: string; outPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'qare-plan-explore-'))
  const profile = join(dir, '.qa')
  await cp(FIXTURE, profile, { recursive: true })
  const config = await readFile(join(profile, 'config.yml'), 'utf8')
  await writeFile(join(profile, 'config.yml'), `${config}\n${extra}\n`)
  await writeFile(join(dir, 'criteria.json'), JSON.stringify(CRITERIA))
  await writeFile(join(dir, 'change.diff'), 'diff --git a/settings.ts b/settings.ts')
  const seenPath = join(dir, 'seen.json')
  const binary = join(dir, 'nare')
  await writeFile(binary, `#!/bin/sh\nexec node ${NARE} ${seenPath} '${JSON.stringify(answer)}' "$@"\n`)
  await chmod(binary, 0o755)
  const outPath = join(dir, 'plan.json')
  const args = ['plan', '--criteria', join(dir, 'criteria.json'), '--diff', join(dir, 'change.diff'), '--out', outPath, '--nare', binary, '--profile', profile]
  return { args, seenPath, outPath }
}

interface Seen {
  argv: string[]
  config?: unknown
  listed?: string[]
  calls: { name: string; result: { isError?: boolean; content: { text: string }[] } }[]
}

test('qare plan --explore hands the planner the exploration tools, and the plan keeps the page each element came from (#377)', async () => {
  const server = await startExplorationServer(app())
  servers.push(server)
  const { args, seenPath, outPath } = await setUp('flavour: web\nexplore: base', plan(SEEN))
  const out = capture()
  const err = capture()
  expect(await main([...args, '--explore', server.url], out.writer, err.writer), err.text()).toBe(0)

  const seen = JSON.parse(await readFile(seenPath, 'utf8')) as Seen
  expect(seen.argv[seen.argv.indexOf('--tools') + 1]).toBe('explore__observe,explore__snapshot,explore__navigate')
  expect(seen.listed).toEqual(['observe', 'snapshot', 'navigate'])
  // The session went through the bridge to the server beside the app.
  expect(seen.calls.map((call) => call.result.isError ?? false)).toEqual([false, false])
  expect(seen.calls[1]?.result.content[0]?.text).toContain('"page":"/settings"')
  const written = JSON.parse(await readFile(outPath, 'utf8')) as { criteria: { checks: { actions: { element?: unknown }[] }[] }[] }
  expect(written.criteria[0]?.checks[0]?.actions[1]?.element).toEqual(SEEN)
  expect(out.text()).toContain('explored 1 page')
})

test('a plan naming an element the session did not see is refused, so the criterion is unplannable (#377)', async () => {
  const server = await startExplorationServer(app())
  servers.push(server)
  const { args, outPath } = await setUp('flavour: web\nexplore: base', plan({ role: 'button', name: 'Delete', at: 'document/main/button "Delete"', page: '/settings' }))
  expect(await main([...args, '--explore', server.url], capture().writer, capture().writer)).toBe(0)
  const written = JSON.parse(await readFile(outPath, 'utf8')) as { criteria: { unplannable?: string }[] }
  expect(written.criteria[0]?.unplannable).toContain('is not in the snapshot of /settings')
})

test('without exploration the planner is handed no tool and no MCP config, as before (#377)', async () => {
  const { args, seenPath } = await setUp('flavour: web', plan({ role: 'button', name: 'Save' }))
  expect(await main(args, capture().writer, capture().writer)).toBe(0)
  const seen = JSON.parse(await readFile(seenPath, 'utf8')) as Seen
  expect(seen.argv).not.toContain('--mcp-config')
  expect(seen.argv[seen.argv.indexOf('--tools') + 1]).toBe('none')
  expect(seen.calls).toEqual([])
})

test('an exploration endpoint for a profile that does not explore is refused before any model call (#377)', async () => {
  const { args, seenPath } = await setUp('flavour: web', plan(SEEN))
  const err = capture()
  expect(await main([...args, '--explore', `${APP}/`], capture().writer, err.writer)).toBe(4)
  expect(err.text()).toContain('does not explore')
  await expect(readFile(seenPath, 'utf8')).rejects.toThrow()
})
