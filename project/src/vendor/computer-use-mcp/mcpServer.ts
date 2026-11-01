/**
 * MCP server factory + session-context binder.
 *
 * Two entry points:
 *
 *   `bindSessionContext` — the wrapper closure. Takes a `ComputerUseSessionContext`
 *   (getters + callbacks backed by host session state), returns a dispatcher.
 *   Reusable by both the MCP CallTool handler here AND Cowork's
 *   `InternalServerDefinition.handleToolCall` (which doesn't go through MCP).
 *   This replaces the duplicated wrapper closures in earlier desktop host
 *   implementations and CLI host wrappers — both did the same thing: build `ComputerUseOverrides`
 *   fresh from getters, call `handleToolCall`, stash screenshot, merge permissions.
 *
 *   `createComputerUseMcpServer` — the Server object. When `context` is provided,
 *   the CallTool handler is real (uses `bindSessionContext`). When not, it's the
 *   legacy stub that returns a not-wired error. The tool-schema ListTools handler
 *   is the same either way.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { ScreenshotResult } from "./executor.js";
import type { CuCallToolResult } from "./toolCalls.js";
import {
  defersLockAcquire,
  handleToolCall,
  LOCK_HELD_GUIDANCE,
  resetMouseButtonHeld,
} from "./toolCalls.js";
import { buildComputerUseTools } from "./tools.js";
import type {
  AppGrant,
  ComputerUseHostAdapter,
  ComputerUseOverrides,
  ComputerUseSessionContext,
  CoordinateMode,
  CuGrantFlags,
  CuPermissionResponse,
} from "./types.js";
import { DEFAULT_GRANT_FLAGS } from "./types.js";

/**
 * The "who holds it" half. Hosts override it via
 * `ComputerUseSessionContext.formatLockHeldMessage` to name the holder and
 * their own idle-takeover policy; `LOCK_HELD_GUIDANCE` (from toolCalls.ts) is
 * appended either way so the "what can I do" half is never re-implemented, and
 * never contradicted by a host that disabled takeover.
 */
const DEFAULT_LOCK_HELD_MESSAGE =
  "Another agent session is currently using the computer.";

/**
 * The fixed call order, stated once where every MCP client can surface it to
 * the model. `request_access` is the hard prerequisite for everything else —
 * including `screenshot` — and nothing in the tool schemas says so in a place
 * a model reads before its first call.
 */
const SERVER_INSTRUCTIONS =
  "Desktop control for Windows. Fixed order: (1) request_access with the apps " +
  "you need and a one-sentence reason — the user approves in one dialog, and " +
  "EVERY other tool here, screenshot included, returns an error until that has " +
  "happened; (2) screenshot, and read all coordinates off that image; (3) act. " +
  "Screenshots are downscaled, so use zoom to read small text. The " +
  "computer-use skill that ships alongside this server documents the tiers, the " +
  "hit-test gate, batching, and multi-display behaviour — load it before " +
  "driving the desktop rather than trial-and-erroring against these tools.";

/**
 * Dedupe `granted` into `existing` on bundleId, spread truthy-only flags over
 * defaults+existing. Truthy-only: a subsequent `request_access` that doesn't
 * request clipboard can't revoke an earlier clipboard grant — revocation lives
 * in a Settings page, not here.
 *
 * Same merge both hosts implemented independently today.
 */
function mergePermissionResponse(
  existing: readonly AppGrant[],
  existingFlags: CuGrantFlags,
  response: CuPermissionResponse,
): { apps: AppGrant[]; flags: CuGrantFlags } {
  const seen = new Set(existing.map((a) => a.bundleId));
  const apps = [
    ...existing,
    ...response.granted.filter((g) => !seen.has(g.bundleId)),
  ];
  const truthyFlags = Object.fromEntries(
    Object.entries(response.flags).filter(([, v]) => v === true),
  );
  const flags: CuGrantFlags = {
    ...DEFAULT_GRANT_FLAGS,
    ...existingFlags,
    ...truthyFlags,
  };
  return { apps, flags };
}

/**
 * Bind session state to a reusable dispatcher. The returned function is the
 * wrapper closure: async lock gate → build overrides fresh → `handleToolCall`
 * → stash screenshot → strip piggybacked fields.
 *
 * The last-screenshot blob is held in a closure cell here (not on `ctx`), so
 * hosts don't need to guarantee `ctx` object identity across calls — they just
 * need to hold onto the returned dispatcher. Cowork caches per
 * `InternalServerContext` in a WeakMap; the CLI host constructs once at server creation.
 */
