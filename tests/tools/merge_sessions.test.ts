// Vitest tests for merge_sessions.
// Asserts the three strategies: concat (input order), interleave
// (k-way merge by created_at), summarize (LLM-driven merge), plus
// NOT_FOUND on missing session.
import { describe, test, expect } from "vitest";
import { importSession } from "../../src/tools/import_session.js";
import { mergeSessions } from "../../src/tools/merge_sessions.js";
import {
  makeBlob,
  makeLlmClients,
  makeTestDeps,
  summaryReply,
} from "../_helpers.js";

describe("merge_sessions", () => {
  test("concat: appends messages in input order, source_llm = first session's", async () => {
    const deps = makeTestDeps();
    const insA = await importSession(
      {
        blob: makeBlob({
          session_id: "conv_mc_a",
          messages: [
            { role: "user", content: "u1a", created_at: 1 },
            { role: "assistant", content: "a1a", created_at: 2 },
          ],
        }),
        external_session_id: "ext-mc-a",
      },
      deps.db,
    );
    const insB = await importSession(
      {
        blob: makeBlob({
          session_id: "conv_mc_b",
          messages: [
            { role: "user", content: "u1b", created_at: 3 },
          ],
        }),
        external_session_id: "ext-mc-b",
      },
      deps.db,
    );
    if (!insA.ok || !insB.ok) throw new Error("seed failed");
    const { llm } = makeLlmClients();
    const env = await mergeSessions(
      { session_ids: [insA.data.id, insB.data.id], strategy: "concat", target_llm: "openai" },
      llm,
      deps.db,
      { openai: "gpt-4o-mini", minimax: "MiniMax-M3" },
    );
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data.strategy).toBe("concat");
      expect(env.data.message_count).toBe(3);
      expect(env.data.input_session_ids).toEqual([insA.data.id, insB.data.id]);
      const newRow = deps.db.getSession(env.data.session_id);
      expect(newRow).not.toBeNull();
      if (newRow) {
        const newBlob = JSON.parse(newRow.blob_json) as {
          messages: Array<{ content: string }>;
          metadata: Record<string, unknown>;
        };
        expect(newBlob.messages.map((m) => m.content)).toEqual(["u1a", "a1a", "u1b"]);
        expect(newBlob.metadata["merge_strategy"]).toBe("concat");
      }
    }
  });

  test("interleave: chronological order, ties broken by source index", async () => {
    const deps = makeTestDeps();
    const insA = await importSession(
      {
        blob: makeBlob({
          session_id: "conv_mi_a",
          messages: [
            { role: "user", content: "a1", created_at: 1 },
            { role: "user", content: "a3", created_at: 3 },
          ],
        }),
        external_session_id: "ext-mi-a",
      },
      deps.db,
    );
    const insB = await importSession(
      {
        blob: makeBlob({
          session_id: "conv_mi_b",
          messages: [
            { role: "user", content: "b2", created_at: 2 },
            { role: "user", content: "b4", created_at: 4 },
          ],
        }),
        external_session_id: "ext-mi-b",
      },
      deps.db,
    );
    if (!insA.ok || !insB.ok) throw new Error("seed failed");
    const { llm } = makeLlmClients();
    const env = await mergeSessions(
      { session_ids: [insA.data.id, insB.data.id], strategy: "interleave", target_llm: "openai" },
      llm,
      deps.db,
      { openai: "gpt-4o-mini", minimax: "MiniMax-M3" },
    );
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data.strategy).toBe("interleave");
      const newRow = deps.db.getSession(env.data.session_id);
      if (newRow) {
        const newBlob = JSON.parse(newRow.blob_json) as {
          messages: Array<{ content: string }>;
        };
        expect(newBlob.messages.map((m) => m.content)).toEqual(["a1", "b2", "a3", "b4"]);
      }
    }
  });

  test("summarize: LLM summary becomes the new blob's single assistant message", async () => {
    const deps = makeTestDeps();
    const insA = await importSession(
      { blob: makeBlob({ session_id: "conv_ms_a" }), external_session_id: "ext-ms-a" },
      deps.db,
    );
    const insB = await importSession(
      { blob: makeBlob({ session_id: "conv_ms_b" }), external_session_id: "ext-ms-b" },
      deps.db,
    );
    if (!insA.ok || !insB.ok) throw new Error("seed failed");
    const merged = "Merged narrative referencing both sessions.";
    const { llm, minimax } = makeLlmClients({
      minimax: { chatReplies: [summaryReply(merged)] },
    });
    const env = await mergeSessions(
      { session_ids: [insA.data.id, insB.data.id], strategy: "summarize", target_llm: "openai" },
      llm,
      deps.db,
      { openai: "gpt-4o-mini", minimax: "MiniMax-M3" },
    );
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data.strategy).toBe("summarize");
      expect(env.data.message_count).toBe(1);
      const newRow = deps.db.getSession(env.data.session_id);
      if (newRow) {
        const newBlob = JSON.parse(newRow.blob_json) as {
          messages: Array<{ role: string; content: string }>;
          source_llm: string;
        };
        expect(newBlob.messages).toHaveLength(1);
        expect(newBlob.messages[0]?.role).toBe("assistant");
        expect(newBlob.messages[0]?.content).toBe(merged);
        expect(newBlob.source_llm).toBe("openai");
      }
    }
    expect(minimax.chatLog).toHaveLength(1);
  });

  test("NOT_FOUND: missing session_id", async () => {
    const deps = makeTestDeps();
    const insA = await importSession(
      { blob: makeBlob({ session_id: "conv_mn" }), external_session_id: "ext-mn" },
      deps.db,
    );
    if (!insA.ok) throw new Error("seed failed");
    const { llm, minimax } = makeLlmClients();
    let err: unknown;
    try {
      await mergeSessions(
        { session_ids: [insA.data.id, 9999], strategy: "concat", target_llm: "openai" },
        llm,
        deps.db,
        { openai: "gpt-4o-mini", minimax: "MiniMax-M3" },
      );
    } catch (e) {
      err = e;
    }
    const toolErr = err as { code: string; tool: string; message: string };
    expect(toolErr.code).toBe("NOT_FOUND");
    expect(toolErr.tool).toBe("merge_sessions");
    expect(toolErr.message).toContain("9999");
    expect(minimax.chatLog).toHaveLength(0);
  });
});
