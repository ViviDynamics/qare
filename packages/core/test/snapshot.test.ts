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

// #439: on the website pilot the blog index's first match for the post title
// was the thumbnail's alt text, and the trim kept only that, dropping the
// heading a reader saw. The verifier then read the evidence as the title
// sitting on an image alone.
test('keeps every node the text names, so a heading is never dropped for an earlier image alt (#439)', async () => {
  const snapshot = normaliseAriaSnapshot([
    '- banner:',
    '  - link "Blog"',
    '- main:',
    '  - heading "Blog" [level=1]',
    '  - img "QA Published Post"',
    '  - heading "QA Published Post" [level=2]',
    '  - paragraph: A published post the QA seed writes',
    '  - link "Continue reading"',
    '- contentinfo:',
    '  - paragraph: Vivi Dynamics',
  ].join('\n'))

  const trimmed = trimToSubtree(snapshot, 'QA Published Post')

  expect(trimmed.children.map((child) => child.role)).toEqual(['main'])
  const main = trimmed.children[0]
  expect(main?.children.map((child) => `${child.role} ${child.name ?? ''}`)).toEqual(['img QA Published Post', 'heading QA Published Post'])
  expect(main?.children[1]?.states).toEqual({ level: 2 })
})

test('matches in separate branches are each kept with their own ancestors (#439)', async () => {
  const snapshot = normaliseAriaSnapshot([
    '- navigation:',
    '  - link "Ada Lovelace"',
    '- main:',
    '  - list:',
    '    - listitem:',
    '      - link "Ada Lovelace"',
    '    - listitem:',
    '      - link "Grace Hopper"',
  ].join('\n'))

  const trimmed = trimToSubtree(snapshot, 'Ada Lovelace')

  expect(trimmed.children.map((child) => child.role)).toEqual(['navigation', 'main'])
  expect(trimmed.children[1]?.children[0]?.children.map((item) => item.children[0]?.name)).toEqual(['Ada Lovelace'])
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

test('a quoted attribute value keeps its spaces (#82)', async () => {
  const snapshot = normaliseAriaSnapshot([
    '- main:',
    '  - textbox "Motto" [value="hello world"]',
    '  - textbox "Motto" [value="say \\"hi\\" now"]',
  ].join('\n'))

  const textbox = snapshot.children[0]?.children[0]
  expect(textbox?.value).toBe('hello world')
  // The quoted value is one token, so no bogus state joins the node.
  expect(textbox?.states).toEqual({})
  // An escaped quote stays inside the value instead of closing it early.
  expect(snapshot.children[0]?.children[1]?.value).toBe('say "hi" now')
})

test('siblings that would share one path are stamped with their occurrence (#82)', async () => {
  const snapshot = normaliseAriaSnapshot([
    '- main:',
    '  - list:',
    '    - listitem',
    '    - listitem',
  ].join('\n'))

  const list = snapshot.children[0]?.children[0]
  expect(list?.children.map((child) => child.path)).toEqual([
    'document/main/list/listitem[1]',
    'document/main/list/listitem[2]',
  ])

  // Descendants are built under the stamped path.
  const nested = normaliseAriaSnapshot([
    '- main:',
    '  - list:',
    '    - listitem:',
    '      - button "Alpha"',
    '    - listitem:',
    '      - button "Beta"',
  ].join('\n'))
  const inner = nested.children[0]?.children[0]
  expect(inner?.children[0]?.children[0]?.path).toBe('document/main/list/listitem[1]/button "Alpha"')
  expect(inner?.children[1]?.children[0]?.path).toBe('document/main/list/listitem[2]/button "Beta"')

  // Findings say which of the duplicates is the one missing its name.
  const unnamed = normaliseAriaSnapshot([
    '- main:',
    '  - button',
    '  - button',
  ].join('\n'))
  expect(nameFindings(unnamed)).toEqual([
    'accessibility finding: document/main/button[1] has no accessible name',
    'accessibility finding: document/main/button[2] has no accessible name',
  ])
})

test('the required-name role set is complete, scrollbar and listbox included (#82)', async () => {
  const snapshot = normaliseAriaSnapshot([
    '- main:',
    '  - listbox',
    '  - scrollbar',
    '  - gridcell',
  ].join('\n'))

  expect(nameFindings(snapshot)).toEqual([
    'accessibility finding: document/main/listbox has no accessible name',
    'accessibility finding: document/main/scrollbar has no accessible name',
    'accessibility finding: document/main/gridcell has no accessible name',
  ])
})
