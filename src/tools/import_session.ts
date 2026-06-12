// import_session: persist a normalized session blob to SQLite, return a
// server-side id. If `external_session_id` is provided, the same
// (source_llm, external_session_id) pair upserts: the existing row is
// returned, no new row is created. The `deduplicated` flag tells the
// caller which path was taken.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ImportSessionInputSchema, type ImportSessionInput } from "../types.js";
import { ok } from "../util/errors.js";
import { runHandler, type ToolHandlerDeps } from "./handler.js";

export interface ImportSessionData {
  id: number;
  blob_hash: string;
  created_at: number;
  deduplicated: boolean;
}

export function registerImportSession(server: McpServer, deps: ToolHandlerDeps): void {
  server.registerTool(
    "import_session",
    {
      title: "Import Session",
      description: "Persist a normalized session blob to chatport's local SQLite store.",
      inputSchema: ImportSessionInputSchema.shape,
    },
    async (args: ImportSessionInput) =>
      runHandler("import_session", args, (input) => importSession(input, deps.db)),
  );
}

export async function importSession(
  input: ImportSessionInput,
  db: ToolHandlerDeps["db"],
): Promise<{ ok: true; data: ImportSessionData }> {
  if (input.external_session_id !== undefined) {
    const existing = db.findByExternalId(
      input.blob.source_llm,
      input.external_session_id,
    );
    if (existing) {
      return ok({
        id: existing.id,
        blob_hash: existing.blob_hash,
        created_at: existing.created_at,
        deduplicated: true,
      });
    }
  }

  const result = db.insertSession({
    source_llm: input.blob.source_llm,
    external_session_id: input.external_session_id ?? null,
    blob: input.blob,
    parent_session_id: null,
  });

  return ok({
    id: result.id,
    blob_hash: result.blob_hash,
    created_at: result.created_at,
    deduplicated: false,
  });
}
