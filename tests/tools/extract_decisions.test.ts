// Vitest tests for extract_decisions.
// Asserts envelope shape and side effects: happy path, empty items,
// NOT_FOUND, EXTRACTION_FAILED on wrong shape, and UPSTREAM_TIMEOUT.
import { describe, test, expect } from "vitest";
import { importSession } from "../../src/tools/import_session.js";
import { extractDecisions } from "../../src/tools/extract_decisions.js";
import {
  makeBlob,
  makeLlmClients,
  makeTestDeps,
  decisionsReply,
} from "../_helpers.js";

describe("extract_decisions", () => {
  test("happy path: returns items with decision/rationale/decided_at", async () => {
    const deps = makeTestDeps();
    const ins = await importSession(
      { blob: makeBlob({ session_id: "conv_d_1" }), external_session_id: "ext-d" },
      deps.db,
    );
    if (!ins.ok) throw new Error("seed failed");
    const { llm, minimax } = makeLlmClients({
      minimax: {
        chatReplies: [
          decisionsReply([
            {
              decision: "Use redis for caching",
              rationale: "low-latency, simple",
              decided_at: "2023-11-14T22:13:21Z",
            },
          ]),
        ],
      },
    });
    const env = await extractDecisions(
      { session_id: ins.data.id },
      { llm, db: deps.db, models: { openai: "gpt-4o-mini", minimax: "MiniMax-M3" } },
    );
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data.items).toHaveLength(1);
      const item = env.data.items[0];
      if (item) {
        expect(item.decision).toBe("Use redis for caching");
        expect(item.rationale).toBe("low-latency, simple");
        expect(item.decided_at).toBe("2023-11-14T22:13:21Z");
      }
    }
    expect(minimax.chatLog).toHaveLength(1);
  });

  test("NOT_FOUND: missing session", async () => {
    const deps = makeTestDeps();
    const { llm, minimax } = makeLlmClients();
    let err: unknown;
    try {
      await extractDecisions(
        { session_id: 9999 },
        { llm, db: deps.db, models: { openai: "gpt-4o-mini", minimax: "MiniMax-M3" } },
      );
    } catch (e) {
      err = e;
    }
    const toolErr = err as { code: string };
    expect(toolErr.code).toBe("NOT_FOUND");
    expect(minimax.chatLog).toHaveLength(0);
  });

  test("EXTRACTION_FAILED: items array missing -> ToolError", async () => {
    const deps = makeTestDeps();
    const ins = await importSession(
      { blob: makeBlob({ session_id: "conv_d_2" }), external_session_id: "ext-d2" },
      deps.db,
    );
    if (!ins.ok) throw new Error("seed failed");
    const wrong = {
      id: "cmpl",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: JSON.stringify({ not_items: [] }),
          },
          finish_reason: "stop",
        },
      ],
    };
    const { llm } = makeLlmClients({ minimax: { chatReplies: [wrong] } });
    let err: unknown;
    try {
      await extractDecisions(
        { session_id: ins.data.id },
        { llm, db: deps.db, models: { openai: "gpt-4o-mini", minimax: "MiniMax-M3" } },
      );
    } catch (e) {
      err = e;
    }
    const toolErr = err as { code: string };
    expect(toolErr.code).toBe("EXTRACTION_FAILED");
  });

  test("UPSTREAM_TIMEOUT: hanging LLM", async () => {
    const deps = makeTestDeps();
    const ins = await importSession(
      { blob: makeBlob({ session_id: "conv_d_3" }), external_session_id: "ext-d3" },
      deps.db,
    );
    if (!ins.ok) throw new Error("seed failed");
    const { llm } = makeLlmClients({ minimax: { chatHangMs: 5_000 } });
    let err: unknown;
    try {
      await extractDecisions(
        { session_id: ins.data.id },
        { llm, db: deps.db, models: { openai: "gpt-4o-mini", minimax: "MiniMax-M3" } },
        50,
      );
    } catch (e) {
      err = e;
    }
    const toolErr = err as { code: string };
    expect(toolErr.code).toBe("UPSTREAM_TIMEOUT");
  });
});
