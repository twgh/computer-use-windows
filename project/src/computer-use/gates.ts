import type { CoordinateMode, CuSubGates } from '../vendor/computer-use-mcp/types.js'

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
