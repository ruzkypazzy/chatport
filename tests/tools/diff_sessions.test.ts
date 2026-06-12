// Vitest tests for diff_sessions.
// Asserts the message-level diff envelope: added, removed, modified.
// Covers identical messages, B extras (added), A extras (removed),
// same-length modifications, and NOT_FOUND on missing ids.
import { describe, test, expect } from "vitest";
import { importSession } from "../../src/tools/import_session.js";
import { diffSessions } from "../../src/tools/diff_sessions.js";
import { makeBlob, makeTestDeps } from "../_helpers.js";

describe("diff_sessions", () => {
  test("identical messages: added=0, removed=0, modified=0", async () => {
    const deps = makeTestDeps();
    const msgs = [
      { role: "user" as const, content: "hi", created_at: 1_700_000_000 },
      { role: "assistant" as const, content: "hello", created_at: 1_700_000_001 },
    ];
    const insA = await importSession(
      { blob: makeBlob({ session_id: "conv_da", messages: msgs }), external_session_id: "ext-da" },
      deps.db,
    );
    const insB = await importSession(
      { blob: makeBlob({ session_id: "conv_db", messages: msgs }), external_session_id: "ext-db" },
      deps.db,
    );
    if (!insA.ok || !insB.ok) throw new Error("seed failed");
    const env = await diffSessions(
      { session_id_a: insA.data.id, session_id_b: insB.data.id },
      deps.db,
    );
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data.added).toHaveLength(0);
      expect(env.data.removed).toHaveLength(0);
      expect(env.data.modified).toHaveLength(0);
    }
  });

  test("B has 1 extra message at the end -> added=1, removed=0, modified=0", async () => {
    const deps = makeTestDeps();
    const a = [{ role: "user" as const, content: "u1", created_at: 1 }];
    const b = [
      { role: "user" as const, content: "u1", created_at: 1 },
      { role: "assistant" as const, content: "a1", created_at: 2 },
    ];
    const insA = await importSession(
      { blob: makeBlob({ session_id: "conv_da2", messages: a }), external_session_id: "ext-da2" },
      deps.db,
    );
    const insB = await importSession(
      { blob: makeBlob({ session_id: "conv_db2", messages: b }), external_session_id: "ext-db2" },
      deps.db,
    );
    if (!insA.ok || !insB.ok) throw new Error("seed failed");
    const env = await diffSessions(
      { session_id_a: insA.data.id, session_id_b: insB.data.id },
      deps.db,
    );
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data.added).toHaveLength(1);
      expect(env.data.added[0]?.content).toBe("a1");
      expect(env.data.removed).toHaveLength(0);
      expect(env.data.modified).toHaveLength(0);
    }
  });

  test("A has 1 extra message at the end -> added=0, removed=1, modified=0", async () => {
    const deps = makeTestDeps();
    const a = [
      { role: "user" as const, content: "u1", created_at: 1 },
      { role: "assistant" as const, content: "a1", created_at: 2 },
    ];
    const b = [{ role: "user" as const, content: "u1", created_at: 1 }];
    const insA = await importSession(
      { blob: makeBlob({ session_id: "conv_da3", messages: a }), external_session_id: "ext-da3" },
      deps.db,
    );
    const insB = await importSession(
      { blob: makeBlob({ session_id: "conv_db3", messages: b }), external_session_id: "ext-db3" },
      deps.db,
    );
    if (!insA.ok || !insB.ok) throw new Error("seed failed");
    const env = await diffSessions(
      { session_id_a: insA.data.id, session_id_b: insB.data.id },
      deps.db,
    );
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data.removed).toHaveLength(1);
      expect(env.data.removed[0]?.content).toBe("a1");
      expect(env.data.added).toHaveLength(0);
      expect(env.data.modified).toHaveLength(0);
    }
  });

  test("same length, one index differs -> modified=1 with { index, a, b }", async () => {
    const deps = makeTestDeps();
    const a = [
      { role: "user" as const, content: "u1", created_at: 1 },
      { role: "assistant" as const, content: "a1", created_at: 2 },
    ];
    const b = [
      { role: "user" as const, content: "u1", created_at: 1 },
      { role: "assistant" as const, content: "a1-CHANGED", created_at: 2 },
    ];
    const insA = await importSession(
      { blob: makeBlob({ session_id: "conv_da4", messages: a }), external_session_id: "ext-da4" },
      deps.db,
    );
    const insB = await importSession(
      { blob: makeBlob({ session_id: "conv_db4", messages: b }), external_session_id: "ext-db4" },
      deps.db,
    );
    if (!insA.ok || !insB.ok) throw new Error("seed failed");
    const env = await diffSessions(
      { session_id_a: insA.data.id, session_id_b: insB.data.id },
      deps.db,
    );
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data.modified).toHaveLength(1);
      expect(env.data.modified[0]?.index).toBe(1);
      expect(env.data.modified[0]?.a.content).toBe("a1");
      expect(env.data.modified[0]?.b.content).toBe("a1-CHANGED");
    }
  });

  test("NOT_FOUND: missing session_id_a", async () => {
    const deps = makeTestDeps();
    const insB = await importSession(
      { blob: makeBlob({ session_id: "conv_dn1" }), external_session_id: "ext-dn1" },
      deps.db,
    );
    if (!insB.ok) throw new Error("seed failed");
    let err: unknown;
    try {
      await diffSessions(
        { session_id_a: 9999, session_id_b: insB.data.id },
        deps.db,
      );
    } catch (e) {
      err = e;
    }
    const toolErr = err as { code: string; tool: string; message: string };
    expect(toolErr.code).toBe("NOT_FOUND");
    expect(toolErr.tool).toBe("diff_sessions");
    expect(toolErr.message).toContain("9999");
  });
});
