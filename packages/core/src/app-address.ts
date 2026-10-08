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
  // Scheme and host, without userinfo: a credential in the health URL is the
  // profile's own, and the address is written into the model's prompt.
  const parts = /^(https?:\/\/)(?:[^/?#\s@]*@)?([^/?#\s@]+)/i.exec(appHealth.trim())
  if (parts === null) return undefined
  const authored = `${parts[1]}${parts[2]}`
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
    // Without userinfo, like the booted app's address: a credential in the
    // target URL is the profile's own, this is written into the model's
    // prompt, and a check reaches the target through {{run.target_url}},
    // which the harness fills at run time.
    ...(profile.target === undefined ? {} : { target: withoutUserinfo(profile.target.url) }),
    ...(profile.client === undefined ? {} : { client: profile.client.driver }),
    ...(app === undefined ? {} : { app: { address: app } }),
  }
}

/**
 * A URL as it is written into a prompt: parsed the way the profile loader
 * parses it, with the username and password cleared. The URL is read as a
 * URL and not as text, so a form the loader accepts (surrounding whitespace,
 * an upper-case scheme) cannot carry a credential past a pattern. A slash
 * the parser adds to a URL that named no path is taken off again, so the
 * address reads as the profile wrote it. What cannot be parsed has no
 * userinfo that can be told from the rest, and is not written at all.
 */
function withoutUserinfo(url: string): string {
  const written = url.trim()
  const unread = 'an address the profile names'
  let parsed: URL
  try {
    parsed = new URL(written)
  } catch {
    return unread
  }
  // Only an http(s) URL has userinfo where the parser looks for it.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return unread
  parsed.username = ''
  parsed.password = ''
  // A query or a fragment can carry a credential too (a signed URL), and the
  // planner needs neither: a page is opened by path, and a command reaches
  // the target through {{run.target_url}}, which the harness fills whole.
  const bare = parsed.search === '' && parsed.hash === '' ? written : (written.split(/[?#]/)[0] ?? '')
  parsed.search = ''
  parsed.hash = ''
  const clean = parsed.toString()
  return clean.endsWith('/') && !bare.endsWith('/') && parsed.pathname === '/' ? clean.slice(0, -1) : clean
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
