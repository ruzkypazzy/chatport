// One-off smoke test for AC-13: SQLite layer (schema migration + query
// safety).
//
// Verifies that:
//   1. Fresh in-memory DB runs the migration: the `sessions` table is
//      created, the two declared indexes exist, and PRAGMA user_version
//      ends up at 1 (so the migration is gated, not free-running).
//   2. In-memory round-trip works: insertSession returns a positive
//      numeric id and a 64-char SHA-256 hex hash; getSession reads
//      back the same row (blob_json matches the canonical form).
//   3. Re-opening the same file path is idempotent: the row survives
//      close+reopen, PRAGMA user_version is unchanged, and no
//      duplicate tables or indexes are created.
//   4. User data with SQL-injection-like characters is stored as
//      literal text and the `sessions` table is still present after
//      the attempt (proves no string interpolation of user data).
//   5. All five prepared-statement-backed methods work
//      (insertSession, getSession, findByExternalId, listSessions,
//      and the count helper exercised through listSessions).
//   6. Foreign keys are enabled (PRAGMA foreign_keys=1) and an insert
//      with parent_session_id pointing at a non-existent row is
//      rejected (FK constraint, no orphan sessions).
//   7. listSessions with an empty DB returns total=0, items=[].
//   8. listSessions with limit/offset paginates correctly and
//      returns rows in `created_at DESC, id DESC` order.
//   9. findByExternalId returns null for a missing entry.
//  10. hashBlob returns a 64 lowercase hex string, is deterministic,
//      and is key-order independent (same content, different property
//      order -> same hash).
//  11. Source-level audit: src/db/sqlite.ts uses prepared statements
//      for every user-data query (5+ .prepare() calls) and the only
//      db.exec() carries the static schema (no user data).
//  12. Edge cases: special characters (NUL, quotes, backslashes,
//      Unicode) in user data are stored verbatim.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { openDatabase, hashBlob } from "../dist/db/sqlite.js";

