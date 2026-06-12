// export_session: fetch a session from OpenAI or MiniMax-M3 and return a
// normalized SessionBlob. The handler:
//   1. Picks the right LLM client (openai or minimax) based on source_llm.
//   2. Calls client.conversations.retrieve() for metadata.
//   3. Paginates client.conversations.items.list() and flattens to a list of
//      messages of type "message" with text content.
//   4. Wraps the work in a 30 s withTimeout(..., "UPSTREAM_TIMEOUT") so a
//      slow upstream returns the right error code.
//   5. Returns the SessionBlob inside the structured envelope.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ExportSessionInputSchema,
  type ExportSessionInput,
  type SessionBlob,
} from "../types.js";
import { ok, ToolError } from "../util/errors.js";
import { withTimeout } from "../util/timeout.js";
import type { LlmClients } from "../llm/openai-client.js";
import { parseSessionBlob } from "../llm/session-parser.js";
import { runHandler, type ToolHandlerDeps } from "./handler.js";

const EXPORT_TIMEOUT_MS = 30_000;

export function registerExportSession(server: McpServer, deps: ToolHandlerDeps): void {
  server.registerTool(
    "export_session",
    {
      title: "Export Session",
      description: "Fetch a session from OpenAI or MiniMax-M3 and return a normalized blob.",
      inputSchema: ExportSessionInputSchema.shape,
    },
    async (args: ExportSessionInput) =>
      runHandler("export_session", args, (input) =>
        exportSession(input, deps.llm, EXPORT_TIMEOUT_MS),
      ),
  );
}

export async function exportSession(
  input: ExportSessionInput,
  llm: LlmClients,
  timeoutMs: number = EXPORT_TIMEOUT_MS,
): Promise<{ ok: true; data: SessionBlob }> {
  const client = pickClient(llm, input.source_llm);
  const work = fetchSessionBlob(client, input.conversation_id, input.source_llm);
  let blob: SessionBlob;
  try {
    blob = await withTimeout(work, timeoutMs, "export_session", {
      code: "UPSTREAM_TIMEOUT",
    });
  } catch (err) {
    if (err instanceof ToolError && err.code === "UPSTREAM_TIMEOUT") {
      throw err;
    }
    throw new ToolError(
      "UPSTREAM_ERROR",
      err instanceof Error ? err.message : String(err),
      "export_session",
    );
  }
  return ok(blob);
}

function pickClient(llm: LlmClients, source_llm: ExportSessionInput["source_llm"]) {
  if (source_llm === "openai") return llm.openai;
  if (source_llm === "MiniMax") return llm.minimax;
  throw new ToolError(
    "INVALID_INPUT",
    `unsupported source_llm: ${String(source_llm)}`,
    "export_session",
  );
}

async function fetchSessionBlob(
  client: LlmClients["openai"],
  conversationId: string,
  source: ExportSessionInput["source_llm"],
): Promise<SessionBlob> {
  const conversation = (await client.conversations.retrieve(conversationId)) as {
    id: string;
    created_at?: number;
    metadata?: unknown;
  };

  const items: Array<{ type?: string; role?: string; content?: unknown; created_at?: number; id?: string }> = [];
  for await (const page of client.conversations.items.list(conversationId)) {
    // The SDK returns either a ConversationItemList { data, has_more, ... }
    // or a page of items; handle both shapes defensively.
    const p = page as { data?: unknown };
    if (p && Array.isArray(p.data)) {
      for (const item of p.data) items.push(item as { type?: string; role?: string; content?: unknown; created_at?: number; id?: string });
    } else if (Array.isArray(page)) {
      for (const item of page) items.push(item as { type?: string; role?: string; content?: unknown; created_at?: number; id?: string });
    }
  }

  return parseSessionBlob({
    conversation: {
      id: conversation.id,
      created_at: conversation.created_at,
      metadata: conversation.metadata,
    },
    items,
    source,
  });
}
