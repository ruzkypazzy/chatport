// One-off smoke test for AC-7: extract_open_questions and extract_decisions.
//
// Stubs the LLM client to capture the chat.completions.create call args and
// return canned responses, calls the real handlers against an in-memory DB,
// and asserts:
//   - extract_open_questions: returns { items: [{ question, context }] }
//     parsed from the LLM's JSON response; routes to llm.minimax with
//     models.minimax, payload includes the full message list + metadata,
//     system prompt instructs the spec'd JSON shape.
//   - extract_decisions: same flow, returns
//     { items: [{ decision, rationale, decided_at }] }.
//   - NOT_FOUND on missing session id for both tools.
//   - EXTRACTION_FAILED on non-JSON or non-conforming response for both.
//   - UPSTREAM_TIMEOUT via test-time override for both.
//   - UPSTREAM_ERROR on thrown LLM errors for both.
//   - Empty items array is accepted (LLM returns "no items").
import { importSession } from "../dist/tools/import_session.js";
import { extractOpenQuestions } from "../dist/tools/extract_open_questions.js";
import { extractDecisions } from "../dist/tools/extract_decisions.js";
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

function chatReply(content) {
  return {
    id: "cmpl_test",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
  };
}

async function seed(db) {
  const blob = {
    session_id: "conv_extract_1",
    source_llm: "openai",
    messages: [
      { role: "user", content: "should we use redis or memcached?", created_at: 1_700_000_000 },
      { role: "assistant", content: "let's go with redis for now", created_at: 1_700_000_001 },
      { role: "user", content: "ok ship it", created_at: 1_700_000_002 },
      { role: "user", content: "what about sharding?", created_at: 1_700_000_003 },
      { role: "assistant", content: "we'll revisit that next sprint", created_at: 1_700_000_004 },
    ],
    metadata: { tag: "extract-smoke" },
  };
  const env = await importSession({ blob, external_session_id: "ext-extract-1" }, db);
  if (env.ok !== true) throw new Error(`seed failed: ${JSON.stringify(env)}`);
  return env.data.id;
}

function assertMinimaxCall(stub, call, expectedSystemContains) {
  if (stub.callLog.length !== 1) {
    throw new Error(`expected 1 chat.completions call, got ${stub.callLog.length}`);
  }
  const c = stub.callLog[0];
  if (c.model !== "MiniMax-M3") throw new Error(`model=${c.model} (want MiniMax-M3)`);
  if (c.temperature !== 0.2) throw new Error(`temperature=${c.temperature} (want 0.2)`);
  if (c.response_format?.type !== "json_object") {
    throw new Error(`response_format=${JSON.stringify(c.response_format)} (want json_object)`);
  }
  if (!Array.isArray(c.messages) || c.messages.length !== 2) {
    throw new Error(`messages shape wrong: ${JSON.stringify(c.messages)}`);
  }
  if (c.messages[0].role !== "system") throw new Error(`first msg role=${c.messages[0].role}`);
  if (!c.messages[0].content.includes(expectedSystemContains)) {
    throw new Error(`system prompt missing "${expectedSystemContains}": ${c.messages[0].content.slice(0, 80)}...`);
  }
  if (c.messages[1].role !== "user") throw new Error(`second msg role=${c.messages[1].role}`);
  let payload;
  try {
    payload = JSON.parse(c.messages[1].content);
  } catch (err) {
    throw new Error(`user payload not JSON: ${err.message}`);
  }
  if (!Array.isArray(payload.messages) || payload.messages.length !== 5) {
    throw new Error(`payload.messages=${JSON.stringify(payload.messages)} (want length 5)`);
  }
  if (payload.metadata?.tag !== "extract-smoke") {
    throw new Error(`payload.metadata.tag=${payload.metadata?.tag} (want extract-smoke)`);
  }
}

