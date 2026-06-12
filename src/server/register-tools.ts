// Iterates the 12 tool modules and registers them against the supplied McpServer.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ALL_TOOL_REGISTRARS, TOOL_NAMES } from "../tools/index.js";
import type { ToolHandlerDeps } from "../tools/handler.js";

export function registerAllTools(
  server: McpServer,
  deps: ToolHandlerDeps,
): ReadonlyArray<string> {
  for (const register of ALL_TOOL_REGISTRARS) {
    register(server, deps);
  }
  return TOOL_NAMES;
}
