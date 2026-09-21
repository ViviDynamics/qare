import { createHash, randomUUID } from 'node:crypto'

export interface CriterionRevision {
  id: string
  revision: number
  text: string
}

export interface CriterionResolution {
  id: string
  revision: number
  reworded: boolean
  matched?: string
}

export function mintCriterionId(random: () => string = randomUUID): string {
  const half = (seed: string): string =>
    createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 16)
  return `c-${half(random())}${half(random())}`
}

export function normalizeWording(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

export function resolveCriterion(
  existing: CriterionRevision[],
  newText: string,
  opts?: { mint?: () => string },
): CriterionResolution {
  const normalized = normalizeWording(newText)
  const matched = (existing ?? []).find((entry) => normalizeWording(entry.text) === normalized)
  if (matched !== undefined) {
    const reworded = matched.text !== newText
    return {
      id: matched.id,
      revision: reworded ? matched.revision + 1 : matched.revision,
      reworded,
      matched: matched.id,
    }
  }
  return { id: mintCriterionId(opts?.mint), revision: 1, reworded: false }
}
