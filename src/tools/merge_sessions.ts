// merge_sessions: combine N (>= 2) stored sessions by concat / interleave /
// summarize strategy.
//
// Steps (matching the plan's AC-11 spec):
//   1. Load all N blobs from SQLite via db.getSession(id). Throw NOT_FOUND
//      if any id is missing. The Zod schema (`session_ids.min(2)`) already
//      enforces at least 2 inputs; this handler doesn't add a third
//      constraint.
//   2. Dispatch on strategy:
//        - "concat": append every input's messages in input order. The
//          new blob's source_llm is the first session's (concat is
//          upstream-agnostic). Metadata carries
//          `merged_from_session_ids: number[]` and `merge_strategy: "concat"`
//          for traceability.
//        - "interleave": k-way merge by `created_at` per message, ties
//          broken by source session index in input order (deterministic).
//          The new blob's source_llm is the first session's; metadata
//          carries the same traceability fields.
//        - "summarize": call llm.minimax.chat.completions.create() with a
//          system prompt that asks for a single merged narrative that
//          references each input session id. The response is parsed as
//          JSON `{ "summary": string }` and stored as a single assistant
//          message in the new blob (the plan: "result stored as a new
//          session"). The new blob's source_llm is `target_llm` from the
//          input (the merged narrative is from the target LLM).
//   3. Persist the new blob via db.insertSession (parent_session_id is
//      null — the plan doesn't link merges to any parent; the metadata
//      carries the lineage).
//   4. Return `{ session_id, strategy, input_session_ids, message_count }`
//      — the spec's `{ session_id, strategy }` plus two traceability
//      fields. `session_id` is the new DB row id (matches the
//      input-style used by branch_session / diff_sessions /
//      get_session).
//
// Errors:
//   - NOT_FOUND: any session_id is missing in SQLite
//   - UPSTREAM_TIMEOUT: MiniMax chat.completions.create times out
//     (summarize strategy only; concat/interleave have no LLM call)
//   - UPSTREAM_ERROR: MiniMax throws or returns no assistant text
//     (summarize strategy only)
//   - EXTRACTION_FAILED: non-JSON or non-conforming response
//     (summarize strategy only)
import { v4 as uuidv4 } from "uuid";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  MergeSessionsInputSchema,
  type MergeSessionsInput,
  type MergeStrategy,
  type Message,
  type SessionBlob,
  type SourceLlm,
} from "../types.js";
import { ok, ToolError } from "../util/errors.js";
import { withTimeout } from "../util/timeout.js";
import { extractAssistantText } from "../util/extraction.js";
import type { LlmClients } from "../llm/openai-client.js";
import type { ChatportDatabase } from "../db/sqlite.js";
import { runHandler, type ToolHandlerDeps } from "./handler.js";

const MERGE_SUMMARIZE_TIMEOUT_MS = 30_000;
const MERGE_SUMMARIZE_TEMPERATURE = 0.2;

const SUMMARIZE_SYSTEM_PROMPT = [
  "You are a session-merging assistant.",
  "You are given the message lists of N stored sessions, each tagged with",
  "its session_id. Produce a single merged narrative that summarizes the",
  "combined intent, decisions, and current state of the work.",
  "The narrative must reference every input session id (by the `session_id`",
  "field of each input) so the caller can trace each input back to its",
  "contribution to the merge.",
  'Return strictly valid JSON of the form { "summary": string } and nothing',
  "else. Do not wrap the JSON in markdown fences. Do not add commentary",
  "outside the JSON object.",
].join(" ");

export interface MergeSessionsData {
  session_id: number;
  strategy: MergeStrategy;
  input_session_ids: number[];
  message_count: number;
}

export function registerMergeSessions(
  server: McpServer,
  deps: ToolHandlerDeps,
): void {
  server.registerTool(
    "merge_sessions",
    {
      title: "Merge Sessions",
      description:
        "Combine N stored sessions by concat, interleave, or summarize strategy.",
      inputSchema: MergeSessionsInputSchema.shape,
    },
    async (args: MergeSessionsInput) =>
      runHandler("merge_sessions", args, (input) =>
        mergeSessions(input, deps.llm, deps.db, deps.models),
      ),
  );
}

