// One-off smoke test: spin up the app, open SSE, send JSON-RPC tools/list and tools/call.
// The MCP SSE transport returns 202 Accepted on POSTs; actual JSON-RPC responses
// arrive as `event: message` events on the open SSE stream.
import { setTimeout as sleep } from "node:timers/promises";
import { createApp } from "../dist/server/app.js";
import { createLogger } from "../dist/util/logger.js";
import { createMcpServer } from "../dist/server/mcp.js";
import { createTransportMap } from "../dist/server/sse.js";
import { openDatabase } from "../dist/db/sqlite.js";
import { TOOL_NAMES } from "../dist/tools/index.js";

class SseParser {
  constructor(stream) {
    this.reader = stream.getReader();
    this.buffer = "";
    this.pending = [];
    this.waiters = [];
    this.reading = false;
  }
  start() {
    this.reading = true;
    this._pump();
  }
  async _pump() {
    try {
      while (this.reading) {
        const { value, done } = await this.reader.read();
        if (done) {
          this.reading = false;
          this._flushWaiters(new Error("stream closed"));
          return;
        }
        this.buffer += new TextDecoder().decode(value, { stream: true });
        this._drain();
      }
    } catch (err) {
      this.reading = false;
      this._flushWaiters(err instanceof Error ? err : new Error(String(err)));
    }
  }
  _drain() {
    let sep = this.buffer.indexOf("\n\n");
    while (sep !== -1) {
      const raw = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 2);
      const ev = { event: "message", data: "" };
      for (const line of raw.split("\n")) {
        if (line.startsWith("event: ")) ev.event = line.slice(7).trim();
        else if (line.startsWith("data: ")) ev.data = line.slice(6);
      }
      this._dispatch(ev);
      sep = this.buffer.indexOf("\n\n");
    }
  }
  _dispatch(ev) {
    if (this.waiters.length > 0) {
      const w = this.waiters.shift();
      w.resolve(ev);
    } else {
      this.pending.push(ev);
    }
  }
  _flushWaiters(err) {
    for (const w of this.waiters) w.reject(err);
    this.waiters = [];
  }
  async nextEvent(predicate, timeoutMs = 5000) {
    for (;;) {
      const idx = this.pending.findIndex(predicate);
      if (idx >= 0) {
        return this.pending.splice(idx, 1)[0];
      }
      if (!this.reading) {
        throw new Error("stream closed before event arrived");
      }
      const ev = await new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w.resolve !== resolve);
          reject(new Error(`timeout waiting for event (${timeoutMs}ms)`));
        }, timeoutMs);
        this.waiters.push({
          resolve: (e) => {
            clearTimeout(t);
            resolve(e);
          },
          reject: (e) => {
            clearTimeout(t);
            reject(e);
          },
        });
      });
      if (predicate(ev)) return ev;
      // not the one we want, but might as well keep looking
    }
  }
  async close() {
    this.reading = false;
    try {
      await this.reader.cancel();
    } catch {
      // ignore
    }
  }
}

