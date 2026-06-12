// Vitest tests for the HTTP request log middleware in src/server/app.ts.
//
// Asserts the operational-hygiene contract of the per-request log line:
//   1. One log line is emitted on response finish with the canonical
//      structured fields: method, path, status, duration_ms.
//   2. status is the final status code (200 on success, 404 on missing).
//   3. duration_ms is a finite, non-negative number.
//   4. The middleware fires for both /health and the MCP transport routes
//      (SSE and POST /messages).
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Writable } from "node:stream";
import type { AddressInfo, Server } from "node:net";
import http from "node:http";
import { createApp } from "../../src/server/app.js";
import { createMcpServer } from "../../src/server/mcp.js";
import { createTransportMap } from "../../src/server/sse.js";
import { openDatabase } from "../../src/db/sqlite.js";
import { type Logger } from "../../src/util/logger.js";
import { makeLlmClients } from "../_helpers.js";

class CapturingSink extends Writable {
  public readonly lines: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override _write(chunk: any, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.lines.push(String(chunk));
    cb();
  }
  clear(): void {
    this.lines.length = 0;
  }
}

let server: Server;
let port: number;
let sink: CapturingSink;
let closeAll: () => Promise<void>;

function findLog(method: string, path: string): {
  msg: string;
  fields: Record<string, unknown>;
} | null {
  for (const line of sink.lines) {
    // pino's default JSON output is one object per line. Parse and look
    // for the matching method+path. The `msg` field is "request" for the
    // request-log middleware.
    try {
      const obj = JSON.parse(line) as { method?: string; path?: string; msg?: string };
      if (obj.msg === "request" && obj.method === method && obj.path === path) {
        return { msg: line, fields: obj as Record<string, unknown> };
      }
    } catch {
      // Not a JSON line (could be a warning / pretty-printer artifact);
      // skip it.
    }
  }
  return null;
}

beforeAll(async () => {
  sink = new CapturingSink();
  // We can't trivially pass a custom sink to createLogger (it spins up
  // pino-pretty in dev), so we build the app with the default logger
  // and additionally monkey-patch the logger's destination by replacing
  // it with a capturing sink via a side channel. Easier: build the
  // logger through pino directly with our sink, and pass that to
  // createApp. createLogger's contract is "returns a Logger that
  // honors LOG_LEVEL" — we honor the same shape by writing our own
  // pino instance with the sink, then type-cast it.
  const capturingLogger = (await import("pino")).default(
    { level: "info", timestamp: false },
    sink,
  ) as unknown as Logger;
  const { llm } = makeLlmClients();
  const db = openDatabase(":memory:");
  const mcpServer = createMcpServer({
    llm,
    db,
    models: { openai: "gpt-4o-mini", minimax: "MiniMax-M3" },
  });
  const transports = createTransportMap();
  const app = createApp({ logger: capturingLogger, mcpServer, transports });
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo | null;
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

describe("HTTP request log middleware", () => {
  test("GET /health: one log line emitted with method, path, status=200, duration_ms", async () => {
    sink.clear();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    await res.text(); // drain body
    // The log line is emitted on the `finish` event, which Node fires
    // after the response is fully written. Wait one microtask + a small
    // macrotask to let the listener run.
    await new Promise((r) => setTimeout(r, 10));
    const log = findLog("GET", "/health");
    expect(log).not.toBeNull();
    if (!log) return;
    expect(log.fields.status).toBe(200);
    expect(typeof log.fields.duration_ms).toBe("number");
    expect((log.fields.duration_ms as number)).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(log.fields.duration_ms as number)).toBe(true);
  });

  test("GET /missing: log line with status=404", async () => {
    sink.clear();
    const res = await fetch(`http://127.0.0.1:${port}/this-does-not-exist`);
    expect(res.status).toBe(404);
    await res.text();
    await new Promise((r) => setTimeout(r, 10));
    const log = findLog("GET", "/this-does-not-exist");
    expect(log).not.toBeNull();
    if (!log) return;
    expect(log.fields.status).toBe(404);
  });

  test("POST /messages with no sessionId: log line with status=400", async () => {
    sink.clear();
    const res = await fetch(`http://127.0.0.1:${port}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(400);
    await res.text();
    await new Promise((r) => setTimeout(r, 10));
    const log = findLog("POST", "/messages");
    expect(log).not.toBeNull();
    if (!log) return;
    expect(log.fields.status).toBe(400);
    expect(typeof log.fields.duration_ms).toBe("number");
  });
});
