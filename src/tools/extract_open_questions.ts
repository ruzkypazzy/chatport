// extract_open_questions: structured extraction of unresolved questions
// from a stored session, via MiniMax-M3.
//
// Loads the blob from SQLite (throws NOT_FOUND if missing), then calls
// chat.completions.create with a system prompt that constrains the JSON
// output to `{ items: [{ question, context }] }` and a user payload that
// carries the full message list + metadata. The response is parsed and
// each item is validated against the spec'd shape; any deviation throws
// EXTRACTION_FAILED (the same error code the spec mandates for both
// extract tools).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ExtractOpenQuestionsInputSchema,
  type ExtractOpenQuestionsInput,
} from "../types.js";
import { ok } from "../util/errors.js";
import { runStructuredExtraction, type ExtractionDeps } from "../util/extraction.js";
import { runHandler, type ToolHandlerDeps } from "./handler.js";

const SYSTEM_PROMPT = [
  "You are a session-analysis assistant.",
  "Read the conversation transcript the user provides and identify the",
  "open questions — topics that were raised in the discussion but were",
  "not yet resolved or answered by the time the session ended.",
  "For each open question, briefly paraphrase it in your own words and",
  "note the context in which it was raised (the user message or topic",
  "that surfaced it).",
  'Return strictly valid JSON of the form { "items": [{ "question": string, "context": string }] }',
  "and nothing else. If there are no open questions, return { \"items\": [] }.",
  "Do not wrap the JSON in markdown fences. Do not add commentary outside the JSON object.",
].join(" ");

export interface OpenQuestion {
  question: string;
  context: string;
}

export interface ExtractOpenQuestionsData {
  items: OpenQuestion[];
}

export function registerExtractOpenQuestions(
  server: McpServer,
  deps: ToolHandlerDeps,
): void {
  server.registerTool(
    "extract_open_questions",
    {
      title: "Extract Open Questions",
      description: "Use MiniMax-M3 to extract the list of open questions from a session.",
      inputSchema: ExtractOpenQuestionsInputSchema.shape,
    },
    async (args: ExtractOpenQuestionsInput) =>
      runHandler("extract_open_questions", args, (input) =>
        extractOpenQuestions(input, { llm: deps.llm, db: deps.db, models: deps.models }),
      ),
  );
}

export async function extractOpenQuestions(
  input: ExtractOpenQuestionsInput,
  deps: ExtractionDeps,
  timeoutMs?: number,
): Promise<{ ok: true; data: ExtractOpenQuestionsData }> {
  const { items } = await runStructuredExtraction<OpenQuestion>(
    input.session_id,
    deps,
    {
      systemPrompt: SYSTEM_PROMPT,
      itemValidator: validateOpenQuestion,
      toolName: "extract_open_questions",
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    },
  );
  return ok({ items });
}

function validateOpenQuestion(value: unknown): OpenQuestion | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as { question?: unknown; context?: unknown };
  if (typeof v.question !== "string" || typeof v.context !== "string") return null;
  return { question: v.question, context: v.context };
}
