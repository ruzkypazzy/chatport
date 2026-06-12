// Vitest tests for branch_session.
// Asserts envelope shape and side effects: happy path with new row
// linking to parent via parent_session_id, NOT_FOUND on missing
// parent, EXTRACTION_FAILED on non-JSON / wrong-shape, and
// UPSTREAM_TIMEOUT on hanging LLM.
import { describe, test, expect } from "vitest";
import { importSession } from "../../src/tools/import_session.js";
import { branchSession } from "../../src/tools/branch_session.js";
import {
  makeBlob,
  makeLlmClients,
  makeTestDeps,
  branchReply,
} from "../_helpers.js";

describe("branch_session", () => {
  test("happy path: new row inserted, parent_session_id set, opening rewritten", async () => {
    const deps = makeTestDeps();
    const ins = await importSession(
      {
        blob: makeBlob({
          session_id: "conv_branch_1",
          messages: [
            { role: "user", content: "Build a chat app", created_at: 1_700_000_000 },
            { role: "assistant", content: "Sure, what stack?", created_at: 1_700_000_001 },
          ],
        }),
        external_session_id: "ext-branch",
      },
      deps.db,
    );
    if (!ins.ok) throw new Error("seed failed");

    const { llm, minimax } = makeLlmClients({
      minimax: {
        chatReplies: [
          branchReply("Build a chat app with observability built in from day one"),
        ],
      },
    });
    const env = await branchSession(
      { parent_session_id: ins.data.id, alternate_path: "Add observability" },
      llm,
      deps.db,
      { openai: "gpt-4o-mini", minimax: "MiniMax-M3" },
    );
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data.session_id).toBeGreaterThan(0);
      expect(env.data.session_id).not.toBe(ins.data.id);
      expect(env.data.parent_session_id).toBe(ins.data.id);
    }
    // The new row links to the parent.
    if (env.ok) {
      const newRow = deps.db.getSession(env.data.session_id);
      expect(newRow).not.toBeNull();
      if (newRow) {
        expect(newRow.parent_session_id).toBe(ins.data.id);
        const newBlob = JSON.parse(newRow.blob_json) as {
          messages: Array<{ role: string; content: string; created_at: number }>;
          metadata: Record<string, unknown>;
        };
        expect(newBlob.messages[0]?.content).toBe(
          "Build a chat app with observability built in from day one",
        );
        expect(newBlob.messages[0]?.role).toBe("user");
        // Tail of the conversation is preserved.
        expect(newBlob.messages[1]?.content).toBe("Sure, what stack?");
        expect(newBlob.metadata["branched_alternate_path"]).toBe("Add observability");
      }
    }
    expect(minimax.chatLog).toHaveLength(1);
  });

  test("NOT_FOUND: missing parent -> no LLM call", async () => {
    const deps = makeTestDeps();
    const { llm, minimax } = makeLlmClients();
    let err: unknown;
    try {
      await branchSession(
        { parent_session_id: 9999, alternate_path: "x" },
        llm,
        deps.db,
        { openai: "gpt-4o-mini", minimax: "MiniMax-M3" },
      );
    } catch (e) {
      err = e;
    }
    const toolErr = err as { code: string; tool: string; message: string };
    expect(toolErr.code).toBe("NOT_FOUND");
    expect(toolErr.tool).toBe("branch_session");
    expect(toolErr.message).toContain("9999");
    expect(minimax.chatLog).toHaveLength(0);
  });

  test("EXTRACTION_FAILED: non-JSON response", async () => {
    const deps = makeTestDeps();
    const ins = await importSession(
      { blob: makeBlob({ session_id: "conv_branch_2" }), external_session_id: "ext-branch2" },
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
      await branchSession(
        { parent_session_id: ins.data.id, alternate_path: "x" },
        llm,
        deps.db,
        { openai: "gpt-4o-mini", minimax: "MiniMax-M3" },
      );
    } catch (e) {
      err = e;
    }
    const toolErr = err as { code: string };
    expect(toolErr.code).toBe("EXTRACTION_FAILED");
  });

  test("EXTRACTION_FAILED: response JSON missing rewritten_message", async () => {
    const deps = makeTestDeps();
    const ins = await importSession(
      { blob: makeBlob({ session_id: "conv_branch_3" }), external_session_id: "ext-branch3" },
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
            content: JSON.stringify({ wrong: "field" }),
          },
          finish_reason: "stop",
        },
      ],
    };
    const { llm } = makeLlmClients({ minimax: { chatReplies: [wrongShape] } });
    let err: unknown;
    try {
      await branchSession(
        { parent_session_id: ins.data.id, alternate_path: "x" },
        llm,
        deps.db,
        { openai: "gpt-4o-mini", minimax: "MiniMax-M3" },
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
      { blob: makeBlob({ session_id: "conv_branch_4" }), external_session_id: "ext-branch4" },
      deps.db,
    );
    if (!ins.ok) throw new Error("seed failed");
    const { llm } = makeLlmClients({ minimax: { chatHangMs: 5_000 } });
    let err: unknown;
    try {
      await branchSession(
        { parent_session_id: ins.data.id, alternate_path: "x" },
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
});
