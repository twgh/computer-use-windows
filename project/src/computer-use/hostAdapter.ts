import type { ComputerUseHostAdapter, Logger } from '../vendor/computer-use-mcp/types.js'
import { format } from 'node:util'
import { logDebug, logWarn } from '../lib/log.js'
import { COMPUTER_USE_MCP_SERVER_NAME } from './common.js'
import { createCliExecutor } from './executor.js'
import { getChicagoEnabled, getChicagoSubGates } from './gates.js'
import { callPythonHelper } from './pythonBridge.js'

class DebugLogger implements Logger {
  silly(message: string, ...args: unknown[]): void { logDebug(format(message, ...args)) }
  debug(message: string, ...args: unknown[]): void { logDebug(format(message, ...args)) }
  info(message: string, ...args: unknown[]): void { logDebug(format(message, ...args)) }
  warn(message: string, ...args: unknown[]): void { logWarn(format(message, ...args)) }
  error(message: string, ...args: unknown[]): void { logWarn(format(message, ...args)) }
}

type OsPermissions = {
  granted: boolean
  accessibility?: boolean
  screenRecording?: boolean
}

let memoizedOsPermissions: Promise<OsPermissions> | undefined

/**
 * OS-permission check, memoized for the process lifetime.
 *
 * The Windows helper has nothing to ask about — `check_permissions` returns a
 * constant `{accessibility: true, screenRecording: true}`, because there is no
 * TCC equivalent here. But the vendored Gate 2 awaits this on EVERY tool call,
 * and each await is a fresh Python process (measured 229ms; a bare `wait` tool
 * call is 294ms, essentially all permission check). Memoizing removes ~20% of
 * the latency of every tool call.
 *
 * If a real precondition is ever wired in here — session 0 / no interactive
 * desktop, RDP disconnected, UAC secure desktop — DROP THIS MEMO: those change
 * while the server runs, unlike the constant answered today.
 */
function ensureOsPermissions(): Promise<OsPermissions> {
  memoizedOsPermissions ??= (async () => {
    try {
      const perms = await callPythonHelper<{ accessibility: boolean; screenRecording: boolean }>('check_permissions', {})
      return perms.accessibility && perms.screenRecording
        ? { granted: true as const }
        : { granted: false as const, accessibility: perms.accessibility, screenRecording: perms.screenRecording }
    } catch (error) {
      // Never cache a failure: a transient spawn error must not pin the session
      // into "permissions missing" for its whole life.
      memoizedOsPermissions = undefined
      throw error
    }
  })()
  return memoizedOsPermissions
}

let cached: ComputerUseHostAdapter | undefined

export function getComputerUseHostAdapter(): ComputerUseHostAdapter {
  if (cached) return cached
  cached = {
    serverName: COMPUTER_USE_MCP_SERVER_NAME,
    logger: new DebugLogger(),
    executor: createCliExecutor({
      getMouseAnimationEnabled: () => getChicagoSubGates().mouseAnimation,
    }),
    ensureOsPermissions,
    isDisabled: () => !getChicagoEnabled(),
    getSubGates: getChicagoSubGates,
    getAutoUnhideEnabled: () => true,
    cropRawPatch: () => null,
  }
  return cached
}
