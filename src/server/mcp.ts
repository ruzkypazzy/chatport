// chatport McpServer factory. Registers all 12 tools against a single McpServer.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ALL_TOOL_REGISTRARS, TOOL_NAMES } from "../tools/index.js";
import type { ToolHandlerDeps } from "../tools/handler.js";

export function createMcpServer(deps: ToolHandlerDeps): McpServer {
  const server = new McpServer(
    {
      name: "chatport",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
      instructions:
        "chatport exports, compresses, branches, merges, verifies, and resumes AI coding sessions between OpenAI and MiniMax M3.",
    },
  );

  for (const register of ALL_TOOL_REGISTRARS) {
    register(server, deps);
  }

  return server;
}

export const REGISTERED_TOOL_NAMES: ReadonlyArray<string> = TOOL_NAMES;
