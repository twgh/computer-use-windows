/**
 * One coordinate truth, restated on EVERY tool result.
 *
 * The rule used to live only in SKILL.md and in the tools/list descriptions —
 * both read once, near the start of a session. In a long conversation a model
 * re-derives a "physical / logical / resized" ratio from whatever numbers it
 * last saw (monitor resolution, DPI percentage, the downsample example in the
 * docs) and starts multiplying image pixels by 1.843 / 1.227 / ... before
 * sending them. The server then scales a second time, and the factor flips
 * between calls depending on which ratio the model currently believes in.
 *
 * Two defences live here:
 *   1. `coordinateReminder` — appended to every tool result, so the rule is
 *      always in the most recent context window instead of only at the top.
 *   2. `validateModelCoordinateFrame` — a hard gate at the shared action
 *      dispatcher: no screenshot anchor, no coordinates; coordinates that
 *      cannot be image pixels, no action.
 *
 * Rule for all model-facing text in this module: NO ratio numbers. Never give
 * the model a number it could multiply by. Bounds in an error message are
 * explicitly labelled as bounds, never as a conversion factor.
 */

import type { ScreenshotResult } from "./executor.js";
import type { CoordinateMode } from "./types.js";

/** The one sentence every coordinate-bearing surface must carry. */
export const COORD_RULE =
  "Use the pixel you read directly off the last full-screen screenshot image, verbatim. " +
  "Never apply any conversion (no DPI, resolution, or resize math) — the server maps image pixels to the screen.";

/** `normalized_0_100` has no image-pixel space; say so instead of "scaling". */
export const COORD_RULE_NORMALIZED =
  "Coordinates are percentages (0-100) of the target display. Send them verbatim; never convert them to or from pixel values.";

export function coordinateReminder(mode: CoordinateMode): string {
  return `[COORD FRAME] ${
    mode === "normalized_0_100" ? COORD_RULE_NORMALIZED : COORD_RULE
  }`;
}

/**
 * Appended to monitor notes. Their labels contain `WxH @<scale>%` (needed to
 * tell monitors apart), which is exactly the kind of number a model will try
 * to "use" later in a long session.
 */
export const COORD_MONITOR_DISCLAIMER =
  "Resolution and scale figures in monitor names identify hardware only — never use them for coordinate math.";

/** Tools whose `coordinate` / `start_coordinate` args are model-space coords. */
const COORDINATE_TOOLS = new Set([
  "left_click",
  "double_click",
  "triple_click",
  "right_click",
  "middle_click",
  "mouse_move",
  "scroll",
  "left_click_drag",
]);

export interface CoordinateFrame {
  mode: CoordinateMode;
  /** Last full-screen screenshot; dims-only reconstruction is fine. */
  screenshot?: ScreenshotResult;
}

function noFrameError(): string {
  return (
    "[COORD FRAME] No screenshot anchor: these coordinates cannot be mapped. " +
    "Call screenshot first, then copy the pixel you read off the returned image. " +
    COORD_RULE
  );
}

/**
 * Reject coordinates that cannot be pixel coordinates of the last screenshot.
 *
 * This is a bound check, not a lie detector: a coordinate multiplied by a
 * ratio small enough to stay inside the image is indistinguishable from a
 * legitimate one. The `[COORD FRAME]` reminder on every result is what deals
 * with that case; this gate catches the rest and — more importantly — removes
 * the old "no screenshot → guess with /scaleFactor" fallback, which used to
 * reward the model for doing its own DPI math.
 *
 * `zoom` is excluded: its `region` is a 4-tuple with its own bounds check, and
 * it never moves the coordinate frame.
 */
export function validateModelCoordinateFrame(
  toolName: string,
  args: Record<string, unknown>,
  frame: CoordinateFrame,
): string | undefined {
  if (!COORDINATE_TOOLS.has(toolName)) return undefined;

  const shot = frame.screenshot;
  if (frame.mode !== "normalized_0_100" && !shot) return noFrameError();

  for (const param of ["coordinate", "start_coordinate"]) {
    const value = args[param];
    if (!Array.isArray(value) || value.length !== 2) continue;
    const [x, y] = value;
    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      // Let the handler's own arg validation report malformed tuples.
      continue;
    }

    if (frame.mode === "normalized_0_100") {
      if (x < 0 || y < 0 || x > 100 || y > 100) {
        return (
          `[COORD FRAME] (${x}, ${y}) is outside 0-100. ` +
          COORD_RULE_NORMALIZED
        );
      }
      continue;
    }

    // +1 tolerance: the exact right/bottom edge is a legitimate image pixel.
    if (x < 0 || y < 0 || x > shot!.width + 1 || y > shot!.height + 1) {
      return (
        `[COORD FRAME] (${x}, ${y}) is outside the last screenshot image ` +
        `(${shot!.width}x${shot!.height}). Those are image bounds, not a conversion factor. ` +
        "This usually means a display, DPI or resize ratio was applied to a coordinate " +
        "that was already in image space. " +
        COORD_RULE +
        " If the layout changed, take a fresh screenshot and read the pixel again."
      );
    }
  }

  return undefined;
}
