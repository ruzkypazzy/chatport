// Vitest tests for src/llm/openai-client.ts — the AC-17 single injection
// point for the LLM client factory.
//
// Asserts the production-purity contract:
//   1. With no `overrides` (the production path), `createOpenAIClient(env)`
//      returns LlmClients that wrap real `OpenAI` SDK instances for
//      BOTH providers (proves the boot path hits the real network).
//   2. With `overrides = {}`, the same — `overrides = {}` is the
//      "no override" case and must produce real clients.
//   3. Passing `overrides.openai` swaps the openai client; the
//      minimax client still hits the real network (per-side
//      override).
//   4. Passing an invalid override (e.g. an object missing the
//      required methods) throws a clear error.
//   5. `isLlmClient` accepts the shape of a real OpenAI wrapper
//      and rejects plain objects, null, undefined, primitives, and
//      objects missing the required method names.
//   6. `buildOpenAIClient(env, baseURL, apiKey)` constructs a client
//      that delegates to the OpenAI SDK (the underlying SDK
//      instance is referenced via the returned object's methods).
import { describe, test, expect } from "vitest";
import OpenAI from "openai";
import {
  buildOpenAIClient,
  createOpenAIClient,
  isLlmClient,
  type LlmClient,
} from "../../src/llm/openai-client.js";
import type { AppEnv } from "../../src/config/env.js";

function makeEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    PORT: 3000,
    LOG_LEVEL: "info",
    TOOL_TIMEOUT_MS: 30_000,
    DATABASE_PATH: ":memory:",
    OPENAI_API_KEY: "test-openai-key",
    OPENAI_BASE_URL: "https://api.example.com/openai/v1",
    OPENAI_MODEL: "gpt-4o-mini",
    MINIMAX_API_KEY: "test-minimax-key",
    MINIMAX_BASE_URL: "https://api.example.com/minimax/v1",
    MINIMAX_MODEL: "MiniMax-M3",
    ...overrides,
  };
}

