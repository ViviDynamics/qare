import { parse as parseYaml } from 'yaml'

/**
 * The version of the normalised snapshot written to the evidence (#82): one
 * schema for every client, so the planner, the evidence and locator repair
 * read the same shape wherever the snapshot came from.
 */
export const SNAPSHOT_SCHEMA_VERSION = 1

/**
 * One node of the normalised accessibility snapshot (#82). The role comes
 * from the W3C Core Accessibility API Mappings role set, the driver's own
 * role names map onto it, and `path` is a stable reference built from roles,
 * names and landmark ancestry: never a coordinate, never a generated id.
 */
export interface SnapshotNode {
  role: string
  /** The accessible name, when the node has one. */
  name?: string
  /** The node's value, for roles that carry one (a textbox's text, a slider's reading). */
  value?: string
  /** Every other state the tree reported (`checked`, `pressed`, `level`, ...). */
  states: Record<string, boolean | number | string>
  /** The stable path from the snapshot root to this node, roles and names only. */
  path: string
  children: SnapshotNode[]
}

type NodeState = boolean | number | string

// Playwright's generated element reference is an id of the current tree walk,
// not of the page: a path that carried it would be stable for nothing.
const GENERATED_IDS = 'ref'

function pathOf(parentPath: string, role: string, name: string | undefined): string {
  const step = name === undefined ? role : `${role} ${JSON.stringify(name)}`
  return parentPath === '' ? step : `${parentPath}/${step}`
}

function parseName(quoted: string): string {
  try {
    return JSON.parse(quoted) as string
  } catch {
    return quoted.slice(1, -1)
  }
}

/** One line of the driver's snapshot, in the form `role "name" [attrs]`. */
function parseAttrLine(line: string, parentPath: string): SnapshotNode {
  const trimmed = line.trim()
  // Attributes ride in trailing bracket groups, one or many: peel them from
  // the end, so a name that itself carries brackets stays with the name.
  const tokens: string[] = []
  let head = trimmed
  for (;;) {
    const bracket = /\[([^\]]*)\]\s*$/.exec(head)
    if (bracket === null || bracket[1] === undefined) break
    head = head.slice(0, bracket.index).trim()
    for (const token of splitAttrs(bracket[1])) tokens.unshift(token)
  }
  const split = /\s/.exec(head)
  const role = split === null ? head : head.slice(0, split.index)
  const tail = split === null ? '' : head.slice(split.index).trim()
  let name: string | undefined
  if (tail !== '') {
    name = tail.startsWith('"') ? parseName(tail) : tail
    // An empty accessible name is no accessible name: it stays off the path.
    if (name === '') name = undefined
  }
  let value: string | undefined
  const states: Record<string, NodeState> = {}
  for (const attr of tokens) {
    const eq = attr.indexOf('=')
    const key = eq === -1 ? attr : attr.slice(0, eq)
    const raw = eq === -1 ? undefined : attr.slice(eq + 1)
    if (key === GENERATED_IDS) continue
    if (key === 'value' && raw !== undefined) {
      value = raw.startsWith('"') ? parseName(raw) : raw
      continue
    }
    states[key] = raw === undefined ? true : asStateValue(raw)
  }
  const path = pathOf(parentPath, role, name)
  return { role, ...(name === undefined ? {} : { name }), ...(value === undefined ? {} : { value }), states, path, children: [] }
}

/**
 * Attribute groups split on whitespace, except that a double-quoted value is
 * one token whatever it holds: `[value="hello world"]` is the control's value,
 * not a value plus a state (#82).
 */
function splitAttrs(text: string): string[] {
  const tokens: string[] = []
  let token = ''
  let quoted = false
  for (const character of text) {
    if (character === '"') {
      quoted = !quoted
      token += character
    } else if (/\s/.test(character) && !quoted) {
      if (token !== '') tokens.push(token)
      token = ''
    } else {
      token += character
    }
  }
  if (token !== '') tokens.push(token)
  return tokens
}

function asStateValue(raw: string): NodeState {
  if (raw.startsWith('"')) return parseName(raw)
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw !== '' && /^[+-]?\d+$/.test(raw)) return Number(raw)
  return raw
}

