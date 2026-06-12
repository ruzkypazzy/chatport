// One-off smoke test for AC-8: continue_in (full handoff).
//
// Stubs the LLM client to capture the chat.completions.create +
// conversations.create call args and return canned responses, calls the
// real handler against an in-memory DB, and asserts:
//   - happy path: load -> summarize -> chat.completions(seed) ->
//     conversations.create(seed + reply) -> { new_session_id,
//     source_llm: target_llm, seeded_messages: [system, user, assistant] }
//   - summarizeProgress is called with compressor=MiniMax-M3 and
//     target_tokens from the input (routed through the default
//     MiniMax-M3 backend)
//   - the chat.completions.create call on the target LLM uses the
//     seed messages and the right model name
//   - the conversations.create call is invoked with seed + reply as
//     items, and the returned id is surfaced in new_session_id
//   - target_llm=openai routes to llm.openai with models.openai
//   - explicit `model` override is honored
//   - NOT_FOUND on missing source_session_id
//   - UPSTREAM_TIMEOUT via test-time override
//   - UPSTREAM_ERROR on thrown LLM errors
//   - malformed chat.completions response (no assistant text) -> UPSTREAM_ERROR
//   - malformed conversations.create response (no id) -> UPSTREAM_ERROR
import { importSession } from "../dist/tools/import_session.js";
import { continueIn } from "../dist/tools/continue_in.js";
import { openDatabase } from "../dist/db/sqlite.js";

const MODELS = { openai: "gpt-4o-mini", minimax: "MiniMax-M3" };

// Queue-based stub: returns the next canned reply per chat.completions
// call, and records the conversations.create args.
function makeSequencedStub({ replies, hangMs = 0, throwError = null, conversationId = "conv_new_abc" }) {
  const chatLog = [];
  const convCreateLog = [];
  let chatIndex = 0;
  return {
    chatLog,
    convCreateLog,
    client: {
      conversations: {
        retrieve: async () => ({}),
        items: { async *list() {} },
        create: async (params) => {
          convCreateLog.push(params);
          return { id: conversationId, object: "conversation" };
        },
      },
      chat: {
        completions: {
          create: async (params) => {
            chatLog.push(params);
            if (throwError) throw throwError;
            if (hangMs > 0) await new Promise((r) => setTimeout(r, hangMs));
            if (chatIndex >= replies.length) {
              throw new Error(
                `stub exhausted: chat.completions call #${chatIndex} but only ${replies.length} canned replies`,
              );
            }
            return replies[chatIndex++];
          },
        },
      },
    },
  };
}

function summaryReply(summary) {
  return {
    id: "cmpl_sum",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: JSON.stringify({ summary }) },
        finish_reason: "stop",
      },
    ],
  };
}

function assistantReply(content) {
  return {
    id: "cmpl_reply",
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
    session_id: "conv_continue_1",
    source_llm: "openai",
    messages: [
      { role: "user", content: "let's add caching", created_at: 1_700_000_000 },
      { role: "assistant", content: "ok using redis with 60s TTL", created_at: 1_700_000_001 },
      { role: "user", content: "ship it", created_at: 1_700_000_002 },
    ],
    metadata: { tag: "continue-smoke" },
  };
  const env = await importSession({ blob, external_session_id: "cont-ext-1" }, db);
  if (env.ok !== true) throw new Error(`seed failed: ${JSON.stringify(env)}`);
  return env.data.id;
}