async function main() {
  const logger = createLogger("warn");
  const db = openDatabase(":memory:");
  const mcpServer = createMcpServer({
    llm: stubLlm(),
    db,
    models: { openai: "test-openai-model", minimax: "test-minimax-model" },
  });
  const transports = createTransportMap();
  const app = createApp({ logger, mcpServer, transports });
  const server = app.listen(0);
  await new Promise((r) => server.on("listening", r));
  const port = server.address().port;
  console.log(`server listening on :${port}`);

  // 1) Open SSE
  const sseRes = await fetch(`http://127.0.0.1:${port}/sse`, {
    headers: { Accept: "text/event-stream" },
  });
  if (!sseRes.ok || !sseRes.body) {
    throw new Error(`SSE open failed: ${sseRes.status}`);
  }
  const contentType = sseRes.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    throw new Error(`bad content-type: ${contentType}`);
  }
  console.log("SSE opened, content-type OK");

  // 2) Read the endpoint event
  const sse = new SseParser(sseRes.body);
  sse.start();
  const endpointEv = await sse.nextEvent((e) => e.event === "endpoint");
  const endpointPath = endpointEv.data;
  console.log("endpoint:", endpointPath);

  // 3) Send initialize (POST returns 202)
  const init = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0" },
    },
  };
  const initPost = await fetch(`http://127.0.0.1:${port}${endpointPath}`, {
    method: "POST",
    headers: { "content-type": "application/json", Accept: "application/json" },
    body: JSON.stringify(init),
  });
  if (initPost.status !== 202) {
    throw new Error(`initialize POST not 202: ${initPost.status}`);
  }
  const initEv = await sse.nextEvent(
    (e) => e.event === "message" && JSON.parse(e.data).id === 1,
  );
  const initBody = JSON.parse(initEv.data);
  console.log(
    "initialize result keys:",
    Object.keys(initBody.result || {}),
  );

  // 4) Send initialized notification
  const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
  const initNotif = await fetch(`http://127.0.0.1:${port}${endpointPath}`, {
    method: "POST",
    headers: { "content-type": "application/json", Accept: "application/json" },
    body: JSON.stringify(initialized),
  });
  if (initNotif.status !== 202) {
    throw new Error(`initialized POST not 202: ${initNotif.status}`);
  }

  // 5) tools/list
  const list = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
  const listPost = await fetch(`http://127.0.0.1:${port}${endpointPath}`, {
    method: "POST",
    headers: { "content-type": "application/json", Accept: "application/json" },
    body: JSON.stringify(list),
  });
  if (listPost.status !== 202) {
    throw new Error(`tools/list POST not 202: ${listPost.status}`);
  }
  const listEv = await sse.nextEvent(
    (e) => e.event === "message" && JSON.parse(e.data).id === 2,
  );
  const listBody = JSON.parse(listEv.data);
  const tools = listBody.result?.tools ?? [];
  const names = tools.map((t) => t.name).sort();
  const expected = [...TOOL_NAMES].sort();
  if (names.length !== expected.length || names.some((n, i) => n !== expected[i])) {
    throw new Error(
      `tools/list mismatch: got ${JSON.stringify(names)} expected ${JSON.stringify(expected)}`,
    );
  }
  console.log(`tools/list returned ${tools.length} tools:`, names.join(", "));

  // 6) tools/call
  const call = {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "list_sessions", arguments: { limit: 5, offset: 0 } },
  };
  const callPost = await fetch(`http://127.0.0.1:${port}${endpointPath}`, {
    method: "POST",
    headers: { "content-type": "application/json", Accept: "application/json" },
    body: JSON.stringify(call),
  });
  if (callPost.status !== 202) {
    throw new Error(`tools/call POST not 202: ${callPost.status}`);
  }
  const callEv = await sse.nextEvent(
    (e) => e.event === "message" && JSON.parse(e.data).id === 3,
  );
  const callBody = JSON.parse(callEv.data);
  if (callBody.error) {
    throw new Error(`tools/call error: ${JSON.stringify(callBody.error)}`);
  }
  const text = callBody.result?.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error(`tools/call missing text content: ${JSON.stringify(callBody)}`);
  }
  const env = JSON.parse(text);
  if (env.ok !== true) {
    throw new Error(`envelope not ok: ${JSON.stringify(env)}`);
  }
  console.log("tools/call envelope.data:", env.data);

  // 6b) tools/call for import_session (AC-4 e2e): insert a blob, then call again
  // to verify the (source_llm, external_session_id) upsert is observable via SSE.
  const importCall = (id, args) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "import_session", arguments: args },
  });
  const importArgs = {
    blob: {
      session_id: "conv_sse_1",
      source_llm: "openai",
      messages: [
        { role: "user", content: "sse hi", created_at: 1_700_000_000 },
      ],
      metadata: { tag: "sse-smoke" },
    },
    external_session_id: "sse-ext-1",
  };
  for (const [callId, args] of [
    [4, importArgs],
    [5, importArgs],
  ]) {
    const r = await fetch(`http://127.0.0.1:${port}${endpointPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify(importCall(callId, args)),
    });
    if (r.status !== 202) throw new Error(`import call POST not 202: ${r.status}`);
  }
  const importEv1 = await sse.nextEvent(
    (e) => e.event === "message" && JSON.parse(e.data).id === 4,
  );
  const importEv2 = await sse.nextEvent(
    (e) => e.event === "message" && JSON.parse(e.data).id === 5,
  );
  const importBody1 = JSON.parse(importEv1.data);
  const importBody2 = JSON.parse(importEv2.data);
  const importEnv1 = JSON.parse(importBody1.result.content[0].text);
  const importEnv2 = JSON.parse(importBody2.result.content[0].text);
  if (importEnv1.ok !== true || importEnv2.ok !== true) {
    throw new Error(`import SSE envelope not ok: ${JSON.stringify([importEnv1, importEnv2])}`);
  }
  if (importEnv1.data.id !== importEnv2.data.id) {
    throw new Error(
      `import SSE upsert mismatch: first id=${importEnv1.data.id} second id=${importEnv2.data.id}`,
    );
  }
  if (importEnv1.data.deduplicated !== false || importEnv2.data.deduplicated !== true) {
    throw new Error(
      `import SSE dedup flag wrong: first=${importEnv1.data.deduplicated} second=${importEnv2.data.deduplicated}`,
    );
  }
  console.log(
    `import_session SSE: id=${importEnv1.data.id}, hash=${importEnv1.data.blob_hash.slice(0, 8)}..., dedup=${importEnv1.data.deduplicated}->${importEnv2.data.deduplicated}`,
  );

  // 6c) AC-5 read paths over the SSE transport: list_sessions should now
  // return the row we just imported, and get_session(id) should return the
  // full blob.
  const listReadCall = (id, args) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "list_sessions", arguments: args },
  });
  const getReadCall = (id, args) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "get_session", arguments: args },
  });
  const rList = await fetch(`http://127.0.0.1:${port}${endpointPath}`, {
    method: "POST",
    headers: { "content-type": "application/json", Accept: "application/json" },
    body: JSON.stringify(listReadCall(6, { limit: 10, offset: 0 })),
  });
  if (rList.status !== 202) throw new Error(`list_sessions POST not 202: ${rList.status}`);
  const rGet = await fetch(`http://127.0.0.1:${port}${endpointPath}`, {
    method: "POST",
    headers: { "content-type": "application/json", Accept: "application/json" },
    body: JSON.stringify(getReadCall(7, { session_id: importEnv1.data.id })),
  });
  if (rGet.status !== 202) throw new Error(`get_session POST not 202: ${rGet.status}`);
  const rMissing = await fetch(`http://127.0.0.1:${port}${endpointPath}`, {
    method: "POST",
    headers: { "content-type": "application/json", Accept: "application/json" },
    body: JSON.stringify(getReadCall(8, { session_id: 9999 })),
  });
  if (rMissing.status !== 202) throw new Error(`get_session missing POST not 202: ${rMissing.status}`);

  const listReadEv = await sse.nextEvent(
    (e) => e.event === "message" && JSON.parse(e.data).id === 6,
  );
  const getReadEv = await sse.nextEvent(
    (e) => e.event === "message" && JSON.parse(e.data).id === 7,
  );
  const missReadEv = await sse.nextEvent(
    (e) => e.event === "message" && JSON.parse(e.data).id === 8,
  );
  const listEnv = JSON.parse(JSON.parse(listReadEv.data).result.content[0].text);
  const getEnv = JSON.parse(JSON.parse(getReadEv.data).result.content[0].text);
  const missEnv = JSON.parse(JSON.parse(missReadEv.data).result.content[0].text);
  if (listEnv.ok !== true) throw new Error(`list_sessions SSE not ok: ${JSON.stringify(listEnv)}`);
  if (listEnv.data.total < 1) {
    throw new Error(`list_sessions SSE total=${listEnv.data.total} (want >=1)`);
  }
  if (!Array.isArray(listEnv.data.items) || listEnv.data.items.length < 1) {
    throw new Error(`list_sessions SSE items empty: ${JSON.stringify(listEnv.data.items)}`);
  }
  if (listEnv.data.limit !== 10 || listEnv.data.offset !== 0) {
    throw new Error(`list_sessions SSE limit/offset echo wrong: ${JSON.stringify(listEnv.data)}`);
  }
  if (getEnv.ok !== true) throw new Error(`get_session SSE not ok: ${JSON.stringify(getEnv)}`);
  if (getEnv.data.id !== importEnv1.data.id) {
    throw new Error(`get_session SSE id mismatch: ${getEnv.data.id} vs ${importEnv1.data.id}`);
  }
  if (getEnv.data.blob.session_id !== "conv_sse_1") {
    throw new Error(`get_session SSE blob.session_id=${getEnv.data.blob.session_id} (want conv_sse_1)`);
  }
  if (missEnv.ok !== false || missEnv.error?.code !== "NOT_FOUND") {
    throw new Error(`get_session missing SSE: expected NOT_FOUND, got ${JSON.stringify(missEnv)}`);
  }
  console.log(
    `AC-5 SSE: list_sessions total=${listEnv.data.total} items=${listEnv.data.items.length}; get_session(id=${getEnv.data.id}) blob.session_id=${getEnv.data.blob.session_id}; missing -> NOT_FOUND`,
  );

  // 7) Verify inputSchema is JSON Schema (object with type + properties)
  const listSchema = tools.find((t) => t.name === "list_sessions")?.inputSchema;
  if (!listSchema || listSchema.type !== "object" || !listSchema.properties) {
    throw new Error(`inputSchema not JSON Schema: ${JSON.stringify(listSchema)}`);
  }
  console.log(
    "list_sessions.inputSchema properties:",
    Object.keys(listSchema.properties).join(", "),
  );

  // Cleanup
  await sse.close();
  await transports.closeAll();
  await mcpServer.close();
  db.close();
  await new Promise((r) => server.close(r));
  console.log("OK");
}

function stubLlm() {
  return {
    openai: {
      conversations: {
        retrieve: async (id) => ({ id, created_at: 1, metadata: null, object: "conversation" }),
        items: { async *list() {} },
      },
      chat: { completions: { create: async () => ({}) } },
    },
    minimax: {
      conversations: {
        retrieve: async (id) => ({ id, created_at: 1, metadata: null, object: "conversation" }),
        items: { async *list() {} },
      },
      chat: { completions: { create: async () => ({}) } },
    },
  };
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
