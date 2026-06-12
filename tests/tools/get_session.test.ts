// Vitest tests for get_session.
// Asserts envelope shape on the happy path and the NOT_FOUND error
// contract. Also confirms the stored canonical-JSON blob is parsed back
// into the original shape on read.
import { describe, test, expect } from "vitest";
import { importSession } from "../../src/tools/import_session.js";
import { getSession } from "../../src/tools/get_session.js";
import { makeBlob, makeTestDeps } from "../_helpers.js";

describe("get_session", () => {
  test("happy path: returns the stored blob parsed from canonical JSON", async () => {
    const deps = makeTestDeps();
    const blob = makeBlob({
      session_id: "conv_get_1",
      messages: [
        { role: "user", content: "hi", created_at: 1_700_000_000 },
        { role: "assistant", content: "hello", created_at: 1_700_000_001 },
      ],
    });
    const ins = await importSession(
      { blob, external_session_id: "ext-get" },
      deps.db,
    );
    expect(ins.ok).toBe(true);
    if (!ins.ok) return;
    const env = await getSession({ session_id: ins.data.id }, deps.db);
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data.id).toBe(ins.data.id);
      expect(env.data.source_llm).toBe("openai");
      expect(env.data.external_session_id).toBe("ext-get");
      expect(env.data.blob_hash).toBe(ins.data.blob_hash);
      const got = env.data.blob as {
        session_id: string;
        source_llm: string;
        messages: Array<{ role: string; content: string; created_at: number }>;
      };
      expect(got.session_id).toBe("conv_get_1");
      expect(got.messages).toHaveLength(2);
      expect(got.messages[0]?.content).toBe("hi");
      expect(got.messages[1]?.content).toBe("hello");
    }
  });

  test("NOT_FOUND: throws ToolError with code NOT_FOUND and the session id in the message", async () => {
    const deps = makeTestDeps();
    let err: unknown;
    try {
      await getSession({ session_id: 9999 }, deps.db);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    const toolErr = err as { code: string; tool: string; message: string };
    expect(toolErr.code).toBe("NOT_FOUND");
    expect(toolErr.tool).toBe("get_session");
    expect(toolErr.message).toContain("9999");
  });
});
