// One-off smoke test for AC-10: branch_session (clone + rewrite opening message).
//
// Sets up an in-memory DB, imports a parent session, stubs the LLM client
// (only the MiniMax client's chat.completions.create is exercised by
// branch_session), and calls the real branchSession handler. Asserts:
//   1. happy path: new row inserted, parent_session_id = parent's row id,
//      new blob's first message content = the LLM-rewritten string,
//      new blob's external session_id is fresh (differs from parent's),
//      parent's blob is unchanged, chat.completions.create was called
//      exactly once with model=MiniMax-M3 and the alternate_path +
//      opening in the user payload.
//   2. NOT_FOUND on missing parent_session_id (no LLM call happens).
//   3. UPSTREAM_TIMEOUT via test-time timeoutMs override (the LLM stub
//      hangs longer than the timeout).
//   4. UPSTREAM_ERROR on a thrown LLM error (stub throws).
//   5. EXTRACTION_FAILED on empty assistant text.
//   6. EXTRACTION_FAILED on non-JSON assistant text.
//   7. EXTRACTION_FAILED on JSON with the wrong shape (no `rewritten_message`).
//   8. EXTRACTION_FAILED on JSON whose `rewritten_message` is an empty string.
//   9. EXTRACTION_FAILED on a parent with no messages.
import { importSession } from "../dist/tools/import_session.js";
import { branchSession } from "../dist/tools/branch_session.js";
import { openDatabase } from "../dist/db/sqlite.js";

const MODELS = { openai: "gpt-4o-mini", minimax: "MiniMax-M3" };

// Stub LLM client factory. The `reply` is returned on chat.completions.create
// (or a throwError is thrown, or the call hangs for hangMs). Each invocation
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

// Build a chat.completions response with the spec'd `rewritten_message` shape.
function branchReply(rewritten) {
  return {
    id: "cmpl_branch",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: JSON.stringify({ rewritten_message: rewritten }),
        },
        finish_reason: "stop",
      },
    ],
  };
}

async function seed(db, tag) {
  const blob = {
    session_id: `conv_${tag}_parent`,
    source_llm: "openai",
    messages: [
      { role: "user", content: "Build a chat app", created_at: 1_700_000_000 },
      { role: "assistant", content: "Sure, what stack?", created_at: 1_700_000_001 },
      { role: "user", content: "Use Next.js", created_at: 1_700_000_002 },
    ],
    metadata: { tag: `${tag}-parent` },
  };
  const env = await importSession(
    { blob, external_session_id: `${tag}-ext` },
    db,
  );
  if (env.ok !== true) throw new Error(`seed ${tag}: ${JSON.stringify(env)}`);
  return env.data.id;
}

async function seedEmpty(db) {
  const blob = {
    session_id: "conv_empty_parent",
    source_llm: "openai",
    messages: [],
    metadata: { tag: "empty-parent" },
  };
  const env = await importSession(
    { blob, external_session_id: "empty-ext" },
    db,
  );
  if (env.ok !== true) throw new Error(`seed empty: ${JSON.stringify(env)}`);
  return env.data.id;
}