export async function mergeSessions(
  input: MergeSessionsInput,
  llm: LlmClients,
  db: ChatportDatabase,
  models: ToolHandlerDeps["models"],
  timeoutMs: number = MERGE_SUMMARIZE_TIMEOUT_MS,
): Promise<{ ok: true; data: MergeSessionsData }> {
  // 1. Load all N parent blobs. NOT_FOUND if any is missing.
  const parentRows: Array<{ blob: SessionBlob; id: number }> = [];
  for (const id of input.session_ids) {
    const row = db.getSession(id);
    if (row === null) {
      throw new ToolError(
        "NOT_FOUND",
        `session ${id} not found`,
        "merge_sessions",
      );
    }
    const blob = JSON.parse(row.blob_json) as SessionBlob;
    parentRows.push({ blob, id });
  }

  // 2. Dispatch on strategy.
  let newMessages: Message[];
  let newSourceLlm: SourceLlm;
  let mergeStrategyTag: MergeStrategy;

  switch (input.strategy) {
    case "concat": {
      const concatenated: Message[] = [];
      for (const { blob } of parentRows) {
        concatenated.push(...blob.messages);
      }
      newMessages = concatenated;
      const first = parentRows[0];
      if (first === undefined) {
        // Schema enforces >= 2, so this is unreachable, but typecheck
        // (noUncheckedIndexedAccess) wants the guard.
        throw new ToolError(
          "INTERNAL_ERROR",
          "merge_sessions: no parent rows after NOT_FOUND check",
          "merge_sessions",
        );
      }
      newSourceLlm = first.blob.source_llm;
      mergeStrategyTag = "concat";
      break;
    }
    case "interleave": {
      const tagged: Array<{ m: Message; srcIdx: number }> = [];
      for (let i = 0; i < parentRows.length; i++) {
        const entry = parentRows[i];
        if (entry === undefined) continue;
        for (const m of entry.blob.messages) {
          tagged.push({ m, srcIdx: i });
        }
      }
      // k-way merge by created_at; ties broken by source index so the
      // output is deterministic across runs.
      tagged.sort((a, b) => {
        if (a.m.created_at !== b.m.created_at) {
          return a.m.created_at - b.m.created_at;
        }
        return a.srcIdx - b.srcIdx;
      });
      newMessages = tagged.map((x) => x.m);
      const first = parentRows[0];
      if (first === undefined) {
        throw new ToolError(
          "INTERNAL_ERROR",
          "merge_sessions: no parent rows after NOT_FOUND check",
          "merge_sessions",
        );
      }
      newSourceLlm = first.blob.source_llm;
      mergeStrategyTag = "interleave";
      break;
    }
    case "summarize": {
      // 2a. Build the user payload: all N sessions, each with its
      //     session_id, source_llm, and messages.
      const sessionsPayload = parentRows.map(({ id, blob }) => ({
        session_id: id,
        external_session_id: blob.session_id,
        source_llm: blob.source_llm,
        messages: blob.messages,
      }));
      const userPayload = JSON.stringify({
        session_ids: input.session_ids,
        target_llm: input.target_llm,
        sessions: sessionsPayload,
      });

      const request = {
        model: models.minimax,
        temperature: MERGE_SUMMARIZE_TEMPERATURE,
        messages: [
          { role: "system" as const, content: SUMMARIZE_SYSTEM_PROMPT },
          { role: "user" as const, content: userPayload },
        ],
      };

      let response: unknown;
      try {
        response = await withTimeout(
          llm.minimax.chat.completions.create(request) as Promise<unknown>,
          timeoutMs,
          "merge_sessions",
          { code: "UPSTREAM_TIMEOUT" },
        );
      } catch (err) {
        if (err instanceof ToolError && err.code === "UPSTREAM_TIMEOUT") {
          throw err;
        }
        throw new ToolError(
          "UPSTREAM_ERROR",
          err instanceof Error ? err.message : String(err),
          "merge_sessions",
        );
      }

      // 2b. Parse the JSON response, pull the summary string.
      const text = extractAssistantText(response);
      if (text === null) {
        throw new ToolError(
          "UPSTREAM_ERROR",
          "LLM response did not contain an assistant message with text content",
          "merge_sessions",
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        throw new ToolError(
          "EXTRACTION_FAILED",
          `LLM response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
          "merge_sessions",
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
          "merge_sessions",
        );
      }
      const summary = (parsed as { summary: string }).summary;
      if (summary.trim() === "") {
        throw new ToolError(
          "EXTRACTION_FAILED",
          "LLM response `summary` was an empty string",
          "merge_sessions",
        );
      }

      // 2c. Build the new blob's messages: a single assistant message
      //     carrying the merged narrative. The `created_at` is the
      //     merge time so the result has a stable timestamp.
      const now = Math.floor(Date.now() / 1000);
      newMessages = [
        {
          role: "assistant",
          content: summary,
          created_at: now,
        },
      ];
      newSourceLlm = input.target_llm;
      mergeStrategyTag = "summarize";
      break;
    }
    default: {
      // Exhaustive switch: the Zod schema restricts strategy to the
      // three known values, so this branch is unreachable at runtime.
      const _exhaustive: never = input.strategy;
      throw new ToolError(
        "INTERNAL_ERROR",
        `merge_sessions: unhandled strategy ${String(_exhaustive)}`,
        "merge_sessions",
      );
    }
  }

  // 3. Persist. Fresh external session_id via uuid v4 (each merge is a
  //    unique artifact, so a v4 UUID is the right call here — no
  //    user-meaningful lineage to encode in the id itself; the metadata
  //    carries the merged_from_session_ids list). parent_session_id is
  //    null (the plan doesn't link merges to a parent).
  const newExternalSessionId = `merge-${uuidv4()}`;
  const newBlob: SessionBlob = {
    session_id: newExternalSessionId,
    source_llm: newSourceLlm,
    messages: newMessages,
    metadata: {
      merged_from_session_ids: input.session_ids,
      merge_strategy: mergeStrategyTag,
    },
  };

  const result = db.insertSession({
    source_llm: newBlob.source_llm,
    external_session_id: newExternalSessionId,
    blob: newBlob,
    parent_session_id: null,
  });

  return ok({
    session_id: result.id,
    strategy: mergeStrategyTag,
    input_session_ids: input.session_ids,
    message_count: newMessages.length,
  });
}
