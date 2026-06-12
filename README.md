# chatport

**chatport** is a Model Context Protocol (MCP) server that exports, compresses, branches, merges, verifies, and resumes AI coding sessions between **OpenAI** and **MiniMax M3**. It exposes 12 MCP tools over a Server-Sent Events (SSE) transport, persists session blobs in SQLite, and is wired for one-click deploy to Railway.

> chatport lets you move long, expensive AI coding sessions between providers and across sessions without losing context.

## Why
- **Export** an existing session from OpenAI or MiniMax into a portable normalized blob.
- **Import** that blob into chatport's local SQLite store.
- **Summarize** the session to a token budget (via MiniMax-M3).
- **Extract** open questions and decisions for hand-off.
- **Branch** the session to explore an alternate path.
- **Merge** N sessions by `concat` / `interleave` / `summarize` strategy.
- **Continue in** a different LLM with the compressed context as a seed.
- **Diff** two stored sessions.
- **Verify** a stored blob against an expected SHA-256 to detect tampering.

## Stack
- Node.js 20+, TypeScript 6 (strict, NodeNext, ESM)
- `@modelcontextprotocol/sdk` v1.x with `SSEServerTransport`
- Express 5 + CORS
- `openai` (OpenAI and MiniMax-M3 endpoints, both OpenAI-compatible)
- `better-sqlite3` (synchronous, WAL, prepared statements)
- Zod 4 (single source of truth for all tool inputs)
- `pino` + `pino-pretty`
- Vitest + supertest

## Setup
```bash
# 1. Install deps (clean reproducible install from package-lock.json)
npm ci

# 2. Copy env template and fill in real keys
cp .env.example .env
$EDITOR .env

# 3. Type-check (should exit 0)
npm run typecheck
```

## Run
```bash
# Dev (auto-reload via tsx)
npm run dev

# Production
npm run build
npm start
```

The server listens on `PORT` (default `3000`) and exposes:
- `GET /health`     — `{"ok":true}` liveness probe (used by Railway)
- `GET /sse`        — MCP SSE transport (server → client stream)
- `POST /messages`  — JSON-RPC `tools/call` and `tools/list`

## The 12 MCP tools

Every tool is reachable through the SSE transport. The examples below are JSON-RPC `tools/call` payloads you can POST to `/messages?sessionId=<id>` after opening `/sse`.

| # | Tool | Purpose |
|---|------|---------|
| 1 | `export_session` | Pull a session from OpenAI or MiniMax-M3 into a normalized blob |
| 2 | `import_session` | Persist a blob to SQLite, return server-side id + SHA-256 |
| 3 | `list_sessions`  | Paginated read of stored sessions |
| 4 | `get_session`    | Read one session by id |
| 5 | `summarize_progress` | Token-bounded summary via MiniMax-M3 |
| 6 | `extract_open_questions` | Structured extraction of unresolved questions |
| 7 | `extract_decisions` | Structured extraction of decisions + rationale |
| 8 | `continue_in`    | Compress → seed → new conversation in target LLM |
| 9 | `diff_sessions`  | Message-level diff between two stored sessions |
| 10 | `branch_session`| Clone a parent, inject `alternate_path`, persist |
| 11 | `merge_sessions` | Combine N sessions by `concat` / `interleave` / `summarize` |
| 12 | `verify_session`| Recompute SHA-256, return tamper-detection result |

### 1. `export_session`
Pull an existing conversation from OpenAI or MiniMax into a normalized blob.
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "export_session",
    "arguments": {
      "source_llm": "openai",
      "conversation_id": "conv_abc123"
    }
  }
}
```
Returns `{ session_id, source_llm, messages: [{ role, content, created_at }], metadata }`.

### 2. `import_session`
Persist a normalized blob to SQLite. Returns the server-side row id and the canonical-JSON SHA-256 hash. Re-imports with the same `(source_llm, external_session_id)` upsert.
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "import_session",
    "arguments": {
      "blob": {
        "session_id": "conv_abc123",
        "source_llm": "openai",
        "messages": [
          { "role": "user", "content": "let's add caching", "created_at": 1700000000 },
          { "role": "assistant", "content": "redis with 60s TTL", "created_at": 1700000001 }
        ],
        "metadata": { "tag": "demo" }
      },
      "external_session_id": "my-stable-id"
    }
  }
}
```
Returns `{ id, blob_hash, deduplicated, created_at }`.