async function main() {
  const db = openDatabase(":memory:");
  const seededId = await seed(db);

  // Case 1: happy path — target_llm=MiniMax, default model.
  {
    const stub = makeSequencedStub({
      replies: [
        summaryReply("We agreed to ship redis caching with 60s TTL."),
        assistantReply("Got it. I'll set up the cache layer now."),
      ],
    });
    const env = await continueIn(
      { source_session_id: seededId, target_llm: "MiniMax", next_step: "set up the cache layer" },
      { openai: stub.client, minimax: stub.client },
      db,
      MODELS,
    );
    if (env.ok !== true) throw new Error(`case1: not ok: ${JSON.stringify(env)}`);
    if (env.data.new_session_id !== "conv_new_abc") {
      throw new Error(`case1: new_session_id=${env.data.new_session_id} (want conv_new_abc)`);
    }
    if (env.data.source_llm !== "MiniMax") {
      throw new Error(`case1: source_llm=${env.data.source_llm} (want MiniMax)`);
    }
    if (!Array.isArray(env.data.seeded_messages) || env.data.seeded_messages.length !== 3) {
      throw new Error(`case1: seeded_messages.length=${env.data.seeded_messages.length} (want 3)`);
    }
    const [sys, user, asst] = env.data.seeded_messages;
    if (sys.role !== "system" || sys.content !== "We agreed to ship redis caching with 60s TTL.") {
      throw new Error(`case1: system seed wrong: ${JSON.stringify(sys)}`);
    }
    if (user.role !== "user" || user.content !== "set up the cache layer") {
      throw new Error(`case1: user seed wrong: ${JSON.stringify(user)}`);
    }
    if (asst.role !== "assistant" || asst.content !== "Got it. I'll set up the cache layer now.") {
      throw new Error(`case1: assistant seed wrong: ${JSON.stringify(asst)}`);
    }
    // Two chat.completions calls: 1st = summarize (MiniMax), 2nd = reply (MiniMax).
    if (stub.chatLog.length !== 2) {
      throw new Error(`case1: expected 2 chat.completions calls, got ${stub.chatLog.length}`);
    }
    // 1st call: summarize -- model=MiniMax-M3, response_format=json_object,
    // system prompt + user payload with messages+metadata.
    const sumCall = stub.chatLog[0];
    if (sumCall.model !== "MiniMax-M3") {
      throw new Error(`case1: summarize model=${sumCall.model} (want MiniMax-M3)`);
    }
    // 2nd call: reply on target MiniMax with the seed messages.
    const replyCall = stub.chatLog[1];
    if (replyCall.model !== "MiniMax-M3") {
      throw new Error(`case1: reply model=${replyCall.model} (want MiniMax-M3)`);
    }
    if (!Array.isArray(replyCall.messages) || replyCall.messages.length !== 2) {
      throw new Error(`case1: reply messages shape wrong: ${JSON.stringify(replyCall.messages)}`);
    }
    if (replyCall.messages[0].role !== "system" || replyCall.messages[0].content !== sys.content) {
      throw new Error(`case1: reply seed[0] wrong: ${JSON.stringify(replyCall.messages[0])}`);
    }
    if (replyCall.messages[1].role !== "user" || replyCall.messages[1].content !== user.content) {
      throw new Error(`case1: reply seed[1] wrong: ${JSON.stringify(replyCall.messages[1])}`);
    }
    // conversations.create called with seed + reply as items.
    if (stub.convCreateLog.length !== 1) {
      throw new Error(`case1: conversations.create called ${stub.convCreateLog.length} times (want 1)`);
    }
    const convCreate = stub.convCreateLog[0];
    if (!Array.isArray(convCreate.items) || convCreate.items.length !== 3) {
      throw new Error(`case1: conversations.create items length=${convCreate.items?.length} (want 3)`);
    }
    if (convCreate.items[0].role !== "system" || convCreate.items[0].content !== sys.content) {
      throw new Error(`case1: conv items[0] wrong: ${JSON.stringify(convCreate.items[0])}`);
    }
    if (convCreate.items[1].role !== "user" || convCreate.items[1].content !== user.content) {
      throw new Error(`case1: conv items[1] wrong: ${JSON.stringify(convCreate.items[1])}`);
    }
    if (convCreate.items[2].role !== "assistant" || convCreate.items[2].content !== asst.content) {
      throw new Error(`case1: conv items[2] wrong: ${JSON.stringify(convCreate.items[2])}`);
    }
    console.log(
      `case1: target_llm=MiniMax -> new_session_id=${env.data.new_session_id} seeded_messages=${env.data.seeded_messages.length} chat.completions=${stub.chatLog.length} conversations.create=${stub.convCreateLog.length}`,
    );
  }

  // Case 2: target_llm=openai routes the reply to llm.openai + models.openai.
  // The summarize step still goes to llm.minimax (compressor is fixed to
  // MiniMax-M3 for continue_in per the plan).
  {
    const openaiChatLog = [];
    const openaiConvLog = [];
    const minimaxChatLog = [];
    let openaiIndex = 0;
    let minimaxIndex = 0;
    const openaiReplies = [assistantReply("openai reply")];
    const minimaxReplies = [summaryReply("summary from minimax")];
    const openaiClient = {
      conversations: {
        retrieve: async () => ({}),
        items: { async *list() {} },
        create: async (params) => {
          openaiConvLog.push(params);
          return { id: "conv_openai_new" };
        },
      },
      chat: {
        completions: {
          create: async (params) => {
            openaiChatLog.push(params);
            return openaiReplies[openaiIndex++];
          },
        },
      },
    };
    const minimaxClient = {
      conversations: {
        retrieve: async () => ({}),
        items: { async *list() {} },
        create: async () => ({ id: "should_not_be_called" }),
      },
      chat: {
        completions: {
          create: async (params) => {
            minimaxChatLog.push(params);
            return minimaxReplies[minimaxIndex++];
          },
        },
      },
    };
    const env = await continueIn(
      { source_session_id: seededId, target_llm: "openai", next_step: "openai step" },
      { openai: openaiClient, minimax: minimaxClient },
      db,
      MODELS,
    );
    if (env.ok !== true) throw new Error(`case2: not ok: ${JSON.stringify(env)}`);
    if (env.data.new_session_id !== "conv_openai_new") {
      throw new Error(`case2: new_session_id=${env.data.new_session_id} (want conv_openai_new)`);
    }
    if (env.data.source_llm !== "openai") {
      throw new Error(`case2: source_llm=${env.data.source_llm} (want openai)`);
    }
    // minimize should have handled exactly the summarize call (1 chat.completions).
    if (minimaxChatLog.length !== 1) {
      throw new Error(`case2: minimax chat.completions called ${minimaxChatLog.length} times (want 1 for summarize)`);
    }
    if (minimaxChatLog[0].model !== "MiniMax-M3") {
      throw new Error(`case2: minimize summarize model=${minimaxChatLog[0].model}`);
    }
    // openai should have handled exactly the reply call.
    if (openaiChatLog.length !== 1) {
      throw new Error(`case2: openai chat.completions called ${openaiChatLog.length} times (want 1 for reply)`);
    }
    if (openaiChatLog[0].model !== "gpt-4o-mini") {
      throw new Error(`case2: openai reply model=${openaiChatLog[0].model} (want gpt-4o-mini)`);
    }
    // openai.conversations.create called once with seed + reply.
    if (openaiConvLog.length !== 1) {
      throw new Error(`case2: openai conversations.create called ${openaiConvLog.length} times (want 1)`);
    }
    if (openaiConvLog[0].items[2].content !== "openai reply") {
      throw new Error(`case2: openai conv items[2] wrong: ${openaiConvLog[0].items[2].content}`);
    }
    console.log(
      `case2: target_llm=openai -> new_session_id=${env.data.new_session_id} summarize=on_minimax reply=on_openai openai_chat=${openaiChatLog.length} openai_conv=${openaiConvLog.length}`,
    );
  }

  // Case 3: explicit `model` override is honored on the target LLM.
  {
    const stub = makeSequencedStub({
      replies: [
        summaryReply("s"),
        assistantReply("ok"),
      ],
    });
    const env = await continueIn(
      {
        source_session_id: seededId,
        target_llm: "MiniMax",
        next_step: "step",
        model: "minimax-text-01",
      },
      { openai: stub.client, minimax: stub.client },
      db,
      MODELS,
    );
    if (env.ok !== true) throw new Error(`case3: not ok: ${JSON.stringify(env)}`);
    // The reply chat.completions call (the 2nd one) should use the override model.
    if (stub.chatLog[1].model !== "minimax-text-01") {
      throw new Error(`case3: reply model=${stub.chatLog[1].model} (want minimax-text-01)`);
    }
    // The summarize call should still use the env default (MINIMAX_MODEL).
    if (stub.chatLog[0].model !== "MiniMax-M3") {
      throw new Error(`case3: summarize model=${stub.chatLog[0].model} (want MiniMax-M3 default)`);
    }
    console.log(
      `case3: explicit model=minimax-text-01 -> reply model=${stub.chatLog[1].model}, summarize model=${stub.chatLog[0].model}`,
    );
  }

  // Case 4: NOT_FOUND on missing source_session_id.
  {
    const stub = makeSequencedStub({ replies: [summaryReply("s")] });
    try {
      await continueIn(
        { source_session_id: 9999, target_llm: "MiniMax", next_step: "x" },
        { openai: stub.client, minimax: stub.client },
        db,
        MODELS,
      );
      throw new Error("case4: expected NOT_FOUND, got success");
    } catch (err) {
      if (err?.code !== "NOT_FOUND") {
        throw new Error(`case4: expected NOT_FOUND, got ${err?.code}: ${err?.message}`);
      }
      if (err?.tool !== "continue_in") {
        throw new Error(`case4: tool=${err?.tool} (want continue_in)`);
      }
      if (stub.chatLog.length !== 0) {
        throw new Error(`case4: stub called even though session missing: ${stub.chatLog.length}`);
      }
      if (stub.convCreateLog.length !== 0) {
        throw new Error(`case4: conversations.create called even though session missing: ${stub.convCreateLog.length}`);
      }
      console.log(`case4: missing session -> NOT_FOUND (${err.message}), LLM not called`);
    }
  }

  // Case 5: UPSTREAM_TIMEOUT via 50ms test-time override on a hanging LLM.
  {
    const stub = makeSequencedStub({ replies: [summaryReply("s"), assistantReply("x")], hangMs: 5000 });
    try {
      await continueIn(
        { source_session_id: seededId, target_llm: "MiniMax", next_step: "x" },
        { openai: stub.client, minimax: stub.client },
        db,
        MODELS,
        50, // 50ms overall budget
      );
      throw new Error("case5: expected UPSTREAM_TIMEOUT, got success");
    } catch (err) {
      if (err?.code !== "UPSTREAM_TIMEOUT") {
        throw new Error(`case5: expected UPSTREAM_TIMEOUT, got ${err?.code}: ${err?.message}`);
      }
      console.log(`case5: hanging LLM -> UPSTREAM_TIMEOUT (${err.message})`);
    }
  }

  // Case 6: UPSTREAM_ERROR on thrown LLM error.
  {
    const stub = makeSequencedStub({ replies: [], throwError: new Error("upstream boom") });
    try {
      await continueIn(
        { source_session_id: seededId, target_llm: "MiniMax", next_step: "x" },
        { openai: stub.client, minimax: stub.client },
        db,
        MODELS,
      );
      throw new Error("case6: expected UPSTREAM_ERROR, got success");
    } catch (err) {
      if (err?.code !== "UPSTREAM_ERROR") {
        throw new Error(`case6: expected UPSTREAM_ERROR, got ${err?.code}: ${err?.message}`);
      }
      console.log(`case6: throwing LLM -> UPSTREAM_ERROR (${err.message})`);
    }
  }

  // Case 7: malformed chat.completions response (no assistant text) -> UPSTREAM_ERROR.
  {
    const stub = makeSequencedStub({
      replies: [
        summaryReply("s"),
        // reply missing message.content
        { choices: [{ message: { role: "assistant" } }] },
      ],
    });
    try {
      await continueIn(
        { source_session_id: seededId, target_llm: "MiniMax", next_step: "x" },
        { openai: stub.client, minimax: stub.client },
        db,
        MODELS,
      );
      throw new Error("case7: expected UPSTREAM_ERROR, got success");
    } catch (err) {
      if (err?.code !== "UPSTREAM_ERROR") {
        throw new Error(`case7: expected UPSTREAM_ERROR, got ${err?.code}: ${err?.message}`);
      }
      if (!err?.message?.includes("assistant message")) {
        throw new Error(`case7: message should mention assistant message: ${err?.message}`);
      }
      // conversations.create should NOT have been called.
      if (stub.convCreateLog.length !== 0) {
        throw new Error(`case7: conversations.create called despite bad reply: ${stub.convCreateLog.length}`);
      }
      console.log(`case7: malformed chat.completions -> UPSTREAM_ERROR (${err.message})`);
    }
  }

  // Case 8: malformed conversations.create response (no id) -> UPSTREAM_ERROR.
  {
    const stub = {
      chatLog: [],
      convCreateLog: [],
      chatIndex: 0,
      client: {
        conversations: {
          retrieve: async () => ({}),
          items: { async *list() {} },
          create: async (params) => {
            stub.convCreateLog.push(params);
            // Return an object missing `id` to test the validator.
            return { object: "conversation" };
          },
        },
        chat: {
          completions: {
            create: async (params) => {
              stub.chatLog.push(params);
              if (stub.chatIndex === 0) return summaryReply("s");
              stub.chatIndex++;
              return assistantReply("ok");
            },
          },
        },
      },
    };
    try {
      await continueIn(
        { source_session_id: seededId, target_llm: "MiniMax", next_step: "x" },
        { openai: stub.client, minimax: stub.client },
        db,
        MODELS,
      );
      throw new Error("case8: expected UPSTREAM_ERROR, got success");
    } catch (err) {
      if (err?.code !== "UPSTREAM_ERROR") {
        throw new Error(`case8: expected UPSTREAM_ERROR, got ${err?.code}: ${err?.message}`);
      }
      if (!err?.message?.includes("conversation id")) {
        throw new Error(`case8: message should mention conversation id: ${err?.message}`);
      }
      console.log(`case8: malformed conversations.create -> UPSTREAM_ERROR (${err.message})`);
    }
  }

  db.close();
  console.log("OK");
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
