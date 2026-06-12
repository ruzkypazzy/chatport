// get_session: read a single stored session by server-side id.
//
// Returns the full SessionBlob (parsed from the canonical blob_json stored
// in SQLite), or a NOT_FOUND error envelope. The id is validated by the
// Zod schema (positive integer); no further normalization is needed.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GetSessionInputSchema, type GetSessionInput } from "../types.js";
import { ok, ToolError } from "../util/errors.js";
import { runHandler, type ToolHandlerDeps } from "./handler.js";

export interface GetSessionData {
  id: number;
  source_llm: string;
  external_session_id: string | null;
  parent_session_id: number | null;
  created_at: number;
  blob_hash: string;
  blob: unknown;
}

export function registerGetSession(server: McpServer, deps: ToolHandlerDeps): void {
  server.registerTool(
    "get_session",
    {
      title: "Get Session",
      description: "Read one stored session by its server-side id.",
      inputSchema: GetSessionInputSchema.shape,
    },
    async (args: GetSessionInput) =>
      runHandler("get_session", args, (input) => getSession(input, deps.db)),
  );
}

export async function getSession(
  input: GetSessionInput,
  db: ToolHandlerDeps["db"],
): Promise<{ ok: true; data: GetSessionData }> {
  const row = db.getSession(input.session_id);
  if (row === null) {
    throw new ToolError(
      "NOT_FOUND",
      `session ${input.session_id} not found`,
      "get_session",
    );
  }
  return ok({
    id: row.id,
    source_llm: row.source_llm,
    external_session_id: row.external_session_id,
    parent_session_id: row.parent_session_id,
    created_at: row.created_at,
    blob_hash: row.blob_hash,
    blob: JSON.parse(row.blob_json) as unknown,
  });
}