function parseEntries(entries: unknown[], parentPath: string): SnapshotNode[] {
  // Siblings are parsed with bare paths first, so a sibling group that would
  // share one path is known before its members' children are built.
  const parsed: Array<{ node: SnapshotNode; nested: unknown }> = []
  for (const entry of entries) {
    if (typeof entry === 'object' && entry !== null) {
      for (const [line, nested] of Object.entries(entry)) {
        parsed.push({
          node: parseAttrLine(line, parentPath),
          nested: Array.isArray(nested) ? nested : [],
        })
      }
    } else if (typeof entry === 'string' && entry.trim() !== '') {
      parsed.push({ node: parseAttrLine(entry, parentPath), nested: [] })
    }
  }
  // Siblings that share one path get an occurrence index in document order:
  // two unnamed buttons under the same parent stay distinguishable, and the
  // index is the tree's own order, never a generated ref or a coordinate (#82).
  const groupSize = new Map<string, number>()
  for (const { node } of parsed) groupSize.set(node.path, (groupSize.get(node.path) ?? 0) + 1)
  const seen = new Map<string, number>()
  for (const { node } of parsed) {
    if ((groupSize.get(node.path) ?? 0) <= 1) continue
    const occurrence = (seen.get(node.path) ?? 0) + 1
    seen.set(node.path, occurrence)
    node.path = `${node.path}[${occurrence}]`
  }
  for (const { node, nested } of parsed) node.children = parseEntries(nested as unknown[], node.path)
  return parsed.map(({ node }) => node)
}

/**
 * The browser mapping (#82): Playwright's ARIA snapshot YAML turned into the
 * normalised schema. Every root the driver reports sits under one `document`
 * node, so every snapshot has a single root wherever it came from.
 */
export function normaliseAriaSnapshot(ariaYaml: string): SnapshotNode {
  const entries = parseYaml(ariaYaml) as unknown
  const roots: SnapshotNode[] = Array.isArray(entries) ? parseEntries(entries, 'document') : []
  return { role: 'document', states: {}, path: 'document', children: roots }
}

function copyNode(node: SnapshotNode): SnapshotNode {
  return { ...node, states: { ...node.states }, children: node.children.map(copyNode) }
}

/**
 * Trim the snapshot to the subtree around `text`: the chain from the root to
 * the first node whose accessible name contains it, pruned to that chain, with
 * the matched node's own subtree kept whole. Text that names nothing leaves the
 * snapshot untrimmed: what the page held at the assertion is the evidence.
 */
export function trimToSubtree(root: SnapshotNode, text: string): SnapshotNode {
  const chain = findNameChain(root, text)
  if (chain === undefined) return copyNode(root)
  let current = copyNode(chain[chain.length - 1] ?? root)
  for (let index = chain.length - 2; index >= 0; index -= 1) {
    const ancestor = chain[index]
    if (ancestor === undefined) continue
    current = { ...ancestor, states: { ...ancestor.states }, children: [current] }
  }
  return current
}

function findNameChain(root: SnapshotNode, text: string): SnapshotNode[] | undefined {
  if (root.name !== undefined && root.name.includes(text)) return [root]
  for (const child of root.children) {
    const chain = findNameChain(child, text)
    if (chain !== undefined) return [root, ...chain]
  }
  return undefined
}

// The Core-AAM roles whose controls answer an accessible name: a control in
// the tree without one is a finding to name, not a node to skip (#82).
const ROLES_REQUIRING_NAME: readonly string[] = [
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'treeitem',
  'option',
  'img',
  'image',
  'heading',
  'scrollbar',
  'columnheader',
  'gridcell',
  'listbox',
  'rowheader',
]

/**
 * Every control in the snapshot that carries no accessible name, named by its
 * path so the finding is read where the element sits (#82).
 */
export function nameFindings(root: SnapshotNode): string[] {
  const findings: string[] = []
  const walk = (node: SnapshotNode): void => {
    const unnamed =
      node.name === undefined || node.name.trim() === ''
    if (unnamed && ROLES_REQUIRING_NAME.includes(node.role))
      findings.push(`accessibility finding: ${node.path} has no accessible name`)
    for (const child of node.children) walk(child)
  }
  walk(root)
  return findings
}
