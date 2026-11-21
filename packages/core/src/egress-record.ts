import { readStackEgress, type BootOpts, type StackEgress } from './boot.js'
import type { RunIsolation } from './isolation.js'
import type { RunEgress } from './result.js'

/**
 * What a side's booted stacks reached for (#382), as the result records it:
 * the run's own stack, and each stack a criterion booted for itself. Code
 * reads it from each stack's resolver after the checks, and decides from it
 * alone what it does to the verdict.
 */
export class StackEgressLedger {
  private readonly entries: RunEgress[] = []

  /** Read one stack's record and keep it. A stack the run did not contain is kept with why. */
  async note(egress: StackEgress | undefined, isolation: RunIsolation | undefined, opts: Pick<BootOpts, 'runCompose'>): Promise<void> {
    if (egress === undefined) return
    if (egress.containment === 'uncontained') {
      this.entries.push({ containment: 'uncontained', reason: egress.reason })
      return
    }
    const record = isolation === undefined ? undefined : await readStackEgress(isolation, opts)
    if (record === undefined) {
      this.entries.push({ containment: 'contained', declared: [], undeclared: [], unread: "the stack's resolver log could not be read, so what the stack looked up is not known" })
      return
    }
    this.entries.push({
      containment: 'contained',
      declared: record.lookups.filter((lookup) => lookup.declared).map((lookup) => lookup.host),
      undeclared: record.lookups.filter((lookup) => !lookup.declared).map((lookup) => lookup.host),
      ...(record.capped ? { capped: true } : {}),
    })
  }

  /** The side's record: contained only if every stack was, and every name any stack looked up, once. */
  summary(): RunEgress | undefined {
    if (this.entries.length === 0) return undefined
    const uncontained = this.entries.find((entry) => entry.containment === 'uncontained')
    if (uncontained !== undefined) return uncontained
    const union = (pick: (entry: RunEgress) => string[] | undefined): string[] => [...new Set(this.entries.flatMap((entry) => pick(entry) ?? []))]
    const unread = this.entries.find((entry) => entry.unread !== undefined)?.unread
    return {
      containment: 'contained',
      declared: union((entry) => entry.declared),
      undeclared: union((entry) => entry.undeclared),
      ...(this.entries.some((entry) => entry.capped === true) ? { capped: true } : {}),
      ...(unread === undefined ? {} : { unread }),
    }
  }
}

/**
 * What a stack's record does to the verdict (#382). A name no stub declares
 * refuses the run: no stubs, no QA. A record the run could not read, or one
 * cut before it named anything undeclared, cannot say the stack reached for
 * nothing, so the run is blocked rather than passed (rule 6). An uncontained
 * stack is recorded as such and decides nothing.
 */
export function stackEgressVerdict(egress: RunEgress | undefined): 'refused' | 'blocked' | undefined {
  if (egress === undefined || egress.containment !== 'contained') return undefined
  if ((egress.undeclared ?? []).length > 0) return 'refused'
  if (egress.unread !== undefined || egress.capped === true) return 'blocked'
  return undefined
}
