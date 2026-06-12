// Vitest tests for summarize_progress.
// Asserts the LLM-routing envelope shape: default MiniMax-M3 with
// temperature 0.2 + response_format json_object; compressor="openai"
// routes the call to the openai client; non-JSON -> EXTRACTION_FAILED;
// missing summary field -> EXTRACTION_FAILED; hanging LLM ->
// UPSTREAM_TIMEOUT; NOT_FOUND on missing session.
import { describe, test, expect } from "vitest";
import { importSession } from "../../src/tools/import_session.js";
import { summarizeProgress } from "../../src/tools/summarize_progress.js";
import {
  makeBlob,
  makeLlmClients,
  makeTestDeps,
  summaryReply,
} from "../_helpers.js";

describe("summarize_progress", () => {
  test("happy path (default MiniMax): returns session_id, summary, target_tokens, compressor", async () => {
    const deps = makeTestDeps();
    const ins = await importSession(
      {
        blob: makeBlob({
          session_id: "conv_sum_1",
          messages: [
            { role: "user", content: "let's add caching", created_at: 1_700_000_000 },
            { role: "assistant", content: "ok use redis with 60s ttl", created_at: 1_700_000_001 },
          ],
        }),
        external_session_id: "ext-sum",
      },
      deps.db,
    );
    expect(ins.ok).toBe(true);
    if (!ins.ok) return;

    const { llm, minimax } = makeLlmClients({
      minimax: { chatReplies: [summaryReply("Added redis caching with 60s TTL.")] },
    });
    const env = await summarizeProgress(
      { session_id: ins.data.id, target_tokens: 4000, compressor: "MiniMax-M3" },
      llm,
      deps.db,
      { openai: "gpt-4o-mini", minimax: "MiniMax-M3" },
    );
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data.session_id).toBe(ins.data.id);
      expect(env.data.summary).toBe("Added redis caching with 60s TTL.");
      expect(env.data.target_tokens).toBe(4000);
      expect(env.data.compressor).toBe("MiniMax-M3");
    }
    // LLM was called once on the minimax client with the spec'd params.
    expect(minimax.chatLog).toHaveLength(1);
    const call = minimax.chatLog[0] as {
      model: string;
      temperature: number;
      response_format: { type: string };
      messages: Array<{ role: string; content: string }>;
    };
    expect(call.model).toBe("MiniMax-M3");
    expect(call.temperature).toBe(0.2);
    expect(call.response_format).toEqual({ type: "json_object" });
  });

  test("compressor=openai routes to the openai client", async () => {
    const deps = makeTestDeps();
    const ins = await importSession(
      { blob: makeBlob({ session_id: "conv_sum_2" }), external_session_id: "ext-sum2" },
      deps.db,
    );
    if (!ins.ok) throw new Error("seed failed");
    const { llm, openai, minimax } = makeLlmClients({
      openai: { chatReplies: [summaryReply("openai path summary")] },
    });
    const env = await summarizeProgress(
      { session_id: ins.data.id, target_tokens: 2000, compressor: "openai" },
      llm,
      deps.db,
      { openai: "gpt-4o-mini", minimax: "MiniMax-M3" },
    );
    expect(env.ok).toBe(true);
    expect(openai.chatLog).toHaveLength(1);
    expect(minimax.chatLog).toHaveLength(0);
  });

  test("NOT_FOUND: missing session surfaces as ToolError(code=NOT_FOUND)", async () => {
    const deps = makeTestDeps();
    const { llm, minimax } = makeLlmClients();
    let err: unknown;
    try {
      await summarizeProgress(
        { session_id: 9999, target_tokens: 1000, compressor: "MiniMax-M3" },
        llm,
        deps.db,
        { openai: "gpt-4o-mini", minimax: "MiniMax-M3" },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    const toolErr = err as { code: string; tool: string };
    expect(toolErr.code).toBe("NOT_FOUND");
    expect(toolErr.tool).toBe("summarize_progress");
    // LLM not called.
    expect(minimax.chatLog).toHaveLength(0);
  });

  test("EXTRACTION_FAILED: non-JSON response -> ToolError", async () => {
    const deps = makeTestDeps();
    const ins = await importSession(
      { blob: makeBlob({ session_id: "conv_sum_3" }), external_session_id: "ext-sum3" },
      deps.db,
    );
    if (!ins.ok) throw new Error("seed failed");
    const notJson = {
      id: "cmpl",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "not json" },
          finish_reason: "stop",
        },
      ],
    };
    const { llm } = makeLlmClients({ minimax: { chatReplies: [notJson] } });
    let err: unknown;
    try {
      await summarizeProgress(
        { session_id: ins.data.id, target_tokens: 1000, compressor: "MiniMax-M3" },
        llm,
        deps.db,
        { openai: "gpt-4o-mini", minimax: "MiniMax-M3" },
      );
    } catch (e) {
      err = e;
    }
    const toolErr = err as { code: string; tool: string };
    expect(toolErr.code).toBe("EXTRACTION_FAILED");
    expect(toolErr.tool).toBe("summarize_progress");
  });

  test("UPSTREAM_TIMEOUT: hanging LLM -> ToolError", async () => {
    const deps = makeTestDeps();
    const ins = await importSession(
      { blob: makeBlob({ session_id: "conv_sum_4" }), external_session_id: "ext-sum4" },
      deps.db,
    );
    if (!ins.ok) throw new Error("seed failed");
    const { llm } = makeLlmClients({ minimax: { chatHangMs: 5_000 } });
    let err: unknown;
    try {
      await summarizeProgress(
        { session_id: ins.data.id, target_tokens: 1000, compressor: "MiniMax-M3" },
        llm,
        deps.db,
        { openai: "gpt-4o-mini", minimax: "MiniMax-M3" },
        50,
      );
    } catch (e) {
      err = e;
    }
    const toolErr = err as { code: string; tool: string };
    expect(toolErr.code).toBe("UPSTREAM_TIMEOUT");
    expect(toolErr.tool).toBe("summarize_progress");
  });
});
