// branch_session: clone a parent session and inject an alternate path into
// the opening message via a MiniMax rewriting pass.
//
// Steps (matching the plan's AC-10 spec):
//   1. Load the parent blob from SQLite via db.getSession(parent_session_id).
//      Throw NOT_FOUND if the row is missing (same contract as the other
//      read tools).
//   2. Pull the opening message from the parent (messages[0]). If the parent
//      has no messages, throw EXTRACTION_FAILED — there's nothing to branch
//      from.
//   3. Call llm.minimax.chat.completions.create() with a system prompt that
//      instructs the model to rewrite the opening message with the
//      `alternate_path` instruction injected, preserving the original
//      intent. The user payload carries `alternate_path` and the opening
//      message's role/content. The model is expected to return JSON of the
//      form { "rewritten_message": string }. Wrapped in withTimeout(30_000,
//      { code: "UPSTREAM_TIMEOUT" }) so a slow upstream returns the right
//      error code (same contract as summarize_progress's UPSTREAM_TIMEOUT).
//   4. Parse the JSON, verify the rewritten_message is a non-empty string.
//      Non-JSON or wrong shape -> EXTRACTION_FAILED (same code the AC-7
//      extraction tools use for non-conforming LLM responses).
//   5. Build the new blob: deep-clone the parent's messages, replace the
//      first message's content with the rewritten one (keep role and
//      created_at from the original so the branch keeps its history),
//      assign a fresh external `session_id` derived from the parent's
//      (`{parent}#branch-{ts}`), and copy the parent's metadata plus a
//      `branched_alternate_path` tag for traceability.
//   6. Persist the new blob via db.insertSession with parent_session_id
//      set to the input id. Returns the new DB row id (number) and the
//      parent's DB row id — the same shape the spec mandates:
//      `{ session_id, parent_session_id }`. The `session_id` here is the
//      server-side row id (matches the input's `parent_session_id`
//      convention used by diff_sessions / get_session / summarize_progress).
//
// Errors:
//   - NOT_FOUND: parent_session_id is absent in SQLite
//   - UPSTREAM_TIMEOUT: MiniMax chat.completions.create exceeds the timeout
//   - UPSTREAM_ERROR: MiniMax throws, or returns a response with no
//     assistant text (same as continue_in's UPSTREAM_ERROR for malformed
//     chat.completions shapes)
//   - EXTRACTION_FAILED: empty / non-JSON / wrong-shape / empty-string
//     rewritten_message, or parent has no messages
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  BranchSessionInputSchema,
  type BranchSessionInput,
  type Message,
  type SessionBlob,
} from "../types.js";
import { ok, ToolError } from "../util/errors.js";
import { withTimeout } from "../util/timeout.js";
import { extractAssistantText } from "../util/extraction.js";
import type { LlmClients } from "../llm/openai-client.js";
import type { ChatportDatabase } from "../db/sqlite.js";
import { runHandler, type ToolHandlerDeps } from "./handler.js";

const BRANCH_TIMEOUT_MS = 30_000;
const BRANCH_TEMPERATURE = 0.2;

const SYSTEM_PROMPT = [
  "You are a session-branching assistant.",
  "You are given an opening message from a parent session and an",
  "`alternate_path` instruction. Rewrite the opening message so the",
  "`alternate_path` is injected into the user's intent, while preserving",
  "the original task and any decisions already in the message.",
  'Return strictly valid JSON of the form { "rewritten_message": string }',
  "and nothing else.",
  "Do not wrap the JSON in markdown fences. Do not add commentary outside the JSON object.",
].join(" ");

export interface BranchSessionData {
  session_id: number;
  parent_session_id: number;
}

export function registerBranchSession(
  server: McpServer,
  deps: ToolHandlerDeps,
): void {
  server.registerTool(
    "branch_session",
    {
      title: "Branch Session",
      description:
        "Clone a parent session and rewrite the opening message with an alternate path.",
      inputSchema: BranchSessionInputSchema.shape,
    },
    async (args: BranchSessionInput) =>
      runHandler("branch_session", args, (input) =>
        branchSession(input, deps.llm, deps.db, deps.models),
      ),
  );
}