export function bindSessionContext(
  adapter: ComputerUseHostAdapter,
  coordinateMode: CoordinateMode,
  ctx: ComputerUseSessionContext,
): (name: string, args: unknown) => Promise<CuCallToolResult> {
  const { logger, serverName } = adapter;

  // Screenshot blob persists here across calls — NOT on `ctx`. Hosts hold
  // onto the returned dispatcher; that's the identity that matters.
  let lastScreenshot: ScreenshotResult | undefined;

  const wrapPermission = ctx.onPermissionRequest
    ? async (
        req: Parameters<NonNullable<typeof ctx.onPermissionRequest>>[0],
        signal: AbortSignal,
      ): Promise<CuPermissionResponse> => {
        const response = await ctx.onPermissionRequest!(req, signal);
        const { apps, flags } = mergePermissionResponse(
          ctx.getAllowedApps(),
          ctx.getGrantFlags(),
          response,
        );
        logger.debug(
          `[${serverName}] permission result: granted=${response.granted.length} denied=${response.denied.length}`,
        );
        ctx.onAllowedAppsChanged?.(apps, flags);
        return response;
      }
    : undefined;

  const wrapTeachPermission = ctx.onTeachPermissionRequest
    ? async (
        req: Parameters<NonNullable<typeof ctx.onTeachPermissionRequest>>[0],
        signal: AbortSignal,
      ): Promise<CuPermissionResponse> => {
        const response = await ctx.onTeachPermissionRequest!(req, signal);
        logger.debug(
          `[${serverName}] teach permission result: granted=${response.granted.length} denied=${response.denied.length}`,
        );
        // Teach doesn't request grant flags — preserve existing.
        const { apps } = mergePermissionResponse(
          ctx.getAllowedApps(),
          ctx.getGrantFlags(),
          response,
        );
        ctx.onAllowedAppsChanged?.(apps, {
          ...DEFAULT_GRANT_FLAGS,
          ...ctx.getGrantFlags(),
        });
        return response;
      }
    : undefined;

  return async (name, args) => {
    // ─── Async lock gate ─────────────────────────────────────────────────
    // Replaces the sync Gate-3 in `handleToolCall` — we pass
    // `checkCuLock: undefined` below so it no-ops. Hosts with
    // cross-process locks (O_EXCL file) await the real primitive here
    // instead of pre-computing + feeding a fake sync result.
    if (ctx.checkCuLock) {
      const lock = await ctx.checkCuLock();
      if (lock.holder !== undefined && !lock.isSelf) {
        const text =
          (ctx.formatLockHeldMessage?.(lock.holder) ??
            DEFAULT_LOCK_HELD_MESSAGE) + LOCK_HELD_GUIDANCE;
        return {
          content: [{ type: "text", text }],
          isError: true,
          telemetry: { error_kind: "cu_lock_held" },
        };
      }
      if (lock.holder === undefined && !defersLockAcquire(name)) {
        await ctx.acquireCuLock?.();
        // Re-check: the awaits above yield the microtask queue, so another
        // session's check+acquire can interleave with ours. Hosts where
        // acquire is a no-op when already held (Cowork's CuLockManager) give
        // no signal that we lost — verify we're now the holder before
        // proceeding. The CLI's O_EXCL file lock would surface this as a throw from
        // acquire instead; this re-check is a belt-and-suspenders for that
        // path too.
        const recheck = await ctx.checkCuLock();
        if (recheck.holder !== undefined && !recheck.isSelf) {
          const text =
            (ctx.formatLockHeldMessage?.(recheck.holder) ??
              DEFAULT_LOCK_HELD_MESSAGE) +
            LOCK_HELD_GUIDANCE;
          return {
            content: [{ type: "text", text }],
            isError: true,
            telemetry: { error_kind: "cu_lock_held" },
          };
        }
        // Fresh holder → any prior session's mouseButtonHeld is stale.
        // Mirrors what Gate-3 does on the acquire branch. After the
        // re-check so we only clear module state when we actually won.
        resetMouseButtonHeld();
      }
    }

    // ─── Build overrides fresh ───────────────────────────────────────────
    // Blob-first; dims-fallback with base64:"" when the closure cell is
    // unset (cross-respawn). scaleCoord reads dims; pixelCompare sees "" →
    // isEmpty → skip.
    const dimsFallback = lastScreenshot
      ? undefined
      : ctx.getLastScreenshotDims?.();

    // Per-call AbortController for dialog dismissal. Aborted in `finally` —
    // if handleToolCall finishes (MCP timeout, throw) before the user
    // answers, the host's dialog handler sees the abort and tears down.
    const dialogAbort = new AbortController();

    const overrides: ComputerUseOverrides = {
      allowedApps: [...ctx.getAllowedApps()],
      grantFlags: ctx.getGrantFlags(),
      userDeniedBundleIds: ctx.getUserDeniedBundleIds(),
      coordinateMode,
      selectedDisplayId: ctx.getSelectedDisplayId(),
      displayPinnedByModel: ctx.getDisplayPinnedByModel?.(),
      displayResolvedForApps: ctx.getDisplayResolvedForApps?.(),
      lastScreenshot:
        lastScreenshot ??
        (dimsFallback ? { ...dimsFallback, base64: "" } : undefined),
      onPermissionRequest: wrapPermission
        ? (req) => wrapPermission(req, dialogAbort.signal)
        : undefined,
      onTeachPermissionRequest: wrapTeachPermission
        ? (req) => wrapTeachPermission(req, dialogAbort.signal)
        : undefined,
      onAppsHidden: ctx.onAppsHidden,
      saveImageToDisk: ctx.saveImageToDisk,
      getClipboardStash: ctx.getClipboardStash,
      onClipboardStashChanged: ctx.onClipboardStashChanged,
      onResolvedDisplayUpdated: ctx.onResolvedDisplayUpdated,
      onDisplayPinned: ctx.onDisplayPinned,
      onDisplayResolvedForApps: ctx.onDisplayResolvedForApps,
      onTeachModeActivated: ctx.onTeachModeActivated,
      onTeachStep: ctx.onTeachStep,
      onTeachWorking: ctx.onTeachWorking,
      getTeachModeActive: ctx.getTeachModeActive,
      // Undefined → handleToolCall's sync Gate-3 no-ops. The async gate
      // above already ran.
      checkCuLock: undefined,
      acquireCuLock: undefined,
      // Unlike check/acquire, release is consumed by a TOOL handler
      // (`release_lock`), not by the gate — so it threads through instead of
      // being nulled out here.
      releaseCuLock: ctx.releaseCuLock,
      isAborted: ctx.isAborted,
    };

    logger.debug(
      `[${serverName}] tool=${name} allowedApps=${overrides.allowedApps.length} coordMode=${coordinateMode}`,
    );

    // ─── Dispatch ────────────────────────────────────────────────────────
    try {
      const result = await handleToolCall(adapter, name, args, overrides);

      if (result.screenshot) {
        lastScreenshot = result.screenshot;
        const { base64: _blob, ...dims } = result.screenshot;
        logger.debug(`[${serverName}] screenshot dims: ${JSON.stringify(dims)}`);
        ctx.onScreenshotCaptured?.(dims);
      }

      return result;
    } finally {
      dialogAbort.abort();
    }
  };
}

