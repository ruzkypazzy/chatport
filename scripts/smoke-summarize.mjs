// One-off smoke test for AC-6: summarize_progress.
//
// Stubs the LLM client to capture the chat.completions.create call args and
// return canned responses, calls the real handler against an in-memory DB,
// and asserts:
//   - default compressor=MINIMAX_MODEL routes to llm.minimax with the
//     right model name
//   - call payload has temperature=0.2, response_format={type:"json_object"},
//     a system prompt, and a user payload containing target_tokens + messages
//   - handler returns { session_id, summary, target_tokens, compressor }
//     with summary parsed from the LLM's JSON response
//   - compressor=openai routes to llm.openai with models.openai
//   - NOT_FOUND on missing session id
//   - EXTRACTION_FAILED on non-JSON or non-conforming response
//   - UPSTREAM_TIMEOUT fires within the configured ms
import { importSession } from "../dist/tools/import_session.js";
import { summarizeProgress } from "../dist/tools/summarize_progress.js";
import { openDatabase } from "../dist/db/sqlite.js";

const MODELS = { openai: "gpt-4o-mini", minimax: "MiniMax-M3" };

function makeStubClient({ reply, hangMs = 0, throwError = null }) {
  const callLog = [];
  const buildHandler = () => async (params) => {
    callLog.push(params);
    if (throwError) throw throwError;
    if (hangMs > 0) await new Promise((r) => setTimeout(r, hangMs));
    return reply;
  };
  return {
    callLog,
    client: {
      conversations: {
        retrieve: async () => ({}),
        items: { async *list() {} },
      },
      chat: { completions: { create: buildHandler() } },
    },
  };
}

