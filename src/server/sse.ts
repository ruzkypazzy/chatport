// SSE transport: pairs `GET /sse` with `POST /messages?sessionId=...` per MCP spec.
// Mounts the routes against an Express app and tracks per-session transports.
import { randomUUID } from "node:crypto";
import type { Application, Request, Response } from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "../util/logger.js";

const HEARTBEAT_INTERVAL_MS = 15_000;
const SSE_ENDPOINT_PATH = "/messages";

export interface TransportMap {
  get(sessionId: string): SSEServerTransport | undefined;
  set(sessionId: string, transport: SSEServerTransport): void;
  delete(sessionId: string): boolean;
  size(): number;
  closeAll(): Promise<void>;
}

export function createTransportMap(): TransportMap {
  const map = new Map<string, SSEServerTransport>();

  return {
    get(sessionId) {
      return map.get(sessionId);
    },
    set(sessionId, transport) {
      map.set(sessionId, transport);
    },
    delete(sessionId) {
      return map.delete(sessionId);
    },
    size() {
      return map.size;
    },
    async closeAll() {
      const transports = Array.from(map.values());
      map.clear();
      await Promise.all(transports.map((t) => t.close().catch(() => undefined)));
    },
  };
}

export interface SseDeps {
  mcpServer: McpServer;
  transports: TransportMap;
  logger: Logger;
  // Used for absolute endpoint URLs. Defaults to deriving from req.
  publicBaseUrl?: (req: Request) => string;
}

/**
 * Mount GET /sse and POST /messages?sessionId=... on the given Express app.
 * Each GET creates a new SSEServerTransport, starts the SSE stream, and
 * connects the transport to the McpServer. The transport is stored in the
 * transport map by its UUID session id; POST messages are routed back to the
 * right transport via that map.
 */
export function mountSse(app: Application, deps: SseDeps): void {
  app.get("/sse", async (req: Request, res: Response) => {
    // Express may not have a body-parser installed for the synthetic session id;
    // construct an absolute endpoint URL when possible, fall back to the path.
    const endpoint = `${SSE_ENDPOINT_PATH}?sessionId=${randomUUID()}`;
    const transport = new SSEServerTransport(endpoint, res);

    deps.transports.set(transport.sessionId, transport);
    deps.logger.info(
      { sessionId: transport.sessionId, transports: deps.transports.size() },
      "sse connection opened",
    );

    const cleanup = () => {
      deps.transports.delete(transport.sessionId);
      deps.logger.info(
        { sessionId: transport.sessionId, transports: deps.transports.size() },
        "sse connection closed",
      );
    };
    transport.onclose = cleanup;
    transport.onerror = (err) => {
      deps.logger.error({ err, sessionId: transport.sessionId }, "sse transport error");
    };

    // Heartbeat keeps idle proxies from killing the connection.
    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, HEARTBEAT_INTERVAL_MS);
    res.on("close", () => clearInterval(heartbeat));

    try {
      // connect() calls transport.start() internally and wires the transport
      // to the McpServer for JSON-RPC messaging.
      await deps.mcpServer.connect(transport);
    } catch (err) {
      deps.logger.error({ err, sessionId: transport.sessionId }, "failed to start sse transport");
      clearInterval(heartbeat);
      cleanup();
      if (!res.headersSent) {
        res.status(500).end("failed to start sse transport");
      } else {
        res.end();
      }
    }
  });

  app.post("/messages", async (req: Request, res: Response) => {
    const sessionId = readSessionId(req);
    if (!sessionId) {
      res.status(400).json({
        ok: false,
        error: { code: "BAD_REQUEST", message: "missing sessionId query parameter" },
      });
      return;
    }
    const transport = deps.transports.get(sessionId);
    if (!transport) {
      res.status(404).json({
        ok: false,
        error: {
          code: "SESSION_NOT_FOUND",
          message: `no active SSE session for sessionId=${sessionId}`,
        },
      });
      return;
    }
    try {
      // Let SSEServerTransport read the body via raw-body. The express.json
      // parser is intentionally not applied to /messages — see app.ts.
      await transport.handlePostMessage(req, res);
    } catch (err) {
      deps.logger.error({ err, sessionId }, "failed to handle posted message");
      if (!res.headersSent) {
        res.status(500).json({
          ok: false,
          error: { code: "INTERNAL_ERROR", message: "failed to handle posted message" },
        });
      }
    }
  });
}

function readSessionId(req: Request): string | undefined {
  if (typeof req.query.sessionId === "string" && req.query.sessionId.length > 0) {
    return req.query.sessionId;
  }
  return undefined;
}
