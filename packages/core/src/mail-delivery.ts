import { AUTH_MECHANISMS, type AuthMechanism, type MailAuthenticationAssertion } from './mail-auth.js'

export type { MailAuthenticationAssertion } from './mail-auth.js'

const HOST_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i

/**
 * The delivery assertions of a `mail` check (#218), as a plan and a job both
 * carry them, read by one parser so the two cannot disagree: `authentication`
 * (which mechanisms must pass, the sending domain expected, and the receiving
 * server whose results count) and `placement`.
 *
 * `authentication: {}` asks for all three mechanisms. Anything that is not
 * what it should be is refused with the field named, at plan time: an
 * assertion read wrong would be evidence held to the wrong thing.
 */
export function parseMailDelivery(
  value: Record<string, unknown>,
  base: string,
  fail: (field: string, message: string) => never,
): { authentication?: MailAuthenticationAssertion; placement?: string } {
  const out: { authentication?: MailAuthenticationAssertion; placement?: string } = {}
  const authentication = value.authentication
  if (authentication !== undefined) {
    const field = `${base}.authentication`
    if (typeof authentication !== 'object' || authentication === null || Array.isArray(authentication))
      fail(field, 'authentication must be an object with require, and optionally domain and authserv')
    const record = authentication as Record<string, unknown>
    const unknown = Object.keys(record).filter((key) => key !== 'require' && key !== 'domain' && key !== 'authserv')
    if (unknown.length > 0) fail(`${field}.${unknown[0] ?? ''}`, `authentication takes require, domain and authserv, not ${unknown.join(', ')}`)
    let require: AuthMechanism[] = [...AUTH_MECHANISMS]
    if (record.require !== undefined) {
      const listed = record.require
      if (!Array.isArray(listed) || listed.length === 0 || !listed.every((entry): entry is AuthMechanism => (AUTH_MECHANISMS as readonly unknown[]).includes(entry)))
        fail(`${field}.require`, `require must be a non-empty list of ${AUTH_MECHANISMS.join(', ')}`)
      require = AUTH_MECHANISMS.filter((mechanism) => (listed as AuthMechanism[]).includes(mechanism))
    }
    const named = (key: 'domain' | 'authserv'): string | undefined => {
      const held = record[key]
      if (held === undefined) return undefined
      if (typeof held !== 'string' || !HOST_NAME.test(held.trim())) fail(`${field}.${key}`, `${key} must be a host name, such as mail.example.com`)
      return (held as string).trim().toLowerCase()
    }
    const domain = named('domain')
    const authserv = named('authserv')
    out.authentication = { require, ...(domain === undefined ? {} : { domain }), ...(authserv === undefined ? {} : { authserv }) }
  }
  const placement = value.placement
  if (placement !== undefined) {
    if (typeof placement !== 'string' || placement.trim() === '') fail(`${base}.placement`, 'placement must be a non-empty string, such as inbox')
    out.placement = (placement as string).trim()
  }
  return out
}
