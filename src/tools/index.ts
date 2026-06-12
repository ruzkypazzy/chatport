// Barrel re-export of all 12 tool registration functions.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolHandlerDeps } from "./handler.js";

import { registerExportSession } from "./export_session.js";
import { registerImportSession } from "./import_session.js";
import { registerListSessions } from "./list_sessions.js";
import { registerGetSession } from "./get_session.js";
import { registerSummarizeProgress } from "./summarize_progress.js";
import { registerExtractOpenQuestions } from "./extract_open_questions.js";
import { registerExtractDecisions } from "./extract_decisions.js";
import { registerContinueIn } from "./continue_in.js";
import { registerDiffSessions } from "./diff_sessions.js";
import { registerBranchSession } from "./branch_session.js";
import { registerMergeSessions } from "./merge_sessions.js";
import { registerVerifySession } from "./verify_session.js";

export type ToolRegistrar = (server: McpServer, deps: ToolHandlerDeps) => void;

export const ALL_TOOL_REGISTRARS: ReadonlyArray<ToolRegistrar> = [
  registerExportSession,
  registerImportSession,
  registerListSessions,
  registerGetSession,
  registerSummarizeProgress,
  registerExtractOpenQuestions,
  registerExtractDecisions,
  registerContinueIn,
  registerDiffSessions,
  registerBranchSession,
  registerMergeSessions,
  registerVerifySession,
];

export const TOOL_NAMES: ReadonlyArray<string> = [
  "export_session",
  "import_session",
  "list_sessions",
  "get_session",
  "summarize_progress",
  "extract_open_questions",
  "extract_decisions",
  "continue_in",
  "diff_sessions",
  "branch_session",
  "merge_sessions",
  "verify_session",
];
