// Shared test utilities for the vitest suites under tests/.
//
// Exports:
//   - makeStubLlm(opts): build a stub LlmClient that records calls and
//     returns canned chat.completions responses or throws on demand.
//   - makeLlmClients(opts): wrap makeStubLlm into the LlmClients shape
//     (both openai and minimax point at the same stub unless `separate`
//     is set; tests can pass `separate: true` for split clients).
//   - makeTestDeps(opts): build a ToolHandlerDeps with a stub LLM, an
//     in-memory SQLite DB, and a fixed models bag.
//   - makeBlob(...): build a valid SessionBlob with sensible defaults
//     for the test suite.
//   - summaryReply, itemsReply, conversationReply, branchReply:
//     canned chat.completions.create responses shaped like the OpenAI
//     SDK's return.
//
// The stub mirrors the LlmClient interface (src/llm/openai-client.ts).
// Tests pass it to ToolHandlerDeps.llm and the tool handlers call into
// it via the interface, with no production code being modified.
import {
  openDatabase,
  type ChatportDatabase,
} from "../src/db/sqlite.js";
import type {
  LlmClient,
  LlmClients,
} from "../src/llm/openai-client.js";
import type { ToolHandlerDeps } from "../src/tools/handler.js";

export interface StubLlmOptions {
  /** Queue of canned chat.completions.create responses. Each is returned in order. */
  chatReplies?: unknown[];
  /** If set, chat.completions.create throws this error. */
  chatThrow?: Error;
  /** If > 0, chat.completions.create hangs for this many ms before returning. */
  chatHangMs?: number;
  /** Returned by conversations.create. */
  conversationId?: string;
  /** Yielded by conversations.items.list (inside { data, has_more }). */
  conversationItems?: Array<unknown>;
}

export interface StubLlm extends LlmClient {
  /** Append-only log of every chat.completions.create params object. */
  chatLog: unknown[];
  /** Append-only log of every conversations.create params object. */
  convCreateLog: unknown[];
}

export function makeStubLlm(opts: StubLlmOptions = {}): StubLlm {
  const chatLog: unknown[] = [];
  const convCreateLog: unknown[] = [];
  let chatIndex = 0;

  return {
    chatLog,
    convCreateLog,
    conversations: {
      retrieve: async (id: string) => ({ id, created_at: 1_700_000_000 }),
      create: async (params: { items: unknown[]; metadata?: unknown }) => {
        convCreateLog.push(params);
        return {
          id: opts.conversationId ?? "conv_new_test",
          object: "conversation",
        };
      },
      items: {
        async *list(_conversationId: string) {
          yield {
            data: opts.conversationItems ?? [],
            has_more: false,
          };
        },
      },
    },
    chat: {
      completions: {
        create: async (params: unknown) => {
          chatLog.push(params);
          if (opts.chatThrow) throw opts.chatThrow;
          if (opts.chatHangMs && opts.chatHangMs > 0) {
            // Never-resolving promise: withTimeout's race will always
            // pick the timeout branch, so the test reliably sees
            // UPSTREAM_TIMEOUT (rather than racing setTimeout vs the
            // post-hang "stub LLM exhausted" throw under vitest's
            // timer behavior).
            return new Promise<never>(() => undefined);
          }
          if (
            opts.chatReplies === undefined ||
            chatIndex >= opts.chatReplies.length
          ) {
            throw new Error(
              `stub LLM exhausted: chat.completions call #${chatIndex} but only ${opts.chatReplies?.length ?? 0} canned replies`,
            );
          }
          const reply = opts.chatReplies[chatIndex];
          chatIndex += 1;
          return reply;
        },
      },
    },
  };
}

export interface LlmClientsOptions {
  openai?: StubLlmOptions;
  minimax?: StubLlmOptions;
}

export function makeLlmClients(opts: LlmClientsOptions = {}): {
  llm: LlmClients;
  openai: StubLlm;
  minimax: StubLlm;
} {
  // If only one side is configured, the other side inherits the same
  // config. This makes the common case (one stub, two clients) a
  // one-liner. The continue_in UPSTREAM_ERROR test wants each client
  // to throw a different error and builds LlmClients directly via
  // makeStubLlm + { openai, minimax } assignment.
  const shared: StubLlmOptions =
    opts.openai === undefined && opts.minimax === undefined
      ? {}
      : (opts.openai ?? opts.minimax ?? {});
  const openaiStub = makeStubLlm(opts.openai ?? shared);
  const minimaxStub = makeStubLlm(opts.minimax ?? shared);
  return {
    llm: { openai: openaiStub, minimax: minimaxStub },
    openai: openaiStub,
    minimax: minimaxStub,
  };
}

export interface TestDepsOptions {
  llm?: LlmClients;
  db?: ChatportDatabase;
}

export function makeTestDeps(opts: TestDepsOptions = {}): ToolHandlerDeps {
  return {
    llm: opts.llm ?? makeLlmClients().llm,
    db: opts.db ?? openDatabase(":memory:"),
    models: { openai: "gpt-4o-mini", minimax: "MiniMax-M3" },
  };
}

export interface BlobOverrides {
  session_id?: string;
  source_llm?: "openai" | "MiniMax";
  messages?: Array<{ role: string; content: string; created_at: number }>;
  metadata?: Record<string, unknown>;
}

export function makeBlob(overrides: BlobOverrides = {}): {
  session_id: string;
  source_llm: "openai" | "MiniMax";
  messages: Array<{ role: string; content: string; created_at: number }>;
  metadata: Record<string, unknown>;
} {
  return {
    session_id: overrides.session_id ?? "conv_test_1",
    source_llm: overrides.source_llm ?? "openai",
    messages: overrides.messages ?? [
      { role: "user", content: "hi", created_at: 1_700_000_000 },
    ],
    metadata: overrides.metadata ?? {},
  };
}

// Canned chat.completions.create responses shaped like the OpenAI SDK's
// return. Each is a "happy path" response the LLM-using tools can parse.

export function summaryReply(summary: string): {
  id: string;
  choices: Array<{ index: number; message: { role: string; content: string }; finish_reason: string }>;
} {
  return {
    id: "cmpl_test_summary",
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

export function openQuestionsReply(
  items: Array<{ question: string; context: string }>,
): {
  id: string;
  choices: Array<{ index: number; message: { role: string; content: string }; finish_reason: string }>;
} {
  return {
    id: "cmpl_test_questions",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: JSON.stringify({ items }),
        },
        finish_reason: "stop",
      },
    ],
  };
}

export function decisionsReply(
  items: Array<{ decision: string; rationale: string; decided_at: string }>,
): {
  id: string;
  choices: Array<{ index: number; message: { role: string; content: string }; finish_reason: string }>;
} {
  return {
    id: "cmpl_test_decisions",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: JSON.stringify({ items }),
        },
        finish_reason: "stop",
      },
    ],
  };
}

export function assistantReply(content: string): {
  id: string;
  choices: Array<{ index: number; message: { role: string; content: string }; finish_reason: string }>;
} {
  return {
    id: "cmpl_test_assistant",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
  };
}

export function branchReply(rewritten: string): {
  id: string;
  choices: Array<{ index: number; message: { role: string; content: string }; finish_reason: string }>;
} {
  return {
    id: "cmpl_test_branch",
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
