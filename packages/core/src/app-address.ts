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

/** A host as an address may name it: letters, digits, dots and hyphens, or a bracketed IPv6 address. */
const HOST_NAME = /^(?:[a-z0-9._-]+|\[[0-9a-f:.]+\])$/i

/** The run's port by name, as a profile writes it in a health URL and as a plan writes it in an address. */
const RUN_PORT = '{{run.app_port}}'
const RUN_PORT_WRITTEN = /\{\{\s*run\.app_port\s*\}\}/g

/**
 * The booted app's address as a plan may write it (#264): the origin of the
 * health check as the profile authors it, with the run's port by name. A
 * local health check that names a fixed port is pinned to the run's port when
 * the run boots, so the number in the profile is not where the app will be,
 * and the planner is told `{{run.app_port}}` instead.
 *
 * The address is written into the model's prompt, and a health check is any
 * non-empty string to the profile loader, so it is rebuilt from what a URL
 * parser reads as the scheme, the host and the port, and from nothing else
 * (#267): never the userinfo, the path, the query or the fragment, and never
 * text a parser does not read as one of the three. The run's port is the one
 * run value an address may name, and only as the port: the URL is parsed
 * twice with two different numbers standing in for it, and what does not
 * parse, or whose host moves with the stand-in, tells the planner nothing.
 */
export function plannedAppAddress(appHealth: string): string | undefined {
  const written = appHealth.trim()
  const read = (port: string): URL | undefined => {
    try {
      const parsed = new URL(written.replace(RUN_PORT_WRITTEN, port))
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : undefined
    } catch {
      return undefined
    }
  }
  const [one, other] = [read('65001'), read('65002')]
  if (one === undefined || other === undefined) return undefined
  if (one.hostname === '' || one.hostname !== other.hostname) return undefined
  // The parser lets braces and other marks stand in a host. A host is a name
  // of letters, digits, dots and hyphens, or a bracketed IPv6 address.
  if (!HOST_NAME.test(one.hostname)) return undefined
  const origin = `${one.protocol}//${one.hostname}`
  // The two readings differ in the port exactly when the profile named the run's port there.
  if (one.port !== other.port) return one.port === '65001' && other.port === '65002' ? `${origin}:${RUN_PORT}` : undefined
  // A fixed local port is not where this run's app will be: the run pins it to its own.
  if (pinsToRunPort(written) && isolatedHealthUrl(written, 65003) !== written) return `${origin}:${RUN_PORT}`
  return one.port === '' ? origin : `${origin}:${one.port}`
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
 * no profile, or an address with no origin a parser can read, says nothing.
 */
export function plannerAddress(profile: Pick<QaProfile, 'target' | 'client' | 'app'> | undefined): PlannerAddress {
  if (profile === undefined) return {}
  const app = profile.app === undefined ? undefined : plannedAppAddress(profile.app.health.http)
  const target = profile.target === undefined ? undefined : targetOrigin(profile.target.url)
  return {
    // The origin and nothing else: this is written into the model's prompt,
    // and a credential anywhere in the target URL is the profile's own.
    ...(target === undefined ? {} : { target }),
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
 * http(s) URL has no origin to tell, and the planner is told nothing of it.
 */
function targetOrigin(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  // The parser lets braces and other marks stand in a host: only a plain host name is written.
  if (!HOST_NAME.test(parsed.hostname)) return undefined
  return `${parsed.protocol}//${parsed.hostname}${parsed.port === '' ? '' : `:${parsed.port}`}`
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
