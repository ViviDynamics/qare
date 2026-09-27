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
    for (const token of bracket[1].split(/\s+/)) if (token !== '') tokens.unshift(token)
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

function asStateValue(raw: string): NodeState {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw !== '' && /^[+-]?\d+$/.test(raw)) return Number(raw)
  return raw
}

function parseEntries(entries: unknown[], parentPath: string): SnapshotNode[] {
  const nodes: SnapshotNode[] = []
  for (const entry of entries) {
    if (typeof entry === 'object' && entry !== null) {
      for (const [line, nested] of Object.entries(entry)) {
        const node = parseAttrLine(line, parentPath)
        node.children = Array.isArray(nested) ? parseEntries(nested, node.path) : []
        nodes.push(node)
      }
    } else if (typeof entry === 'string' && entry.trim() !== '') {
      nodes.push(parseAttrLine(entry, parentPath))
    }
  }
  return nodes
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