export async function branchSession(
  input: BranchSessionInput,
  llm: LlmClients,
  db: ChatportDatabase,
  models: ToolHandlerDeps["models"],
  timeoutMs: number = BRANCH_TIMEOUT_MS,
): Promise<{ ok: true; data: BranchSessionData }> {
  // 1. Load the parent blob. NOT_FOUND if absent (matches the contract
  //    used by get_session, diff_sessions, summarize_progress, etc.).
  const parentRow = db.getSession(input.parent_session_id);
  if (parentRow === null) {
    throw new ToolError(
      "NOT_FOUND",
      `session ${input.parent_session_id} not found`,
      "branch_session",
    );
  }
  const parentBlob = JSON.parse(parentRow.blob_json) as SessionBlob;

  // 2. Pull the opening message; EXTRACTION_FAILED if the parent has no
  //    messages at all (nothing to rewrite).
  const opening = parentBlob.messages[0];
  if (opening === undefined) {
    throw new ToolError(
      "EXTRACTION_FAILED",
      "parent session has no messages to branch from",
      "branch_session",
    );
  }

  // 3. Ask MiniMax to rewrite the opening message with the alternate_path
  //    instruction injected, preserving intent.
  const userPayload = JSON.stringify({
    alternate_path: input.alternate_path,
    opening_message: { role: opening.role, content: opening.content },
  });

  const request = {
    model: models.minimax,
    temperature: BRANCH_TEMPERATURE,
    messages: [
      { role: "system" as const, content: SYSTEM_PROMPT },
      { role: "user" as const, content: userPayload },
    ],
  };

  let response: unknown;
  try {
    response = await withTimeout(
      llm.minimax.chat.completions.create(request) as Promise<unknown>,
      timeoutMs,
      "branch_session",
      { code: "UPSTREAM_TIMEOUT" },
    );
  } catch (err) {
    if (err instanceof ToolError && err.code === "UPSTREAM_TIMEOUT") {
      throw err;
    }
    throw new ToolError(
      "UPSTREAM_ERROR",
      err instanceof Error ? err.message : String(err),
      "branch_session",
    );
  }

  // 4. Parse the JSON response and pull the rewritten string. Mirror
  //    summarize_progress's parse/validate chain (UPSTREAM_ERROR on
  //    missing assistant text, EXTRACTION_FAILED on JSON problems or a
  //    missing/wrong-typed `rewritten_message` field).
  const text = extractAssistantText(response);
  if (text === null) {
    throw new ToolError(
      "UPSTREAM_ERROR",
      "LLM response did not contain an assistant message with text content",
      "branch_session",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ToolError(
      "EXTRACTION_FAILED",
      `LLM response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      "branch_session",
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { rewritten_message?: unknown }).rewritten_message !== "string"
  ) {
    throw new ToolError(
      "EXTRACTION_FAILED",
      "LLM response JSON did not include a string `rewritten_message` field",
      "branch_session",
    );
  }
  const rewritten = (parsed as { rewritten_message: string }).rewritten_message;
  if (rewritten.trim() === "") {
    throw new ToolError(
      "EXTRACTION_FAILED",
      "LLM response `rewritten_message` was an empty string",
      "branch_session",
    );
  }

  // 5. Build the new blob: clone parent's messages, replace only the
  //    first message's content (keep role and created_at), assign a
  //    fresh external session_id derived from the parent's, and carry
  //    the parent's metadata plus a `branched_alternate_path` tag.
  const newMessages: Message[] = parentBlob.messages.map((m, i) =>
    i === 0
      ? { role: m.role, content: rewritten, created_at: m.created_at }
      : m,
  );
  const branchTag = Math.floor(Date.now() / 1000);
  const newExternalSessionId = `${parentBlob.session_id}#branch-${branchTag}`;
  const newBlob: SessionBlob = {
    session_id: newExternalSessionId,
    source_llm: parentBlob.source_llm,
    messages: newMessages,
    metadata: {
      ...parentBlob.metadata,
      branched_alternate_path: input.alternate_path,
      branched_from_session_id: input.parent_session_id,
    },
  };

  // 6. Persist. The DB layer canonicalizes + hashes the blob, assigns a
  //    fresh row id, and stores parent_session_id alongside.
  const result = db.insertSession({
    source_llm: newBlob.source_llm,
    external_session_id: newExternalSessionId,
    blob: newBlob,
    parent_session_id: input.parent_session_id,
  });

  return ok({
    session_id: result.id,
    parent_session_id: input.parent_session_id,
  });
}
