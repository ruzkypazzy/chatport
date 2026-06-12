// continue_in: full handoff of a stored session to a different target LLM
// in one tool call.
//
// Steps (matching the plan):
//   1. Load the blob from SQLite via db.getSession(source_session_id).
//      Throw NOT_FOUND if the row is missing (same contract as the other
//      read tools).
//   2. Compress the blob to a token-bounded summary via summarizeProgress
//      (compressor defaults to MiniMax-M3 since the plan doesn't expose
//      the compressor field on continue_in's input schema).
//   3. Build the seed messages:
//        [{ role: "system", content: summary },
//         { role: "user",   content: next_step }]
//   4. Call targetClient.chat.completions.create({ model, messages: seed })
//      to obtain the assistant's opening reply on the target LLM.
//   5. Call targetClient.conversations.create({ items: [...seed, reply] })
//      to materialize the handoff as a real conversation on the target
//      upstream. The upstream returns { id, ... } — `id` is the new
//      session id we'll surface to the caller.
//   6. Return { new_session_id, source_llm: target_llm, seeded_messages }.
//
// The whole composed operation is wrapped in withTimeout(60_000, ...) so
// a slow upstream at any step (summarize, chat.completions, or
// conversations.create) returns UPSTREAM_TIMEOUT before the overall
// budget blows. The inner summarizeProgress call has its own 30 s timeout
// (shorter than the 60 s outer budget), so any single sub-step that hangs
// surfaces as UPSTREAM_TIMEOUT from the inner Promise.race and the outer
// `finally` clears the outer timer.
//
// Errors:
//   - NOT_FOUND: source_session_id is absent in SQLite
//   - UPSTREAM_TIMEOUT: any step (including the summarize sub-call)
//     exceeds its timeout
//   - UPSTREAM_ERROR: any step throws, or the target LLM returns a
//     malformed chat.completions / conversations.create response
//     (missing assistant message or missing id)
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ContinueInInputSchema,
  type ContinueInInput,
  type SourceLlm,
} from "../types.js";
import { ok, ToolError } from "../util/errors.js";
import { withTimeout } from "../util/timeout.js";
import type { LlmClients } from "../llm/openai-client.js";
import type { ChatportDatabase } from "../db/sqlite.js";
import { runHandler, type ToolHandlerDeps } from "./handler.js";
import { summarizeProgress } from "./summarize_progress.js";

const CONTINUE_TIMEOUT_MS = 60_000;

type SeedMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

export interface ContinueInData {
  new_session_id: string;
  source_llm: SourceLlm;
  seeded_messages: SeedMessage[];
}

export function registerContinueIn(
  server: McpServer,
  deps: ToolHandlerDeps,
): void {
  server.registerTool(
    "continue_in",
    {
      title: "Continue In",
      description:
        "Hand off a stored session to another LLM with the compressed context as a seed.",
      inputSchema: ContinueInInputSchema.shape,
    },
    async (args: ContinueInInput) =>
      runHandler("continue_in", args, (input) =>
        continueIn(input, deps.llm, deps.db, deps.models),
      ),
  );
}

export async function continueIn(
  input: ContinueInInput,
  llm: LlmClients,
  db: ChatportDatabase,
  models: ToolHandlerDeps["models"],
  timeoutMs: number = CONTINUE_TIMEOUT_MS,
): Promise<{ ok: true; data: ContinueInData }> {
  // Wrap the whole composed operation in a single 60 s timeout. If any
  // sub-step (summarize, chat.completions, conversations.create) hangs,
  // its own inner timeout / a thrown error will reject first and the
  // `finally` clears this outer timer.
  try {
    return await withTimeout(
      doContinueIn(input, llm, db, models),
      timeoutMs,
      "continue_in",
      { code: "UPSTREAM_TIMEOUT" },
    );
  } catch (err) {
    if (err instanceof ToolError && err.code === "UPSTREAM_TIMEOUT") {
      throw err;
    }
    if (err instanceof ToolError) {
      // Re-throw with continue_in as the tool name (the inner error may
      // have come from summarize_progress, which would carry
      // `tool: "summarize_progress"`).
      throw new ToolError(err.code, err.message, "continue_in", err.details);
    }
    throw new ToolError(
      "UPSTREAM_ERROR",
      err instanceof Error ? err.message : String(err),
      "continue_in",
    );
  }
}

