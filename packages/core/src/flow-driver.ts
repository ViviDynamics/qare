import type { FlowDriverCapabilities } from './flow.js'
import { ELECTRON_FLOW_DRIVER } from './flow-electron.js'
import { BROWSER_FLOW_DRIVER } from './flow-playwright.js'
import { mcpDriverCapabilities } from './mcp.js'
import type { ClientDriver, QaProfile } from './profile.js'

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
