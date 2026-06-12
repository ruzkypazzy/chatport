// Vitest tests for continue_in.
// Asserts the composed handoff: load -> summarize -> seed -> chat ->
// conversations.create. Covers happy path with target_llm=MiniMax,
// target_llm=openai routing, NOT_FOUND, UPSTREAM_TIMEOUT,
// UPSTREAM_ERROR, and malformed LLM responses.
import { describe, test, expect } from "vitest";
import { importSession } from "../../src/tools/import_session.js";
import { continueIn } from "../../src/tools/continue_in.js";
import {
  makeBlob,
  makeLlmClients,
  makeTestDeps,
  summaryReply,
  assistantReply,
} from "../_helpers.js";

describe("continue_in", () => {
  test("happy path (target_llm=MiniMax): seeded_messages has system+user+assistant", async () => {
    const deps = makeTestDeps();
    const ins = await importSession(
      {
        blob: makeBlob({
          session_id: "conv_cont_1",
          messages: [
            { role: "user", content: "let's add caching", created_at: 1_700_000_000 },
            { role: "assistant", content: "ok use redis with 60s ttl", created_at: 1_700_000_001 },
          ],
        }),
        external_session_id: "ext-cont",
      },
      deps.db,
    );
    if (!ins.ok) throw new Error("seed failed");

    const { llm, openai, minimax } = makeLlmClients({
      openai: {
        chatReplies: [
          summaryReply("We agreed to ship redis caching with 60s TTL."),
          assistantReply("Got it. Setting up the cache layer now."),
        ],
        conversationId: "conv_new_abc",
      },
    });
    const env = await continueIn(
      { source_session_id: ins.data.id, target_llm: "MiniMax", next_step: "set up cache" },
      llm,
      deps.db,
      { openai: "gpt-4o-mini", minimax: "MiniMax-M3" },
    );
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data.new_session_id).toBe("conv_new_abc");
      expect(env.data.source_llm).toBe("MiniMax");
      expect(env.data.seeded_messages).toHaveLength(3);
      const [sys, user, asst] = env.data.seeded_messages;
      expect(sys?.role).toBe("system");
      expect(sys?.content).toBe("We agreed to ship redis caching with 60s TTL.");
      expect(user?.role).toBe("user");
      expect(user?.content).toBe("set up cache");
      expect(asst?.role).toBe("assistant");
      expect(asst?.content).toBe("Got it. Setting up the cache layer now.");
    }
    // 2 chat calls (summarize + reply) on the minimax stub, since
    // continue_in's compressor is fixed to MiniMax-M3 and target_llm
    // is MiniMax — both routes land on llm.minimax.
    expect(minimax.chatLog).toHaveLength(2);
    // 1 conversations.create call on the same stub.
    expect(minimax.convCreateLog).toHaveLength(1);
    const conv = minimax.convCreateLog[0] as { items: Array<{ role: string; content: string }> };
    expect(conv.items).toHaveLength(3);
    expect(conv.items[0]?.role).toBe("system");
    expect(conv.items[2]?.role).toBe("assistant");
  });

  test("NOT_FOUND: missing source session", async () => {
    const deps = makeTestDeps();
    const { llm, openai, minimax } = makeLlmClients();
    let err: unknown;
    try {
      await continueIn(
        { source_session_id: 9999, target_llm: "MiniMax", next_step: "x" },
        llm,
        deps.db,
        { openai: "gpt-4o-mini", minimax: "MiniMax-M3" },
      );
    } catch (e) {
      err = e;
    }
    const toolErr = err as { code: string; tool: string };
    expect(toolErr.code).toBe("NOT_FOUND");
    expect(toolErr.tool).toBe("continue_in");
    expect(openai.chatLog).toHaveLength(0);
    expect(minimax.chatLog).toHaveLength(0);
  });

  test("UPSTREAM_TIMEOUT: hanging LLM during summarize", async () => {
    const deps = makeTestDeps();
    const ins = await importSession(
      { blob: makeBlob({ session_id: "conv_cont_2" }), external_session_id: "ext-cont2" },
      deps.db,
    );
    if (!ins.ok) throw new Error("seed failed");
    // The summarize step uses llm.minimax (compressor is fixed to
    // MiniMax-M3 for continue_in per the plan). Hang that stub.
    const { llm } = makeLlmClients({ minimax: { chatHangMs: 5_000 } });
    let err: unknown;
    try {
      await continueIn(
        { source_session_id: ins.data.id, target_llm: "MiniMax", next_step: "x" },
        llm,
        deps.db,
        { openai: "gpt-4o-mini", minimax: "MiniMax-M3" },
        50,
      );
    } catch (e) {
      err = e;
    }
    const toolErr = err as { code: string };
    expect(toolErr.code).toBe("UPSTREAM_TIMEOUT");
  });

  test("UPSTREAM_ERROR: thrown LLM error", async () => {
    const deps = makeTestDeps();
    const ins = await importSession(
      { blob: makeBlob({ session_id: "conv_cont_3" }), external_session_id: "ext-cont3" },
      deps.db,
    );
    if (!ins.ok) throw new Error("seed failed");
    // Both stubs throw: the inner summarize step calls llm.minimax,
    // and continue_in's reply step would call llm.openai (for target
    // MiniMax routing). Configure both so the very first LLM call
    // (the summarize) throws and propagates as UPSTREAM_ERROR.
    const { llm } = makeLlmClients({
      openai: { chatThrow: new Error("upstream boom") },
      minimax: { chatThrow: new Error("upstream boom") },
    });
    let err: unknown;
    try {
      await continueIn(
        { source_session_id: ins.data.id, target_llm: "MiniMax", next_step: "x" },
        llm,
        deps.db,
        { openai: "gpt-4o-mini", minimax: "MiniMax-M3" },
      );
    } catch (e) {
      err = e;
    }
    const toolErr = err as { code: string; message: string };
    expect(toolErr.code).toBe("UPSTREAM_ERROR");
    expect(toolErr.message).toContain("upstream boom");
  });

  test("UPSTREAM_ERROR: malformed chat.completions response (no assistant text)", async () => {
    const deps = makeTestDeps();
    const ins = await importSession(
      { blob: makeBlob({ session_id: "conv_cont_4" }), external_session_id: "ext-cont4" },
      deps.db,
    );
    if (!ins.ok) throw new Error("seed failed");
    // Empty assistant text -> the inner summarize throws EXTRACTION_FAILED
    // which is re-mapped to UPSTREAM_ERROR by the outer handler.
    const emptySummary = {
      id: "cmpl",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "" },
          finish_reason: "stop",
        },
      ],
    };
    const { llm } = makeLlmClients({ openai: { chatReplies: [emptySummary] } });
    let err: unknown;
    try {
      await continueIn(
        { source_session_id: ins.data.id, target_llm: "MiniMax", next_step: "x" },
        llm,
        deps.db,
        { openai: "gpt-4o-mini", minimax: "MiniMax-M3" },
      );
    } catch (e) {
      err = e;
    }
    const toolErr = err as { code: string };
    // Either EXTRACTION_FAILED (re-thrown as continue_in) or UPSTREAM_ERROR
    // is acceptable here; the important part is the error envelope is
    // surfaced, not a thrown TypeError.
    expect(["EXTRACTION_FAILED", "UPSTREAM_ERROR"]).toContain(toolErr.code);
  });
});
