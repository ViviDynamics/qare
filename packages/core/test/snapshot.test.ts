import { expect, test } from 'vitest'
import { nameFindings, normaliseAriaSnapshot, trimToSubtree } from '../src/snapshot.js'

const CATALOG = [
  '- main:',
  '  - heading "Catalog" [level=2]',
  '  - list:',
  '    - listitem:',
  '      - link "Ada Lovelace" [ref=e7]',
  '    - listitem:',
  '      - link "Grace Hopper"',
].join('\n')

test('maps the ARIA snapshot of the browser onto the normalised schema (#82)', async () => {
  const snapshot = normaliseAriaSnapshot([
    '- banner:',
    '  - heading "QARE" [level=1]',
    '- main:',
    '  - textbox "Search" [value=hello] [ref=e3]',
    '  - button "Send"',
  ].join('\n'))

  expect(snapshot.role).toBe('document')
  expect(snapshot.children.map((child) => child.role)).toEqual(['banner', 'main'])

  const main = snapshot.children[1]
  expect(main?.path).toBe('document/main')
  const heading = snapshot.children[0]?.children[0]
  expect(heading?.role).toBe('heading')
  expect(heading?.name).toBe('QARE')
  expect(heading?.states).toEqual({ level: 1 })
  expect(heading?.path).toBe('document/banner/heading "QARE"')

  const textbox = main?.children[0]
  expect(textbox?.name).toBe('Search')
  expect(textbox?.value).toBe('hello')
  // The generated reference is dropped: a path that carried it would be stable for nothing.
  expect(textbox?.states).toEqual({})
  expect(textbox?.path).toBe('document/main/textbox "Search"')
})

test('trims to the subtree the assertion touched, along the chain from the root', async () => {
  const snapshot = normaliseAriaSnapshot(CATALOG)

  const trimmed = trimToSubtree(snapshot, 'Ada Lovelace')

  expect(trimmed.path).toBe('document')
  const main = trimmed.children[0]
  expect(main?.role).toBe('main')
  // The heading and the other listitem are outside the relevant subtree.
  expect(main?.children.map((child) => child.role)).toEqual(['list'])
  const link = main?.children[0]?.children[0]?.children[0]
  expect(link?.role).toBe('link')
  expect(link?.name).toBe('Ada Lovelace')
  expect(link?.children).toEqual([])
})

test('text that names nothing leaves the snapshot untrimmed', async () => {
  const snapshot = normaliseAriaSnapshot(CATALOG)

  const trimmed = trimToSubtree(snapshot, 'Welcome')

  expect(trimmed).toEqual(snapshot)
})

test('a control with no accessible name is a finding, named by its path (#82)', async () => {
  const snapshot = normaliseAriaSnapshot([
    '- main:',
    '  - button "Send"',
    '  - button',
    '  - generic',
    '  - img ""',
  ].join('\n'))

  const findings = nameFindings(snapshot)

  expect(findings).toEqual([
    'accessibility finding: document/main/button has no accessible name',
    'accessibility finding: document/main/img has no accessible name',
  ])
})

test('named controls produce no findings', async () => {
  const snapshot = normaliseAriaSnapshot(CATALOG)

  expect(nameFindings(trimToSubtree(snapshot, 'Ada Lovelace'))).toEqual([])
})
