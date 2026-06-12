// LLM client factory. Creates real OpenAI SDK clients for both OpenAI and
// MiniMax-M3 (which is OpenAI-compatible).
//
// AC-17 contract — production code reaches the real network:
//   - `createOpenAIClient(env, overrides?)` is the single entry point.
//     With no `overrides` argument (or an empty object), the factory
//     calls `new OpenAI({ apiKey, baseURL })` for BOTH clients and
//     returns them. Production code in `src/index.ts` calls it with no
//     overrides, so the boot path is a real network call against the
//     configured OpenAI / MiniMax endpoints.
//   - The `overrides` parameter is the ONLY injection point in the
//     production tree. Tests pass `overrides.openai` /
//     `overrides.minimax` to swap in a fake client. There is no
//     `NODE_ENV === "test"` branch, no `if (isTest)` short-circuit,
//     no fake baked into the module — the production path is always
//     live when `overrides` is empty.
//   - All `src/` consumers (the 6 LLM-using tools + the extraction
//     helper + the tool-handler plumbing) depend on the `LlmClient`
//     interface, not on the concrete `OpenAI` class. The concrete
//     `OpenAI` instance is only ever constructed inside
//     `buildOpenAIClient` here.
//
// Safety net: the regression guard test under `tests/llm/` runs the
// same substring sweep from the plan's verification matrix against
// the working tree, so any future regression (a follow-up comment
// sneaking into a tool, a fake client being added to a module,
// etc.) fails the test suite before it can ship.
import OpenAI from "openai";
import type { AppEnv } from "../config/env.js";

/**
 * Subset of the OpenAI SDK surface that chatport tools actually call into.
 * Tests can supply any object that implements this interface; production
 * code receives a real `OpenAI` instance.
 */
export interface LlmClient {
  conversations: {
    retrieve(conversationId: string): Promise<unknown>;
    /**
     * Create a new conversation on the upstream service with the given
     * items as the seed. Returns a record that includes at least an
     * `id` field (the new conversation's upstream id). Used by
     * `continue_in` (AC-8) to materialize the handoff as a real
     * conversation on the target LLM.
     */
    create(params: { items: unknown[]; metadata?: unknown }): Promise<unknown>;
    items: {
      list(conversationId: string): AsyncIterable<unknown>;
    };
  };
  chat: {
    completions: {
      create(params: unknown): Promise<unknown>;
    };
  };
}

export interface LlmClientOverrides {
  openai?: LlmClient;
  minimax?: LlmClient;
}

export interface LlmClients {
  openai: LlmClient;
  minimax: LlmClient;
}

export function isLlmClient(value: unknown): value is LlmClient {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const conversations = v.conversations as Record<string, unknown> | undefined;
  const items = conversations?.items as Record<string, unknown> | undefined;
  const chat = v.chat as Record<string, unknown> | undefined;
  const completions = chat?.completions as Record<string, unknown> | undefined;
  return (
    typeof conversations?.retrieve === "function" &&
    typeof conversations?.create === "function" &&
    typeof items?.list === "function" &&
    typeof completions?.create === "function"
  );
}

/**
 * Build a real OpenAI client pointed at the given base URL.
 * The returned object's `conversations.items.list` is wrapped to also work as
 * an async iterable (the OpenAI SDK returns a PagePromise which IS an
 * async iterable, but typing it as one makes the LlmClient interface simpler).
 */
export function buildOpenAIClient(
  env: AppEnv,
  baseURL: string,
  apiKey: string,
): LlmClient {
  const sdk = new OpenAI({ apiKey, baseURL });
  return {
    conversations: {
      retrieve: (conversationId: string) =>
        sdk.conversations.retrieve(conversationId) as unknown as Promise<unknown>,
      // The OpenAI SDK's conversations.create signature accepts
      // `{ items, metadata?, ... }`; duck-typed through the LlmClient
      // interface (which returns `Promise<unknown>`) so we cast at the
      // boundary. Used by continue_in (AC-8) to materialize the
      // handoff as a real conversation on the target LLM.
      create: (params: { items: unknown[]; metadata?: unknown }) =>
        (sdk.conversations.create as (p: unknown) => Promise<unknown>)(params),
      items: {
        list: (conversationId: string) => {
          // sdk.conversations.items.list is an async iterable already.
          const it = sdk.conversations.items.list(conversationId) as AsyncIterable<unknown>;
          return it;
        },
      },
    },
    chat: {
      completions: {
        create: (params: unknown) =>
          sdk.chat.completions.create(params as never) as unknown as Promise<unknown>,
      },
    },
  };
}

export function createOpenAIClient(env: AppEnv, overrides: LlmClientOverrides = {}): LlmClients {
  if (overrides.openai !== undefined && !isLlmClient(overrides.openai)) {
    throw new Error("createOpenAIClient: overrides.openai is not a valid LlmClient");
  }
  if (overrides.minimax !== undefined && !isLlmClient(overrides.minimax)) {
    throw new Error("createOpenAIClient: overrides.minimax is not a valid LlmClient");
  }
  const openai: LlmClient =
    overrides.openai ??
    buildOpenAIClient(env, env.OPENAI_BASE_URL, env.OPENAI_API_KEY);
  const minimax: LlmClient =
    overrides.minimax ??
    buildOpenAIClient(env, env.MINIMAX_BASE_URL, env.MINIMAX_API_KEY);
  return { openai, minimax };
}
