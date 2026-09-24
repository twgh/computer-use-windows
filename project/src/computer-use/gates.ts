import type { ResizeParams } from '../vendor/computer-use-mcp/imageResize.js'
import { API_RESIZE_PARAMS } from '../vendor/computer-use-mcp/imageResize.js'
import type { CoordinateMode, CuSubGates } from '../vendor/computer-use-mcp/types.js'
import { logWarn } from '../lib/log.js'

const enabled = process.env.COMPUTER_USE_ENABLED !== '0'
const coordinateMode = (process.env.COMPUTER_USE_COORDINATE_MODE as CoordinateMode | undefined) ?? 'pixels'

export function getChicagoEnabled(): boolean {
  return enabled
}

export function getChicagoCoordinateMode(): CoordinateMode {
  return coordinateMode
}

/**
 * Pre-action preparation toggle. Renamed from
 * `COMPUTER_USE_HIDE_BEFORE_ACTION`: on this runtime the preparation raises a
 * granted app's window and hides nothing, so the old name described macOS
 * behavior that doesn't exist here.
 *
 * `COMPUTER_USE_FOCUS_BEFORE_ACTION` wins when set; the legacy variable is
 * still read as a fallback so MCP client configs written before 0.2.0 keep
 * working unchanged. Both are re-read per call.
 */
function focusBeforeActionEnabled(): boolean {
  const current = process.env.COMPUTER_USE_FOCUS_BEFORE_ACTION
  if (current !== undefined) return current !== '0'
  const legacy = process.env.COMPUTER_USE_HIDE_BEFORE_ACTION
  return legacy === undefined ? true : legacy !== '0'
}

export function getChicagoSubGates(): CuSubGates {
  return {
    pixelValidation: process.env.COMPUTER_USE_PIXEL_VALIDATION === '1',
    clipboardPasteMultiline: process.env.COMPUTER_USE_CLIPBOARD_PASTE !== '0',
    mouseAnimation: process.env.COMPUTER_USE_MOUSE_ANIMATION !== '0',
    focusBeforeAction: focusBeforeActionEnabled(),
    autoTargetDisplay: process.env.COMPUTER_USE_AUTO_TARGET_DISPLAY !== '0',
    clipboardGuard: process.env.COMPUTER_USE_CLIPBOARD_GUARD !== '0',
  }
}

/** Sentinel for `COMPUTER_USE_IMAGE_MAX_*`: no pre-resize, raw capture. */
const NATIVE_BUDGET = Number.MAX_SAFE_INTEGER

/** `label` is what gets logged — the sentinel is not a number worth printing. */
function readCap(name: string, fallback: number): { value: number; label: string } {
  const raw = process.env[name]?.trim()
  if (!raw) return { value: fallback, label: String(fallback) }
  if (raw.toLowerCase() === 'native') return { value: NATIVE_BUDGET, label: 'native' }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logWarn(
      '[computer-use] ignoring %s=%s (expected a positive number or "native"); using %d.',
      name,
      raw,
      fallback,
    )
    return { value: fallback, label: String(fallback) }
  }
  const value = Math.floor(parsed)
  return { value, label: String(value) }
}

let warnedAboutImageBudget = false

/**
 * Long-edge cap and tile budget for images handed to the model.
 *
 * The defaults are NOT this runtime's preference: they are a port of the
 * consuming model's own image transcoder (`imageResize.ts`). Pre-resizing to
 * exactly those numbers is what makes `ScreenshotResult.width/height` equal the
 * size the model actually sees, and therefore what makes `scaleCoord` correct.
 *
 * `COMPUTER_USE_IMAGE_MAX_PX` / `COMPUTER_USE_IMAGE_MAX_TOKENS` override them,
 * or accept `native` to send the raw capture. Only raise them when the attached
 * model really does accept a larger image — a local VLM, or a service with
 * different tiling. Sending more than the consumer accepts is worse than
 * useless: it re-resizes on arrival, the model then reads coordinates off a
 * larger image than we reported, and every click scales by the wrong ratio
 * (~13% off for 1568 vs 1389). Use `COMPUTER_USE_COORDINATE_MODE=
 * normalized_0_100` alongside an override: percentages survive any downstream
 * re-resize.
 */
export function getImageResizeParams(): ResizeParams {
  const px = readCap('COMPUTER_USE_IMAGE_MAX_PX', API_RESIZE_PARAMS.maxTargetPx)
  const tokens = readCap(
    'COMPUTER_USE_IMAGE_MAX_TOKENS',
    API_RESIZE_PARAMS.maxTargetTokens,
  )
  const params: ResizeParams = {
    pxPerToken: API_RESIZE_PARAMS.pxPerToken,
    maxTargetPx: px.value,
    maxTargetTokens: tokens.value,
  }

  if (
    !warnedAboutImageBudget &&
    (params.maxTargetPx !== API_RESIZE_PARAMS.maxTargetPx ||
      params.maxTargetTokens !== API_RESIZE_PARAMS.maxTargetTokens)
  ) {
    warnedAboutImageBudget = true
    logWarn(
      '[computer-use] image budget overridden (maxTargetPx=%s, maxTargetTokens=%s vs default 1568/1568). ' +
        'Click coordinates stay correct only if the consuming model does not re-resize the image; ' +
        'prefer COMPUTER_USE_COORDINATE_MODE=normalized_0_100 when raising it.',
      px.label,
      tokens.label,
    )
  }

  return params
}
