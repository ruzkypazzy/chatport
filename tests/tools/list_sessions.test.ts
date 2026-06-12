// Vitest tests for list_sessions.
// Asserts envelope shape and side effects: total count, paginated
// limit/offset, ordering by created_at DESC, and that the blob field
// is parsed JSON (not a string).
import { describe, test, expect } from "vitest";
import { importSession } from "../../src/tools/import_session.js";
import { listSessions } from "../../src/tools/list_sessions.js";
import { makeBlob, makeTestDeps } from "../_helpers.js";

describe("list_sessions", () => {
  test("empty DB: returns total=0, items=[]", async () => {
    const deps = makeTestDeps();
    const env = await listSessions({ limit: 10, offset: 0 }, deps.db);
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data.total).toBe(0);
      expect(env.data.items).toHaveLength(0);
      expect(env.data.limit).toBe(10);
      expect(env.data.offset).toBe(0);
    }
  });

  test("5 inserts: total=5, items returned newest-first as parsed blobs", async () => {
    const deps = makeTestDeps();
    for (let i = 0; i < 5; i++) {
      const r = await importSession(
        { blob: makeBlob({ session_id: `conv_ls_${i}` }), external_session_id: `ext-${i}` },
        deps.db,
      );
      expect(r.ok).toBe(true);
    }
    const env = await listSessions({ limit: 10, offset: 0 }, deps.db);
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data.total).toBe(5);
      expect(env.data.items).toHaveLength(5);
      // Each item's blob is a parsed object, not a string.
      for (const it of env.data.items) {
        expect(typeof it.blob).toBe("object");
        expect(it.blob).not.toBeNull();
      }
      // Newest first -> highest id first.
      const ids = env.data.items.map((it) => it.id);
      const sortedDesc = [...ids].sort((a, b) => b - a);
      expect(ids).toEqual(sortedDesc);
    }
  });

  test("pagination: limit=2 returns first 2, offset=2 returns next 2", async () => {
    const deps = makeTestDeps();
    for (let i = 0; i < 5; i++) {
      const r = await importSession(
        { blob: makeBlob({ session_id: `conv_pg_${i}` }), external_session_id: `ext-pg-${i}` },
        deps.db,
      );
      expect(r.ok).toBe(true);
    }
    const page1 = await listSessions({ limit: 2, offset: 0 }, deps.db);
    const page2 = await listSessions({ limit: 2, offset: 2 }, deps.db);
    expect(page1.ok && page2.ok).toBe(true);
    if (page1.ok && page2.ok) {
      expect(page1.data.items).toHaveLength(2);
      expect(page2.data.items).toHaveLength(2);
      expect(page1.data.total).toBe(5);
      expect(page2.data.total).toBe(5);
      // No overlap.
      const ids1 = new Set(page1.data.items.map((it) => it.id));
      for (const it of page2.data.items) {
        expect(ids1.has(it.id)).toBe(false);
      }
    }
  });
});
