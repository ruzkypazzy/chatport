// One-off smoke test for export_session: stub the LLM client, call the handler,
// assert the envelope shape and the 25-message count.
import { exportSession } from "../dist/tools/export_session.js";

function makeStubClients({ messageCount }) {
  const messages = [];
  for (let i = 0; i < messageCount; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    messages.push({
      id: `msg_${i}`,
      type: "message",
      role,
      content: [{ type: "text", text: `hello ${i}` }],
      status: "completed",
      created_at: 1_700_000_000 + i,
    });
  }
  return {
    openai: {
      conversations: {
        retrieve: async (id) => ({
          id,
          created_at: 1_700_000_000,
          metadata: { source: "smoke" },
          object: "conversation",
        }),
        items: {
          async *list(_id) {
            yield { data: messages, has_more: false };
          },
        },
      },
      chat: { completions: { create: async () => ({}) } },
    },
    minimax: {
      conversations: {
        retrieve: async (id) => ({
          id,
          created_at: 1_700_000_000,
          metadata: { source: "smoke" },
          object: "conversation",
        }),
        items: {
          async *list(_id) {
            yield { data: messages, has_more: false };
          },
        },
      },
      chat: { completions: { create: async () => ({}) } },
    },
  };
}

async function main() {
  const cases = [
    { source_llm: "openai", count: 25, label: "openai 25 msgs" },
    { source_llm: "MiniMax", count: 3, label: "MiniMax 3 msgs" },
  ];
  for (const c of cases) {
    const llm = makeStubClients({ messageCount: c.count });
    const env = await exportSession(
      { source_llm: c.source_llm, conversation_id: "conv_123" },
      llm,
    );
    if (env.ok !== true) {
      throw new Error(`${c.label}: envelope not ok: ${JSON.stringify(env)}`);
    }
    if (env.data.messages.length !== c.count) {
      throw new Error(
        `${c.label}: expected ${c.count} messages, got ${env.data.messages.length}`,
      );
    }
    if (env.data.source_llm !== c.source_llm) {
      throw new Error(
        `${c.label}: source_llm mismatch: ${env.data.source_llm} vs ${c.source_llm}`,
      );
    }
    if (env.data.session_id !== "conv_123") {
      throw new Error(`${c.label}: session_id mismatch: ${env.data.session_id}`);
    }
    if (env.data.messages[0].role !== "user" || env.data.messages[0].content !== "hello 0") {
      throw new Error(`${c.label}: first message shape wrong: ${JSON.stringify(env.data.messages[0])}`);
    }
    if (env.data.messages[0].created_at !== 1_700_000_000) {
      throw new Error(`${c.label}: created_at wrong: ${env.data.messages[0].created_at}`);
    }
    if (env.data.metadata.upstream_id !== "conv_123") {
      throw new Error(`${c.label}: metadata.upstream_id wrong: ${env.data.metadata.upstream_id}`);
    }
    console.log(
      `${c.label}: ok, ${env.data.messages.length} messages, first role=${env.data.messages[0].role}`,
    );
  }

  // Negative: unknown source_llm is rejected by the Zod schema (not this code).
  // But the tool also defends: let's verify the upstream-error path. We pass
  // a stub that throws on retrieve and expect a UPSTREAM_ERROR envelope.
  const failing = {
    openai: {
      conversations: {
        retrieve: async () => {
          throw new Error("upstream boom");
        },
        items: { async *list() {} },
      },
      chat: { completions: { create: async () => ({}) } },
    },
    minimax: {
      conversations: {
        retrieve: async () => {
          throw new Error("upstream boom");
        },
        items: { async *list() {} },
      },
      chat: { completions: { create: async () => ({}) } },
    },
  };
  try {
    await exportSession(
      { source_llm: "openai", conversation_id: "conv_fail" },
      failing,
    );
    throw new Error("expected upstream error");
  } catch (err) {
    if (err.code !== "UPSTREAM_ERROR") {
      throw new Error(`expected UPSTREAM_ERROR, got ${err.code}: ${err.message}`);
    }
    console.log("upstream error path: ok, code = UPSTREAM_ERROR");
  }

  // UPSTREAM_TIMEOUT path: stub hangs forever; withTimeout fires.
  const hanging = {
    openai: {
      conversations: {
        retrieve: () => new Promise(() => {}),
        items: { async *list() {} },
      },
      chat: { completions: { create: async () => ({}) } },
    },
    minimax: {
      conversations: {
        retrieve: () => new Promise(() => {}),
        items: { async *list() {} },
      },
      chat: { completions: { create: async () => ({}) } },
    },
  };
  // Bypass the default 30s by using a tiny ms. We can't override ms without
  // changing the API, so we just verify the code path with a quick race:
  // cancel after 50ms and expect the handler to throw with UPSTREAM_TIMEOUT.
  const start = Date.now();
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("test timed out")), 5000),
  );
  const handlerPromise = exportSession(
    { source_llm: "openai", conversation_id: "conv_hang" },
    hanging,
    50, // 50ms timeout for the test
  ).catch((err) => err);
  const winner = await Promise.race([handlerPromise, timeoutPromise]).catch((e) => e);
  if (winner instanceof Error && winner.message === "test timed out") {
    throw new Error("handler did not reject in time");
  }
  if (winner.code !== "UPSTREAM_TIMEOUT") {
    throw new Error(
      `expected UPSTREAM_TIMEOUT, got ${winner.code || "(no code)"}: ${winner.message}`,
    );
  }
  console.log(`UPSTREAM_TIMEOUT path: ok (fired in ${Date.now() - start}ms)`);

  console.log("OK");
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
