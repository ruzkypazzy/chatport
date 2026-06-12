// verify_session: recompute SHA-256 of a stored blob and return tamper
// detection.
//
// Steps (matching the plan's AC-12 spec):
//   1. Load the row from SQLite via db.getSession(session_id). Throw
//      NOT_FOUND if the row is missing (same contract as the other
//      read tools: get_session, diff_sessions, summarize_progress,
//      branch_session, merge_sessions).
//   2. Compute SHA-256 over the stored `blob_json` column. The DB layer
//      already stores the canonical-JSON form (it calls
//      `canonicalStringify` on insert in `src/db/sqlite.ts`), so
//      hashing the raw `blob_json` string is equivalent to hashing
//      `canonicalStringify(JSON.parse(blob_json))` but is a single
//      hash call with no parse roundtrip. This is the "computed hash".
//   3. Pick the comparison target:
//        - If the caller passed `expected_hash`, that's the target.
//          The caller is asserting "the stored blob should hash to
//          this value I recorded earlier".
//        - Otherwise the target is the row's stored `blob_hash`
//          (the hash the DB layer computed at insert time). This
//          makes "no expected_hash" mean "is the stored blob_json
//          still intact in its stored form?" — i.e. has the row been
//          tampered with since insertion.
//   4. `matches` is true iff the computed hash equals the comparison
//      target. The spec contract: `{ session_id, matches, computed_hash }`.
//      `computed_hash` is always surfaced so the caller can see
//      exactly what the recomputation produced.
//
// Errors:
//   - NOT_FOUND: session_id is absent in SQLite
//
// This is a pure local DB read + hash recompute; no LLM call, so no
// withTimeout (matches the diff_sessions pattern). The implementation
// is fully deterministic and side-effect-free: it never mutates the
// stored row.
import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  VerifySessionInputSchema,
  type VerifySessionInput,
} from "../types.js";
import { ok, ToolError } from "../util/errors.js";
import type { ChatportDatabase } from "../db/sqlite.js";
import { runHandler, type ToolHandlerDeps } from "./handler.js";

export interface VerifySessionData {
  session_id: number;
  matches: boolean;
  computed_hash: string;
}

export function registerVerifySession(
  server: McpServer,
  deps: ToolHandlerDeps,
): void {
  server.registerTool(
    "verify_session",
    {
      title: "Verify Session",
      description:
        "Recompute the SHA-256 of a stored blob and compare against the expected hash.",
      inputSchema: VerifySessionInputSchema.shape,
    },
    async (args: VerifySessionInput) =>
      runHandler("verify_session", args, (input) =>
        verifySession(input, deps.db),
      ),
  );
}

export async function verifySession(
  input: VerifySessionInput,
  db: ChatportDatabase,
): Promise<{ ok: true; data: VerifySessionData }> {
  // 1. Load the row. NOT_FOUND if absent.
  const row = db.getSession(input.session_id);
  if (row === null) {
    throw new ToolError(
      "NOT_FOUND",
      `session ${input.session_id} not found`,
      "verify_session",
    );
  }

  // 2. Recompute SHA-256 over the stored blob_json (which is already
  //    the canonical form per the DB layer's `canonicalStringify`).
  //    Hashing the raw string is simpler than re-canonicalizing after
  //    a parse and produces the same hex digest.
  const computed_hash = createHash("sha256")
    .update(row.blob_json)
    .digest("hex");

  // 3. Pick the comparison target. With no expected_hash, the target
  //    is the row's stored blob_hash (the value the DB layer computed
  //    at insert time), so the caller is asking "is the blob still
  //    intact?".
  const target = input.expected_hash ?? row.blob_hash;
  const matches = computed_hash === target;

  return ok({
    session_id: input.session_id,
    matches,
    computed_hash,
  });
}
