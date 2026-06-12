// Vitest tests for the SSE transport.
//
// Spins up the real Express app on an ephemeral port, opens an SSE
// connection via node:http (to read the streaming `endpoint` event
// and capture the per-session transport id), then issues a
// JSON-RPC `tools/list` and `tools/call` over `POST /messages?sessionId=...`
// and asserts the round-trip envelope.
//
// The MCP SSE transport returns 202 Accepted on POSTs with no body —
// actual JSON-RPC responses arrive as `event: message` events on the
// open SSE stream. This test reads them from the same stream.
//
// The LLM client is a no-op stub: the LLM-using tools are not exercised
// here. Tool-handler-level coverage lives under tests/tools/*.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import http, { type IncomingMessage, type RequestOptions } from "node:http";
import { createApp } from "../../src/server/app.js";
import { createMcpServer } from "../../src/server/mcp.js";
import { createTransportMap } from "../../src/server/sse.js";
import { openDatabase } from "../../src/db/sqlite.js";
import { createLogger, type Logger } from "../../src/util/logger.js";
import { makeLlmClients } from "../_helpers.js";
import type { Server } from "node:http";

interface SseEvent {
  event: string;
  data: string;
}

interface SseHandshake {
  sessionId: string;
  /**
   * Pop the next SSE event whose `event` field matches `expectedEvent`
   * (default "message"). Resolves with the parsed event. Rejects on
   * stream close.
   */
  nextEvent: (expectedEvent?: string, timeoutMs?: number) => Promise<SseEvent>;
  close: () => void;
}

function openSse(port: number): Promise<SseHandshake> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/sse",
        method: "GET",
        headers: { Accept: "text/event-stream" },
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`SSE returned status ${res.statusCode}`));
          return;
        }
        const ct = String(res.headers["content-type"] ?? "");
        if (!ct.includes("text/event-stream")) {
          reject(new Error(`SSE content-type was ${ct}, expected text/event-stream`));
          return;
        }
        let buffer = "";
        // Pending waiters keyed by event name. When an event of the
        // expected type arrives, we resolve the first waiter (FIFO).
        const waiters: Array<{ event: string; resolve: (ev: SseEvent) => void; reject: (err: Error) => void; timer: NodeJS.Timeout | null }> = [];
        let streamClosed = false;

        const onChunk = (chunk: Buffer | string) => {
          buffer += chunk.toString("utf8");
          let sep = buffer.indexOf("\n\n");
          while (sep !== -1) {
            const raw = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const ev: SseEvent = { event: "message", data: "" };
            for (const line of raw.split("\n")) {
              if (line.startsWith("event: ")) ev.event = line.slice(7).trim();
              else if (line.startsWith("data: ")) ev.data = line.slice(6);
            }
            // Resolve the first waiter whose event matches (or any
            // waiter if event is "message" - the SDK always emits
            // responses as "message" events).
            const idx = waiters.findIndex(
              (w) => w.event === "*" || w.event === ev.event,
            );
            if (idx !== -1) {
              const w = waiters.splice(idx, 1)[0];
              if (w) {
                if (w.timer) clearTimeout(w.timer);
                w.resolve(ev);
              }
            }
            if (ev.event === "endpoint") {
              const m = /sessionId=([^&\s]+)/.exec(ev.data);
              if (!m) {
                reject(new Error(`SSE endpoint missing sessionId: ${ev.data}`));
                return;
              }
              const sessionId = m[1] ?? "";
              const handshake: SseHandshake = {
                sessionId,
                nextEvent: (expectedEvent = "message", timeoutMs = 5_000) =>
                  new Promise<SseEvent>((res2, rej2) => {
                    const w: { event: string; resolve: (ev: SseEvent) => void; reject: (err: Error) => void; timer: NodeJS.Timeout | null } = {
                      event: expectedEvent,
                      resolve: res2,
                      reject: rej2,
                      timer: null,
                    };
                    w.timer = setTimeout(() => {
                      const i = waiters.indexOf(w);
                      if (i !== -1) waiters.splice(i, 1);
                      rej2(new Error(`SSE: timed out waiting for event "${expectedEvent}"`));
                    }, timeoutMs);
                    waiters.push(w);
                  }),
                close: () => {
                  streamClosed = true;
                  req.destroy();
                },
              };
              resolve(handshake);
            }
            sep = buffer.indexOf("\n\n");
          }
        };
        res.on("data", onChunk);
        res.on("end", () => {
          streamClosed = true;
          // Reject all pending waiters so timeouts surface cleanly.
          for (const w of waiters) {
            if (w.timer) clearTimeout(w.timer);
            w.reject(new Error("SSE stream closed"));
          }
        });
        res.on("error", (err) => {
          streamClosed = true;
          for (const w of waiters) {
            if (w.timer) clearTimeout(w.timer);
            w.reject(err);
          }
        });
        // Suppress an unused-var warning; streamClosed is read by the
        // nextEvent promise's error path indirectly via the close.
        void streamClosed;
      },
    );
    req.on("error", (err) => reject(err));
    req.end();
  });
}

