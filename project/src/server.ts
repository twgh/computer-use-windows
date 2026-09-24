import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { homedir } from 'node:os'
import { createComputerUseMcpServer } from './vendor/computer-use-mcp/mcpServer.js'
import { buildComputerUseTools } from './vendor/computer-use-mcp/tools.js'
import type { InstalledApp } from './vendor/computer-use-mcp/executor.js'
import { filterAppsForDescription } from './computer-use/appNames.js'
import { getComputerUseHostAdapter } from './computer-use/hostAdapter.js'
import { getChicagoCoordinateMode } from './computer-use/gates.js'
import { listWindowApps } from './computer-use/windowApps.js'
import { createSessionContext } from './session.js'
import { logDebug } from './lib/log.js'

async function getInstalledAppNames(): Promise<string[] | undefined> {
  try {
    const installed = await getComputerUseHostAdapter().executor.listInstalledApps()
    // Merge in apps that currently own a visible window: the registry list has
    // no usable name for Store apps, which are exactly what an agent is often
    // asked to drive. Tagged so the name filter can skip the install-path
    // allowlist — a running, on-screen app is user-facing by definition.
    let windowApps: InstalledApp[] = []
    try {
      windowApps = await listWindowApps()
    } catch {}
    return filterAppsForDescription(
      [
        ...installed,
        ...windowApps.map(app => ({ ...app, origin: 'window' as const })),
      ],
      homedir(),
    )
  } catch {
    return undefined
  }
}

export async function runServer(): Promise<void> {
  const adapter = getComputerUseHostAdapter()
  const coordinateMode = getChicagoCoordinateMode()
  const context = createSessionContext()
  // Build the tool list BEFORE constructing the server: the `request_access`
  // description enumerates this machine's installed apps, and only the host can
  // do that executor round trip. Handing it to the factory keeps a single
  // ListTools handler (the kill-switch check lives there).
  const installedAppNames = await getInstalledAppNames()
  const tools = buildComputerUseTools(adapter.executor.capabilities, coordinateMode, installedAppNames)
  const server = createComputerUseMcpServer(adapter, coordinateMode, context, tools)
  const transport = new StdioServerTransport()
  logDebug('starting stdio MCP server')
  await server.connect(transport)
}
