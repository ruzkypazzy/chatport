// One-off smoke test for AC-11: merge_sessions (concat / interleave / summarize).
//
// Sets up an in-memory DB, imports 2-3 parent sessions, stubs the LLM
// client (only the MiniMax client's chat.completions.create is exercised
// by merge_sessions, and only on the summarize strategy), and calls the
// real mergeSessions handler. Asserts:
//   1. concat (2 sessions): messages are appended in input order, new
//      row's source_llm = first session's, metadata carries
//      merged_from_session_ids + merge_strategy, parent_session_id = null.
//   2. concat (3 sessions): messages appended in input order, total
//      length = sum of inputs.
//   3. interleave (2 sessions, distinct timestamps): merged order is
//      chronological across the two sessions.
//   4. interleave (2 sessions, ties on created_at): ties broken by
//      source session index in input order (deterministic).
//   5. summarize (2 sessions, default target_llm=openai): MiniMax is
//      called once, the response's summary is the new blob's single
//      assistant message, source_llm is `openai` (the target), metadata
//      carries the input ids + strategy, chat.completions payload
//      references all input ids.
//   6. summarize with target_llm=MiniMax routes source_llm to "MiniMax".
//   7. NOT_FOUND on any missing session_id (no LLM call happens for
//      concat/interleave; for summarize the LLM is also not called
//      because we fail fast at the parent-load step).
//   8. UPSTREAM_TIMEOUT on summarize (test-time timeoutMs override).
//   9. UPSTREAM_ERROR on a thrown LLM error (summarize only).
//  10. EXTRACTION_FAILED on non-JSON / wrong-shape / empty-string
//      summary (summarize only).
//  11. concat with empty input session (0 messages) -> merged length
//      reflects the 0-message input.
import { importSession } from "../dist/tools/import_session.js";
import { mergeSessions } from "../dist/tools/merge_sessions.js";
import { openDatabase } from "../dist/db/sqlite.js";

const MODELS = { openai: "gpt-4o-mini", minimax: "MiniMax-M3" };

// Stub LLM client factory. The `reply` is returned on chat.completions.create
// (or throwError is thrown, or the call hangs for hangMs). Each invocation
// logs the params to chatLog so we can assert on the call shape.
function makeStub({ reply = null, throwError = null, hangMs = 0 }) {
  const chatLog = [];
  return {
    chatLog,
    client: {
      conversations: {
        retrieve: async () => ({}),
        items: { async *list() {} },
        create: async () => ({}),
      },
      chat: {
        completions: {
          create: async (params) => {
            chatLog.push(params);
            if (throwError) throw throwError;
            if (hangMs > 0) await new Promise((r) => setTimeout(r, hangMs));
            if (reply === null) {
              throw new Error("stub: no reply configured");
            }
            return reply;
          },
        },
      },
    },
  };
}

function summaryReply(summary) {
  return {
    id: "cmpl_merge_summary",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: JSON.stringify({ summary }),
        },
        finish_reason: "stop",
      },
    ],
  };
}

async function seed(db, tag, source_llm = "openai", messages) {
  const blob = {
    session_id: `conv_${tag}`,
    source_llm,
    messages,
    metadata: { tag },
  };
  const env = await importSession(
    { blob, external_session_id: `${tag}-ext` },
    db,
  );
  if (env.ok !== true) throw new Error(`seed ${tag}: ${JSON.stringify(env)}`);
  return env.data.id;
}