interface JsonRpcResponse {
  jsonrpc: string;
  id?: string | number | null;
  result?: {
    content: Array<{ type: string; text: string }>;
  };
  error?: { code: number; message: string };
}

function postJsonRpc(
  port: number,
  sessionId: string,
  body: unknown,
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const opts: RequestOptions = {
      hostname: "127.0.0.1",
      port,
      path: `/messages?sessionId=${encodeURIComponent(sessionId)}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": payload.length,
      },
    };
    const req = http.request(opts, (res: IncomingMessage) => {
      // Drain the response (we don't need the body; it's "Accepted").
      res.on("data", () => undefined);
      res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

let server: Server;
let port: number;
let logger: Logger;
let closeAll: () => Promise<void>;

beforeAll(async () => {
  // Pin logger to warn so vitest output stays clean.
  logger = createLogger("warn");
  const { llm } = makeLlmClients();
  const db = openDatabase(":memory:");
  const mcpServer = createMcpServer({
    llm,
    db,
    models: { openai: "gpt-4o-mini", minimax: "MiniMax-M3" },
  });
  const transports = createTransportMap();
  const app = createApp({ logger, mcpServer, transports });
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("could not determine port");
  port = addr.port;
  closeAll = async () => {
    await transports.closeAll();
    await mcpServer.close();
    db.close();
  };
});

afterAll(async () => {
  await closeAll();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("SSE transport", () => {
  test("GET /sse: returns text/event-stream + endpoint event with sessionId", async () => {
    const sse = await openSse(port);
    try {
      expect(sse.sessionId).toMatch(/^[0-9a-f-]{36}$/i);
    } finally {
      sse.close();
    }
  });

  test("POST /messages: tools/list round-trip returns all 12 tool names via SSE", async () => {
    const sse = await openSse(port);
    try {
      const post = postJsonRpc(port, sse.sessionId, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      });
      // The POST itself returns 202 Accepted; the JSON-RPC response
      // arrives as an SSE message event.
      const { status } = await post;
      expect(status).toBe(202);
      const ev = await sse.nextEvent("message", 5_000);
      const json = JSON.parse(ev.data) as JsonRpcResponse;
      expect(json.jsonrpc).toBe("2.0");
      expect(json.id).toBe(1);
      expect(json.error).toBeUndefined();
      expect(json.result).toBeDefined();
      const result = json.result;
      if (!result) throw new Error("no result");
      // The MCP tools/list response is { result: { tools: [...] } } —
      // each tool is a { name, title, description, inputSchema } object.
      // (tools/call is the one that wraps in { content: [{ type: "text", text: ... }] }.)
      const tools = (result as { tools: Array<{ name: string }> }).tools;
      expect(Array.isArray(tools)).toBe(true);
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(
        [
          "branch_session",
          "continue_in",
          "diff_sessions",
          "export_session",
          "extract_decisions",
          "extract_open_questions",
          "get_session",
          "import_session",
          "list_sessions",
          "merge_sessions",
          "summarize_progress",
          "verify_session",
        ].sort(),
      );
    } finally {
      sse.close();
    }
  });

  test("POST /messages with missing sessionId: 404 SESSION_NOT_FOUND", async () => {
    // No SSE handshake -> no transport -> the server returns 404.
    const { status } = await postJsonRpc(
      port,
      "00000000-0000-0000-0000-000000000000",
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      },
    );
    expect(status).toBe(404);
  });

  test("POST /messages with a real session: tools/call list_sessions returns the structured envelope via SSE", async () => {
    const sse = await openSse(port);
    try {
      const post = postJsonRpc(port, sse.sessionId, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "list_sessions",
          arguments: { limit: 5, offset: 0 },
        },
      });
      const { status } = await post;
      expect(status).toBe(202);
      const ev = await sse.nextEvent("message", 5_000);
      const json = JSON.parse(ev.data) as JsonRpcResponse;
      expect(json.error).toBeUndefined();
      const result = json.result;
      if (!result) throw new Error("no result");
      const first = result.content[0];
      if (!first) throw new Error("empty content");
      const env = JSON.parse(first.text) as {
        ok: boolean;
        data?: { items: unknown[]; total: number; limit: number; offset: number };
        error?: { code: string; message: string; tool: string };
      };
      expect(env.ok).toBe(true);
      if (env.ok && env.data) {
        expect(env.data.total).toBe(0);
        expect(env.data.limit).toBe(5);
        expect(env.data.offset).toBe(0);
        expect(Array.isArray(env.data.items)).toBe(true);
      }
    } finally {
      sse.close();
    }
  });
});