async function main() {
  const db = openDatabase(":memory:");

  // Case 1: happy path.
  {
    const parentId = await seed(db, "case1");
    const stub = makeStub({
      reply: branchReply("Build a chat app with observability built in from day one"),
    });
    const env = await branchSession(
      { parent_session_id: parentId, alternate_path: "Add observability" },
      { openai: stub.client, minimax: stub.client },
      db,
      MODELS,
    );
    if (env.ok !== true) throw new Error(`case1: not ok: ${JSON.stringify(env)}`);
    if (env.data.session_id === parentId) {
      throw new Error(`case1: new session_id equals parent: ${env.data.session_id}`);
    }
    if (env.data.parent_session_id !== parentId) {
      throw new Error(
        `case1: parent_session_id=${env.data.parent_session_id} (want ${parentId})`,
      );
    }
    const newRow = db.getSession(env.data.session_id);
    if (newRow === null) throw new Error(`case1: new session not in DB`);
    if (newRow.parent_session_id !== parentId) {
      throw new Error(
        `case1: new row parent_session_id=${newRow.parent_session_id} (want ${parentId})`,
      );
    }
    const newBlob = JSON.parse(newRow.blob_json);
    if (
      newBlob.messages[0].content !==
      "Build a chat app with observability built in from day one"
    ) {
      throw new Error(
        `case1: new blob messages[0].content=${JSON.stringify(newBlob.messages[0].content)}`,
      );
    }
    if (newBlob.messages[0].role !== "user") {
      throw new Error(`case1: messages[0].role=${newBlob.messages[0].role} (want user)`);
    }
    if (newBlob.messages[0].created_at !== 1_700_000_000) {
      throw new Error(
        `case1: messages[0].created_at=${newBlob.messages[0].created_at} (want 1700000000)`,
      );
    }
    if (newBlob.session_id === "conv_case1_parent") {
      throw new Error(`case1: external session_id should differ from parent's`);
    }
    if (!newBlob.session_id.startsWith("conv_case1_parent#branch-")) {
      throw new Error(
        `case1: external session_id should be derived from parent's: ${newBlob.session_id}`,
      );
    }
    // The 2nd and 3rd messages are unchanged.
    if (newBlob.messages[1].content !== "Sure, what stack?") {
      throw new Error(`case1: messages[1] should be unchanged: ${newBlob.messages[1].content}`);
    }
    if (newBlob.messages[2].content !== "Use Next.js") {
      throw new Error(`case1: messages[2] should be unchanged: ${newBlob.messages[2].content}`);
    }
    if (newBlob.metadata.branched_alternate_path !== "Add observability") {
      throw new Error(
        `case1: metadata.branched_alternate_path=${newBlob.metadata.branched_alternate_path}`,
      );
    }
    if (newBlob.metadata.branched_from_session_id !== parentId) {
      throw new Error(
        `case1: metadata.branched_from_session_id=${newBlob.metadata.branched_from_session_id} (want ${parentId})`,
      );
    }
    // Parent blob is unchanged.
    const parentRow = db.getSession(parentId);
    const parentBlob = JSON.parse(parentRow.blob_json);
    if (parentBlob.messages[0].content !== "Build a chat app") {
      throw new Error(
        `case1: parent blob modified! messages[0].content=${parentBlob.messages[0].content}`,
      );
    }
    if (parentBlob.messages.length !== 3) {
      throw new Error(`case1: parent messages length changed: ${parentBlob.messages.length}`);
    }
    // chat.completions.create was called exactly once on the MiniMax client.
    if (stub.chatLog.length !== 1) {
      throw new Error(`case1: chat.completions called ${stub.chatLog.length} times (want 1)`);
    }
    const call = stub.chatLog[0];
    if (call.model !== "MiniMax-M3") {
      throw new Error(`case1: model=${call.model} (want MiniMax-M3)`);
    }
    if (!Array.isArray(call.messages) || call.messages.length !== 2) {
      throw new Error(`case1: messages shape wrong: ${JSON.stringify(call.messages)}`);
    }
    if (call.messages[0].role !== "system" || !call.messages[0].content.includes("rewritten_message")) {
      throw new Error(
        `case1: system message should describe the contract: ${call.messages[0].content}`,
      );
    }
    const userMsg = call.messages[1];
    if (userMsg.role !== "user" || !userMsg.content.includes("Add observability")) {
      throw new Error(
        `case1: user payload should include alternate_path: ${userMsg.content}`,
      );
    }
    if (!userMsg.content.includes("Build a chat app")) {
      throw new Error(
        `case1: user payload should include the opening message: ${userMsg.content}`,
      );
    }
    console.log(
      `case1: branched session_id=${env.data.session_id} from parent=${parentId} (LLM call shape OK)`,
    );
  }

  // Case 2: NOT_FOUND on missing parent.
  {
    const stub = makeStub({ reply: branchReply("never reached") });
    try {
      await branchSession(
        { parent_session_id: 9999, alternate_path: "x" },
        { openai: stub.client, minimax: stub.client },
        db,
        MODELS,
      );
      throw new Error("case2: expected NOT_FOUND, got success");
    } catch (err) {
      if (err?.code !== "NOT_FOUND") {
        throw new Error(`case2: expected NOT_FOUND, got ${err?.code}: ${err?.message}`);
      }
      if (err?.tool !== "branch_session") {
        throw new Error(`case2: tool=${err?.tool} (want branch_session)`);
      }
      if (!err?.message?.includes("9999")) {
        throw new Error(`case2: message should include 9999: ${err?.message}`);
      }
      if (stub.chatLog.length !== 0) {
        throw new Error(`case2: LLM should not have been called, got ${stub.chatLog.length} calls`);
      }
      console.log(`case2: missing parent -> NOT_FOUND (no LLM call)`);
    }
  }

  // Case 3: UPSTREAM_TIMEOUT via test-time timeoutMs override.
  {
    const parentId = await seed(db, "case3");
    const stub = makeStub({ reply: branchReply("never"), hangMs: 5_000 });
    try {
      await branchSession(
        { parent_session_id: parentId, alternate_path: "x" },
        { openai: stub.client, minimax: stub.client },
        db,
        MODELS,
        50, // 50ms timeout, much shorter than the 5s hang
      );
      throw new Error("case3: expected UPSTREAM_TIMEOUT, got success");
    } catch (err) {
      if (err?.code !== "UPSTREAM_TIMEOUT") {
        throw new Error(`case3: expected UPSTREAM_TIMEOUT, got ${err?.code}: ${err?.message}`);
      }
      console.log(`case3: slow LLM -> UPSTREAM_TIMEOUT`);
    }
  }

  // Case 4: UPSTREAM_ERROR on a thrown LLM error.
  {
    const parentId = await seed(db, "case4");
    const stub = makeStub({ throwError: new Error("upstream down") });
    try {
      await branchSession(
        { parent_session_id: parentId, alternate_path: "x" },
        { openai: stub.client, minimax: stub.client },
        db,
        MODELS,
      );
      throw new Error("case4: expected UPSTREAM_ERROR, got success");
    } catch (err) {
      if (err?.code !== "UPSTREAM_ERROR") {
        throw new Error(`case4: expected UPSTREAM_ERROR, got ${err?.code}: ${err?.message}`);
      }
      if (!err?.message?.includes("upstream down")) {
        throw new Error(`case4: message should include upstream error: ${err?.message}`);
      }
      console.log(`case4: LLM threw -> UPSTREAM_ERROR`);
    }
  }

  // Case 5: EXTRACTION_FAILED on empty assistant text.
  {
    const parentId = await seed(db, "case5");
    const emptyReply = {
      id: "cmpl",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "" },
          finish_reason: "stop",
        },
      ],
    };
    const stub = makeStub({ reply: emptyReply });
    try {
      await branchSession(
        { parent_session_id: parentId, alternate_path: "x" },
        { openai: stub.client, minimax: stub.client },
        db,
        MODELS,
      );
      throw new Error("case5: expected EXTRACTION_FAILED, got success");
    } catch (err) {
      if (err?.code !== "EXTRACTION_FAILED") {
        throw new Error(`case5: expected EXTRACTION_FAILED, got ${err?.code}: ${err?.message}`);
      }
      console.log(`case5: empty LLM response -> EXTRACTION_FAILED`);
    }
  }

  // Case 6: EXTRACTION_FAILED on non-JSON assistant text.
  {
    const parentId = await seed(db, "case6");
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
    const stub = makeStub({ reply: notJson });
    try {
      await branchSession(
        { parent_session_id: parentId, alternate_path: "x" },
        { openai: stub.client, minimax: stub.client },
        db,
        MODELS,
      );
      throw new Error("case6: expected EXTRACTION_FAILED, got success");
    } catch (err) {
      if (err?.code !== "EXTRACTION_FAILED") {
        throw new Error(`case6: expected EXTRACTION_FAILED, got ${err?.code}: ${err?.message}`);
      }
      console.log(`case6: non-JSON LLM response -> EXTRACTION_FAILED`);
    }
  }

  // Case 7: EXTRACTION_FAILED on JSON with the wrong shape (no `rewritten_message`).
  {
    const parentId = await seed(db, "case7");
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
    const stub = makeStub({ reply: wrongShape });
    try {
      await branchSession(
        { parent_session_id: parentId, alternate_path: "x" },
        { openai: stub.client, minimax: stub.client },
        db,
        MODELS,
      );
      throw new Error("case7: expected EXTRACTION_FAILED, got success");
    } catch (err) {
      if (err?.code !== "EXTRACTION_FAILED") {
        throw new Error(`case7: expected EXTRACTION_FAILED, got ${err?.code}: ${err?.message}`);
      }
      console.log(`case7: wrong shape LLM response -> EXTRACTION_FAILED`);
    }
  }

  // Case 8: EXTRACTION_FAILED on JSON whose `rewritten_message` is empty string.
  {
    const parentId = await seed(db, "case8");
    const emptyMsg = {
      id: "cmpl",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: JSON.stringify({ rewritten_message: "   " }),
          },
          finish_reason: "stop",
        },
      ],
    };
    const stub = makeStub({ reply: emptyMsg });
    try {
      await branchSession(
        { parent_session_id: parentId, alternate_path: "x" },
        { openai: stub.client, minimax: stub.client },
        db,
        MODELS,
      );
      throw new Error("case8: expected EXTRACTION_FAILED, got success");
    } catch (err) {
      if (err?.code !== "EXTRACTION_FAILED") {
        throw new Error(`case8: expected EXTRACTION_FAILED, got ${err?.code}: ${err?.message}`);
      }
      console.log(`case8: empty rewritten_message -> EXTRACTION_FAILED`);
    }
  }

  // Case 9: EXTRACTION_FAILED on a parent with no messages.
  {
    const emptyId = await seedEmpty(db);
    const stub = makeStub({ reply: branchReply("never reached") });
    try {
      await branchSession(
        { parent_session_id: emptyId, alternate_path: "x" },
        { openai: stub.client, minimax: stub.client },
        db,
        MODELS,
      );
      throw new Error("case9: expected EXTRACTION_FAILED, got success");
    } catch (err) {
      if (err?.code !== "EXTRACTION_FAILED") {
        throw new Error(`case9: expected EXTRACTION_FAILED, got ${err?.code}: ${err?.message}`);
      }
      if (stub.chatLog.length !== 0) {
        throw new Error(
          `case9: LLM should not have been called, got ${stub.chatLog.length} calls`,
        );
      }
      console.log(`case9: empty parent -> EXTRACTION_FAILED (no LLM call)`);
    }
  }

  db.close();
  console.log("OK");
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
