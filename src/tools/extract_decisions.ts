// extract_decisions: structured extraction of decisions and rationale from
// a stored session, via MiniMax-M3.
//
// Loads the blob from SQLite (throws NOT_FOUND if missing), then calls
// chat.completions.create with a system prompt that constrains the JSON
// output to `{ items: [{ decision, rationale, decided_at }] }` and a
// user payload that carries the full message list + metadata. The
// response is parsed and each item is validated against the spec'd
// shape; any deviation throws EXTRACTION_FAILED (the same error code
// the spec mandates for both extract tools).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ExtractDecisionsInputSchema,
  type ExtractDecisionsInput,
} from "../types.js";
import { ok } from "../util/errors.js";
import { runStructuredExtraction, type ExtractionDeps } from "../util/extraction.js";
import { runHandler, type ToolHandlerDeps } from "./handler.js";

const SYSTEM_PROMPT = [
  "You are a session-analysis assistant.",
  "Read the conversation transcript the user provides and identify the",
  "key decisions that were made during the session. For each decision,",
  "note what was decided, why it was decided (the rationale), and the",
  "approximate time it was decided (decided_at as an ISO 8601 string",
  "such as \"2025-01-15T10:30:00Z\" — pick the closest message timestamp",
  "from the transcript).",
  'Return strictly valid JSON of the form { "items": [{ "decision": string, "rationale": string, "decided_at": string }] }',
  "and nothing else. If no decisions were made, return { \"items\": [] }.",
  "Do not wrap the JSON in markdown fences. Do not add commentary outside the JSON object.",
].join(" ");

export interface Decision {
  decision: string;
  rationale: string;
  decided_at: string;
}

export interface ExtractDecisionsData {
  items: Decision[];
}

export function registerExtractDecisions(
  server: McpServer,
  deps: ToolHandlerDeps,
): void {
  server.registerTool(
    "extract_decisions",
    {
      title: "Extract Decisions",
      description: "Use MiniMax-M3 to extract the list of decisions from a session.",
      inputSchema: ExtractDecisionsInputSchema.shape,
    },
    async (args: ExtractDecisionsInput) =>
      runHandler("extract_decisions", args, (input) =>
        extractDecisions(input, { llm: deps.llm, db: deps.db, models: deps.models }),
      ),
  );
}

export async function extractDecisions(
  input: ExtractDecisionsInput,
  deps: ExtractionDeps,
  timeoutMs?: number,
): Promise<{ ok: true; data: ExtractDecisionsData }> {
  const { items } = await runStructuredExtraction<Decision>(
    input.session_id,
    deps,
    {
      systemPrompt: SYSTEM_PROMPT,
      itemValidator: validateDecision,
      toolName: "extract_decisions",
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    },
  );
  return ok({ items });
}

function validateDecision(value: unknown): Decision | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as {
    decision?: unknown;
    rationale?: unknown;
    decided_at?: unknown;
  };
  if (typeof v.decision !== "string") return null;
  if (typeof v.rationale !== "string") return null;
  if (typeof v.decided_at !== "string") return null;
  return {
    decision: v.decision,
    rationale: v.rationale,
    decided_at: v.decided_at,
  };
}
