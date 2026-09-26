/**
 * Single-use artefacts observed during a run (#69). A mail check that declares
 * itself single use publishes the links and extracted code of the message it
 * read; a later check that references `{{mail.<name>.link}}` or
 * `{{mail.<name>.code}}` consumes the artefact the first time the harness
 * substitutes it, and a second substitution of the same value is refused with
 * the reason named: the artefact is spent, and a retry requires a fresh
 * message.
 */
export type ArtefactField = 'link' | 'code'

export class Artefacts {
  private readonly ready = new Map<string, { link?: string; code?: string; singleUse: boolean }>()
  private readonly spent = new Map<string, string>()

  /** Record what a mail check read. Publishes are last-wins per name; a name maps to one message per run. */
  publish(name: string, artefacts: { link?: string; code?: string }, singleUse: boolean): void {
    this.ready.set(name, { ...artefacts, singleUse })
  }

  /**
   * Resolve `{{mail.<name>.<field>}}` for one consuming step, marking the
   * artefact spent on the first resolve. Every unresolvable case is the
   * caller's `unverified` with a reason that names the artefact, never a
   * failure: an artefact that is gone is the environment's report, not the
   * product's.
   */
  resolve(name: string, field: ArtefactField, consumer: string): { ok: true; artefact: string } | { ok: false; reason: string } {
    const entry = this.ready.get(name)
    if (entry === undefined) {
      return { ok: false, reason: `no message was read by mail check ${name}, so no ${field} is available to substitute` }
    }
    const value = entry[field]
    if (value === undefined) {
      const noun = field === 'link' ? 'links' : 'code'
      return { ok: false, reason: `the message read by mail check ${name} carries no ${noun}, so there is no artefact to substitute` }
    }
    if (entry.singleUse) {
      const spentBy = this.spent.get(`${field}:${value}`)
      if (spentBy !== undefined) {
        const verb = field === 'link' ? 'follow' : 'use'
        return { ok: false, reason: `the single-use ${field} from mail check ${name} was already consumed by criterion ${spentBy}; a retry requires a fresh message, and this run will not ${verb} the same ${field} twice` }
      }
      this.spent.set(`${field}:${value}`, consumer)
    }
    return { ok: true, artefact: value }
  }
}
