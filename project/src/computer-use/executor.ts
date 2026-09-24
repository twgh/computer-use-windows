import type {
  ComputerExecutor,
  DisplayGeometry,
  FrontmostApp,
  InstalledApp,
  ResolvePrepareCaptureResult,
  RunningApp,
  ScreenshotResult,
} from '../vendor/computer-use-mcp/executor.js'
import { API_RESIZE_PARAMS, targetImageSize } from '../vendor/computer-use-mcp/imageResize.js'
import { sleep } from '../lib/sleep.js'
import { CLI_CU_CAPABILITIES, CLI_HOST_BUNDLE_ID } from './common.js'
import { callPythonHelper } from './pythonBridge.js'

const SCREENSHOT_JPEG_QUALITY = 0.75
const MOVE_SETTLE_MS = 50

type PythonDisplayGeometry = DisplayGeometry

type PythonResolvePrepareCaptureResult = ResolvePrepareCaptureResult

/**
 * Capture target for `screenshot`: the display's own pixel size, capped by the
 * vision budget. Never larger than the capture.
 *
 * Deliberately NOT multiplied by `scaleFactor`. That multiplication is a macOS
 * porting leftover — there `DisplayGeometry.width/height` are logical points, so
 * a Retina capture needs the factor to reach physical pixels. This backend
 * reports physical pixels (mss grabs them, and a PMv2-aware `GetWindowRect`
 * agrees), so multiplying upscales instead: a 1280x800 display was captured at
 * 1280x800 and then resampled to 1389x868 — interpolated pixels, bigger
 * payload, no extra detail. Screens large enough to hit the token budget were
 * unaffected, which is why this hid for so long.
 */
function screenshotTargetDims(width: number, height: number): [number, number] {
  return targetImageSize(width, height, API_RESIZE_PARAMS)
}

/**
 * Capture target for `zoom`. Magnification here is intentional: the tool exists
 * to make text the model could not read legible, and a 1:1 crop of an already
 * downsampled screenshot is exactly what it already could not read. Follows the
 * display scale factor, then the same vision budget applies.
 */
function zoomTargetDims(
  physicalW: number,
  physicalH: number,
  scaleFactor: number,
): [number, number] {
  return targetImageSize(
    Math.round(physicalW * scaleFactor),
    Math.round(physicalH * scaleFactor),
    API_RESIZE_PARAMS,
  )
}

function normalizeDisplayGeometry(display: PythonDisplayGeometry): DisplayGeometry {
  return {
    ...display,
    displayId: display.displayId ?? display.id,
    label: display.label ?? display.name,
  }
}

async function readClipboard(): Promise<string> {
  return callPythonHelper('read_clipboard', {})
}

async function writeClipboard(text: string): Promise<void> {
  await callPythonHelper('write_clipboard', { text })
}

async function typeViaClipboard(text: string): Promise<void> {
  let saved: string | undefined
  try {
    saved = await readClipboard()
  } catch {}

  try {
    await writeClipboard(text)
    await callPythonHelper('key', { keySequence: 'ctrl+v', repeat: 1 })
    await sleep(100)
  } finally {
    if (typeof saved === 'string') {
      try {
        await writeClipboard(saved)
      } catch {}
    }
  }
}

