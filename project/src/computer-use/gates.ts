import type { CoordinateMode, CuSubGates } from '../vendor/computer-use-mcp/types.js'

const enabled = process.env.COMPUTER_USE_ENABLED !== '0'
const coordinateMode = (process.env.COMPUTER_USE_COORDINATE_MODE as CoordinateMode | undefined) ?? 'pixels'

export function getChicagoEnabled(): boolean {
  return enabled
}

export function getChicagoCoordinateMode(): CoordinateMode {
  return coordinateMode
}

export function getChicagoSubGates(): CuSubGates {
  return {
    pixelValidation: process.env.COMPUTER_USE_PIXEL_VALIDATION === '1',
    clipboardPasteMultiline: process.env.COMPUTER_USE_CLIPBOARD_PASTE !== '0',
    mouseAnimation: process.env.COMPUTER_USE_MOUSE_ANIMATION !== '0',
    hideBeforeAction: process.env.COMPUTER_USE_HIDE_BEFORE_ACTION !== '0',
    autoTargetDisplay: process.env.COMPUTER_USE_AUTO_TARGET_DISPLAY !== '0',
    clipboardGuard: process.env.COMPUTER_USE_CLIPBOARD_GUARD !== '0',
  }
}
