/**
 * Pure-logic tests for the vendored MCP layer. Run against the built output, so
 * `npm run build` must have happened first (scripts/run_tests.py does that).
 *
 *     node --test scripts/tests/
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveGrantedApp } from "../../project/dist/vendor/computer-use-mcp/toolCalls.js";
import { getDeniedCategoryForApp } from "../../project/dist/vendor/computer-use-mcp/deniedApps.js";

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
