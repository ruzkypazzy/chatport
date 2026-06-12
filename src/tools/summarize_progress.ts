// summarize_progress: token-bounded summary of a stored session.
//
// Steps:
//   1. Load the blob from SQLite via db.getSession(session_id). Throw
//      NOT_FOUND if the row is missing (matches get_session's contract).
//   2. Pick the LLM client + model name based on `compressor`:
//        "MiniMax-M3" -> llm.minimax with models.minimax (the default)
//        "openai"     -> llm.openai  with models.openai
//   3. Call chat.completions.create() with the schema-pinned payload:
//        - temperature: 0.2 (deterministic-ish)
//        - response_format: { type: "json_object" } (forces JSON output)
//        - system prompt: instructs JSON { "summary": string } shape
//        - user payload: JSON-stringified { target_tokens, messages }
//      The call is wrapped in withTimeout(30_000, { code: "UPSTREAM_TIMEOUT" })
//      so a slow upstream returns the right error code (same contract as
//      export_session's UPSTREAM_TIMEOUT).
//   4. Parse the assistant text as JSON, verify it has a string `summary`
//      field, and return { session_id, summary, target_tokens, compressor }.
//      Any non-JSON / non-conforming response throws EXTRACTION_FAILED so
//      the caller knows the model didn't honor the JSON contract — same
//      error code the AC-7 extraction tools use.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SummarizeProgressInputSchema,
  type SummarizeProgressInput,
} from "../types.js";
import { ok, ToolError } from "../util/errors.js";
import { withTimeout } from "../util/timeout.js";
import type { LlmClients } from "../llm/openai-client.js";
import type { ChatportDatabase } from "../db/sqlite.js";
import { runHandler, type ToolHandlerDeps } from "./handler.js";

const SUMMARY_TIMEOUT_MS = 30_000;
const SUMMARY_TEMPERATURE = 0.2;

const SYSTEM_PROMPT = [
  "You are a session-summarization assistant.",
  "Read the conversation transcript the user provides and produce a",
  "concise, token-bounded summary that preserves the key decisions,",
  "open questions, and the current state of the work.",
  "Stay within roughly `target_tokens` tokens in the output.",
  'Return strictly valid JSON of the form { "summary": string } and nothing else.',
  "Do not wrap the JSON in markdown fences. Do not add commentary outside the JSON object.",
].join(" ");

export interface SummarizeProgressData {
  session_id: number;
  summary: string;
  target_tokens: number;
  compressor: "MiniMax-M3" | "openai";
}

export function registerSummarizeProgress(
  server: McpServer,
  deps: ToolHandlerDeps,
): void {
  server.registerTool(
    "summarize_progress",
    {
      title: "Summarize Progress",
      description:
        "Compress a stored session to a token-bounded summary using MiniMax-M3 (or openai).",
      inputSchema: SummarizeProgressInputSchema.shape,
    },
    async (args: SummarizeProgressInput) =>
      runHandler("summarize_progress", args, (input) =>
        summarizeProgress(input, deps.llm, deps.db, deps.models),
      ),
  );
}

export async function summarizeProgress(
  input: SummarizeProgressInput,
  llm: LlmClients,
  db: ChatportDatabase,
  models: ToolHandlerDeps["models"],
  timeoutMs: number = SUMMARY_TIMEOUT_MS,
): Promise<{ ok: true; data: SummarizeProgressData }> {
  const row = db.getSession(input.session_id);
  if (row === null) {
    throw new ToolError(
      "NOT_FOUND",
      `session ${input.session_id} not found`,
      "summarize_progress",
    );
  }

  // Parse the canonical blob back into a SessionBlob. We only need messages
  // and metadata; tolerate any extra keys the blob might carry.
  const parsedBlob = JSON.parse(row.blob_json) as {
    messages: Array<{ role: string; content: string; created_at: number }>;
    metadata?: Record<string, unknown>;
  };

  // Routing: compressor -> client + model. The schema already restricts
  // compressor to "MiniMax-M3" | "openai", so the conditional covers both.
  const client =
    input.compressor === "MiniMax-M3" ? llm.minimax : llm.openai;
  const model =
    input.compressor === "MiniMax-M3" ? models.minimax : models.openai;

  const userPayload = JSON.stringify({
    target_tokens: input.target_tokens,
    messages: parsedBlob.messages,
    metadata: parsedBlob.metadata ?? {},
  });

  const request = {
    model,
    temperature: SUMMARY_TEMPERATURE,
    response_format: { type: "json_object" as const },
    messages: [
      { role: "system" as const, content: SYSTEM_PROMPT },
      { role: "user" as const, content: userPayload },
    ],
  };

  let response: unknown;
  try {
    response = await withTimeout(
      client.chat.completions.create(request) as Promise<unknown>,
      timeoutMs,
      "summarize_progress",
      { code: "UPSTREAM_TIMEOUT" },
    );
  } catch (err) {
    if (err instanceof ToolError && err.code === "UPSTREAM_TIMEOUT") {
      throw err;
    }
    throw new ToolError(
      "UPSTREAM_ERROR",
      err instanceof Error ? err.message : String(err),
      "summarize_progress",
    );
  }

  const text = extractAssistantText(response);
  if (text === null) {
    throw new ToolError(
      "EXTRACTION_FAILED",
      "LLM response did not contain an assistant message with text content",
      "summarize_progress",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ToolError(
      "EXTRACTION_FAILED",
      `LLM response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      "summarize_progress",
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { summary?: unknown }).summary !== "string"
  ) {
    throw new ToolError(
      "EXTRACTION_FAILED",
      "LLM response JSON did not include a string `summary` field",
      "summarize_progress",
    );
  }
  const summary = (parsed as { summary: string }).summary;

  return ok({
    session_id: input.session_id,
    summary,
    target_tokens: input.target_tokens,
    compressor: input.compressor,
  });
}

/**
 * Pull the first assistant message text from an OpenAI-compatible
 * `chat.completions.create` response. Duck-typed because the LlmClient
 * interface returns `Promise<unknown>`.
 */
function extractAssistantText(response: unknown): string | null {
  if (typeof response !== "object" || response === null) return null;
  const r = response as { choices?: unknown };
  if (!Array.isArray(r.choices) || r.choices.length === 0) return null;
  const first = r.choices[0] as {
    message?: { content?: unknown };
  };
  if (typeof first?.message?.content !== "string") return null;
  return first.message.content;
}
