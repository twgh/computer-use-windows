/**
 * Pure-logic tests for the vendored MCP layer. Run against the built output, so
 * `npm run build` must have happened first (scripts/run_tests.py does that).
 *
 *     node --test scripts/tests/
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveGrantedApp, _test } from "../../project/dist/vendor/computer-use-mcp/toolCalls.js";
import { getDeniedCategoryForApp } from "../../project/dist/vendor/computer-use-mcp/deniedApps.js";
import {
  COORD_MONITOR_DISCLAIMER,
  coordinateReminder,
  validateModelCoordinateFrame,
} from "../../project/dist/vendor/computer-use-mcp/coordinateFrame.js";
import {
  API_RESIZE_PARAMS,
  targetImageSize,
} from "../../project/dist/vendor/computer-use-mcp/imageResize.js";
import {
  getChicagoCoordinateMode,
  getCoordinateGridEnabled,
} from "../../project/dist/computer-use/gates.js";

const grant = (displayName, bundleId, tier = "full") => ({
  displayName,
  bundleId,
  tier,
  grantedAt: 0,
});

const NOTEPAD = grant("Notepad", "c:\\program files\\windowsapps\\notepad.exe");
const NPP = grant("Notepad++ (64-bit x64)", "c:\\apps\\notepad++\\notepad++.exe");
const PS5 = grant("Windows PowerShell", "c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe", "click");
const PS7 = grant("PowerShell 7", "c:\\program files\\powershell\\7\\pwsh.exe", "click");

test("exact display name wins over any loose candidate", () => {
  const r = resolveGrantedApp("Notepad", [NPP, NOTEPAD]);
  assert.equal(r.kind, "ok");
  assert.equal(r.grant.displayName, "Notepad");
});

test("loose match: the name passed to request_access resolves again", () => {
  // Regression: open_application used to require an exact display name, so
  // `Notepad++` was rejected as "not granted" while `request_access` had
  // accepted it — and the advice to re-run request_access looped the model.
  const r = resolveGrantedApp("Notepad++", [NPP]);
  assert.equal(r.kind, "ok");
  assert.equal(r.grant.bundleId, NPP.bundleId);
});

test("reverse containment is gone: Notepad++ must not also match Notepad", () => {
  // This is the bug the first version of the loose match introduced — it made a
  // unique answer into a false ambiguity.
  const r = resolveGrantedApp("Notepad++", [NOTEPAD, NPP]);
  assert.equal(r.kind, "ok");
  assert.equal(r.grant.bundleId, NPP.bundleId);
});

test("genuine ambiguity is refused, never guessed", () => {
  const r = resolveGrantedApp("PowerShell", [PS5, PS7]);
  assert.equal(r.kind, "ambiguous");
  assert.equal(r.grants.length, 2);
});

test("executable-name stem resolves to the grant", () => {
  const r = resolveGrantedApp("pwsh", [PS5, PS7]);
  assert.equal(r.kind, "ok");
  assert.equal(r.grant.displayName, "PowerShell 7");
});

test("unknown name with a non-empty allowlist is `none`, not ambiguous", () => {
  const r = resolveGrantedApp("DefinitelyNotInstalled", [NPP]);
  assert.equal(r.kind, "none");
});

test("empty allowlist resolves to none", () => {
  assert.equal(resolveGrantedApp("Notepad", []).kind, "none");
});

test("bundleId passthrough works only for a granted bundleId", () => {
  const hit = resolveGrantedApp(NPP.bundleId, [NPP]);
  assert.equal(hit.kind, "ok");
  assert.equal(hit.grant.bundleId, NPP.bundleId);
  assert.equal(resolveGrantedApp("c:\\other\\app.exe", [NPP]).kind, "none");
});

test("matching is case-insensitive", () => {
  assert.equal(resolveGrantedApp("nOtEpAd++", [NPP]).kind, "ok");
});

test("console hosts categorize as terminal — tier click, never full", () => {
  // conhost's display name is "Console Window Host", which contains no
  // "terminal" substring. Uncategorized it lands on the default tier = full
  // keyboard into a shell.
  const cases = [
    ["c:\\windows\\system32\\conhost.exe", "Console Window Host"],
    ["c:\\windows\\system32\\conhost.exe", "conhost"],
    ["c:\\program files\\windowsapps\\microsoft.windowsterminal_1.24_x64__8wekyb3d8bbwe\\windowsterminal.exe", "Windows Terminal Host"],
    ["c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe", "Windows PowerShell"],
  ];
  for (const [bundleId, displayName] of cases) {
    assert.equal(getDeniedCategoryForApp(bundleId, displayName), "terminal", displayName);
  }
});

test("ordinary apps are not mis-categorized", () => {
  assert.equal(getDeniedCategoryForApp(NPP.bundleId, NPP.displayName), null);
  assert.equal(getDeniedCategoryForApp(NOTEPAD.bundleId, NOTEPAD.displayName), null);
});

// ─── Coordinate frame ────────────────────────────────────────────────────
// Regression for the "1.843 / 1.227" drift: a long-session model starts
// multiplying image pixels by a physical-pixel or logical-point ratio, and
// the server scales a second time. See coordinateFrame.ts.

const shot = {
  base64: "",
  width: 1389,
  height: 868,
  displayWidth: 2560,
  displayHeight: 1600,
  originX: 0,
  originY: 0,
};
const display = {
  width: 2560,
  height: 1600,
  scaleFactor: 1.5,
  originX: 100,
  originY: 0,
};
const pixelsFrame = { mode: "pixels", screenshot: shot };

test("the reminder restates the rule without any number the model could multiply by", () => {
  const reminder = coordinateReminder("pixels");
  assert.match(reminder, /^\[COORD FRAME\]/);
  assert.match(reminder, /Never apply any conversion/);
  assert.doesNotMatch(reminder, /Grid labels/, "opt-in overlay is not promised by default");
  assert.doesNotMatch(reminder, /\d/, "no ratio / dimension figures in pixels-mode reminder");
  assert.match(coordinateReminder("normalized_0_100"), /percentages/);
  assert.match(COORD_MONITOR_DISCLAIMER, /never use them for coordinate math/);
});

test("verbatim image pixels pass the frame gate", () => {
  assert.equal(
    validateModelCoordinateFrame("left_click", { coordinate: [600, 400] }, pixelsFrame),
    undefined,
  );
  assert.equal(
    validateModelCoordinateFrame("wait", { duration: 1 }, pixelsFrame),
    undefined,
  );
  assert.equal(
    validateModelCoordinateFrame("zoom", { region: [0, 0, 5000, 5000] }, pixelsFrame),
    undefined,
    "zoom has its own region check and never changes the frame",
  );
});

test("physical-pixel rescaling (x1.843) is rejected before any click", () => {
  const err = validateModelCoordinateFrame(
    "left_click",
    { coordinate: [1000 * 1.843, 600 * 1.843] },
    pixelsFrame,
  );
  assert.match(err, /\[COORD FRAME\]/);
  assert.match(err, /outside the last screenshot image/);
  assert.match(err, /not a conversion factor/);
});

test("a small ratio that stays inside the image is a documented blind spot", () => {
  // The frame gate is a bound check, not a lie detector. This is exactly why
  // [COORD FRAME] is repeated on every single tool result instead of being
  // stated once in the skill doc.
  assert.equal(
    validateModelCoordinateFrame(
      "left_click",
      { coordinate: [600 * 1.227, 400 * 1.227] },
      pixelsFrame,
    ),
    undefined,
  );
});

test("drag start coordinate is checked too", () => {
  assert.match(
    validateModelCoordinateFrame(
      "left_click_drag",
      { coordinate: [700, 500], start_coordinate: [10, 900] },
      pixelsFrame,
    ),
    /outside the last screenshot image/,
  );
});

test("no screenshot anchor is a hard error, not a /scaleFactor guess", () => {
  const err = validateModelCoordinateFrame(
    "mouse_move",
    { coordinate: [600, 400] },
    { mode: "pixels" },
  );
  assert.match(err, /No screenshot anchor/);
  assert.equal(
    validateModelCoordinateFrame(
      "mouse_move",
      { coordinate: [50, 50] },
      { mode: "normalized_0_100" },
    ),
    undefined,
    "percentages need live display geometry, not a screenshot",
  );
  assert.match(
    validateModelCoordinateFrame(
      "scroll",
      { coordinate: [120, 50] },
      { mode: "normalized_0_100" },
    ),
    /outside 0-100/,
  );
});

test("scaleCoord uses capture-time image dims and ignores scaleFactor entirely", () => {
  const a = _test.scaleCoord(600, 400, "pixels", display, shot, {});
  const b = _test.scaleCoord(
    600,
    400,
    "pixels",
    { ...display, scaleFactor: 2.5 },
    shot,
    {},
  );
  assert.deepEqual(a, b);
  // Origin comes from the capture-time screenshot snapshot, NOT the fresh
  // display geometry — that is the point of snapshotted geometry.
  assert.deepEqual(a, {
    x: Math.round((600 * shot.displayWidth) / shot.width) + shot.originX,
    y: Math.round((400 * shot.displayHeight) / shot.height) + shot.originY,
  });
  assert.throws(
    () => _test.scaleCoord(600, 400, "pixels", display, undefined, {}),
    /No screenshot anchor/,
  );
});

test("image budget produces the frame dimensions the gate validates against", () => {
  assert.deepEqual(targetImageSize(2560, 1600, API_RESIZE_PARAMS), [1389, 868]);
});

test("coordinate grid is off by default and opt-in via env=1", () => {
  const saved = process.env.COMPUTER_USE_COORD_GRID;
  try {
    delete process.env.COMPUTER_USE_COORD_GRID;
    assert.equal(getCoordinateGridEnabled(), false);
    process.env.COMPUTER_USE_COORD_GRID = "0";
    assert.equal(getCoordinateGridEnabled(), false);
    process.env.COMPUTER_USE_COORD_GRID = "1";
    assert.equal(
      getCoordinateGridEnabled(),
      getChicagoCoordinateMode() === "pixels",
      "never draw pixel labels in normalized_0_100 mode",
    );
  } finally {
    if (saved === undefined) delete process.env.COMPUTER_USE_COORD_GRID;
    else process.env.COMPUTER_USE_COORD_GRID = saved;
  }
});
