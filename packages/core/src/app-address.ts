import { isolatedHealthUrl, pinsToRunPort } from './isolation.js'
import { pathOnTarget } from './profile.js'
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
 * and the planner is told `{{run.app_port}}` instead.
 */
export function plannedAppAddress(appHealth: string): string | undefined {
  const authored = /^(https?:\/\/[^/?#\s]+)/i.exec(appHealth.trim())?.[1]
  if (authored === undefined) return undefined
  if (authored.includes('{{')) return authored
  if (!pinsToRunPort(appHealth)) return authored
  return authored.replace(/:\d+$/, ':{{run.app_port}}')
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
