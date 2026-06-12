// Express application factory. Mounts the MCP SSE transport and health check.
import express, { type Application, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "../util/logger.js";
import { mountSse, type TransportMap } from "./sse.js";

export interface AppDeps {
  logger: Logger;
  mcpServer: McpServer;
  transports: TransportMap;
}

export function createApp(deps: AppDeps): Application {
  const app = express();

  app.use(cors());

  // Per-request structured log line. Placed before route mounting so every
  // request, including SSE and /messages, is logged. Logs one line on
  // response finish with method, path, status, and duration_ms — the
  // standard structured-log shape for HTTP operational hygiene. SSE
  // responses never call `finish` until the client disconnects, so SSE
  // open/close is logged by the SSE module's own logger calls and not
  // duplicated here.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const startNs = process.hrtime.bigint();
    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
      deps.logger.info(
        {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          duration_ms: Math.round(durationMs * 1000) / 1000,
        },
        "request",
      );
    });
    next();
  });

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  // Mount SSE + /messages BEFORE the JSON body parser, because the MCP SDK
  // reads the request stream itself via raw-body. Routes added after this
  // point can opt into JSON parsing with a per-route middleware.
  mountSse(app, {
    mcpServer: deps.mcpServer,
    transports: deps.transports,
    logger: deps.logger,
  });

  return app;
}
