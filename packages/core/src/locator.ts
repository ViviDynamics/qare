import type { FlowElement } from './flow.js'
import type { SnapshotNode } from './snapshot.js'

/**
 * The Core-AAM landmark roles. Landmark ancestry is what locator repair
 * compares: two elements with the same role and accessible name are the same
 * element only when they sit in the same chain of landmarks, so a rename of
 * the markup around them is repaired and a move into another region is not.
 */
export const LANDMARK_ROLES: readonly string[] = [
  'banner',
  'complementary',
  'contentinfo',
  'form',
  'main',
  'navigation',
  'region',
  'search',
]

/** The version of the repairs record written to the evidence (#83). */
export const REPAIRS_SCHEMA_VERSION = 1

/** One step of a snapshot path: `role`, `role "name"`, with an optional `[n]` occurrence index. */
const SEGMENT = /^([a-z]+)(?:\s+("(?:[^"\\]|\\.)*"))?(?:\[(\d+)\])?$/

/**
 * A path is split on the slashes between steps, never on a slash inside a
 * quoted accessible name: the snapshot writes names JSON-quoted, so the
 * splitter tracks quotes and their escapes exactly as the snapshot wrote
 * them, and a name like `Save / Continue` stays one step (#83).
 */
export function splitSegments(path: string): string[] {
  const segments: string[] = []
  let current = ''
  let quoted = false
  for (let index = 0; index < path.length; index++) {
    const char = path[index] ?? ''
    if (char === '\\' && quoted) {
      const next = path[index + 1]
      current += next === undefined ? '\\' : char + next
      if (next !== undefined) index++
      continue
    }
    if (char === '"') quoted = !quoted
    if (char === '/' && !quoted) {
      segments.push(current)
      current = ''
    } else current += char
  }
  segments.push(current)
  return segments
}

/**
 * The identity a reference claims: the role and accessible name it names, and
 * the landmarks its snapshot path sat in. A reference that carries a path has
 * an identity; a reference without one has nothing to compare, so no repair
 * can ever be proposed for it.
 */
export interface ElementIdentity {
  role: string
  name?: string
  /** The landmark roles above the element, in snapshot order, `/`-joined. */
  landmarks: string
}

/** The landmark roles an element sits in, from its own path (its own step excluded). */
export function landmarkAncestry(path: string): string {
  const chain: string[] = []
  const segments = splitSegments(path)
  for (const segment of segments.slice(0, -1)) {
    const match = SEGMENT.exec(segment)
    const role = match === null ? segment : (match[1] ?? segment)
    if (LANDMARK_ROLES.includes(role)) chain.push(role)
  }
  return chain.join('/')
}

/** The identity the reference's own snapshot path claims. */
export function identityOfPath(path: string): ElementIdentity {
  const segment = splitSegments(path).at(-1) ?? ''
  const match = SEGMENT.exec(segment)
  const role = match === null ? segment : (match[1] ?? segment)
  const quoted = match?.[2]
  const name = quoted === undefined ? undefined : (JSON.parse(quoted) as string)
  return { role, ...(name === undefined ? {} : { name }), landmarks: landmarkAncestry(path) }
}

/** The identity a snapshot node claims: its own role and name, and the landmarks it sits in. */
export function identityOfNode(node: SnapshotNode): ElementIdentity {
  return {
    role: node.role,
    ...(node.name === undefined ? {} : { name: node.name }),
    landmarks: landmarkAncestry(node.path),
  }
}

/**
 * The repair rule, verbatim: same role, same accessible name, same landmark
 * ancestry. Anything else is a different element, and a different element is
 * a review finding, never a repair.
 */
export function sameIdentity(a: ElementIdentity, b: ElementIdentity): boolean {
  return a.role === b.role && a.name === b.name && a.landmarks === b.landmarks
}

/**
 * The snapshot paths a plan may carry: a `document` root, then steps of a
 * role, an optional quoted accessible name and an optional occurrence index.
 * The path is a reference, never a selector: only the shape the normalised
 * snapshot itself produces is accepted.
 */
export function isSnapshotPath(path: unknown): path is string {
  if (typeof path !== 'string' || path === '') return false
  const segments = splitSegments(path)
  if (segments[0] !== 'document') return false
  return segments.slice(1).every((segment) => {
    const match = SEGMENT.exec(segment)
    if (match === null) return false
    if (match[3] !== undefined && Number(match[3]) < 1) return false
    return match[2] === undefined || isJsonString(match[2])
  })
}

function isJsonString(quoted: string): boolean {
  try {
    return typeof JSON.parse(quoted) === 'string'
  } catch {
    return false
  }
}

/** Every node in the tree whose role and accessible name match the reference. */
export function findCandidates(root: SnapshotNode, element: { role: string; name?: string }): SnapshotNode[] {
  const found: SnapshotNode[] = []
  const walk = (node: SnapshotNode): void => {
    if (node.role === element.role && node.name === element.name) found.push(node)
    for (const child of node.children) walk(child)
  }
  walk(root)
  return found
}

/** Whether a repair applies, or why it is refused: the decision the identity comparison makes. */
export type RepairDecision =
  | { decision: 'apply'; path: string }
  | { decision: 'review'; reason: string }

/**
 * Decide a repair from the reference's old path and the candidates the
 * snapshot holds now. Applied only when exactly one candidate claims the same
 * identity, and the path really moved: the same path means the failure is not
 * a rename, and more than one match means the repair is ambiguous — both go
 * to review.
 */
export function decideRepair(oldPath: string, candidates: SnapshotNode[]): RepairDecision {
  const old = identityOfPath(oldPath)
  const matching = candidates.filter((candidate) => sameIdentity(identityOfNode(candidate), old))
  if (candidates.length === 0)
    return { decision: 'review', reason: `no element with role ${old.role} and name ${old.name ?? '""'} sits in the snapshot the page holds now` }
  if (matching.length === 0)
    return {
      decision: 'review',
      reason: `the element named ${old.name ?? '""'} now sits under different landmarks (${candidates.map((candidate) => identityOfNode(candidate).landmarks).join(', ')}), so it is a different element, not a repaired one`,
    }
  if (matching.length > 1)
    return { decision: 'review', reason: `${matching.length} elements share the identity the reference claims, so the repair is ambiguous` }
  const candidate = matching[0]
  if (candidate === undefined) return { decision: 'review', reason: 'the snapshot holds no element the reference names' }
  if (candidate.path === oldPath)
    return { decision: 'review', reason: 'the reference still resolves to the same element, so the failure is not a rename a repair may cross' }
  return { decision: 'apply', path: candidate.path }
}

/** The identity comparison a repair record names, in the words the issue asks for. */
export function identityText(landmarks: string): string {
  return `same role, same accessible name, same landmark ancestry (${landmarks === '' ? 'none' : landmarks})`
}

/** The description a repair record carries for a reference: reference plus path. */
export function describeReference(element: FlowElement): string {
  return 'testId' in element ? `testId=${element.testId}` : `role=${element.role} name=${element.name} at=${element.at ?? ''}`
}

/**
 * One recorded repair: the action that failed, the reference as the plan
 * carried it, the reference it was repaired to (or the reason a repair was
 * refused), and the identity comparison that decided it. Assertions are never
 * here: a repair never touches what a check asserts.
 */
export interface FlowRepairRecord {
  action: number
  reference: string
  repaired?: string
  identity: string
  status: 'applied' | 'refused'
  refusedReason?: string
}