async function main() {
  const db = openDatabase(":memory:");

  // Case 1: concat with 2 sessions.
  {
    const idA = await seed(
      db,
      "case1_a",
      "openai",
      [
        { role: "user", content: "u1a", created_at: 1_700_000_000 },
        { role: "assistant", content: "a1a", created_at: 1_700_000_001 },
      ],
    );
    const idB = await seed(
      db,
      "case1_b",
      "openai",
      [
        { role: "user", content: "u1b", created_at: 1_700_000_002 },
        { role: "assistant", content: "a1b", created_at: 1_700_000_003 },
      ],
    );
    const stub = makeStub({ reply: summaryReply("never reached") });
    const env = await mergeSessions(
      { session_ids: [idA, idB], strategy: "concat", target_llm: "openai" },
      { openai: stub.client, minimax: stub.client },
      db,
      MODELS,
    );
    if (env.ok !== true) throw new Error(`case1: not ok: ${JSON.stringify(env)}`);
    if (env.data.strategy !== "concat") {
      throw new Error(`case1: strategy=${env.data.strategy} (want concat)`);
    }
    if (env.data.input_session_ids.join(",") !== `${idA},${idB}`) {
      throw new Error(
        `case1: input_session_ids=${env.data.input_session_ids} (want ${idA},${idB})`,
      );
    }
    if (env.data.message_count !== 4) {
      throw new Error(`case1: message_count=${env.data.message_count} (want 4)`);
    }
    if (stub.chatLog.length !== 0) {
      throw new Error(
        `case1: LLM should not be called for concat, got ${stub.chatLog.length} calls`,
      );
    }
    const newRow = db.getSession(env.data.session_id);
    if (newRow === null) throw new Error(`case1: new row missing`);
    if (newRow.parent_session_id !== null) {
      throw new Error(
        `case1: new row parent_session_id=${newRow.parent_session_id} (want null)`,
      );
    }
    const newBlob = JSON.parse(newRow.blob_json);
    if (newBlob.source_llm !== "openai") {
      throw new Error(`case1: source_llm=${newBlob.source_llm} (want openai)`);
    }
    if (!newBlob.session_id.startsWith("merge-")) {
      throw new Error(`case1: external session_id should start with merge-: ${newBlob.session_id}`);
    }
    const expected = ["u1a", "a1a", "u1b", "a1b"];
    for (let i = 0; i < expected.length; i++) {
      if (newBlob.messages[i]?.content !== expected[i]) {
        throw new Error(
          `case1: messages[${i}].content=${newBlob.messages[i]?.content} (want ${expected[i]})`,
        );
      }
    }
    if (newBlob.metadata.merge_strategy !== "concat") {
      throw new Error(
        `case1: metadata.merge_strategy=${newBlob.metadata.merge_strategy} (want concat)`,
      );
    }
    if (newBlob.metadata.merged_from_session_ids.join(",") !== `${idA},${idB}`) {
      throw new Error(
        `case1: metadata.merged_from_session_ids=${JSON.stringify(newBlob.metadata.merged_from_session_ids)}`,
      );
    }
    console.log(
      `case1: concat [${idA},${idB}] -> session_id=${env.data.session_id} (4 messages, source_llm=openai)`,
    );
  }

  // Case 2: concat with 3 sessions.
  {
    const idA = await seed(db, "case2_a", "openai", [
      { role: "user", content: "a", created_at: 100 },
    ]);
    const idB = await seed(db, "case2_b", "openai", [
      { role: "user", content: "b1", created_at: 200 },
      { role: "user", content: "b2", created_at: 201 },
    ]);
    const idC = await seed(db, "case2_c", "openai", [
      { role: "user", content: "c", created_at: 300 },
    ]);
    const stub = makeStub({ reply: summaryReply("never") });
    const env = await mergeSessions(
      { session_ids: [idA, idB, idC], strategy: "concat", target_llm: "openai" },
      { openai: stub.client, minimax: stub.client },
      db,
      MODELS,
    );
    if (env.ok !== true) throw new Error(`case2: ${JSON.stringify(env)}`);
    if (env.data.message_count !== 4) {
      throw new Error(`case2: message_count=${env.data.message_count} (want 4)`);
    }
    const newRow = db.getSession(env.data.session_id);
    const newBlob = JSON.parse(newRow.blob_json);
    const contents = newBlob.messages.map((m) => m.content);
    if (contents.join(",") !== "a,b1,b2,c") {
      throw new Error(`case2: concat order wrong: ${contents.join(",")}`);
    }
    console.log(
      `case2: concat 3 sessions [${idA},${idB},${idC}] -> ${newBlob.messages.length} messages in order [a,b1,b2,c]`,
    );
  }

  // Case 3: interleave with 2 sessions, distinct timestamps.
  {
    // session A: t=1,3,5 ; session B: t=2,4,6 -> merged: 1,2,3,4,5,6
    const idA = await seed(db, "case3_a", "openai", [
      { role: "user", content: "a1", created_at: 1 },
      { role: "user", content: "a3", created_at: 3 },
      { role: "user", content: "a5", created_at: 5 },
    ]);
    const idB = await seed(db, "case3_b", "openai", [
      { role: "user", content: "b2", created_at: 2 },
      { role: "user", content: "b4", created_at: 4 },
      { role: "user", content: "b6", created_at: 6 },
    ]);
    const stub = makeStub({ reply: summaryReply("never") });
    const env = await mergeSessions(
      { session_ids: [idA, idB], strategy: "interleave", target_llm: "openai" },
      { openai: stub.client, minimax: stub.client },
      db,
      MODELS,
    );
    if (env.ok !== true) throw new Error(`case3: ${JSON.stringify(env)}`);
    if (env.data.strategy !== "interleave") {
      throw new Error(`case3: strategy=${env.data.strategy} (want interleave)`);
    }
    if (env.data.message_count !== 6) {
      throw new Error(`case3: message_count=${env.data.message_count} (want 6)`);
    }
    const newBlob = JSON.parse(db.getSession(env.data.session_id).blob_json);
    const contents = newBlob.messages.map((m) => m.content);
    if (contents.join(",") !== "a1,b2,a3,b4,a5,b6") {
      throw new Error(`case3: interleave order wrong: ${contents.join(",")}`);
    }
    if (newBlob.metadata.merge_strategy !== "interleave") {
      throw new Error(`case3: metadata.merge_strategy=${newBlob.metadata.merge_strategy}`);
    }
    console.log(
      `case3: interleave [${idA},${idB}] -> [a1,b2,a3,b4,a5,b6] (chronological)`,
    );
  }

  // Case 4: interleave with 2 sessions, ties on created_at.
  // session A (idA=lower input index): t=5,5 ; session B: t=5
  // Tie-break: A's two messages come first (lower srcIdx), then B.
  {
    const idA = await seed(db, "case4_a", "openai", [
      { role: "user", content: "Aa1", created_at: 5 },
      { role: "user", content: "Aa2", created_at: 5 },
    ]);
    const idB = await seed(db, "case4_b", "openai", [
      { role: "user", content: "Bb", created_at: 5 },
    ]);
    const stub = makeStub({ reply: summaryReply("never") });
    const env = await mergeSessions(
      { session_ids: [idA, idB], strategy: "interleave", target_llm: "openai" },
      { openai: stub.client, minimax: stub.client },
      db,
      MODELS,
    );
    if (env.ok !== true) throw new Error(`case4: ${JSON.stringify(env)}`);
    const newBlob = JSON.parse(db.getSession(env.data.session_id).blob_json);
    const contents = newBlob.messages.map((m) => m.content);
    if (contents.join(",") !== "Aa1,Aa2,Bb") {
      throw new Error(`case4: tie-break order wrong: ${contents.join(",")} (want Aa1,Aa2,Bb)`);
    }
    console.log(
      `case4: interleave with ties [${idA},${idB}] -> [Aa1,Aa2,Bb] (deterministic tie-break by input order)`,
    );
  }

  // Case 5: summarize (default target_llm=openai).
  {
    const idA = await seed(db, "case5_a", "openai", [
      { role: "user", content: "build a chat app", created_at: 1_700_000_000 },
      { role: "assistant", content: "what stack?", created_at: 1_700_000_001 },
    ]);
    const idB = await seed(db, "case5_b", "MiniMax", [
      { role: "user", content: "ship redis caching", created_at: 1_700_000_002 },
      { role: "assistant", content: "60s TTL sounds good", created_at: 1_700_000_003 },
    ]);
    const summary = `Merged: session ${idA} agreed to build a chat app; session ${idB} added redis caching with 60s TTL.`;
    const stub = makeStub({ reply: summaryReply(summary) });
    const env = await mergeSessions(
      { session_ids: [idA, idB], strategy: "summarize", target_llm: "openai" },
      { openai: stub.client, minimax: stub.client },
      db,
      MODELS,
    );
    if (env.ok !== true) throw new Error(`case5: ${JSON.stringify(env)}`);
    if (env.data.strategy !== "summarize") {
      throw new Error(`case5: strategy=${env.data.strategy} (want summarize)`);
    }
    if (env.data.message_count !== 1) {
      throw new Error(`case5: message_count=${env.data.message_count} (want 1)`);
    }
    // LLM was called exactly once.
    if (stub.chatLog.length !== 1) {
      throw new Error(`case5: chat.completions called ${stub.chatLog.length} times (want 1)`);
    }
    const call = stub.chatLog[0];
    if (call.model !== "MiniMax-M3") {
      throw new Error(`case5: model=${call.model} (want MiniMax-M3)`);
    }
    if (call.messages[1].content.includes(String(idA)) === false) {
      throw new Error(`case5: payload should reference idA=${idA}: ${call.messages[1].content}`);
    }
    if (call.messages[1].content.includes(String(idB)) === false) {
      throw new Error(`case5: payload should reference idB=${idB}: ${call.messages[1].content}`);
    }
    const newBlob = JSON.parse(db.getSession(env.data.session_id).blob_json);
    if (newBlob.source_llm !== "openai") {
      throw new Error(`case5: source_llm=${newBlob.source_llm} (want openai from target_llm)`);
    }
    if (newBlob.messages.length !== 1) {
      throw new Error(`case5: new blob has ${newBlob.messages.length} messages (want 1)`);
    }
    if (newBlob.messages[0].role !== "assistant" || newBlob.messages[0].content !== summary) {
      throw new Error(
        `case5: new blob messages[0] wrong: ${JSON.stringify(newBlob.messages[0])}`,
      );
    }
    if (newBlob.metadata.merge_strategy !== "summarize") {
      throw new Error(`case5: metadata.merge_strategy=${newBlob.metadata.merge_strategy}`);
    }
    console.log(
      `case5: summarize [${idA},${idB}] target_llm=openai -> session_id=${env.data.session_id} (1 assistant message, source_llm=openai)`,
    );
  }

  // Case 6: summarize with target_llm=MiniMax.
  {
    const idA = await seed(db, "case6_a", "openai", [
      { role: "user", content: "x", created_at: 1 },
    ]);
    const idB = await seed(db, "case6_b", "openai", [
      { role: "user", content: "y", created_at: 2 },
    ]);
    const stub = makeStub({ reply: summaryReply("merged x+y") });
    const env = await mergeSessions(
      { session_ids: [idA, idB], strategy: "summarize", target_llm: "MiniMax" },
      { openai: stub.client, minimax: stub.client },
      db,
      MODELS,
    );
    if (env.ok !== true) throw new Error(`case6: ${JSON.stringify(env)}`);
    const newBlob = JSON.parse(db.getSession(env.data.session_id).blob_json);
    if (newBlob.source_llm !== "MiniMax") {
      throw new Error(`case6: source_llm=${newBlob.source_llm} (want MiniMax from target_llm)`);
    }
    console.log(
      `case6: summarize target_llm=MiniMax -> source_llm=MiniMax (target_llm honored)`,
    );
  }

  // Case 7: NOT_FOUND on missing session_id (concat).
  {
    const idA = await seed(db, "case7", "openai", [
      { role: "user", content: "x", created_at: 1 },
    ]);
    const stub = makeStub({ reply: summaryReply("never") });
    try {
      await mergeSessions(
        { session_ids: [idA, 9999], strategy: "concat", target_llm: "openai" },
        { openai: stub.client, minimax: stub.client },
        db,
        MODELS,
      );
      throw new Error("case7: expected NOT_FOUND, got success");
    } catch (err) {
      if (err?.code !== "NOT_FOUND") {
        throw new Error(`case7: expected NOT_FOUND, got ${err?.code}: ${err?.message}`);
      }
      if (err?.tool !== "merge_sessions") {
        throw new Error(`case7: tool=${err?.tool} (want merge_sessions)`);
      }
      if (!err?.message?.includes("9999")) {
        throw new Error(`case7: message should include 9999: ${err?.message}`);
      }
      if (stub.chatLog.length !== 0) {
        throw new Error(`case7: LLM should not have been called, got ${stub.chatLog.length} calls`);
      }
      console.log(`case7: missing session -> NOT_FOUND (no LLM call)`);
    }
  }

  // Case 8: UPSTREAM_TIMEOUT on summarize via test-time override.
  {
    const idA = await seed(db, "case8_a", "openai", [
      { role: "user", content: "x", created_at: 1 },
    ]);
    const idB = await seed(db, "case8_b", "openai", [
      { role: "user", content: "y", created_at: 2 },
    ]);
    const stub = makeStub({ reply: summaryReply("never"), hangMs: 5_000 });
    try {
      await mergeSessions(
        { session_ids: [idA, idB], strategy: "summarize", target_llm: "openai" },
        { openai: stub.client, minimax: stub.client },
        db,
        MODELS,
        50, // 50ms timeout, much shorter than the 5s hang
      );
      throw new Error("case8: expected UPSTREAM_TIMEOUT, got success");
    } catch (err) {
      if (err?.code !== "UPSTREAM_TIMEOUT") {
        throw new Error(`case8: expected UPSTREAM_TIMEOUT, got ${err?.code}: ${err?.message}`);
      }
      console.log(`case8: slow LLM -> UPSTREAM_TIMEOUT`);
    }
  }

  // Case 9: UPSTREAM_ERROR on a thrown LLM error (summarize).
  {
    const idA = await seed(db, "case9_a", "openai", [
      { role: "user", content: "x", created_at: 1 },
    ]);
    const idB = await seed(db, "case9_b", "openai", [
      { role: "user", content: "y", created_at: 2 },
    ]);
    const stub = makeStub({ throwError: new Error("upstream down") });
    try {
      await mergeSessions(
        { session_ids: [idA, idB], strategy: "summarize", target_llm: "openai" },
        { openai: stub.client, minimax: stub.client },
        db,
        MODELS,
      );
      throw new Error("case9: expected UPSTREAM_ERROR, got success");
    } catch (err) {
      if (err?.code !== "UPSTREAM_ERROR") {
        throw new Error(`case9: expected UPSTREAM_ERROR, got ${err?.code}: ${err?.message}`);
      }
      if (!err?.message?.includes("upstream down")) {
        throw new Error(`case9: message should include upstream error: ${err?.message}`);
      }
      console.log(`case9: LLM threw -> UPSTREAM_ERROR`);
    }
  }

  // Case 10: EXTRACTION_FAILED on summarize (3 sub-cases: non-JSON, wrong shape, empty string).
  {
    const idA = await seed(db, "case10_a", "openai", [
      { role: "user", content: "x", created_at: 1 },
    ]);
    const idB = await seed(db, "case10_b", "openai", [
      { role: "user", content: "y", created_at: 2 },
    ]);
    // 10a: non-JSON.
    {
      const stub = makeStub({
        reply: {
          id: "cmpl",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "not json" },
              finish_reason: "stop",
            },
          ],
        },
      });
      try {
        await mergeSessions(
          { session_ids: [idA, idB], strategy: "summarize", target_llm: "openai" },
          { openai: stub.client, minimax: stub.client },
          db,
          MODELS,
        );
        throw new Error("case10a: expected EXTRACTION_FAILED, got success");
      } catch (err) {
        if (err?.code !== "EXTRACTION_FAILED") {
          throw new Error(`case10a: expected EXTRACTION_FAILED, got ${err?.code}`);
        }
        console.log(`case10a: non-JSON LLM response -> EXTRACTION_FAILED`);
      }
    }
    // 10b: wrong shape (no `summary` field).
    {
      const stub = makeStub({
        reply: {
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
        },
      });
      try {
        await mergeSessions(
          { session_ids: [idA, idB], strategy: "summarize", target_llm: "openai" },
          { openai: stub.client, minimax: stub.client },
          db,
          MODELS,
        );
        throw new Error("case10b: expected EXTRACTION_FAILED, got success");
      } catch (err) {
        if (err?.code !== "EXTRACTION_FAILED") {
          throw new Error(`case10b: expected EXTRACTION_FAILED, got ${err?.code}`);
        }
        console.log(`case10b: wrong-shape LLM response -> EXTRACTION_FAILED`);
      }
    }
    // 10c: empty string summary.
    {
      const stub = makeStub({
        reply: {
          id: "cmpl",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify({ summary: "   " }),
              },
              finish_reason: "stop",
            },
          ],
        },
      });
      try {
        await mergeSessions(
          { session_ids: [idA, idB], strategy: "summarize", target_llm: "openai" },
          { openai: stub.client, minimax: stub.client },
          db,
          MODELS,
        );
        throw new Error("case10c: expected EXTRACTION_FAILED, got success");
      } catch (err) {
        if (err?.code !== "EXTRACTION_FAILED") {
          throw new Error(`case10c: expected EXTRACTION_FAILED, got ${err?.code}`);
        }
        console.log(`case10c: empty summary LLM response -> EXTRACTION_FAILED`);
      }
    }
  }

  // Case 11: concat with an empty input session.
  {
    const idA = await seed(db, "case11_a", "openai", [
      { role: "user", content: "a1", created_at: 1 },
    ]);
    const idEmpty = await seed(db, "case11_empty", "openai", []);
    const idB = await seed(db, "case11_b", "openai", [
      { role: "user", content: "b1", created_at: 2 },
    ]);
    const stub = makeStub({ reply: summaryReply("never") });
    const env = await mergeSessions(
      {
        session_ids: [idA, idEmpty, idB],
        strategy: "concat",
        target_llm: "openai",
      },
      { openai: stub.client, minimax: stub.client },
      db,
      MODELS,
    );
    if (env.ok !== true) throw new Error(`case11: ${JSON.stringify(env)}`);
    if (env.data.message_count !== 2) {
      throw new Error(`case11: message_count=${env.data.message_count} (want 2)`);
    }
    const newBlob = JSON.parse(db.getSession(env.data.session_id).blob_json);
    const contents = newBlob.messages.map((m) => m.content);
    if (contents.join(",") !== "a1,b1") {
      throw new Error(`case11: contents wrong: ${contents.join(",")} (want a1,b1)`);
    }
    console.log(
      `case11: concat with empty middle [${idA},${idEmpty},${idB}] -> [a1,b1]`,
    );
  }

  db.close();
  console.log("OK");
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
