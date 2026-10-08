import { isolatedHealthUrl, pinsToRunPort } from './isolation.js'
import { pathOnTarget, type QaProfile } from './profile.js'
import { substituteValues, type RunValues } from './values.js'

/**
 * Where the app a run booted answers (#264): the origin of the profile's
 * health check, with the run's values substituted and a local port pinned to
 * the one the run published the app on. It is the origin the run proved
 * healthy, so a page opened there is a page of the app this run booted and
 * not another run's. Undefined when the health check names no http(s) origin.
 */
export function bootedAppOrigin(appHealth: string, values: RunValues): string | undefined {
  const port = values.app_port === undefined ? undefined : Number(values.app_port)
  const health = isolatedHealthUrl(substituteValues(appHealth, values), port)
  try {
    const parsed = new URL(health)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined
  } catch {
    return undefined
  }
}

/**
 * The booted app's address as a plan may write it (#264): the origin of the
 * health check as the profile authors it, with the run's port by name. A
 * local health check that names a fixed port is pinned to the run's port when
 * the run boots, so the number in the profile is not where the app will be,
 * and the planner is told `{{run.app_port}}` instead. It is an origin, like
 * `bootedAppOrigin`: credentials the health URL carries are left out.
 */
export function plannedAppAddress(appHealth: string): string | undefined {
  // Scheme and host, and nothing else: a credential in the health URL is the
  // profile's own, and the address is written into the model's prompt. The
  // URL cannot go through a parser, since it may name the port by a run
  // value, so the host is what follows the last @ of the authority (a
  // password may itself hold an @), and it is written only when it is made
  // of the characters a host, a port and a run value are made of.
  const parts = /^(https?):\/\/([^/?#\s\\]*)/i.exec(appHealth.trim())
  if (parts === null) return undefined
  const authority = parts[2] ?? ''
  const host = authority.slice(authority.lastIndexOf('@') + 1)
  if (!/^(?:[A-Za-z0-9.\-_[\]:]|\{\{\s*[\w.]+\s*\}\})+$/.test(host)) return undefined
  const authored = `${(parts[1] ?? '').toLowerCase()}://${host}`
  if (authored.includes('{{')) return authored
  if (!pinsToRunPort(appHealth)) return authored
  return authored.replace(/:\d+$/, ':{{run.app_port}}')
}

/**
 * How the app under test is addressed, as the planner is told it: the three
 * inputs of the plan step that say so (`PlanInputs.target`, `client`, `app`).
 */
export interface PlannerAddress {
  /** The URL of a running target the profile names (#122). */
  target?: string
  /** The client driver of a profile that names a build to launch (#72). */
  client?: string
  /** The app the run boots (#264), by the address a plan may write. */
  app?: { address: string }
}

/**
 * What a profile says about how its app is addressed, as the plan step takes
 * it (#267). Every caller that plans builds these inputs here, so none of
 * them can tell the planner less than the profile knows: the pipeline's plan
 * step once left out the target, and the one-off check the booted app.
 * A profile names one of target, client and app, so at most one comes back;
 * no profile, or an app whose health check names no origin, says nothing.
 */
export function plannerAddress(profile: Pick<QaProfile, 'target' | 'client' | 'app'> | undefined): PlannerAddress {
  if (profile === undefined) return {}
  const app = profile.app === undefined ? undefined : plannedAppAddress(profile.app.health.http)
  return {
    // The origin and nothing else: this is written into the model's prompt,
    // and a credential anywhere in the target URL is the profile's own.
    ...(profile.target === undefined ? {} : { target: targetOrigin(profile.target.url) }),
    ...(profile.client === undefined ? {} : { client: profile.client.driver }),
    ...(app === undefined ? {} : { app: { address: app } }),
  }
}

/**
 * The origin of a target, as it is written into a prompt: scheme, host and
 * port, read by the parser the profile loader uses, and nothing else. The
 * address is built from the parts that cannot carry a secret, not by taking
 * the dangerous parts off, so no spelling of a credential (in the userinfo,
 * the path, the query or the fragment) is one a rule failed to think of.
 * The planner needs no more: a page is opened by path, which resolves
 * against the whole target URL at run time, and a command reaches the target
 * through {{run.target_url}}, which the harness fills. What is not an
 * http(s) URL has no origin to tell, and is not written at all.
 */
function targetOrigin(url: string): string {
  const unread = 'an address the profile names'
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return unread
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return unread
  return `${parsed.protocol}//${parsed.host}`
}

export interface FlowAddressContext {
  /** The health URL of the app the run boots, as the profile authors it. */
  appHealth?: string
  /** The target the run checks, when it boots nothing (#122). */
  targetUrl?: string
  /** The run launches a client build (#72), whose driver resolves a path inside the application. */
  client?: boolean
}

/**
 * The URL a flow's `open` action opens (#264). A path is a page of the app
 * under test: on a run that booted the app, it resolves on the origin the
 * run proved healthy, and it cannot leave that origin (leading slashes are
 * a path, never a protocol-relative URL). A path on a target, and a path
 * inside a client build, are resolved where they always were, by the target
 * rule and by the client's driver. Anything that is not a path is a URL,
 * taken as written.
 *
 * A path with no app to be a page of is not something a browser can open,
 * and it says nothing about the change: the reason is named, and the flow is
 * unverified, never failed.
 */
export function flowOpenUrl(url: string, context: FlowAddressContext, values: RunValues): { ok: true; url: string } | { ok: false; reason: string } {
  if (!url.startsWith('/') || context.client === true || context.targetUrl !== undefined) return { ok: true, url }
  if (context.appHealth === undefined)
    return {
      ok: false,
      reason: `the flow opens the path ${JSON.stringify(url)}, but the run booted no app and the profile names no target, so there is no app the path is a page of`,
    }
  const origin = bootedAppOrigin(context.appHealth, values)
  if (origin === undefined)
    return {
      ok: false,
      reason: `the flow opens the path ${JSON.stringify(url)}, but the app's health URL ${JSON.stringify(context.appHealth)} names no origin a page can be opened on`,
    }
  const page = pathOnTarget(origin, url)
  if (page === undefined) return { ok: false, reason: `the path ${JSON.stringify(url)} climbs out of the app at ${origin}` }
  return { ok: true, url: page }
}
