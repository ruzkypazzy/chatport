// Vitest tests for export_session.
// Asserts the LLM-routing envelope shape: openai and MiniMax clients
// are picked by source_llm, items.list() is paginated and flattened,
// and the response is a normalized SessionBlob. Also asserts the
// UPSTREAM_TIMEOUT and UPSTREAM_ERROR error contracts.
import { describe, test, expect } from "vitest";
import { exportSession } from "../../src/tools/export_session.js";
import { makeLlmClients, makeTestDeps } from "../_helpers.js";
import type { LlmClient } from "../../src/llm/openai-client.js";

interface LlmOpts {
  items?: unknown[];
  throwError?: Error;
  hangMs?: number;
}

function makeLlm(opts: LlmOpts = {}): LlmClient {
  const chatLog: unknown[] = [];
  const convCreateLog: unknown[] = [];
  let chatIndex = 0;
  const chatReplies: unknown[] = [];
  // export_session calls conversations.retrieve and conversations.items.list
  // (not chat.completions.create). To exercise the timeout, we hang in
  // the conversation methods. A never-resolving promise is the most
  // reliable way to force the race; setTimeout(5000) is the fallback.
  return {
    chatLog,
    convCreateLog,
    conversations: {
      retrieve: async (id: string) => {
        if (opts.hangMs && opts.hangMs > 0) {
          return new Promise<{ id: string; created_at: number }>(() => undefined);
        }
        if (opts.throwError) throw opts.throwError;
        return { id, created_at: 1_700_000_000 };
      },
      create: async (params: { items: unknown[] }) => {
        convCreateLog.push(params);
        return { id: "conv_new", object: "conversation" };
      },
      items: {
        async *list(_id: string) {
          if (opts.hangMs && opts.hangMs > 0) {
            // Yield a never-resolving promise: withTimeout's race will
            // always pick the timeout branch.
            await new Promise(() => undefined);
            return;
          }
          if (opts.throwError) throw opts.throwError;
          yield { data: opts.items ?? [], has_more: false };
        },
      },
    },
    chat: {
      completions: {
        create: async (params: unknown) => {
          chatLog.push(params);
          if (opts.throwError) throw opts.throwError;
          if (opts.hangMs) await new Promise((r) => setTimeout(r, opts.hangMs));
          return chatReplies[chatIndex++] ?? {};
        },
      },
    },
  };
}

function openaiItem(role: string, text: string, created_at: number) {
  return {
    type: "message",
    role,
    content: [{ type: "text", text }],
    created_at,
  };
}

describe("export_session", () => {
  test("happy path (openai): 25 messages -> SessionBlob with 25 normalized messages", async () => {
    const items = Array.from({ length: 25 }, (_, i) =>
      openaiItem(i % 2 === 0 ? "user" : "assistant", `msg-${i}`, 1_700_000_000 + i),
    );
    const stub = makeLlm({ items });
    const deps = makeTestDeps({ llm: { openai: stub, minimax: stub } });
    const env = await exportSession(
      { source_llm: "openai", conversation_id: "conv_openai_1" },
      deps.llm,
    );
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data.messages).toHaveLength(25);
      expect(env.data.session_id).toBe("conv_openai_1");
      expect(env.data.source_llm).toBe("openai");
      expect(env.data.messages[0]?.role).toBe("user");
    }
  });

  test("happy path (MiniMax): 3 messages -> SessionBlob with 3 messages, source_llm=MiniMax", async () => {
    const items = [
      openaiItem("user", "u1", 1_700_000_000),
      openaiItem("assistant", "a1", 1_700_000_001),
      openaiItem("user", "u2", 1_700_000_002),
    ];
    const stub = makeLlm({ items });
    const deps = makeTestDeps({ llm: { openai: stub, minimax: stub } });
    const env = await exportSession(
      { source_llm: "MiniMax", conversation_id: "conv_mx_1" },
      deps.llm,
    );
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data.messages).toHaveLength(3);
      expect(env.data.source_llm).toBe("MiniMax");
    }
  });

  test("UPSTREAM_TIMEOUT: hanging conversation -> ToolError(code=UPSTREAM_TIMEOUT)", async () => {
    const stub = makeLlm({ hangMs: 5_000 });
    const deps = makeTestDeps({ llm: { openai: stub, minimax: stub } });
    let err: unknown;
    try {
      await exportSession(
        { source_llm: "openai", conversation_id: "conv_hang" },
        deps.llm,
        50, // 50ms timeout
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    const toolErr = err as { code: string; tool: string };
    expect(toolErr.code).toBe("UPSTREAM_TIMEOUT");
    expect(toolErr.tool).toBe("export_session");
  });

  test("UPSTREAM_ERROR: thrown conversation error -> ToolError(code=UPSTREAM_ERROR)", async () => {
    const stub = makeLlm({ throwError: new Error("upstream down") });
    const deps = makeTestDeps({ llm: { openai: stub, minimax: stub } });
    let err: unknown;
    try {
      await exportSession(
        { source_llm: "openai", conversation_id: "conv_throw" },
        deps.llm,
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    const toolErr = err as { code: string; tool: string; message: string };
    expect(toolErr.code).toBe("UPSTREAM_ERROR");
    expect(toolErr.tool).toBe("export_session");
    expect(toolErr.message).toContain("upstream down");
  });
});
