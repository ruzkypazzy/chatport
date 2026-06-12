// chatport bootstrap: load env, init logger, build LLM client + DB + McpServer,
// mount the app, listen, and install signal handlers.
import { loadEnv } from "./config/env.js";
import { createLogger } from "./util/logger.js";
import { createApp } from "./server/app.js";
import { createMcpServer } from "./server/mcp.js";
import { createTransportMap } from "./server/sse.js";
import { createOpenAIClient } from "./llm/openai-client.js";
import { openDatabase } from "./db/sqlite.js";

function installSignalHandlers(logger: ReturnType<typeof createLogger>, close: () => Promise<void>): void {
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaughtException");
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ reason }, "unhandledRejection");
    process.exit(1);
  });
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutdown signal received");
    try {
      await close();
    } catch (err) {
      logger.error({ err }, "error during shutdown");
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);

  // Real LLM clients by default. Tests pass `overrides` to swap in stubs;
  // production never does. See src/llm/openai-client.ts for the contract.
  const llm = createOpenAIClient(env);

  // SQLite persistence. Open the file, run idempotent migrations, and keep
  // the connection open for the lifetime of the process.
  const db = openDatabase(env.DATABASE_PATH);

  // Per-provider model names are picked up here once and threaded into
  // every LLM-using tool via ToolHandlerDeps. summarize_progress /
  // extract_* / continue_in / branch_session / merge_sessions all need
  // to know which model to pass to chat.completions.create().
  const models = { openai: env.OPENAI_MODEL, minimax: env.MINIMAX_MODEL };

  const mcpServer = createMcpServer({ llm, db, models });
  const transports = createTransportMap();
  const app = createApp({ logger, mcpServer, transports });

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, database: env.DATABASE_PATH }, "chatport listening");
  });

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await transports.closeAll();
    await mcpServer.close();
    db.close();
  };

  installSignalHandlers(logger, close);
}

void main();

