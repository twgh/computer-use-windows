import type {
  AppGrant,
  ComputerUseSessionContext,
  CuGrantFlags,
  CuPermissionRequest,
  CuPermissionResponse,
  ScreenshotDims,
} from './vendor/computer-use-mcp/types.js'
import { DEFAULT_GRANT_FLAGS } from './vendor/computer-use-mcp/types.js'
import { checkComputerUseLock, idleStealSeconds, releaseComputerUseLock, touchComputerUseLock, tryAcquireComputerUseLock } from './computer-use/computerUseLock.js'
import { saveImageToDisk } from './computer-use/imageSave.js'

type State = {
  allowedApps: AppGrant[]
  grantFlags: CuGrantFlags
  hiddenDuringTurn: Set<string>
  clipboardStash?: string
  selectedDisplayId?: number
  displayPinnedByModel?: boolean
  displayResolvedForApps?: string
  lastScreenshotDims?: ScreenshotDims
}

function autoApprovePermission(req: CuPermissionRequest): CuPermissionResponse {
  const granted = req.apps
    .filter(app => app.resolved && !app.alreadyGranted)
    .map(app => ({
      bundleId: app.resolved!.bundleId,
      displayName: app.resolved!.displayName,
      grantedAt: Date.now(),
      tier: app.proposedTier,
    }))

  const denied = req.apps
    .filter(app => !app.resolved)
    .map(app => ({
      bundleId: app.requestedName,
      reason: 'not_installed' as const,
    }))

  return {
    granted,
    denied,
    flags: {
      ...DEFAULT_GRANT_FLAGS,
      ...req.requestedFlags,
    },
  }
}

export function createSessionContext(): ComputerUseSessionContext {
  const state: State = {
    allowedApps: [],
    grantFlags: { ...DEFAULT_GRANT_FLAGS },
    hiddenDuringTurn: new Set<string>(),
  }

  return {
    getAllowedApps: () => state.allowedApps,
    getGrantFlags: () => state.grantFlags,
    getUserDeniedBundleIds: () => [],
    getSelectedDisplayId: () => state.selectedDisplayId,
    getDisplayPinnedByModel: () => state.displayPinnedByModel ?? false,
    getDisplayResolvedForApps: () => state.displayResolvedForApps,
    getLastScreenshotDims: () => state.lastScreenshotDims,
    onPermissionRequest: async req => autoApprovePermission(req),
    onAllowedAppsChanged: (apps, flags) => {
      state.allowedApps = [...apps]
      state.grantFlags = flags
    },
    onAppsHidden: ids => {
      for (const id of ids) state.hiddenDuringTurn.add(id)
    },
    getClipboardStash: () => state.clipboardStash,
    onClipboardStashChanged: stash => {
      state.clipboardStash = stash
    },
    onResolvedDisplayUpdated: displayId => {
      state.selectedDisplayId = displayId
      state.displayPinnedByModel = false
    },
    onDisplayPinned: displayId => {
      state.selectedDisplayId = displayId
      state.displayPinnedByModel = displayId !== undefined
      if (displayId === undefined) state.displayResolvedForApps = undefined
    },
    onDisplayResolvedForApps: key => {
      state.displayResolvedForApps = key
    },
    onScreenshotCaptured: dims => {
      state.lastScreenshotDims = dims
    },
    // Backs `save_to_disk: true` on screenshot/zoom. Writes under the OS temp
    // directory — never into the skill tree — and returns the absolute path the
    // model reports to the user.
    saveImageToDisk,
    checkCuLock: async () => {
      const result = await checkComputerUseLock()
      switch (result.kind) {
        case 'free':
          return { holder: undefined, isSelf: false }
        case 'held_by_self':
          // Heartbeat: every gated tool call (including the defer tools)
          // refreshes the timestamp, so another session's idle-steal only
          // fires when this session is truly dormant, not merely between
          // tool calls.
          await touchComputerUseLock()
          return { holder: process.env.CODEX_THREAD_ID ?? `pid-${process.pid}`, isSelf: true }
        case 'blocked':
          return { holder: result.by, isSelf: false }
      }
    },
    acquireCuLock: async () => {
      const result = await tryAcquireComputerUseLock()
      if (result.kind === 'blocked') {
        throw new Error(`Computer use is locked by another session (${result.by}).`)
      }
    },
    releaseCuLock: async () => releaseComputerUseLock(),
    // The "who holds it and when it frees up" half — the vendor appends
    // `LOCK_HELD_GUIDANCE` with what a blocked session can actually do, so this
    // stays factual and does not repeat "wait for them". The idle number lives
    // here because only this host knows its policy, and promising takeover when
    // `COMPUTER_USE_LOCK_IDLE_SECS=0` disabled it is worse than saying nothing.
    // "Normally" is load-bearing: a lock written by a pre-0.5.0 runtime carries
    // no heartbeat, and those are never taken over.
    formatLockHeldMessage: holder => {
      const idle = idleStealSeconds()
      return (
        `Computer use is already in use by another session (${holder}). ` +
        (idle > 0
          ? `A holder that goes quiet is normally taken over after ${idle}s without computer-use calls.`
          : `Automatic takeover is disabled on this machine (COMPUTER_USE_LOCK_IDLE_SECS=0).`)
      )
    },
  }
}
