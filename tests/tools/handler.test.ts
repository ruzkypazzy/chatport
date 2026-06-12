// Vitest tests for the AC-16 operational-hygiene layer around
// src/tools/handler.ts: runHandler must always return a structured
// envelope (never throw across the MCP boundary) and must enforce the
// outer timeout (so a misbehaving tool that returns a never-resolving
// promise can't hang the server).
import { describe, test, expect } from "vitest";
import {
  runHandler,
  envelopeToCallToolResult,
  isTimeoutError,
  DEFAULT_TOOL_TIMEOUT_MS,
  type ToolHandler,
  type ToolHandlerContext,
} from "../../src/tools/handler.js";
import { ok, ToolError } from "../../src/util/errors.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

describe("runHandler: structured error envelope at the MCP boundary", () => {
  test("successful handler: returns CallToolResult with the JSON-stringified envelope", async () => {
    const handler: ToolHandler<{ x: number }> = (args) => ok({ doubled: args.x * 2 });
    const result = await runHandler("double", { x: 21 }, handler);
    expect(result).toBeDefined();
    expect(Array.isArray(result.content)).toBe(true);
    const first = result.content[0];
    expect(first?.type).toBe("text");
    const env = JSON.parse(first?.text ?? "{}");
    expect(env.ok).toBe(true);
    expect(env.data).toEqual({ doubled: 42 });
  });

  test("thrown ToolError: returns the error envelope with code/tool preserved", async () => {
    const handler: ToolHandler<unknown> = () => {
      throw new ToolError("NOT_FOUND", "session 42 not found", "get_session");
    };
    const result = await runHandler("get_session", {}, handler);
    const first = result.content[0];
    const env = JSON.parse(first?.text ?? "{}") as {
      ok: boolean;
      error: { code: string; message: string; tool: string };
    };
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("NOT_FOUND");
    expect(env.error.tool).toBe("get_session");
    expect(env.error.message).toBe("session 42 not found");
  });

  test("thrown non-ToolError: returns the INTERNAL_ERROR envelope (no raw throw across boundary)", async () => {
    const handler: ToolHandler<unknown> = () => {
      throw new Error("boom");
    };
    const result = await runHandler("buggy_tool", {}, handler);
    const first = result.content[0];
    const env = JSON.parse(first?.text ?? "{}") as {
      ok: boolean;
      error: { code: string; message: string; tool: string };
    };
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("INTERNAL_ERROR");
    expect(env.error.tool).toBe("buggy_tool");
    expect(env.error.message).toBe("boom");
  });

  test("envelopeToCallToolResult: serializes a success envelope with text content type", () => {
    const result = envelopeToCallToolResult(ok({ items: [1, 2, 3] }));
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
    const parsed = JSON.parse(result.content[0]?.text ?? "{}");
    expect(parsed).toEqual({ ok: true, data: { items: [1, 2, 3] } });
  });
});

describe("runHandler: outer timeout (defense-in-depth)", () => {
  test("default timeout is 30s (mirrors TOOL_TIMEOUT_MS)", () => {
    expect(DEFAULT_TOOL_TIMEOUT_MS).toBe(30_000);
  });

  test("handler that returns a never-resolving promise is bounded by `timeoutMs` -> TIMEOUT envelope", async () => {
    const handler: ToolHandler<unknown> = () => new Promise<never>(() => undefined);
    const start = Date.now();
    const result: CallToolResult = await runHandler("stuck_tool", {}, handler, {
      timeoutMs: 50,
    });
    const elapsed = Date.now() - start;
    // The race should fire close to (and not significantly after) the 50ms budget.
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(2_000);
    const first = result.content[0];
    const env = JSON.parse(first?.text ?? "{}") as {
      ok: boolean;
      error: { code: string; message: string; tool: string };
    };
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("TIMEOUT");
    expect(env.error.tool).toBe("stuck_tool");
    expect(env.error.message).toBe("stuck_tool timed out after 50ms");
  });

  test("fast handler (under timeout) resolves normally and the timeout does not fire", async () => {
    const handler: ToolHandler<unknown> = async (): Promise<ReturnType<typeof ok>> => {
      await new Promise((r) => setTimeout(r, 5));
      return ok({ done: true });
    };
    const result = await runHandler("fast_tool", {}, handler, { timeoutMs: 1_000 });
    const first = result.content[0];
    const env = JSON.parse(first?.text ?? "{}") as {
      ok: boolean;
      data?: { done: boolean };
    };
    expect(env.ok).toBe(true);
    expect(env.data).toEqual({ done: true });
  });

  test("synchronous handler that throws synchronously is still wrapped (not propagated)", async () => {
    const handler: ToolHandler<unknown> = (() => {
      throw new Error("sync boom");
    }) as ToolHandler<unknown>;
    const result = await runHandler("sync_bug", {}, handler);
    const first = result.content[0];
    const env = JSON.parse(first?.text ?? "{}") as {
      ok: boolean;
      error: { code: string };
    };
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("INTERNAL_ERROR");
  });
});

describe("isTimeoutError type guard", () => {
  test("returns true for a ToolError with code=TIMEOUT", () => {
    const err = new ToolError("TIMEOUT", "x timed out after 1ms", "x");
    expect(isTimeoutError(err)).toBe(true);
  });
  test("returns false for a ToolError with a different code", () => {
    const err = new ToolError("NOT_FOUND", "nope", "get_session");
    expect(isTimeoutError(err)).toBe(false);
  });
  test("returns false for a non-ToolError", () => {
    expect(isTimeoutError(new Error("boom"))).toBe(false);
    expect(isTimeoutError("string")).toBe(false);
    expect(isTimeoutError(null)).toBe(false);
    expect(isTimeoutError(undefined)).toBe(false);
  });
});

// The ToolHandlerContext type is exported for handler authors; we
// don't have a strong runtime test for it, but we can ensure the
// handler's `ctx` is passed through correctly. Touch it here so the
// import isn't flagged as unused.
const _ctxCheck: ToolHandlerContext = { tool: "double" };
void _ctxCheck;