export function createCliExecutor(opts: {
  getMouseAnimationEnabled: () => boolean
}): ComputerExecutor {
  if (process.platform !== 'win32') {
    throw new Error(`createCliExecutor called on ${process.platform}. Computer control is Windows-only.`)
  }

  // Resolved per action, not captured at construction: flipping
  // COMPUTER_USE_MOUSE_ANIMATION mid-session takes effect on the next click
  // without restarting the server. The helper owns the distance → duration
  // math (it already has the cursor position, so this stays one round trip).
  const animate = (): boolean => opts.getMouseAnimationEnabled()

  return {
    capabilities: {
      ...CLI_CU_CAPABILITIES,
      hostBundleId: CLI_HOST_BUNDLE_ID,
    },

    async prepareForAction(allowlistBundleIds: string[]): Promise<string[]> {
      return callPythonHelper('prepare_for_action', { allowlistBundleIds })
    },

    async previewHideSet() {
      return callPythonHelper('preview_hide_set', {})
    },

    async getDisplaySize(displayId?: number): Promise<DisplayGeometry> {
      return normalizeDisplayGeometry(await callPythonHelper('get_display_size', { displayId }))
    },

    async listDisplays(): Promise<DisplayGeometry[]> {
      const displays = await callPythonHelper<PythonDisplayGeometry[]>('list_displays', {})
      return displays.map(display => normalizeDisplayGeometry(display))
    },

    async findWindowDisplays(bundleIds: string[]) {
      return callPythonHelper('find_window_displays', { bundleIds })
    },

    async resolvePrepareCapture(opts): Promise<ResolvePrepareCaptureResult> {
      const display = await this.getDisplaySize(opts.preferredDisplayId)
      const [targetW, targetH] = screenshotTargetDims(display.width, display.height)
      const result = await callPythonHelper<PythonResolvePrepareCaptureResult>('resolve_prepare_capture', {
        preferredDisplayId: opts.preferredDisplayId,
        // Forwarded so the helper can pick the display the granted apps are on
        // when nothing is pinned. Without these two the backend had no way to
        // honor `autoResolve` and always fell back to the primary display.
        autoResolve: opts.autoResolve,
        allowlistBundleIds: opts.allowedBundleIds,
        targetWidth: targetW,
        targetHeight: targetH,
        jpegQuality: SCREENSHOT_JPEG_QUALITY,
      })
      return {
        ...result,
        display: normalizeDisplayGeometry(result.display),
        resolvedDisplayId: result.resolvedDisplayId ?? result.displayId,
      }
    },

    async screenshot(opts): Promise<ScreenshotResult> {
      const display = await this.getDisplaySize(opts.displayId)
      const [targetW, targetH] = screenshotTargetDims(display.width, display.height)
      const result = await callPythonHelper<ScreenshotResult>('screenshot', {
        displayId: opts.displayId,
        targetWidth: targetW,
        targetHeight: targetH,
        jpegQuality: SCREENSHOT_JPEG_QUALITY,
      })
      return result
    },

    async zoom(regionLogical, _allowedBundleIds, displayId) {
      const display = await this.getDisplaySize(displayId)
      const [outW, outH] = zoomTargetDims(regionLogical.w, regionLogical.h, display.scaleFactor)
      return callPythonHelper('zoom', {
        x: regionLogical.x,
        y: regionLogical.y,
        width: regionLogical.w,
        height: regionLogical.h,
        targetWidth: outW,
        targetHeight: outH,
      })
    },

    async key(keySequence: string, repeat?: number): Promise<void> {
      await callPythonHelper('key', { keySequence, repeat: repeat ?? 1 })
    },

    async holdKey(keyNames: string[], durationMs: number): Promise<void> {
      await callPythonHelper('hold_key', { keyNames, durationMs })
    },

    async type(text: string, opts2: { viaClipboard: boolean }): Promise<void> {
      if (opts2.viaClipboard) {
        await typeViaClipboard(text)
        return
      }
      await callPythonHelper('type', { text })
    },

    readClipboard,
    writeClipboard,

    async click(x, y, button, count, modifiers): Promise<void> {
      await callPythonHelper('click', { x, y, button, count, modifiers, animate: animate() })
      await sleep(MOVE_SETTLE_MS)
    },

    async mouseDown(): Promise<void> {
      await callPythonHelper('mouse_down', {})
    },

    async mouseUp(): Promise<void> {
      await callPythonHelper('mouse_up', {})
    },

    async getCursorPosition(): Promise<{ x: number; y: number }> {
      return callPythonHelper('cursor_position', {})
    },

    async drag(from, to): Promise<void> {
      await callPythonHelper('drag', { from, to, animate: animate() })
      await sleep(MOVE_SETTLE_MS)
    },

    async moveMouse(x, y): Promise<void> {
      await callPythonHelper('move_mouse', { x, y, animate: animate() })
      await sleep(MOVE_SETTLE_MS)
    },

    async scroll(x, y, dx, dy): Promise<void> {
      await callPythonHelper('scroll', { x, y, deltaX: dx, deltaY: dy, animate: animate() })
    },

    async getFrontmostApp(): Promise<FrontmostApp | null> {
      return callPythonHelper('frontmost_app', {})
    },

    async appUnderPoint(x, y) {
      return callPythonHelper('app_under_point', { x, y })
    },

    async listInstalledApps(): Promise<InstalledApp[]> {
      return callPythonHelper('list_installed_apps', {})
    },

    async listRunningApps(): Promise<RunningApp[]> {
      return callPythonHelper('list_running_apps', {})
    },

    async openApp(bundleId: string): Promise<void> {
      await callPythonHelper('open_app', { bundleId })
    },
  }
}

export async function unhideComputerUseApps(_bundleIds: readonly string[]): Promise<void> {
  return
}
