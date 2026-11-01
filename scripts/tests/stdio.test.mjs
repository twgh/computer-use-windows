/**
 * Integration test: spawn the real MCP server over stdio and assert on what an
 * agent would actually receive.
 *
 * This exercises the parts a unit test cannot reach — the SDK wiring, the
 * `initialize` handshake, the gate ordering, and the exact error strings that
 * are the only guidance a skill-skipping agent ever reads.
 *
 * It injects NO input and touches NO user window. It does take the desktop
 * session lock (any non-defer tool call does), so a concurrently running agent
 * session makes these skip rather than fail, and the lock is released at the
 * end regardless.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const cliPath = path.join(root, "project", "dist", "cli.js");
const pkg = JSON.parse(
  readFileSync(path.join(root, "project", "package.json"), "utf8"),
);

const child = spawn(process.execPath, [cliPath], {
  stdio: ["pipe", "pipe", "ignore"],
});

let nextId = 1;
const pending = new Map();
let lineBuf = "";
let lockHeldByOther = false;

child.stdout.on("data", (d) => {
  lineBuf += d.toString();
  let i;
  while ((i = lineBuf.indexOf("\n")) >= 0) {
    const line = lineBuf.slice(0, i).trim();
    lineBuf = lineBuf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

after(() => child.kill());

function rpc(method, params, timeoutMs = 60000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (m) => {
        clearTimeout(timer);
        resolve(m);
      },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function callTool(name, args) {
  return rpc("tools/call", { name, arguments: args });
}

function textOf(response) {
  const content = response?.result?.content ?? response?.error?.message ?? "";
  if (Array.isArray(content)) {
    return content.filter((p) => p.type === "text").map((p) => p.text).join(" ");
  }
  return String(content);
}

const isError = (response) =>
  response?.result?.isError === true || response?.error !== undefined;

/** Another agent session owns the desktop — report skip, not failure. */
function skipIfLocked(response, t) {
  if (isError(response) && /already in use by another session/.test(textOf(response))) {
    lockHeldByOther = true;
    t.skip("desktop lock held by another agent session");
    return true;
  }
  return lockHeldByOther;
}

const init = await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "computer-use-tests", version: "0" },
});
notify("notifications/initialized", {});

test("initialize reports the server version matching package.json", () => {
  assert.equal(init.result.serverInfo.version, pkg.version);
});

test("initialize carries instructions naming request_access as the prerequisite", () => {
  // The one text position that speaks before the first call. Without it a
  // skill-skipping agent's first sight of this server is an error.
  const instructions = init.result.instructions;
  assert.ok(typeof instructions === "string" && instructions.length > 100, "instructions missing");
  assert.match(instructions, /request_access/);
  assert.match(instructions, /screenshot/);
});

test("tools/list exposes all 25 tools", async () => {
  const list = await rpc("tools/list", {});
  const names = list.result.tools.map((tool) => tool.name);
  assert.equal(names.length, 25, `got ${names.length}: ${names.join(", ")}`);
  for (const expected of [
    "request_access",
    "list_granted_applications",
    "release_lock",
    "screenshot",
    "zoom",
    "scroll",
    "computer_batch",
    "open_application",
    "read_clipboard",
    "write_clipboard",
  ]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
});

test("every tool description is non-empty (honest-descriptions invariant)", async () => {
  const list = await rpc("tools/list", {});
  for (const tool of list.result.tools) {
    assert.ok(tool.description?.trim().length > 10, `${tool.name} has no description`);
  }
});

test("screenshot on an empty allowlist fails with self-guiding text", async (t) => {
  const response = await callTool("screenshot", {});
  if (skipIfLocked(response, t)) return;
  assert.ok(isError(response), "screenshot must not succeed with nothing granted");
  const text = textOf(response);
  assert.match(text, /request_access/);
  assert.match(text, /computer-use skill/);
  // The stale-grant cause is the one an agent cannot infer from the message.
  assert.match(text, /rebuilt|moved/);
});

test("an unknown monitor is rejected rather than silently accepted", async (t) => {
  const response = await callTool("switch_display", { display: "Display 999 · nope" });
  if (skipIfLocked(response, t)) return;
  // The invariant is "an unknown name never succeeds". Which error shape it
  // takes depends on the machine: a runner with no display at all fails
  // enumeration instead of listing candidates, and both are correct.
  assert.ok(isError(response), textOf(response));
  const text = textOf(response);
  if (/Available monitors/.test(text)) {
    assert.match(text, /No monitor named "Display 999 · nope"/);
  }
});

test("open_application refuses a name matching two grants instead of guessing", async (t) => {
  const granted = await callTool("request_access", {
    apps: ["Windows PowerShell", "PowerShell 7"],
    reason: "test: ambiguous name resolution",
  });
  if (skipIfLocked(granted, t)) return;
  // Both entries have to exist on this machine for the input to be ambiguous.
  // Where only one is installed the call would resolve uniquely and actually
  // launch something, so the case is skipped — the logic itself is covered by
  // the pure `resolveGrantedApp` unit test, which needs no installed apps.
  const payload = JSON.parse(textOf(granted));
  if ((payload.granted ?? []).length !== 2) {
    t.skip(`only ${(payload.granted ?? []).length} of the two names is installed here`);
    return;
  }
  const response = await callTool("open_application", { app: "PowerShell" });
  assert.ok(isError(response), "ambiguous input must not silently pick a grant");
  assert.match(textOf(response), /matches 2 granted applications/);
});

test("release_lock gives the desktop back", async (t) => {
  const response = await callTool("release_lock", {});
  if (skipIfLocked(response, t)) return;
  assert.ok(!isError(response), textOf(response));
});