### 3. `list_sessions`
Paginated read of stored sessions, newest first. Defaults `limit=20`, `offset=0`.
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "list_sessions",
    "arguments": { "limit": 20, "offset": 0 }
  }
}
```
Returns `{ items: [...], total, limit, offset }`.

### 4. `get_session`
Read a single session blob by its server-side id. `NOT_FOUND` on a missing id.
```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "get_session",
    "arguments": { "session_id": 42 }
  }
}
```
Returns `{ id, source_llm, external_session_id, blob, blob_hash, parent_session_id, created_at }`.

### 5. `summarize_progress`
Produce a token-bounded summary of a stored session via MiniMax-M3. Defaults `target_tokens=4000`, `compressor="MiniMax-M3"`.
```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tools/call",
  "params": {
    "name": "summarize_progress",
    "arguments": {
      "session_id": 42,
      "target_tokens": 4000,
      "compressor": "MiniMax-M3"
    }
  }
}
```
Returns `{ session_id, summary, target_tokens, compressor }`.

### 6. `extract_open_questions`
Pull out unresolved questions from a stored session. Backed by MiniMax-M3.
```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "tools/call",
  "params": {
    "name": "extract_open_questions",
    "arguments": { "session_id": 42 }
  }
}
```
Returns `{ session_id, items: [{ question, context }] }`.

### 7. `extract_decisions`
Pull out the decisions and their rationale from a stored session. Backed by MiniMax-M3.
```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tools/call",
  "params": {
    "name": "extract_decisions",
    "arguments": { "session_id": 42 }
  }
}
```
Returns `{ session_id, items: [{ decision, rationale, decided_at }] }`.

### 8. `continue_in`
Compress a stored session, seed a new conversation in the target LLM, and return the new id. 60 s timeout.
```json
{
  "jsonrpc": "2.0",
  "id": 8,
  "method": "tools/call",
  "params": {
    "name": "continue_in",
    "arguments": {
      "source_session_id": 42,
      "target_llm": "MiniMax",
      "next_step": "set up the cache layer",
      "target_tokens": 4000
    }
  }
}
```
Returns `{ new_session_id, source_llm, seeded_messages }`.

### 9. `diff_sessions`
Message-level diff between two stored sessions. `NOT_FOUND` on either missing id.
```json
{
  "jsonrpc": "2.0",
  "id": 9,
  "method": "tools/call",
  "params": {
    "name": "diff_sessions",
    "arguments": { "session_id_a": 42, "session_id_b": 43 }
  }
}
```
Returns `{ added: [...], removed: [...], modified: [{ index, a, b }] }`.

### 10. `branch_session`
Clone a parent session and rewrite the opening message with `alternate_path` (via MiniMax-M3). Stores the new row with `parent_session_id` set.
```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "method": "tools/call",
  "params": {
    "name": "branch_session",
    "arguments": {
      "parent_session_id": 42,
      "alternate_path": "Add observability from day one"
    }
  }
}
```
Returns `{ session_id, parent_session_id }`.

### 11. `merge_sessions`
Combine N stored sessions by strategy. `concat` appends in input order, `interleave` round-robins by `created_at`, `summarize` uses MiniMax-M3 to produce a single assistant message.
```json
{
  "jsonrpc": "2.0",
  "id": 11,
  "method": "tools/call",
  "params": {
    "name": "merge_sessions",
    "arguments": {
      "session_ids": [42, 43],
      "strategy": "concat",
      "target_llm": "openai"
    }
  }
}
```
Returns `{ session_id, strategy, input_session_ids, message_count }`.

### 12. `verify_session`
Recompute the canonical-JSON SHA-256 of a stored blob and compare to an optional `expected_hash`. Used for tamper detection.
```json
{
  "jsonrpc": "2.0",
  "id": 12,
  "method": "tools/call",
  "params": {
    "name": "verify_session",
    "arguments": {
      "session_id": 42,
      "expected_hash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  }
}
```
Returns `{ session_id, matches, computed_hash }`.

## Environment
See [`.env.example`](.env.example). The full set:

| Var | Default | Notes |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `LOG_LEVEL` | `info` | pino log level |
| `TOOL_TIMEOUT_MS` | `30000` | Default per-tool timeout (ms) |
| `DATABASE_PATH` | `./chatport.db` | SQLite file path |
| `OPENAI_API_KEY` | *(empty)* | OpenAI API key |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI base URL |
| `OPENAI_MODEL` | `gpt-4o-mini` | Default OpenAI model |
| `MINIMAX_API_KEY` | *(empty)* | MiniMax M3 API key |
| `MINIMAX_BASE_URL` | `https://api.minimax.io/v1` | MiniMax base URL |
| `MINIMAX_MODEL` | `MiniMax-M3` | Default MiniMax model |

## Tests
```bash
npm test           # full vitest run
npm run test:watch # watch mode
```

## Project standards
See [`claude.md`](./claude.md) for the locked tech stack, file layout, coding rules, and definition of done.

## Deploy to Railway

`railway.json` declares the build, start, and healthcheck config that Railway picks up:
- `build.buildCommand = "npm run build"`
- `deploy.startCommand = "npm start"`
- `deploy.healthcheckPath = "/health"`

Deploy steps:
```bash
# Install the Railway CLI: https://docs.railway.com/guides/cli
npm install -g @railway/cli

# Login and link to a Railway project (create one in the dashboard first)
railway login
railway link

# Push env vars from your local .env (or set them in the Railway dashboard)
railway variables set $(grep -v '^#' .env | xargs)

# Deploy
railway up
```

The `better-sqlite3` native module and `pino` logs are wired to Railway's ephemeral filesystem by default. For production persistence, attach a Railway Volume and point `DATABASE_PATH` at a path under `/data` (or similar). The `/health` endpoint is hit periodically; a non-200 response triggers a restart.

> Note: The MCP SSE transport is the spec'd one. The newer Streamable HTTP transport is a follow-up; see `.humanize/rlcr/.../plan.md` for details.

## License
ISC (default — change as needed before publishing).