export function createComputerUseMcpServer(
  adapter: ComputerUseHostAdapter,
  coordinateMode: CoordinateMode,
  context?: ComputerUseSessionContext,
  tools?: Tool[],
): Server {
  const { serverName, logger } = adapter;

  const server = new Server(
    // Reported over MCP `initialize`. Keep in step with package.json — the
    // vendor layer can't read it (no node:fs by design), so nothing enforces it.
    { name: serverName, version: "0.5.4" },
    {
      capabilities: { tools: {}, logging: {} },
      // Surfaced to the model at initialize time, before any call. Agents that
      // skip the skill doc go straight for `screenshot` and hit an error they
      // have no context to interpret; this is the cheapest place to state the
      // fixed order up front.
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  // The caller may pass a pre-built tool list: the CLI host splices this
  // machine's installed-app names into the `request_access` description, which
  // needs an executor round trip the server factory can't do. Building it here
  // instead would overwrite that enrichment — `setRequestHandler` on the same
  // schema replaces the previous handler silently. One handler, one source.
  const toolList =
    tools ??
    buildComputerUseTools(adapter.executor.capabilities, coordinateMode);

  server.setRequestHandler(ListToolsRequestSchema, async () =>
    adapter.isDisabled() ? { tools: [] } : { tools: toolList },
  );

  if (context) {
    const dispatch = bindSessionContext(adapter, coordinateMode, context);
    server.setRequestHandler(
      CallToolRequestSchema,
      async (request): Promise<CallToolResult> => {
        const { screenshot: _s, telemetry: _t, ...result } = await dispatch(
          request.params.name,
          request.params.arguments ?? {},
        );
        return result;
      },
    );
    return server;
  }

  // Legacy: no context → stub handler. Reached only if something calls the
  // server over MCP transport WITHOUT going through a binder (a wiring
  // regression). Clear error instead of silent failure.
  server.setRequestHandler(
    CallToolRequestSchema,
    async (request): Promise<CallToolResult> => {
      logger.warn(
        `[${serverName}] tool call "${request.params.name}" reached the stub handler — no session context bound. Per-session state unavailable.`,
      );
      return {
        content: [
          {
            type: "text",
            text: "This computer-use server instance is not wired to a session. Per-session app permissions are not available on this code path.",
          },
        ],
        isError: true,
      };
    },
  );

  return server;
}