function check(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

async function main() {
  // Case 1: Fresh in-memory DB -> sessions table + 2 indexes + user_version=1.
  {
    const db = openDatabase(":memory:");
    const tableRow = db
      .raw()
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'",
      )
      .get();
    check(tableRow !== undefined, "sessions table should exist after migration");
    const userVersion = db.raw().pragma("user_version", { simple: true });
    check(userVersion === 1, `user_version should be 1, got ${userVersion}`);
    const idxRows = db
      .raw()
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sessions'",
      )
      .all();
    const idxNames = idxRows.map((r) => r.name);
    check(
      idxNames.includes("idx_sessions_source_external"),
      `idx_sessions_source_external should exist (got ${idxNames.join(", ")})`,
    );
    check(
      idxNames.includes("idx_sessions_created_at"),
      `idx_sessions_created_at should exist (got ${idxNames.join(", ")})`,
    );
    db.close();
    console.log(
      `case1: fresh DB -> sessions table + 2 indexes + user_version=${userVersion}`,
    );
  }

  // Case 2: In-memory round-trip.
  {
    const db = openDatabase(":memory:");
    const blob = {
      session_id: "conv_rt_1",
      source_llm: "openai",
      messages: [
        { role: "user", content: "hello", created_at: 1_700_000_000 },
      ],
      metadata: { tag: "rt" },
    };
    const ins = db.insertSession({
      source_llm: "openai",
      external_session_id: "rt-ext-1",
      blob,
    });
    check(ins.id > 0, `id should be positive, got ${ins.id}`);
    check(
      /^[0-9a-f]{64}$/.test(ins.blob_hash),
      `blob_hash should be 64 lowercase hex, got ${ins.blob_hash}`,
    );
    const row = db.getSession(ins.id);
    check(row !== null, "row should be readable by id");
    check(row.id === ins.id, "ids should match");
    // blob_json is the canonical-JSON form (sorted keys), so the
    // canonicalized blob string is the comparison target.
    const { canonicalStringify } = await import("../dist/util/canonical.js");
    check(
      row.blob_json === canonicalStringify(blob),
      "blob_json should match canonicalStringify(blob)",
    );
    check(row.blob_hash === ins.blob_hash, "blob_hash should match what insert returned");
    db.close();
    console.log("case2: round-trip insertSession -> getSession works");
  }

  // Case 3: Re-opening the same file path is idempotent.
  {
    const dir = mkdtempSync(join(tmpdir(), "chatport-db-"));
    const path = join(dir, "test.db");
    try {
      // Open, insert, close.
      const db1 = openDatabase(path);
      const ins = db1.insertSession({
        source_llm: "openai",
        external_session_id: "idemp-1",
        blob: {
          session_id: "conv_idemp_1",
          source_llm: "openai",
          messages: [],
          metadata: {},
        },
      });
      db1.close();

      // Re-open on a different ChatportDatabase instance, verify row + version.
      const db2 = openDatabase(path);
      const row = db2.getSession(ins.id);
      check(row !== null, "row should survive re-open");
      const userVersion = db2.raw().pragma("user_version", { simple: true });
      check(userVersion === 1, `user_version should still be 1, got ${userVersion}`);
      // No duplicate table / no duplicate indexes.
      const tableCount = db2
        .raw()
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='sessions'")
        .get();
      check(tableCount.n === 1, `sessions table should appear exactly once, got ${tableCount.n}`);
      const idxCounts = db2
        .raw()
        .prepare(
          "SELECT name, COUNT(*) AS n FROM sqlite_master WHERE type='index' AND tbl_name='sessions' GROUP BY name",
        )
        .all();
      for (const ic of idxCounts) {
        check(ic.n === 1, `index ${ic.name} should appear exactly once, got ${ic.n}`);
      }
      db2.close();
      console.log(
        `case3: re-open is idempotent (row preserved, user_version unchanged, no dup tables/indexes)`,
      );
    } finally {
      // Cleanup: try to remove the db file plus the WAL sidecars.
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        try {
          rmSync(path + suffix, { force: true });
        } catch {
          // ignore
        }
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  // Case 4: SQL-injection characters are stored as literal text.
  {
    const db = openDatabase(":memory:");
    const evil = "'; DROP TABLE sessions; --";
    const blob = {
      session_id: evil,
      source_llm: "openai",
      messages: [
        { role: "user", content: evil, created_at: 1_700_000_000 },
      ],
      metadata: { evil },
    };
    const ins = db.insertSession({
      source_llm: "openai",
      external_session_id: evil,
      blob,
    });
    const row = db.getSession(ins.id);
    check(row !== null, "row with evil data should exist");
    check(
      row.blob_json.includes(evil),
      "evil content should be stored as literal text in blob_json",
    );
    // The sessions table is still here -> the DROP didn't execute.
    const tableCheck = db
      .raw()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
      .get();
    check(tableCheck !== undefined, "sessions table should still exist (no SQL injection)");
    db.close();
    console.log("case4: SQL-injection characters stored as literal text (no interpolation)");
  }

  // Case 5: All prepared-statement methods work end-to-end.
  {
    const db = openDatabase(":memory:");
    for (let i = 0; i < 5; i++) {
      db.insertSession({
        source_llm: "openai",
        external_session_id: `ext-${i}`,
        blob: {
          session_id: `s${i}`,
          source_llm: "openai",
          messages: [{ role: "user", content: `m${i}`, created_at: 1_700_000_000 + i }],
          metadata: { i },
        },
      });
    }
    const insMx = db.insertSession({
      source_llm: "MiniMax",
      external_session_id: "ext-mx",
      blob: {
        session_id: "smx",
        source_llm: "MiniMax",
        messages: [],
        metadata: {},
      },
    });

    // getSession
    const got = db.getSession(insMx.id);
    check(got !== null, "getSession should find the MiniMax row");
    check(got.source_llm === "MiniMax", `source_llm should be MiniMax, got ${got.source_llm}`);
    check(got.blob_json.includes("smx"), "blob_json should contain the smx marker");

    // getSession miss
    const miss = db.getSession(99999);
    check(miss === null, "getSession should return null for missing id");

    // findByExternalId hit + miss
    const found = db.findByExternalId("MiniMax", "ext-mx");
    check(found !== null, "findByExternalId should find the MiniMax row");
    check(found.id === insMx.id, `findByExternalId id=${found.id} (want ${insMx.id})`);
    const notFound = db.findByExternalId("MiniMax", "ext-nonexistent");
    check(notFound === null, "findByExternalId should return null for missing entry");

    // listSessions: 6 rows total, paginated limit=3.
    const page1 = db.listSessions({ limit: 3, offset: 0 });
    check(page1.items.length === 3, `page1 should have 3 items, got ${page1.items.length}`);
    check(page1.total === 6, `total should be 6, got ${page1.total}`);
    const page2 = db.listSessions({ limit: 3, offset: 3 });
    check(page2.items.length === 3, `page2 should have 3 items, got ${page2.items.length}`);
    // No overlap.
    const page1Ids = new Set(page1.items.map((r) => r.id));
    for (const r of page2.items) {
      check(!page1Ids.has(r.id), `page2 id=${r.id} overlaps with page1`);
    }
    // listSessions orders by created_at DESC, id DESC. We inserted 5
    // openai rows in a tight loop (same second), then 1 MiniMax row
    // after. The MiniMax row has the highest id and either the same
    // or later created_at. The 5 openai rows are ordered by id DESC
    // within the same created_at.
    const allIds = [...page1.items, ...page2.items].map((r) => r.id);
    check(allIds[0] === insMx.id, `first row should be the latest insert (id=${insMx.id})`);
    db.close();
    console.log("case5: insertSession + getSession + findByExternalId + listSessions all work");
  }

  // Case 6: Foreign keys are enabled and enforced.
  {
    const db = openDatabase(":memory:");
    const fk = db.raw().pragma("foreign_keys", { simple: true });
    check(fk === 1, `foreign_keys should be ON, got ${fk}`);
    let threw = false;
    let errMsg = "";
    try {
      db.insertSession({
        source_llm: "openai",
        external_session_id: "fk-1",
        blob: {
          session_id: "fk_orphan",
          source_llm: "openai",
          messages: [],
          metadata: {},
        },
        parent_session_id: 9999,
      });
    } catch (err) {
      threw = true;
      errMsg = err instanceof Error ? err.message : String(err);
    }
    check(threw, "insert with invalid parent_session_id should fail (FK constraint)");
    check(
      /FOREIGN KEY/i.test(errMsg) || /constraint/i.test(errMsg),
      `FK error message should mention the constraint: ${errMsg}`,
    );
    // But insert with a valid parent succeeds.
    const parent = db.insertSession({
      source_llm: "openai",
      external_session_id: "fk-parent",
      blob: {
        session_id: "fk_parent",
        source_llm: "openai",
        messages: [],
        metadata: {},
      },
    });
    const child = db.insertSession({
      source_llm: "openai",
      external_session_id: "fk-child",
      blob: {
        session_id: "fk_child",
        source_llm: "openai",
        messages: [],
        metadata: {},
      },
      parent_session_id: parent.id,
    });
    // insertSession's return value doesn't include parent_session_id,
    // so we re-read the row to assert the FK round-trip.
    const childRow = db.getSession(child.id);
    check(childRow !== null, "child row should be readable");
    check(
      childRow.parent_session_id === parent.id,
      `child.parent_session_id=${childRow.parent_session_id} (want ${parent.id})`,
    );
    db.close();
    console.log("case6: foreign_keys=ON, invalid parent rejected, valid parent accepted");
  }

  // Case 7: Empty DB listSessions.
  {
    const db = openDatabase(":memory:");
    const { items, total } = db.listSessions({ limit: 10, offset: 0 });
    check(items.length === 0, "empty DB should have 0 items");
    check(total === 0, "empty DB should have total=0");
    db.close();
    console.log("case7: empty DB -> total=0, items=[]");
  }

  // Case 8: hashBlob is 64 lowercase hex, deterministic, and
  // key-order independent.
  {
    const a = {
      session_id: "h1",
      source_llm: "openai",
      messages: [{ role: "user", content: "hi", created_at: 1 }],
      metadata: { x: 1, y: 2 },
    };
    const aReordered = {
      metadata: { y: 2, x: 1 },
      messages: [{ created_at: 1, role: "user", content: "hi" }],
      source_llm: "openai",
      session_id: "h1",
    };
    const b = {
      ...a,
      messages: [{ role: "user", content: "DIFFERENT", created_at: 1 }],
    };
    const ha = hashBlob(a);
    const haReordered = hashBlob(aReordered);
    const hb = hashBlob(b);
    check(/^[0-9a-f]{64}$/.test(ha), `hash should be 64 lowercase hex, got ${ha}`);
    check(ha === haReordered, "hash should be key-order independent (canonical JSON)");
    check(ha !== hb, "different content should hash to different values");
    console.log("case8: hashBlob is 64-hex, deterministic, key-order independent");
  }

  // Case 9: Source-level audit of prepared-statement usage.
  {
    // Resolve src/db/sqlite.ts relative to this script (the script lives
    // at scripts/smoke-db.mjs, so the source is at ../src/db/sqlite.ts).
    const here = fileURLToPath(import.meta.url);
    const srcPath = join(here, "..", "..", "src", "db", "sqlite.ts");
    const src = await readFile(srcPath, "utf8");
    const prepareCount = (src.match(/\.prepare\(/g) || []).length;
    check(
      prepareCount >= 5,
      `expected >= 5 .prepare() calls (one per prepared statement), got ${prepareCount}`,
    );
    // The migrate runner calls db.pragma(`user_version = ${applied}`)
    // once. Other db.pragma() calls are WAL/foreign_keys (constants).
    // The only db.exec() is the static CREATE TABLE block in v1.
    const execCount = (src.match(/\bdb\.exec\(/g) || []).length;
    check(
      execCount === 1,
      `expected exactly 1 db.exec() call (the static schema), got ${execCount}`,
    );
    // No string interpolation of user data into SQL: the only
    // `${...}` template-literal interpolation in any SQL string is
    // the static `user_version = ${applied}` bump in migrate(), where
    // `applied` is an integer derived from the MIGRATIONS array
    // (never user-controlled). Anywhere a string contains `INSERT`,
    // `UPDATE`, `DELETE`, or `SELECT` (case-insensitive) AND a `${`
    // interpolation outside a `?` placeholder context would be a
    // smell; assert the layer has zero such cases.
    const interpolationSqlSmell = (src.match(
      /(?:INSERT|UPDATE|DELETE|SELECT)[^`'"]*\$\{/gi,
    ) || []).length;
    check(
      interpolationSqlSmell === 0,
      `no SQL keyword + \${...} interpolation (would indicate string concatenation of values into SQL), got ${interpolationSqlSmell}`,
    );
    console.log(
      `case9: source audit OK — ${prepareCount} prepared statements, ${execCount} db.exec() (static schema only), 0 SQL+interpolation smells`,
    );
  }

  // Case 10: Edge-case characters (NUL, quotes, backslashes, Unicode)
  // round-trip safely.
  {
    const db = openDatabase(":memory:");
    const evilBlob = {
      session_id: "edge",
      source_llm: "openai",
      messages: [
        { role: "user", content: "tab\there\nand\\and\"and'and", created_at: 1 },
        { role: "assistant", content: "🚀 unicode ✨ — en-dash", created_at: 2 },
      ],
      metadata: {
        nested: { deep: { deeper: [1, 2, { x: "y\n" }] } },
      },
    };
    const ins = db.insertSession({
      source_llm: "openai\"x\\y",
      external_session_id: "ext-edge\0with-nul",
      blob: evilBlob,
    });
    const row = db.getSession(ins.id);
    check(row !== null, "edge-case row should exist");
    const parsed = JSON.parse(row.blob_json);
    check(parsed.messages[0].content === "tab\there\nand\\and\"and'and", "control chars preserved");
    check(parsed.messages[1].content === "🚀 unicode ✨ — en-dash", "unicode preserved");
    check(parsed.metadata.nested.deep.deeper[2].x === "y\n", "deeply nested + newline preserved");
    check(row.source_llm === "openai\"x\\y", "source_llm quotes/backslashes preserved");
    check(row.external_session_id === "ext-edge\0with-nul", "external_session_id NUL preserved");
    db.close();
    console.log("case10: edge-case chars (NUL, quotes, backslashes, Unicode) round-trip cleanly");
  }

  console.log("OK");
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
