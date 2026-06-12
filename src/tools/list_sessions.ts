// list_sessions: paginated read of stored sessions.
//
// Reads through the real ChatportDatabase. Items are returned as full
// SessionBlob objects (not raw DB rows) so the MCP caller can use them
// directly with import_session / diff_sessions / verify_session etc.
// Ordering is by `created_at DESC, id DESC` (newest first), which the DB
// layer guarantees in its prepared statement. `limit` and `offset` are
// validated by the Zod schema (non-negative integers, max limit 200) and
// passed through to the DB.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListSessionsInputSchema, type ListSessionsInput } from "../types.js";
import { ok } from "../util/errors.js";
import { runHandler, type ToolHandlerDeps } from "./handler.js";

export interface ListSessionsData {
  items: Array<{
    id: number;
    source_llm: string;
    external_session_id: string | null;
    parent_session_id: number | null;
    created_at: number;
    blob_hash: string;
    blob: unknown;
  }>;
  total: number;
  limit: number;
  offset: number;
}

export function registerListSessions(server: McpServer, deps: ToolHandlerDeps): void {
  server.registerTool(
    "list_sessions",
    {
      title: "List Sessions",
      description: "Return a paginated list of stored sessions, newest first.",
      inputSchema: ListSessionsInputSchema.shape,
    },
    async (args: ListSessionsInput) =>
      runHandler("list_sessions", args, (input) => listSessions(input, deps.db)),
  );
}

export async function listSessions(
  input: ListSessionsInput,
  db: ToolHandlerDeps["db"],
): Promise<{ ok: true; data: ListSessionsData }> {
  const { items, total } = db.listSessions({
    limit: input.limit,
    offset: input.offset,
  });
  return ok({
    items: items.map((row) => ({
      id: row.id,
      source_llm: row.source_llm,
      external_session_id: row.external_session_id,
      parent_session_id: row.parent_session_id,
      created_at: row.created_at,
      blob_hash: row.blob_hash,
      // The DB layer stored the canonical-stringified blob; hand the parsed
      // JSON back to the caller so they can pass it to other tools
      // (diff_sessions, branch_session, etc.) without re-parsing.
      blob: JSON.parse(row.blob_json) as unknown,
    })),
    total,
    limit: input.limit,
    offset: input.offset,
  });
}
