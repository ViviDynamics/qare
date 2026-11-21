import { expect, test } from 'vitest'

import { ExplorationError, explorationPageOf, type FlowPage, type SnapshotNode } from '../src/index.js'

const url = (rest: string, scheme = 'http'): string => [scheme, '://', rest].join('')
const APP = url('127.0.0.1:41000')
const TREE: SnapshotNode = { role: 'document', states: {}, path: 'document', children: [] }

function fakePage(): { page: FlowPage; opened: string[] } {
  const opened: string[] = []
  const page: FlowPage = {
    open: async (target) => {
      opened.push(target)
    },
    click: async () => {},
    type: async () => {},
    choose: async () => {},
    waitFor: async () => {},
    assertText: async () => {},
    assertElement: async () => {},
    screenshot: async () => {},
    observe: async () => ({ url: opened.at(-1) ?? 'about:blank', title: 'Settings' }),
    snapshot: async () => TREE,
    frame: async () => new Uint8Array([137, 80, 78, 71]),
  }
  return { page, opened }
}

test('the explored page answers the channel from the flow page the browser driver drives (#377)', async () => {
  const { page, opened } = fakePage()
  const explored = explorationPageOf(page, APP)
  await explored.navigate(`${APP}/settings?tab=billing`)
  expect(opened).toEqual([`${APP}/settings?tab=billing`])
  expect(await explored.observe()).toEqual({ url: `${APP}/settings?tab=billing`, title: 'Settings' })
  expect(await explored.snapshot()).toEqual(TREE)
  expect([...(await explored.capture())]).toEqual([137, 80, 78, 71])
})

test("navigation stays on the booted app's origin, whatever a tool call asks for (#377)", async () => {
  const { page, opened } = fakePage()
  const explored = explorationPageOf(page, `${APP}/`)
  for (const elsewhere of [url('127.0.0.1:41001/'), url('169.254.169.254/latest/meta-data'), url('127.0.0.1:41000/', 'https'), url('evil.example/')])
    await expect(explored.navigate(elsewhere), elsewhere).rejects.toThrow(ExplorationError)
  expect(opened).toEqual([])
})

test('a flow page without the seams exploration reads is refused when it is adapted, not when the model calls it (#377)', () => {
  const { page } = fakePage()
  const { observe: _observe, ...noObserve } = page
  void _observe
  expect(() => explorationPageOf(noObserve, APP)).toThrow(ExplorationError)
  const { snapshot: _snapshot, ...noSnapshot } = page
  void _snapshot
  expect(() => explorationPageOf(noSnapshot, APP)).toThrow(ExplorationError)
  expect(() => explorationPageOf(page, 'not a url')).toThrow(ExplorationError)
})