async function doContinueIn(
  input: ContinueInInput,
  llm: LlmClients,
  db: ChatportDatabase,
  models: ToolHandlerDeps["models"],
): Promise<{ ok: true; data: ContinueInData }> {
  // 1. Load the source blob. NOT_FOUND if absent.
  const row = db.getSession(input.source_session_id);
  if (row === null) {
    throw new ToolError(
      "NOT_FOUND",
      `session ${input.source_session_id} not found`,
      "continue_in",
    );
  }

  // 2. Summarize the blob to a token-bounded string. The plan says
  //    `summarize_progress(target_tokens)`; the compressor field is not
  //    part of continue_in's input schema so we route through the
  //    default MiniMax-M3 backend. Any failure here propagates as a
  //    ToolError (EXTRACTION_FAILED, UPSTREAM_TIMEOUT, UPSTREAM_ERROR,
  //    or NOT_FOUND on the inner summarize).
  const summarizeResult = await summarizeProgress(
    {
      session_id: input.source_session_id,
      target_tokens: input.target_tokens,
      compressor: "MiniMax-M3",
    },
    llm,
    db,
    models,
  );
  const summary = summarizeResult.data.summary;

  // 3. Build the seed messages. The first carries the summary as the
  //    target LLM's system context; the second is the user's next step.
  const seed: SeedMessage[] = [
    { role: "system", content: summary },
    { role: "user", content: input.next_step },
  ];

  // 4. Pick the target LLM client + model. If the caller supplied a
  //    `model` override, honor it; otherwise fall back to the env-driven
  //    default for the chosen target.
  const targetClient =
    input.target_llm === "MiniMax" ? llm.minimax : llm.openai;
  const targetModel =
    input.model ??
    (input.target_llm === "MiniMax" ? models.minimax : models.openai);

  const chatReply = await targetClient.chat.completions.create({
    model: targetModel,
    messages: seed,
  });

  // 5. Extract the assistant's reply from the OpenAI-shaped response.
  const assistantReply = extractAssistantMessage(chatReply);
  if (assistantReply === null) {
    throw new ToolError(
      "UPSTREAM_ERROR",
      "target LLM did not return an assistant message with string content",
      "continue_in",
    );
  }

  // 6. Materialize the handoff as a real conversation on the target
  //    upstream. The seed + reply are sent as items; the upstream
  //    returns a record that includes `id`.
  const newConversation = (await targetClient.conversations.create({
    items: [
      ...seed,
      { role: assistantReply.role, content: assistantReply.content },
    ],
  })) as { id?: unknown };

  if (
    newConversation === null ||
    typeof newConversation !== "object" ||
    typeof newConversation.id !== "string"
  ) {
    throw new ToolError(
      "UPSTREAM_ERROR",
      "target LLM did not return a string conversation id from conversations.create",
      "continue_in",
    );
  }

  // 7. Return the spec'd shape.
  return ok({
    new_session_id: newConversation.id,
    source_llm: input.target_llm,
    seeded_messages: [
      ...seed,
      { role: "assistant", content: assistantReply.content },
    ],
  });
}

/**
 * Pull the first assistant message out of an OpenAI-compatible
 * chat.completions.create response. Duck-typed because the LlmClient
 * interface returns `Promise<unknown>`. Returns null if the response
 * shape is unexpected.
 */
function extractAssistantMessage(
  response: unknown,
): { role: "assistant"; content: string } | null {
  if (typeof response !== "object" || response === null) return null;
  const r = response as { choices?: unknown };
  if (!Array.isArray(r.choices) || r.choices.length === 0) return null;
  const first = r.choices[0] as { message?: { role?: unknown; content?: unknown } };
  if (typeof first?.message?.content !== "string") return null;
  // Normalize the role: anything non-"assistant" (or missing) is folded
  // into "assistant" since the target LLM is responding to the seed
  // we just sent. The plan only requires the reply to land in the
  // seeded_messages array as a { role, content } pair; the upstream's
  // role naming is an implementation detail.
  const role: "assistant" = "assistant";
  return { role, content: first.message.content };
}
