# Claude Project Standards — chatport

These rules apply whenever you (Claude) work in this repository.

## Mission
Build and maintain **chatport**, a Node.js 20+ / TypeScript (strict) Model Context Protocol server that exports, compresses, branches, merges, verifies, and resumes AI coding sessions between OpenAI and MiniMax M3, exposing 12 MCP tools over an SSE transport, persisting sessions in SQLite, and deploying cleanly to Railway.

## Tech stack (locked)
- **Language / module system**: TypeScript with `"strict": true`, `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, `"target": "ES2022"`. ESM (`"type": "module"`).
- **Runtime**: Node.js 20+.
- **MCP**: `@modelcontextprotocol/sdk` v1.x (uses `SSEServerTransport`).
- **HTTP**: Express 5 with `cors()`, `express.json({ limit: "5mb" })`.
- **LLM**: `openai` package — one client for OpenAI, one for MiniMax (OpenAI-compatible).
- **Storage**: `better-sqlite3` (synchronous, WAL mode, prepared statements).
- **Validation**: Zod schemas in `src/types.ts` are the single source of truth; converted to JSON Schema for MCP `inputSchema`.
- **Logging**: `pino` (with `pino-pretty` in dev).
- **Diff**: `diff` npm package.
- **Hashing**: `node:crypto` SHA-256 over canonical JSON (sorted keys).

## Coding rules
1. **No mocks in production code.** `src/` must make real HTTP calls to OpenAI and MiniMax. The only injection point is `createOpenAIClient(env, overrides?)` whose default `overrides = {}` uses real network. Tests may pass `overrides` to swap in fakes.
2. **No `// TODO`, no "implement later", no placeholder functions in `src/`.** If a function is exported, it must work end-to-end against the real LLM / DB.
3. **All async paths wrapped in `withTimeout`.** Default 30 000 ms (`TOOL_TIMEOUT_MS`).
4. **Every tool returns a structured envelope on failure.** Shape: `{ ok: false, error: { code, message, tool, details? } }`. Success shape: `{ ok: true, data }`.
5. **All SQLite queries use prepared statements.** No string interpolation of user data.
6. **Canonical JSON** is `JSON.stringify` with sorted keys (recursive) for stable hashing.
7. **Error policy**: handlers never throw across the MCP boundary — they always wrap the error via `toEnvelope(err, toolName)`.
8. **Process safety**: `uncaughtException` and `unhandledRejection` log and exit non-zero (Railway restarts).

## File layout
```
src/
  index.ts              -- bootstrap, signal handlers, server start
  config/env.ts         -- env loading & validation
  types.ts              -- Zod schemas + TS types (single source of truth)
  util/                 -- canonical, errors, timeout, logger
  server/               -- app factory, SSE transport, tool registration
  llm/                  -- OpenAI/MiniMax client factory, session parser
  db/                   -- sqlite layer (open, migrate, prepared statements)
  tools/                -- one file per MCP tool (12 files)
tests/                  -- vitest suites, mirroring src/
docs/                   -- operator notes, references
```

## Scripts
- `npm run dev`        — `tsx watch src/index.ts` (auto-reload)
- `npm run build`      — `tsc` (output to `dist/`)
- `npm start`          — `node dist/index.js` (production)
- `npm test`           — `vitest run`
- `npm run typecheck`  — `tsc --noEmit`

## Definition of done (per change)
- Code compiles under `npm run typecheck` (strict).
- New behavior has a vitest spec; running `npm test` exits 0.
- New env vars are documented in `.env.example`.
- No new `// TODO`, no placeholder code in `src/`.
- The README's tool reference and env table stay in sync with reality.

## Deploy target (Railway)
- `railway.json` declares `build.command = "npm run build"`, `deploy.startCommand = "npm start"`, `healthcheck.path = "/health"`.
- Health check is `GET /health` → `{ ok: true }`.
