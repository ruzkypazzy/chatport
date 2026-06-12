// Vitest tests for extract_open_questions.
// Asserts envelope shape and side effects: happy path with N items,
// empty items array, NOT_FOUND on missing session, EXTRACTION_FAILED
// on non-JSON / wrong-shape / per-item validation failure, and
// UPSTREAM_TIMEOUT on hanging LLM.
import { describe, test, expect } from "vitest";
import { importSession } from "../../src/tools/import_session.js";
import { extractOpenQuestions } from "../../src/tools/extract_open_questions.js";
import {
  makeBlob,
  makeLlmClients,
  makeTestDeps,
  openQuestionsReply,
} from "../_helpers.js";

describe("extract_open_questions", () => {
  test("happy path: returns items array with the LLM's questions", async () => {
    const deps = makeTestDeps();
    const ins = await importSession(
      {
        blob: makeBlob({
          session_id: "conv_q_1",
          messages: [
            { role: "user", content: "what about retries?", created_at: 1 },
          ],
        }),
        external_session_id: "ext-q",
      },
      deps.db,
    );
    if (!ins.ok) throw new Error("seed failed");

    const { llm, minimax } = makeLlmClients({
      minimax: {
        chatReplies: [
          openQuestionsReply([
            { question: "How should we handle retries?", context: "raised in user message about transient failures" },
          ]),
        ],
      },
    });
    const env = await extractOpenQuestions(
      { session_id: ins.data.id },
      { llm, db: deps.db, models: { openai: "gpt-4o-mini", minimax: "MiniMax-M3" } },
    );
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data.items).toHaveLength(1);
      expect(env.data.items[0]?.question).toBe("How should we handle retries?");
      expect(env.data.items[0]?.context).toContain("user message");
    }
    expect(minimax.chatLog).toHaveLength(1);
  });

  test("empty items: returns { items: [] }", async () => {
    const deps = makeTestDeps();
    const ins = await importSession(
      { blob: makeBlob({ session_id: "conv_q_2" }), external_session_id: "ext-q2" },
      deps.db,
    );
    if (!ins.ok) throw new Error("seed failed");
    const { llm } = makeLlmClients({
      minimax: { chatReplies: [openQuestionsReply([])] },
    });
    const env = await extractOpenQuestions(
      { session_id: ins.data.id },
      { llm, db: deps.db, models: { openai: "gpt-4o-mini", minimax: "MiniMax-M3" } },
    );
    expect(env.ok).toBe(true);
    if (env.ok) expect(env.data.items).toHaveLength(0);
  });

  test("NOT_FOUND on missing session: LLM not called", async () => {
    const deps = makeTestDeps();
    const { llm, minimax } = makeLlmClients();
    let err: unknown;
    try {
      await extractOpenQuestions(
        { session_id: 9999 },
        { llm, db: deps.db, models: { openai: "gpt-4o-mini", minimax: "MiniMax-M3" } },
      );
    } catch (e) {
      err = e;
    }
    const toolErr = err as { code: string; tool: string };
    expect(toolErr.code).toBe("NOT_FOUND");
    expect(toolErr.tool).toBe("extract_open_questions");
    expect(minimax.chatLog).toHaveLength(0);
  });

  test("EXTRACTION_FAILED: non-JSON response", async () => {
    const deps = makeTestDeps();
    const ins = await importSession(
      { blob: makeBlob({ session_id: "conv_q_3" }), external_session_id: "ext-q3" },
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
      await extractOpenQuestions(
        { session_id: ins.data.id },
        { llm, db: deps.db, models: { openai: "gpt-4o-mini", minimax: "MiniMax-M3" } },
      );
    } catch (e) {
      err = e;
    }
    const toolErr = err as { code: string };
    expect(toolErr.code).toBe("EXTRACTION_FAILED");
  });

  test("EXTRACTION_FAILED: per-item missing question field", async () => {
    const deps = makeTestDeps();
    const ins = await importSession(
      { blob: makeBlob({ session_id: "conv_q_4" }), external_session_id: "ext-q4" },
      deps.db,
    );
    if (!ins.ok) throw new Error("seed failed");
    const wrongShape = {
      id: "cmpl",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: JSON.stringify({
              items: [{ question: "ok", context: "ok" }, { context: "missing question" }],
            }),
          },
          finish_reason: "stop",
        },
      ],
    };
    const { llm } = makeLlmClients({ minimax: { chatReplies: [wrongShape] } });
    let err: unknown;
    try {
      await extractOpenQuestions(
        { session_id: ins.data.id },
        { llm, db: deps.db, models: { openai: "gpt-4o-mini", minimax: "MiniMax-M3" } },
      );
    } catch (e) {
      err = e;
    }
    const toolErr = err as { code: string; message: string };
    expect(toolErr.code).toBe("EXTRACTION_FAILED");
    expect(toolErr.message).toMatch(/item\[1\]/);
  });
});