async function main() {
  const db = openDatabase(":memory:");
  const seededId = await seed(db);

  // ---- extract_open_questions ----

  // Case 1: happy path — LLM returns valid items array.
  {
    const stub = makeStubClient({
      reply: chatReply(
        JSON.stringify({
          items: [
            { question: "How will we shard redis?", context: "raised in the last user message" },
            { question: "When to revisit the cache TTL?", context: "implied by the assistant's reply" },
          ],
        }),
      ),
    });
    const env = await extractOpenQuestions(
      { session_id: seededId },
      { llm: { openai: stub.client, minimax: stub.client }, db, models: MODELS },
    );
    if (env.ok !== true) throw new Error(`case1: not ok: ${JSON.stringify(env)}`);
    if (!Array.isArray(env.data.items) || env.data.items.length !== 2) {
      throw new Error(`case1: items=${JSON.stringify(env.data.items)} (want length 2)`);
    }
    if (env.data.items[0].question !== "How will we shard redis?") {
      throw new Error(`case1: items[0].question=${env.data.items[0].question}`);
    }
    if (typeof env.data.items[0].context !== "string" || env.data.items[0].context.length === 0) {
      throw new Error(`case1: items[0].context empty`);
    }
    assertMinimaxCall(stub, stub.callLog[0], '"items": [{ "question"');
    console.log(
      `case1: extract_open_questions happy path -> items=${env.data.items.length} model=${stub.callLog[0].model} payload.messages=${JSON.parse(stub.callLog[0].messages[1].content).messages.length}`,
    );
  }

  // Case 2: empty items array.
  {
    const stub = makeStubClient({ reply: chatReply(JSON.stringify({ items: [] })) });
    const env = await extractOpenQuestions(
      { session_id: seededId },
      { llm: { openai: stub.client, minimax: stub.client }, db, models: MODELS },
    );
    if (env.ok !== true) throw new Error(`case2: not ok: ${JSON.stringify(env)}`);
    if (!Array.isArray(env.data.items) || env.data.items.length !== 0) {
      throw new Error(`case2: items=${JSON.stringify(env.data.items)} (want [])`);
    }
    console.log(`case2: empty items array -> items=[]`);
  }

  // Case 3: NOT_FOUND on missing session id.
  {
    const stub = makeStubClient({ reply: chatReply(JSON.stringify({ items: [] })) });
    try {
      await extractOpenQuestions(
        { session_id: 9999 },
        { llm: { openai: stub.client, minimax: stub.client }, db, models: MODELS },
      );
      throw new Error("case3: expected NOT_FOUND, got success");
    } catch (err) {
      if (err?.code !== "NOT_FOUND") {
        throw new Error(`case3: expected NOT_FOUND, got ${err?.code}: ${err?.message}`);
      }
      if (err?.tool !== "extract_open_questions") {
        throw new Error(`case3: tool=${err?.tool} (want extract_open_questions)`);
      }
      if (stub.callLog.length !== 0) {
        throw new Error(`case3: stub called even though session missing: ${stub.callLog.length}`);
      }
      console.log(`case3: missing session -> NOT_FOUND (${err.message}), LLM not called`);
    }
  }

  // Case 4: EXTRACTION_FAILED on non-JSON response.
  {
    const stub = makeStubClient({ reply: chatReply("not json") });
    try {
      await extractOpenQuestions(
        { session_id: seededId },
        { llm: { openai: stub.client, minimax: stub.client }, db, models: MODELS },
      );
      throw new Error("case4: expected EXTRACTION_FAILED, got success");
    } catch (err) {
      if (err?.code !== "EXTRACTION_FAILED") {
        throw new Error(`case4: expected EXTRACTION_FAILED, got ${err?.code}: ${err?.message}`);
      }
      console.log(`case4: non-JSON -> EXTRACTION_FAILED (${err.message})`);
    }
  }

  // Case 5: EXTRACTION_FAILED on JSON without items array.
  {
    const stub = makeStubClient({ reply: chatReply(JSON.stringify({ result: "oops" })) });
    try {
      await extractOpenQuestions(
        { session_id: seededId },
        { llm: { openai: stub.client, minimax: stub.client }, db, models: MODELS },
      );
      throw new Error("case5: expected EXTRACTION_FAILED, got success");
    } catch (err) {
      if (err?.code !== "EXTRACTION_FAILED") {
        throw new Error(`case5: expected EXTRACTION_FAILED, got ${err?.code}: ${err?.message}`);
      }
      console.log(`case5: JSON without items -> EXTRACTION_FAILED (${err.message})`);
    }
  }

  // Case 6: EXTRACTION_FAILED when an item is missing the `question` field.
  {
    const stub = makeStubClient({
      reply: chatReply(
        JSON.stringify({
          items: [
            { question: "ok", context: "fine" },
            { context: "no question field" },
          ],
        }),
      ),
    });
    try {
      await extractOpenQuestions(
        { session_id: seededId },
        { llm: { openai: stub.client, minimax: stub.client }, db, models: MODELS },
      );
      throw new Error("case6: expected EXTRACTION_FAILED, got success");
    } catch (err) {
      if (err?.code !== "EXTRACTION_FAILED") {
        throw new Error(`case6: expected EXTRACTION_FAILED, got ${err?.code}: ${err?.message}`);
      }
      if (!err?.message?.includes("item[1]")) {
        throw new Error(`case6: message should mention item[1]: ${err?.message}`);
      }
      console.log(`case6: item[1] missing question -> EXTRACTION_FAILED (${err.message})`);
    }
  }

  // Case 7: UPSTREAM_TIMEOUT via test-time override.
  {
    const stub = makeStubClient({ reply: {}, hangMs: 5000 });
    try {
      await extractOpenQuestions(
        { session_id: seededId },
        { llm: { openai: stub.client, minimax: stub.client }, db, models: MODELS },
        50,
      );
      throw new Error("case7: expected UPSTREAM_TIMEOUT, got success");
    } catch (err) {
      if (err?.code !== "UPSTREAM_TIMEOUT") {
        throw new Error(`case7: expected UPSTREAM_TIMEOUT, got ${err?.code}: ${err?.message}`);
      }
      console.log(`case7: hanging LLM -> UPSTREAM_TIMEOUT (${err.message})`);
    }
  }

  // Case 8: UPSTREAM_ERROR on thrown LLM error.
  {
    const stub = makeStubClient({ reply: {}, throwError: new Error("upstream boom") });
    try {
      await extractOpenQuestions(
        { session_id: seededId },
        { llm: { openai: stub.client, minimax: stub.client }, db, models: MODELS },
      );
      throw new Error("case8: expected UPSTREAM_ERROR, got success");
    } catch (err) {
      if (err?.code !== "UPSTREAM_ERROR") {
        throw new Error(`case8: expected UPSTREAM_ERROR, got ${err?.code}: ${err?.message}`);
      }
      console.log(`case8: throwing LLM -> UPSTREAM_ERROR (${err.message})`);
    }
  }

  // ---- extract_decisions ----

  // Case 9: happy path — LLM returns valid items array with decision/rationale/decided_at.
  {
    const stub = makeStubClient({
      reply: chatReply(
        JSON.stringify({
          items: [
            {
              decision: "Use redis for caching",
              rationale: "user asked, assistant agreed, ready to ship",
              decided_at: "2023-11-14T22:13:21Z",
            },
          ],
        }),
      ),
    });
    const env = await extractDecisions(
      { session_id: seededId },
      { llm: { openai: stub.client, minimax: stub.client }, db, models: MODELS },
    );
    if (env.ok !== true) throw new Error(`case9: not ok: ${JSON.stringify(env)}`);
    if (!Array.isArray(env.data.items) || env.data.items.length !== 1) {
      throw new Error(`case9: items=${JSON.stringify(env.data.items)} (want length 1)`);
    }
    const d = env.data.items[0];
    if (d.decision !== "Use redis for caching") {
      throw new Error(`case9: decision=${d.decision}`);
    }
    if (d.rationale !== "user asked, assistant agreed, ready to ship") {
      throw new Error(`case9: rationale=${d.rationale}`);
    }
    if (d.decided_at !== "2023-11-14T22:13:21Z") {
      throw new Error(`case9: decided_at=${d.decided_at}`);
    }
    assertMinimaxCall(stub, stub.callLog[0], '"items": [{ "decision"');
    console.log(
      `case9: extract_decisions happy path -> items=${env.data.items.length} decision="${d.decision}" decided_at=${d.decided_at}`,
    );
  }

  // Case 10: empty items array.
  {
    const stub = makeStubClient({ reply: chatReply(JSON.stringify({ items: [] })) });
    const env = await extractDecisions(
      { session_id: seededId },
      { llm: { openai: stub.client, minimax: stub.client }, db, models: MODELS },
    );
    if (env.ok !== true) throw new Error(`case10: not ok: ${JSON.stringify(env)}`);
    if (env.data.items.length !== 0) {
      throw new Error(`case10: items=${env.data.items.length} (want 0)`);
    }
    console.log(`case10: empty items array -> items=[]`);
  }

  // Case 11: NOT_FOUND on missing session.
  {
    const stub = makeStubClient({ reply: chatReply(JSON.stringify({ items: [] })) });
    try {
      await extractDecisions(
        { session_id: 9999 },
        { llm: { openai: stub.client, minimax: stub.client }, db, models: MODELS },
      );
      throw new Error("case11: expected NOT_FOUND, got success");
    } catch (err) {
      if (err?.code !== "NOT_FOUND") {
        throw new Error(`case11: expected NOT_FOUND, got ${err?.code}: ${err?.message}`);
      }
      if (err?.tool !== "extract_decisions") {
        throw new Error(`case11: tool=${err?.tool} (want extract_decisions)`);
      }
      console.log(`case11: missing session -> NOT_FOUND (${err.message})`);
    }
  }

  // Case 12: EXTRACTION_FAILED when an item is missing `decided_at`.
  {
    const stub = makeStubClient({
      reply: chatReply(
        JSON.stringify({
          items: [
            { decision: "ok", rationale: "fine" }, // no decided_at
          ],
        }),
      ),
    });
    try {
      await extractDecisions(
        { session_id: seededId },
        { llm: { openai: stub.client, minimax: stub.client }, db, models: MODELS },
      );
      throw new Error("case12: expected EXTRACTION_FAILED, got success");
    } catch (err) {
      if (err?.code !== "EXTRACTION_FAILED") {
        throw new Error(`case12: expected EXTRACTION_FAILED, got ${err?.code}: ${err?.message}`);
      }
      console.log(`case12: item missing decided_at -> EXTRACTION_FAILED (${err.message})`);
    }
  }

  // Case 13: EXTRACTION_FAILED when LLM returns non-JSON.
  {
    const stub = makeStubClient({ reply: chatReply("not json") });
    try {
      await extractDecisions(
        { session_id: seededId },
        { llm: { openai: stub.client, minimax: stub.client }, db, models: MODELS },
      );
      throw new Error("case13: expected EXTRACTION_FAILED, got success");
    } catch (err) {
      if (err?.code !== "EXTRACTION_FAILED") {
        throw new Error(`case13: expected EXTRACTION_FAILED, got ${err?.code}: ${err?.message}`);
      }
      console.log(`case13: non-JSON -> EXTRACTION_FAILED (${err.message})`);
    }
  }

  // Case 14: UPSTREAM_TIMEOUT via test-time override.
  {
    const stub = makeStubClient({ reply: {}, hangMs: 5000 });
    try {
      await extractDecisions(
        { session_id: seededId },
        { llm: { openai: stub.client, minimax: stub.client }, db, models: MODELS },
        50,
      );
      throw new Error("case14: expected UPSTREAM_TIMEOUT, got success");
    } catch (err) {
      if (err?.code !== "UPSTREAM_TIMEOUT") {
        throw new Error(`case14: expected UPSTREAM_TIMEOUT, got ${err?.code}: ${err?.message}`);
      }
      console.log(`case14: hanging LLM -> UPSTREAM_TIMEOUT (${err.message})`);
    }
  }

  // Case 15: UPSTREAM_ERROR on thrown LLM error.
  {
    const stub = makeStubClient({ reply: {}, throwError: new Error("upstream boom") });
    try {
      await extractDecisions(
        { session_id: seededId },
        { llm: { openai: stub.client, minimax: stub.client }, db, models: MODELS },
      );
      throw new Error("case15: expected UPSTREAM_ERROR, got success");
    } catch (err) {
      if (err?.code !== "UPSTREAM_ERROR") {
        throw new Error(`case15: expected UPSTREAM_ERROR, got ${err?.code}: ${err?.message}`);
      }
      console.log(`case15: throwing LLM -> UPSTREAM_ERROR (${err.message})`);
    }
  }

  db.close();
  console.log("OK");
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
