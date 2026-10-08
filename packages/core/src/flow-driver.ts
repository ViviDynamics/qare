import type { FlowDriverCapabilities } from './flow.js'
import { ELECTRON_FLOW_DRIVER } from './flow-electron.js'
import { BROWSER_FLOW_DRIVER } from './flow-playwright.js'
import { mcpDriverCapabilities } from './mcp.js'
import type { ClientDriver, ImageFlavour, QaProfile } from './profile.js'

const CLIENT_FLOW_DRIVERS: Record<ClientDriver, FlowDriverCapabilities> = { electron: ELECTRON_FLOW_DRIVER }

/**
 * The driver a profile's flows run against (#72): the client it names, the
 * MCP mapping it carries (#94), or the browser. One place decides, so the
 * planner, the plan loader and the run hold a plan to the same declaration.
 */
export function flowDriverFor(profile: Pick<QaProfile, 'client' | 'mcp'> | undefined): FlowDriverCapabilities {
  if (profile?.client !== undefined) return CLIENT_FLOW_DRIVERS[profile.client.driver]
  return mcpDriverCapabilities(profile?.mcp) ?? BROWSER_FLOW_DRIVER
}

/** The published flavours whose image ships a browser (#258): the rest have nothing for the browser driver to launch. */
export const BROWSER_FLAVOURS: readonly ImageFlavour[] = ['web']

/** The flavour a profile that names none runs in, as the pipeline's execute job reads it (#88). */
export const DEFAULT_FLAVOUR: ImageFlavour = 'core'

/**
 * The flavour of a profile whose flows would run on the browser driver in an
 * image that ships no browser (#258), and nothing otherwise. A plan made for
 * such a profile can hold no action flow, visual or a11y check: each would
 * end unverified at `browserType.launch`, after the planning was paid for.
 *
 * A profile that names a client or maps an MCP driver plans against that
 * driver whatever its flavour, because the driver is not the image's browser.
 * With no profile there is no flavour to read, and nothing is claimed.
 */
export function browserlessFlavour(
  profile: Pick<QaProfile, 'client' | 'mcp' | 'flavour'> | undefined,
): ImageFlavour | undefined {
  if (profile === undefined || flowDriverFor(profile) !== BROWSER_FLOW_DRIVER) return undefined
  const flavour = profile.flavour ?? DEFAULT_FLAVOUR
  return BROWSER_FLAVOURS.includes(flavour) ? undefined : flavour
}