async function main() {
  const db = openDatabase(":memory:");

  // Seed a session so the handler has something to load.
  const seedBlob = {
    session_id: "conv_sum_1",
    source_llm: "openai",
    messages: [
      { role: "user", content: "let's add caching", created_at: 1_700_000_000 },
      {
        role: "assistant",
        content: "ok using redis with a 60s TTL",
        created_at: 1_700_000_001,
      },
      { role: "user", content: "ship it", created_at: 1_700_000_002 },
    ],
    metadata: { tag: "summarize-smoke" },
  };
  const seeded = await importSession(
    { blob: seedBlob, external_session_id: "sum-ext-1" },
    db,
  );
  if (seeded.ok !== true) throw new Error(`seed failed: ${JSON.stringify(seeded)}`);

  // Case 1: default compressor (MiniMax-M3) routes to llm.minimax and the
  // right model name, with the right request shape.
  {
    const stub = makeStubClient({
      reply: {
        id: "cmpl_test_1",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                summary: "Added Redis caching with 60s TTL; user signed off.",
              }),
            },
            finish_reason: "stop",
          },
        ],
      },
    });
    const env = await summarizeProgress(
      { session_id: seeded.data.id, target_tokens: 4000, compressor: "MiniMax-M3" },
      { openai: stub.client, minimax: stub.client },
      db,
      MODELS,
    );
    if (env.ok !== true) throw new Error(`case1: not ok: ${JSON.stringify(env)}`);
    if (env.data.session_id !== seeded.data.id) {
      throw new Error(`case1: session_id=${env.data.session_id} (want ${seeded.data.id})`);
    }
    if (env.data.summary !== "Added Redis caching with 60s TTL; user signed off.") {
      throw new Error(`case1: summary mismatch: ${env.data.summary}`);
    }
    if (env.data.target_tokens !== 4000) {
      throw new Error(`case1: target_tokens=${env.data.target_tokens} (want 4000)`);
    }
    if (env.data.compressor !== "MiniMax-M3") {
      throw new Error(`case1: compressor=${env.data.compressor} (want MiniMax-M3)`);
    }
    // Assert the captured call args.
    if (stub.callLog.length !== 1) {
      throw new Error(`case1: expected 1 chat.completions call, got ${stub.callLog.length}`);
    }
    const call = stub.callLog[0];
    if (call.model !== "MiniMax-M3") {
      throw new Error(`case1: model=${call.model} (want MiniMax-M3)`);
    }
    if (call.temperature !== 0.2) {
      throw new Error(`case1: temperature=${call.temperature} (want 0.2)`);
    }
    if (call.response_format?.type !== "json_object") {
      throw new Error(`case1: response_format=${JSON.stringify(call.response_format)} (want json_object)`);
    }
    if (!Array.isArray(call.messages) || call.messages.length !== 2) {
      throw new Error(`case1: messages shape wrong: ${JSON.stringify(call.messages)}`);
    }
    if (call.messages[0].role !== "system" || typeof call.messages[0].content !== "string") {
      throw new Error(`case1: system message wrong: ${JSON.stringify(call.messages[0])}`);
    }
    if (call.messages[1].role !== "user" || typeof call.messages[1].content !== "string") {
      throw new Error(`case1: user message wrong: ${JSON.stringify(call.messages[1])}`);
    }
    // The user payload should JSON-parse to { target_tokens, messages, metadata }.
    let payload;
    try {
      payload = JSON.parse(call.messages[1].content);
    } catch (err) {
      throw new Error(`case1: user content not JSON: ${err.message}`);
    }
    if (payload.target_tokens !== 4000) {
      throw new Error(`case1: payload.target_tokens=${payload.target_tokens} (want 4000)`);
    }
    if (!Array.isArray(payload.messages) || payload.messages.length !== 3) {
      throw new Error(`case1: payload.messages=${JSON.stringify(payload.messages)} (want length 3)`);
    }
    if (payload.metadata?.tag !== "summarize-smoke") {
      throw new Error(`case1: payload.metadata.tag=${payload.metadata?.tag} (want summarize-smoke)`);
    }
    console.log(
      `case1: default MiniMax -> model=${call.model} temp=${call.temperature} response_format=${call.response_format.type} payload.messages=${payload.messages.length} -> summary="${env.data.summary.slice(0, 30)}..."`,
    );
  }

  // Case 2: compressor=openai routes to llm.openai with models.openai.
  {
    const openaiStub = makeStubClient({
      reply: {
        choices: [
          {
            message: {
              role: "assistant",
              content: JSON.stringify({ summary: "openai path" }),
            },
          },
        ],
      },
    });
    const minimaxStub = makeStubClient({
      reply: { choices: [{ message: { role: "assistant", content: "{}" } }] },
    });
    const env = await summarizeProgress(
      { session_id: seeded.data.id, target_tokens: 2000, compressor: "openai" },
      { openai: openaiStub.client, minimax: minimaxStub.client },
      db,
      MODELS,
    );
    if (env.ok !== true) throw new Error(`case2: not ok: ${JSON.stringify(env)}`);
    if (env.data.compressor !== "openai") {
      throw new Error(`case2: compressor=${env.data.compressor} (want openai)`);
    }
    if (env.data.target_tokens !== 2000) {
      throw new Error(`case2: target_tokens=${env.data.target_tokens} (want 2000)`);
    }
    if (openaiStub.callLog.length !== 1) {
      throw new Error(`case2: openai stub not called: ${openaiStub.callLog.length}`);
    }
    if (minimaxStub.callLog.length !== 0) {
      throw new Error(`case2: minimax stub called when it shouldn't be: ${minimaxStub.callLog.length}`);
    }
    if (openaiStub.callLog[0].model !== "gpt-4o-mini") {
      throw new Error(`case2: openai model=${openaiStub.callLog[0].model} (want gpt-4o-mini)`);
    }
    console.log(
      `case2: compressor=openai -> model=${openaiStub.callLog[0].model} target_tokens=${env.data.target_tokens} summary="${env.data.summary}"`,
    );
  }

  // Case 3: NOT_FOUND on missing session id.
  {
    const stub = makeStubClient({
      reply: { choices: [{ message: { content: "{}" } }] },
    });
    try {
      await summarizeProgress(
        { session_id: 9999, target_tokens: 4000, compressor: "MiniMax-M3" },
        { openai: stub.client, minimax: stub.client },
        db,
        MODELS,
      );
      throw new Error("case3: expected NOT_FOUND, got success");
    } catch (err) {
      if (err?.code !== "NOT_FOUND") {
        throw new Error(`case3: expected NOT_FOUND, got ${err?.code}: ${err?.message}`);
      }
      if (err?.tool !== "summarize_progress") {
        throw new Error(`case3: tool=${err?.tool} (want summarize_progress)`);
      }
      if (stub.callLog.length !== 0) {
        throw new Error(`case3: stub called even though session is missing: ${stub.callLog.length}`);
      }
      console.log(`case3: missing session -> NOT_FOUND (${err.message}), LLM not called`);
    }
  }

  // Case 4: EXTRACTION_FAILED when LLM returns non-JSON content.
  {
    const stub = makeStubClient({
      reply: { choices: [{ message: { role: "assistant", content: "not json" } }] },
    });
    try {
      await summarizeProgress(
        { session_id: seeded.data.id, target_tokens: 4000, compressor: "MiniMax-M3" },
        { openai: stub.client, minimax: stub.client },
        db,
        MODELS,
      );
      throw new Error("case4: expected EXTRACTION_FAILED, got success");
    } catch (err) {
      if (err?.code !== "EXTRACTION_FAILED") {
        throw new Error(`case4: expected EXTRACTION_FAILED, got ${err?.code}: ${err?.message}`);
      }
      console.log(`case4: non-JSON response -> EXTRACTION_FAILED (${err.message})`);
    }
  }

  // Case 5: EXTRACTION_FAILED when JSON has no string `summary` field.
  {
    const stub = makeStubClient({
      reply: {
        choices: [
          {
            message: {
              role: "assistant",
              content: JSON.stringify({ foo: "bar", items: [1, 2, 3] }),
            },
          },
        ],
      },
    });
    try {
      await summarizeProgress(
        { session_id: seeded.data.id, target_tokens: 4000 },
        { openai: stub.client, minimax: stub.client },
        db,
        MODELS,
      );
      throw new Error("case5: expected EXTRACTION_FAILED, got success");
    } catch (err) {
      if (err?.code !== "EXTRACTION_FAILED") {
        throw new Error(`case5: expected EXTRACTION_FAILED, got ${err?.code}: ${err?.message}`);
      }
      console.log(`case5: JSON without summary field -> EXTRACTION_FAILED (${err.message})`);
    }
  }

  // Case 6: UPSTREAM_TIMEOUT fires when the LLM hangs past the configured ms.
  // Use a tiny test-time timeout by passing a 50ms override to the handler.
  {
    const stub = makeStubClient({ reply: {}, hangMs: 5000 });
    try {
      await summarizeProgress(
        { session_id: seeded.data.id, target_tokens: 4000, compressor: "MiniMax-M3" },
        { openai: stub.client, minimax: stub.client },
        db,
        MODELS,
        50, // 50 ms test-time timeout
      );
      throw new Error("case6: expected UPSTREAM_TIMEOUT, got success");
    } catch (err) {
      if (err?.code !== "UPSTREAM_TIMEOUT") {
        throw new Error(`case6: expected UPSTREAM_TIMEOUT, got ${err?.code}: ${err?.message}`);
      }
      console.log(`case6: hanging LLM -> UPSTREAM_TIMEOUT (${err.message})`);
    }
  }

  // Case 7: UPSTREAM_ERROR when the LLM throws.
  {
    const stub = makeStubClient({
      reply: {},
      throwError: new Error("upstream boom"),
    });
    try {
      await summarizeProgress(
        { session_id: seeded.data.id, target_tokens: 4000, compressor: "MiniMax-M3" },
        { openai: stub.client, minimax: stub.client },
        db,
        MODELS,
      );
      throw new Error("case7: expected UPSTREAM_ERROR, got success");
    } catch (err) {
      if (err?.code !== "UPSTREAM_ERROR") {
        throw new Error(`case7: expected UPSTREAM_ERROR, got ${err?.code}: ${err?.message}`);
      }
      if (err?.message !== "upstream boom") {
        throw new Error(`case7: message=${err?.message} (want "upstream boom")`);
      }
      console.log(`case7: throwing LLM -> UPSTREAM_ERROR (${err.message})`);
    }
  }

  // Case 8: explicit target_tokens override (not just the default 4000) is
  // echoed in both the response and the user payload.
  {
    const stub = makeStubClient({
      reply: { choices: [{ message: { content: JSON.stringify({ summary: "short" }) } }] },
    });
    const env = await summarizeProgress(
      { session_id: seeded.data.id, target_tokens: 512, compressor: "MiniMax-M3" },
      { openai: stub.client, minimax: stub.client },
      db,
      MODELS,
    );
    if (env.ok !== true) throw new Error(`case8: not ok: ${JSON.stringify(env)}`);
    if (env.data.target_tokens !== 512) {
      throw new Error(`case8: target_tokens=${env.data.target_tokens} (want 512)`);
    }
    const userPayload = JSON.parse(stub.callLog[0].messages[1].content);
    if (userPayload.target_tokens !== 512) {
      throw new Error(`case8: payload.target_tokens=${userPayload.target_tokens} (want 512)`);
    }
    console.log(
      `case8: target_tokens=512 -> response target_tokens=${env.data.target_tokens} payload target_tokens=${userPayload.target_tokens}`,
    );
  }

  db.close();
  console.log("OK");
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
