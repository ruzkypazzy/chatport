// Shared helper for the AC-7 extraction tools: extract_open_questions and
// extract_decisions. Both tools follow the same pattern:
//
//   1. Load the blob from SQLite via db.getSession(session_id). Throw
//      NOT_FOUND if the row is missing (matches get_session's contract).
//   2. Call chat.completions.create() against the MiniMax-M3 client with
//        - temperature: 0.2
//        - response_format: { type: "json_object" }
//        - system prompt: instructs JSON shape (per-tool)
//        - user payload: JSON-stringified { messages, metadata }
//      Wrapped in withTimeout(30_000, { code: "UPSTREAM_TIMEOUT" }) so a
//      slow upstream returns the right error code.
//   3. Parse the assistant text as JSON. If the response is non-JSON or
//      doesn't match the spec'd `{ items: [...] }` shape, throw
//      EXTRACTION_FAILED with a descriptive message.
//   4. Validate each item against the per-tool schema via `itemValidator`.
//      If any item doesn't match, throw EXTRACTION_FAILED with the index.
//
// `extractAssistantText` is exported because the LlmClient interface returns
// `Promise<unknown>`; the helper is reused by summarize_progress's
// dedicated handler as well (which is why it lives here next to the
// extraction code, even though summarize_progress itself stays separate
// because its return shape is a single string, not an items array).
import { ToolError } from "./errors.js";
import { withTimeout } from "./timeout.js";
import type { LlmClients } from "../llm/openai-client.js";
import type { ChatportDatabase } from "../db/sqlite.js";

export const EXTRACTION_TIMEOUT_MS = 30_000;
export const EXTRACTION_TEMPERATURE = 0.2;

export interface ExtractionDeps {
  llm: LlmClients;
  db: ChatportDatabase;
  models: { openai: string; minimax: string };
}

export interface ExtractionOptions<T> {
  /** Per-tool JSON-shape instruction, e.g. `{ items: [{ question, context }] }`. */
  systemPrompt: string;
  /** Returns the validated item or null if `value` doesn't match the per-tool shape. */
  itemValidator: (value: unknown) => T | null;
  /** Tool name used in error envelopes (e.g. "extract_open_questions"). */
  toolName: string;
  /** Optional test-time override for the LLM call timeout. */
  timeoutMs?: number;
}

export async function runStructuredExtraction<T>(
  sessionId: number,
  deps: ExtractionDeps,
  options: ExtractionOptions<T>,
): Promise<{ items: T[] }> {
  const row = deps.db.getSession(sessionId);
  if (row === null) {
    throw new ToolError(
      "NOT_FOUND",
      `session ${sessionId} not found`,
      options.toolName,
    );
  }

  const parsedBlob = JSON.parse(row.blob_json) as {
    messages: Array<{ role: string; content: string; created_at: number }>;
    metadata?: Record<string, unknown>;
  };

  // Both AC-7 extraction tools use MiniMax by default — the compressor
  // field from AC-6's summarize_progress doesn't apply here.
  const client = deps.llm.minimax;
  const model = deps.models.minimax;

  const userPayload = JSON.stringify({
    messages: parsedBlob.messages,
    metadata: parsedBlob.metadata ?? {},
  });

  const request = {
    model,
    temperature: EXTRACTION_TEMPERATURE,
    response_format: { type: "json_object" as const },
    messages: [
      { role: "system" as const, content: options.systemPrompt },
      { role: "user" as const, content: userPayload },
    ],
  };

  let response: unknown;
  try {
    response = await withTimeout(
      client.chat.completions.create(request) as Promise<unknown>,
      options.timeoutMs ?? EXTRACTION_TIMEOUT_MS,
      options.toolName,
      { code: "UPSTREAM_TIMEOUT" },
    );
  } catch (err) {
    if (err instanceof ToolError && err.code === "UPSTREAM_TIMEOUT") {
      throw err;
    }
    throw new ToolError(
      "UPSTREAM_ERROR",
      err instanceof Error ? err.message : String(err),
      options.toolName,
    );
  }

  const text = extractAssistantText(response);
  if (text === null) {
    throw new ToolError(
      "EXTRACTION_FAILED",
      "LLM response did not contain an assistant message with text content",
      options.toolName,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ToolError(
      "EXTRACTION_FAILED",
      `LLM response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      options.toolName,
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new ToolError(
      "EXTRACTION_FAILED",
      "LLM response JSON was not an object",
      options.toolName,
    );
  }

  const itemsRaw = (parsed as { items?: unknown }).items;
  if (!Array.isArray(itemsRaw)) {
    throw new ToolError(
      "EXTRACTION_FAILED",
      "LLM response JSON did not include an `items` array",
      options.toolName,
    );
  }

  const items: T[] = [];
  for (let i = 0; i < itemsRaw.length; i++) {
    const validated = options.itemValidator(itemsRaw[i]);
    if (validated === null) {
      throw new ToolError(
        "EXTRACTION_FAILED",
        `LLM response item[${i}] did not match the expected shape`,
        options.toolName,
      );
    }
    items.push(validated);
  }

  return { items };
}

/**
 * Pull the first assistant message text from an OpenAI-compatible
 * `chat.completions.create` response. Duck-typed because the LlmClient
 * interface returns `Promise<unknown>`. Exported because summarize_progress
 * uses the same parsing logic.
 */
export function extractAssistantText(response: unknown): string | null {
  if (typeof response !== "object" || response === null) return null;
  const r = response as { choices?: unknown };
  if (!Array.isArray(r.choices) || r.choices.length === 0) return null;
  const first = r.choices[0] as {
    message?: { content?: unknown };
  };
  if (typeof first?.message?.content !== "string") return null;
  return first.message.content;
}
