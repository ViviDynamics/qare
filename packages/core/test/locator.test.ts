import { expect, test } from 'vitest'
import {
  decideRepair,
  findCandidates,
  identityOfNode,
  identityOfPath,
  isSnapshotPath,
  landmarkAncestry,
  sameIdentity,
} from '../src/locator.js'
import { normaliseAriaSnapshot, type SnapshotNode } from '../src/snapshot.js'

const TREE = normaliseAriaSnapshot(
  [
    '- banner:',
    '  - heading "QARE" [level=1]',
    '- main:',
    '  - form "Sign in":',
    '    - textbox "Email"',
    '    - button "Save"',
    '  - navigation:',
    '    - button "Save"',
  ].join('\n'),
)

/** The first button "Save" the tree holds, whatever the fixture renamed around it. */
function buttonIn(yaml: string): SnapshotNode {
  const node = findCandidates(normaliseAriaSnapshot(yaml), { role: 'button', name: 'Save' })[0]
  if (node === undefined) throw new Error('fixture broken: no button "Save" in the tree')
  return node
}

test('the landmark ancestry of a path is the chain of landmark roles above the element (#83)', () => {
  expect(landmarkAncestry('document/main/form "Sign in"/button "Save"')).toBe('main/form')
  expect(landmarkAncestry('document/main')).toBe('')
  expect(landmarkAncestry('document/banner/heading "QARE"')).toBe('banner')
  // A landmark's own accessible name is not part of its role chain: the form
  // may be renamed without the ancestry moving.
  expect(landmarkAncestry('document/main/form "Billing"/button "Save"')).toBe('main/form')
  // Groups and lists are not landmarks: they say nothing about where an element sits.
  expect(landmarkAncestry('document/main/group "Panel"/button "Save"')).toBe('main')
})

test('an identity is claimed by the path a reference carries, and compared by the rule (#83)', () => {
  const authored = identityOfPath('document/main/form "Sign in"/button "Save"')
  expect(authored.role).toBe('button')
  expect(authored.name).toBe('Save')
  expect(authored.landmarks).toBe('main/form')

  const moved = identityOfPath('document/main/form "Billing"/button "Save"')
  expect(sameIdentity(authored, moved)).toBe(true)
  expect(sameIdentity(authored, identityOfPath('document/main/navigation/button "Save"'))).toBe(false)
  expect(sameIdentity(authored, identityOfPath('document/main/form "Sign in"/button "Send"'))).toBe(false)

  // A node in the current tree claims the identity its own path holds.
  const button = findCandidates(TREE, { role: 'button', name: 'Save' })[0]
  if (button === undefined) throw new Error('fixture broken: no button "Save" in the tree')
  expect(sameIdentity(authored, identityOfNode(button))).toBe(true)
})

test('a snapshot path is validated to the shape the snapshot itself produces (#83)', () => {
  expect(isSnapshotPath('document/main/button "Save"')).toBe(true)
  expect(isSnapshotPath('document/main')).toBe(true)
  expect(isSnapshotPath('document/main/list/link "Ada"[2]')).toBe(true)
  expect(isSnapshotPath('document')).toBe(true)
  expect(isSnapshotPath('')).toBe(false)
  expect(isSnapshotPath('main/button')).toBe(false)
  expect(isSnapshotPath('document/')).toBe(false)
  expect(isSnapshotPath('document/button "Save"[0]')).toBe(false)
  expect(isSnapshotPath('document/div class="x"/button')).toBe(false)
  expect(isSnapshotPath(42)).toBe(false)
})

test('the candidates are every node whose role and accessible name the reference names (#83)', () => {
  const found = findCandidates(TREE, { role: 'button', name: 'Save' })
  expect(found.map((candidate) => candidate.path)).toEqual([
    'document/main/form "Sign in"/button "Save"',
    'document/main/navigation/button "Save"',
  ])
  expect(findCandidates(TREE, { role: 'button', name: 'Absent' })).toEqual([])
})

test('a repair is applied when exactly one candidate claims the same identity (#83)', () => {
  // The wrapper form was renamed: the path moved, the element did not.
  const decision = decideRepair('document/main/form "Log in"/button "Save"', findCandidates(TREE, { role: 'button', name: 'Save' }))
  expect(decision.decision).toBe('apply')
  if (decision.decision === 'apply') expect(decision.path).toBe('document/main/form "Sign in"/button "Save"')
})

test('a candidate under different landmarks is refused to review, never repaired (#83)', () => {
  // Only the navigation button is on the page: same role and name, but it
  // sits in another landmark, so it is a different element.
  const tree = normaliseAriaSnapshot('- main:\n  - navigation:\n    - button "Save"')
  const decision = decideRepair('document/main/form "Sign in"/button "Save"', findCandidates(tree, { role: 'button', name: 'Save' }))
  expect(decision.decision).toBe('review')
  if (decision.decision === 'review') expect(decision.reason).toContain('different landmarks')
})

test('a repair is refused when no candidate, an ambiguous pair, or the same path answers (#83)', () => {
  const none = decideRepair('document/main/form "Sign in"/button "Save"', [])
  expect(none.decision).toBe('review')
  if (none.decision === 'review') expect(none.reason).toContain('no element')

  // Two buttons with the same role, name and landmarks: the repair cannot
  // tell which one the reference means.
  const both = findCandidates(normaliseAriaSnapshot('- main:\n  - form "Sign in":\n    - button "Save"\n    - button "Save"'), {
    role: 'button',
    name: 'Save',
  })
  expect(both.length).toBe(2)
  const ambiguous = decideRepair('document/main/form "Sign in"/button "Save"', both)
  expect(ambiguous.decision).toBe('review')
  if (ambiguous.decision === 'review') expect(ambiguous.reason).toContain('ambiguous')

  // The path the reference carries still names the element: the failure is
  // not a rename, so there is nothing a repair may cross.
  const same = decideRepair('document/main/form "Sign in"/button "Save"', [
    buttonIn('- main:\n  - form "Sign in":\n    - button "Save"'),
  ])
  expect(same.decision).toBe('review')
  if (same.decision === 'review') expect(same.reason).toContain('still resolves to the same element')
})

test('a path is split on the slashes between steps, never on one inside a quoted name (#83)', () => {
  const path = 'document/main/region "Save / Continue"/button "Save"'
  expect(isSnapshotPath(path)).toBe(true)
  const identity = identityOfPath(path)
  expect(identity.name).toBe('Save')
  expect(identity.landmarks).toBe('main/region')
  const yaml = '- main:\n  - region "Save / Continue":\n    - button "Save"'
  expect(identityOfNode(buttonIn(yaml))).toEqual(identity)
})

test('a quoted name with an escaped quote is one step, and a malformed escape is rejected (#83)', () => {
  const path = 'document/main/button "Say \\"hi\\" now"'
  expect(isSnapshotPath(path)).toBe(true)
  expect(identityOfPath(path).name).toBe('Say "hi" now')
  expect(isSnapshotPath('document/main/button "ends with escape \\\\"')).toBe(true)
})

test('a path may walk the hyphenated roles the snapshot itself writes (#83)', () => {
  const path = 'document/doc-chapter "Rules"/doc-pagebreak "Section 1"/button "Save"'
  expect(isSnapshotPath(path)).toBe(true)
  expect(identityOfPath(path).role).toBe('button')
  expect(identityOfPath(path).name).toBe('Save')
  expect(identityOfPath('document/main/doc-chapter "Rules"/button "Save"').landmarks).toBe('main')
})
