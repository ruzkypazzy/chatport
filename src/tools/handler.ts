// Shared helper for converting chatport envelopes into MCP CallToolResult responses.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Envelope } from "../util/errors.js";
import { ToolError, toEnvelope } from "../util/errors.js";
import { withTimeout } from "../util/timeout.js";
import type { LlmClients } from "../llm/openai-client.js";
import type { ChatportDatabase } from "../db/sqlite.js";

/**
 * Per-tool dependency injection bag. The McpServer factory fills this in once
 * and threads it through every tool registrar. New deps (db, models, etc.)
 * accumulate here so individual tools can pick what they need.
 *
 * `models` carries the per-provider model name to pass to
 * `chat.completions.create`. Each LLM-using tool (summarize_progress,
 * extract_*, continue_in, merge_sessions.summarize, branch_session) picks
 * the right entry based on its own routing decision (e.g. the summarize
 * tool reads the `compressor` field of the input to decide between the
 * MiniMax and OpenAI backends).
 */
export interface ToolHandlerDeps {
  llm: LlmClients;
  db: ChatportDatabase;
  models: {
    openai: string;
    minimax: string;
  };
}

export interface ToolHandlerContext {
  tool: string;
}

export type ToolHandler<Args> = (
  args: Args,
  ctx: ToolHandlerContext,
) => Promise<Envelope<unknown>> | Envelope<unknown>;

export function envelopeToCallToolResult(env: Envelope<unknown>): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(env),
      },
    ],
  };
}

/**
 * Default wall-clock budget for a single tool invocation, measured
 * end-to-end through `runHandler`. Individual LLM-using tools wrap
 * their own `chat.completions.create` calls in tighter inner timeouts
 * (e.g. 30 s for summarize_progress, 60 s for continue_in); this outer
 * limit is the safety net that bounds the whole composed operation,
 * including any synchronous JSON.parse / DB work in the handler.
 *
 * The default mirrors `TOOL_TIMEOUT_MS` from `src/config/env.ts`; tests
 * can override per-invocation via `runHandler(..., { timeoutMs })`.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

export interface RunHandlerOptions {
  /**
   * Wall-clock budget for the handler. When the timeout fires, the
   * error is mapped to a `{ code: "TIMEOUT" }` envelope so the MCP
   * caller still gets a structured response (the MCP boundary never
   * throws). Defaults to `DEFAULT_TOOL_TIMEOUT_MS`.
   */
  timeoutMs?: number;
}

export async function runHandler<Args>(
  tool: string,
  args: Args,
  handler: ToolHandler<Args>,
  options: RunHandlerOptions = {},
): Promise<CallToolResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  try {
    // The outer withTimeout is defense-in-depth: a misbehaving tool that
    // returns a never-resolving promise (e.g. a forgotten `await` on an
    // upstream call) is still bounded by the budget. The inner per-tool
    // withTimeout calls (UPSTREAM_TIMEOUT, etc.) fire first in normal
    // operation and their ToolError propagates up unchanged.
    const env = await withTimeout(
      Promise.resolve(handler(args, { tool })),
      timeoutMs,
      tool,
      { code: "TIMEOUT" },
    );
    return envelopeToCallToolResult(env);
  } catch (err) {
    return envelopeToCallToolResult(toEnvelope(err, tool));
  }
}

/**
 * Type guard for the outer `runHandler` timeout. Returns true if `err`
 * is a `ToolError` with code "TIMEOUT" — the error shape produced by
 * `withTimeout(promise, timeoutMs, tool, { code: "TIMEOUT" })`. Re-
 * exported here so tests don't need to import from the internal
 * `errors.js` module.
 */
export function isTimeoutError(err: unknown): err is ToolError {
  return err instanceof ToolError && err.code === "TIMEOUT";
}
