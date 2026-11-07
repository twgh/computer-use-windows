/**
 * Transport-agnostic computer-use runtime.
 *
 * `bindSessionContext` already returns a dispatcher whose signature carries no
 * MCP types (name + args in, tool result out). This module bundles that
 * dispatcher with the process-lifetime pieces a host must build exactly once —
 * adapter, session context, coordinate mode, the enriched tool list — so a host
 * that does not speak MCP (in-process library call, local IPC, a future CLI
 * escape hatch) shares the same state and the same gates as the MCP entry point
 * instead of re-implementing the wrapper closure.
 *
 * `server.ts` is the thin MCP transport on top: it passes `invokeRaw` to the
 * server factory so a process has exactly one dispatcher and one
 * last-screenshot cell, no matter how many transports end up attached.
 */

import { homedir } from 'node:os'

import { coordinateReminder } from './vendor/computer-use-mcp/coordinateFrame.js'
import { bindSessionContext } from './vendor/computer-use-mcp/mcpServer.js'
import { buildComputerUseTools } from './vendor/computer-use-mcp/tools.js'
import type { CuCallToolResult } from './vendor/computer-use-mcp/toolCalls.js'
import type { InstalledApp } from './vendor/computer-use-mcp/executor.js'
import type {
  ComputerUseHostAdapter,
  ComputerUseSessionContext,
  CoordinateMode,
} from './vendor/computer-use-mcp/types.js'
import { filterAppsForDescription } from './computer-use/appNames.js'
import { getComputerUseHostAdapter } from './computer-use/hostAdapter.js'
import { getChicagoCoordinateMode } from './computer-use/gates.js'
import { listWindowApps } from './computer-use/windowApps.js'
import { createSessionContext } from './session.js'

/**
 * What a host can render directly: the screenshot blob is gone and the
 * `[COORD FRAME]` note is already the last content block.
 *
 * The blob has to go — it is tens of megabytes of base64 that exists only so
 * the next call can use it as a coordinate anchor. It lives in the dispatcher's
 * closure cell; returning it would make every host responsible for remembering
 * not to log, print or forward it.
 */
export type CuToolReply = Omit<CuCallToolResult, 'screenshot'>

export interface ComputerUseRuntime {
  /** Process-lifetime dependencies. `createComputerUseMcpServer` needs them. */
  readonly adapter: ComputerUseHostAdapter
  /** Session state bag. Shared with every transport bound to this runtime. */
  readonly context: ComputerUseSessionContext
  readonly coordinateMode: CoordinateMode
  /** Tool list with this machine's installed apps spliced into `request_access`. */
  readonly tools: ReturnType<typeof buildComputerUseTools>
  /** Kill switch, read fresh. Mirrors the `tools/list` gate. */
  isDisabled(): boolean
  /** Raw dispatch: keeps the screenshot blob and telemetry, appends no note. */
  invokeRaw(name: string, args?: unknown): Promise<CuCallToolResult>
  /** Transport-agnostic entry point. Blob stripped, `[COORD FRAME]` appended. */
  invoke(name: string, args?: unknown): Promise<CuToolReply>
}

/**
 * Installed-app names for the `request_access` description.
 *
 * Merges the registry list with processes that currently own a visible window:
 * the registry has no usable name for Store apps, which are exactly what an
 * agent is often asked to drive. Window apps are tagged so the name filter can
 * skip the install-path allowlist — a running, on-screen app is user-facing by
 * definition.
 *
 * `undefined` when enumeration fails; the description then omits the hint
 * rather than promising a list it could not build.
 */
export async function getInstalledAppNames(): Promise<string[] | undefined> {
  try {
    const installed = await getComputerUseHostAdapter().executor.listInstalledApps()
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

/**
 * Blob off, coordinate note on.
 *
 * `mcpServer.ts` performs the equivalent transform for the MCP transport and
 * cannot import this file (the vendor layer never depends on its host), so the
 * two exist in parallel by necessity. Both must append the note as a NEW block
 * and leave `content[0]` untouched: single-line JSON results stay parseable,
 * and `computer_batch` reads `content[0]` as the payload.
 */
export function finalizeToolResult(
  raw: CuCallToolResult,
  coordinateMode: CoordinateMode,
): CuToolReply {
  const { screenshot: _blob, ...reply } = raw
  return {
    ...reply,
    content: [
      ...(reply.content ?? []),
      { type: 'text' as const, text: coordinateReminder(coordinateMode) },
    ],
  }
}

export async function createComputerUseRuntime(): Promise<ComputerUseRuntime> {
  const adapter = getComputerUseHostAdapter()
  const coordinateMode = getChicagoCoordinateMode()
  const context = createSessionContext()
  // Enumerate BEFORE binding: `request_access`'s description enumerates this
  // machine's apps, and only the executor can answer that round trip.
  const installedAppNames = await getInstalledAppNames()
  const tools = buildComputerUseTools(
    adapter.executor.capabilities,
    coordinateMode,
    installedAppNames,
  )
  // Bound exactly once. A second `bindSessionContext` would give the process a
  // second last-screenshot cell, and after the first capture the two would
  // disagree about which frame coordinates refer to — the click that follows a
  // screenshot taken through the other entry point would be rejected as
  // "outside the last screenshot image", or worse, land somewhere stale.
  const invokeRaw = bindSessionContext(adapter, coordinateMode, context)

  return {
    adapter,
    context,
    coordinateMode,
    tools,
    isDisabled: () => adapter.isDisabled(),
    invokeRaw,
    invoke: async (name, args) =>
      finalizeToolResult(await invokeRaw(name, args ?? {}), coordinateMode),
  }
}
