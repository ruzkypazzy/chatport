// SQLite persistence layer for chatport sessions.
// Single source of truth for schema, migrations, and prepared statements.
//
// Safety contract (AC-13):
//   - `openDatabase(path)` is the only entry point. It returns a
//     `ChatportDatabase` whose methods are the only public API.
//   - On every open, the migration runner applies any pending
//     migrations (gated by `PRAGMA user_version`) and then bumps
//     `user_version` to the latest applied. Re-opening an existing
//     DB is a no-op past the current version — the migration is
//     idempotent and safe to run on every boot.
//   - **All queries against user data go through prepared statements.**
//     The four hot-path methods (insertSession, getSession,
//     findByExternalId, listSessions + its count helper) each build
//     a `.prepare()`-d statement inside `wrap()` and call it with
//     `?` positional bindings. User-controlled values (`source_llm`,
//     `external_session_id`, `id`, `limit`, `offset`, the blob) are
//     never interpolated into a SQL string.
//   - `raw()` is exposed for diagnostics and for the smoke suite to
//     verify schema state. **It must never be called with
//     user-controlled data** — it's a back door to the better-sqlite3
//     connection, not a query helper.
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { canonicalStringify } from "../util/canonical.js";

export interface SessionRow {
  id: number;
  source_llm: string;
  external_session_id: string | null;
  blob_json: string;
  blob_hash: string;
  parent_session_id: number | null;
  created_at: number;
}

export interface InsertSessionInput {
  source_llm: string;
  external_session_id: string | null;
  blob: unknown;
  parent_session_id?: number | null;
}

export interface InsertSessionResult {
  id: number;
  blob_hash: string;
  created_at: number;
}

export interface ListSessionsOptions {
  limit: number;
  offset: number;
}

export interface ListSessionsResult {
  items: SessionRow[];
  total: number;
}

export interface ChatportDatabase {
  insertSession(input: InsertSessionInput): InsertSessionResult;
  getSession(id: number): SessionRow | null;
  listSessions(options: ListSessionsOptions): ListSessionsResult;
  findByExternalId(
    source_llm: string,
    external_session_id: string,
  ): SessionRow | null;
  close(): void;
  /** Exposed for diagnostics / tests; do not call user-data SQL against it. */
  raw(): Database.Database;
}

type DbInstance = Database.Database;

export function openDatabase(path: string): ChatportDatabase {
  const db: DbInstance = new Database(path);
  // WAL gives concurrent readers + a single writer without locking the
  // whole DB; foreign_keys enforces the parent_session_id REFERENCES
  // sessions(id) constraint declared in v1.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return wrap(db);
}

/**
 * A migration is a `(db) => void` upgrade that bumps the schema from
 * `user_version = N-1` to `user_version = N`. Adding a future v2 means
 * pushing `{ version: 2, up: (db) => ... }` and the runner applies it
 * automatically on the next boot (and once more per DB-per-version
 * until everything is at HEAD).
 */
interface Migration {
  version: number;
  up: (db: DbInstance) => void;
}

const MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    up: (db) => {
      // The `sessions` table is the single source of persisted state.
      // `blob_json` is stored as the canonical-JSON form so that
      // verify_session (AC-12) can recompute the hash byte-for-byte
      // by re-hashing the stored string. `blob_hash` is the SHA-256
      // recorded at insert time; recomputing and comparing proves
      // the row wasn't tampered with.
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_llm TEXT NOT NULL,
          external_session_id TEXT,
          blob_json TEXT NOT NULL,
          blob_hash TEXT NOT NULL,
          parent_session_id INTEGER REFERENCES sessions(id),
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_source_external
          ON sessions (source_llm, external_session_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_created_at
          ON sessions (created_at);
      `);
    },
  },
];

function migrate(db: DbInstance): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  let applied = current;
  for (const m of MIGRATIONS) {
    if (applied < m.version) {
      m.up(db);
      applied = m.version;
    }
  }
  if (applied !== current) {
    // Bump user_version to the latest applied version. This is the
    // only place we set user_version, and the value is a static
    // integer derived from the MIGRATIONS array — never user data.
    db.pragma(`user_version = ${applied}`);
  }
}

function wrap(db: DbInstance): ChatportDatabase {
  // All five statements are .prepare()-d once per openDatabase() call
  // and reused on every method invocation. User-controlled values are
  // bound via `?` positional bindings; better-sqlite3 escapes them safely.
  const insertStmt = db.prepare(`
    INSERT INTO sessions
      (source_llm, external_session_id, blob_json, blob_hash, parent_session_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const getByIdStmt = db.prepare(`SELECT * FROM sessions WHERE id = ?`);
  const findByExternalStmt = db.prepare(`
    SELECT * FROM sessions
    WHERE source_llm = ? AND external_session_id = ?
    LIMIT 1
  `);
  const listStmt = db.prepare(`
    SELECT * FROM sessions
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `);
  const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM sessions`);

  function insertSession(input: InsertSessionInput): InsertSessionResult {
    // Store the canonical form so the hash is exactly the bytes we saved.
    // This makes verify_session (AC-12) trivial: just re-hash blob_json.
    const blob_json = canonicalStringify(input.blob);
    const blob_hash = createHash("sha256").update(blob_json).digest("hex");
    const created_at = Math.floor(Date.now() / 1000);
    const result = insertStmt.run(
      input.source_llm,
      input.external_session_id,
      blob_json,
      blob_hash,
      input.parent_session_id ?? null,
      created_at,
    );
    return {
      id: Number(result.lastInsertRowid),
      blob_hash,
      created_at,
    };
  }

  function getSession(id: number): SessionRow | null {
    const row = getByIdStmt.get(id) as SessionRow | undefined;
    return row ?? null;
  }

  function listSessions(options: ListSessionsOptions): ListSessionsResult {
    const items = listStmt.all(options.limit, options.offset) as SessionRow[];
    const total = (countStmt.get() as { n: number }).n;
    return { items, total };
  }

  function findByExternalId(
    source_llm: string,
    external_session_id: string,
  ): SessionRow | null {
    const row = findByExternalStmt.get(source_llm, external_session_id) as
      | SessionRow
      | undefined;
    return row ?? null;
  }

  return {
    insertSession,
    getSession,
    listSessions,
    findByExternalId,
    close: () => db.close(),
    raw: () => db,
  };
}

/**
 * Compute the SHA-256 hex hash of a blob using the same canonical JSON form
 * that openDatabase() persists. Exposed for verify_session (AC-12) and tests.
 */
export function hashBlob(blob: unknown): string {
  return createHash("sha256").update(canonicalStringify(blob)).digest("hex");
}