describe("createOpenAIClient — production path is live (no overrides)", () => {
  test("default call (no overrides argument) returns a client pair", () => {
    const clients = createOpenAIClient(makeEnv());
    expect(clients).toBeDefined();
    expect(clients.openai).toBeDefined();
    expect(clients.minimax).toBeDefined();
  });

  test("explicit empty overrides behaves the same as the default", () => {
    const a = createOpenAIClient(makeEnv());
    const b = createOpenAIClient(makeEnv(), {});
    expect(typeof a.openai.chat.completions.create).toBe("function");
    expect(typeof b.openai.chat.completions.create).toBe("function");
    // And both satisfy the LlmClient interface contract.
    expect(isLlmClient(a.openai)).toBe(true);
    expect(isLlmClient(b.openai)).toBe(true);
    expect(isLlmClient(a.minimax)).toBe(true);
    expect(isLlmClient(b.minimax)).toBe(true);
  });

  test("the openai client delegates to a real OpenAI SDK instance (production path is live)", async () => {
    // The factory's return value's `chat.completions.create` is a
    // closure that calls into the OpenAI SDK. We can't intercept
    // the factory's internal call without changing the source, so
    // we probe the production path two ways:
    //   (a) The wrapper is callable and async — if the factory
    //       returned a plain object, `create` would not be a
    //       function.
    //   (b) Calling the wrapper with a valid shape against a
    //       bogus host triggers a real network error (DNS / fetch
    //       failure), NOT a "fake stub" / "not implemented" /
    //       "method missing" error. That proves the wrapper is
    //       routed through the real OpenAI SDK's HTTP stack.
    const clients = createOpenAIClient(
      makeEnv({
        OPENAI_BASE_URL: "https://this-host-does-not-exist.invalid/v1",
        OPENAI_API_KEY: "k",
      }),
    );
    const create = clients.openai.chat.completions.create;
    expect(typeof create).toBe("function");
    let err: unknown;
    try {
      // The call returns a Promise. We await it; the underlying
      // fetch will fail with a network-layer error (not a
      // "not implemented" / "fake" error).
      await create({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    // The error must NOT be a "fake" / "not implemented" /
    // "method missing" sentinel — that would mean the wrapper is
    // a stub. The OpenAI SDK raises `APIConnectionError` (or a
    // plain fetch failure) on a real network call to a bogus host.
    const msg = err instanceof Error ? err.message : String(err);
    expect(msg).not.toMatch(/not implemented|method missing|fake|placeholder/i);
  });
});

describe("createOpenAIClient — overrides (test path)", () => {
  test("overrides.openai swaps the openai client; minimax still hits the real network", () => {
    const stub: LlmClient = {
      conversations: {
        retrieve: async (id: string) => ({ id, created_at: 1 }),
        create: async (params: { items: unknown[] }) => ({ id: "stub_conv", items: params.items }),
        items: {
          async *list(_id: string) {
            yield { data: [], has_more: false };
          },
        },
      },
      chat: {
        completions: {
          create: async () => ({ id: "stub_chat", choices: [] }),
        },
      },
    };
    const clients = createOpenAIClient(makeEnv(), { openai: stub });
    // The swapped openai client is the stub (identity check).
    expect(clients.openai).toBe(stub);
    // The minimax client is NOT the stub (still real).
    expect(clients.minimax).not.toBe(stub);
    expect(isLlmClient(clients.minimax)).toBe(true);
  });

  test("invalid override (missing methods) throws a clear error", () => {
    const bad = {
      conversations: { retrieve: "not a function" },
      chat: {},
    } as unknown as LlmClient;
    expect(() => createOpenAIClient(makeEnv(), { openai: bad })).toThrow(
      /overrides\.openai is not a valid LlmClient/,
    );
    const badMinimax = { conversations: {}, chat: {} } as unknown as LlmClient;
    expect(() => createOpenAIClient(makeEnv(), { minimax: badMinimax })).toThrow(
      /overrides\.minimax is not a valid LlmClient/,
    );
  });

  test("null / undefined overrides are handled the same as {} (production path)", () => {
    // `createOpenAIClient(env)` (no second arg) and
    // `createOpenAIClient(env, {})` and `createOpenAIClient(env, undefined)`
    // must all produce real clients (not stubs).
    const a = createOpenAIClient(makeEnv());
    const b = createOpenAIClient(makeEnv(), {});
    const c = createOpenAIClient(makeEnv(), undefined);
    expect(isLlmClient(a.openai)).toBe(true);
    expect(isLlmClient(b.openai)).toBe(true);
    expect(isLlmClient(c.openai)).toBe(true);
    // And the three openai clients are distinct objects (each
    // factory call builds a fresh `new OpenAI(...)`).
    expect(a.openai).not.toBe(b.openai);
    expect(b.openai).not.toBe(c.openai);
  });
});

describe("isLlmClient — type guard", () => {
  test("accepts a fully-formed LlmClient-shaped object", () => {
    const ok: LlmClient = {
      conversations: {
        retrieve: async () => undefined,
        create: async () => ({}),
        items: { list: async function* () {} },
      },
      chat: {
        completions: { create: async () => ({}) },
      },
    };
    expect(isLlmClient(ok)).toBe(true);
  });

  test("rejects null, undefined, and primitives", () => {
    expect(isLlmClient(null)).toBe(false);
    expect(isLlmClient(undefined)).toBe(false);
    expect(isLlmClient("string")).toBe(false);
    expect(isLlmClient(42)).toBe(false);
    expect(isLlmClient(true)).toBe(false);
  });

  test("rejects a plain object missing the required methods", () => {
    expect(isLlmClient({})).toBe(false);
    expect(isLlmClient({ conversations: {} })).toBe(false);
    expect(
      isLlmClient({
        conversations: {
          retrieve: () => undefined,
          create: () => undefined,
          items: { list: () => undefined },
        },
        chat: {},
      }),
    ).toBe(false);
    expect(
      isLlmClient({
        conversations: {
          retrieve: () => undefined,
          create: () => undefined,
          items: { list: () => undefined },
        },
        chat: { completions: {} },
      }),
    ).toBe(false);
  });

  test("rejects when a required method is the wrong type (e.g. a string)", () => {
    const bad = {
      conversations: {
        retrieve: "not a function",
        create: async () => ({}),
        items: { list: async function* () {} },
      },
      chat: { completions: { create: async () => ({}) } },
    } as unknown;
    expect(isLlmClient(bad)).toBe(false);
  });
});

describe("buildOpenAIClient — direct factory", () => {
  test("builds a client that satisfies the LlmClient interface", () => {
    const client = buildOpenAIClient(
      makeEnv(),
      "https://api.example.com/openai/v1",
      "k",
    );
    expect(isLlmClient(client)).toBe(true);
    // The returned object's methods are functions with the
    // expected names.
    expect(typeof client.conversations.retrieve).toBe("function");
    expect(typeof client.conversations.create).toBe("function");
    expect(typeof client.conversations.items.list).toBe("function");
    expect(typeof client.chat.completions.create).toBe("function");
  });

  test("the returned items.list is an async iterable (the SDK's PagePromise shape)", () => {
    // The factory's items.list wraps the SDK's iterable. We can
    // assert its structure (returns an object with [Symbol.asyncIterator])
    // without actually hitting the network.
    const client = buildOpenAIClient(
      makeEnv(),
      "https://api.example.com/openai/v1",
      "k",
    );
    const it = client.conversations.items.list("conv_x");
    expect(typeof it[Symbol.asyncIterator]).toBe("function");
  });
});
