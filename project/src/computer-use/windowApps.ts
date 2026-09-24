import type { InstalledApp } from '../vendor/computer-use-mcp/executor.js'
import { callPythonHelper } from './pythonBridge.js'

/**
 * Apps that currently own a visible top-level window.
 *
 * Only used to enrich the `request_access` candidate list. The registry-derived
 * `listInstalledApps()` misses every Store app — Calculator, Photos and friends
 * have no Uninstall / App Paths entry carrying a usable name — so a model asked
 * to drive the Calculator sitting on screen had no way to learn what to call it.
 * A visible window is the strongest signal that a process is something the user
 * can point at, and the helper already restricts this to on-screen, titled,
 * non-minimized windows.
 */
export async function listWindowApps(): Promise<InstalledApp[]> {
  return callPythonHelper<InstalledApp[]>('list_window_apps', {})
}
