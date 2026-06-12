// Vitest tests for import_session.
// Asserts envelope shape (ok/data) and side effects (id, blob_hash,
// deduplicated) for the three contract paths: fresh insert, dedup, and
// no external_session_id.
import { describe, test, expect } from "vitest";
import { importSession } from "../../src/tools/import_session.js";
import { makeBlob, makeTestDeps } from "../_helpers.js";

describe("import_session", () => {
  test("happy path: inserts a blob, returns id + 64-hex hash + deduplicated=false", async () => {
    const deps = makeTestDeps();
    const env = await importSession(
      { blob: makeBlob({ session_id: "conv_1" }), external_session_id: "ext-1" },
      deps.db,
    );
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data.id).toBeGreaterThan(0);
      expect(env.data.blob_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(env.data.deduplicated).toBe(false);
    }
  });

  test("dedup: same (source_llm, external_session_id) returns same id + deduplicated=true", async () => {
    const deps = makeTestDeps();
    const env1 = await importSession(
      { blob: makeBlob({ session_id: "conv_dup" }), external_session_id: "ext-dup" },
      deps.db,
    );
    const env2 = await importSession(
      { blob: makeBlob({ session_id: "conv_dup" }), external_session_id: "ext-dup" },
      deps.db,
    );
    expect(env1.ok && env2.ok).toBe(true);
    if (env1.ok && env2.ok) {
      expect(env2.data.id).toBe(env1.data.id);
      expect(env2.data.blob_hash).toBe(env1.data.blob_hash);
      expect(env2.data.deduplicated).toBe(true);
      expect(env1.data.deduplicated).toBe(false);
    }
  });

  test("no external_session_id: each insert gets a fresh id", async () => {
    const deps = makeTestDeps();
    const env1 = await importSession(
      { blob: makeBlob({ session_id: "conv_a" }) },
      deps.db,
    );
    const env2 = await importSession(
      { blob: makeBlob({ session_id: "conv_b" }) },
      deps.db,
    );
    expect(env1.ok && env2.ok).toBe(true);
    if (env1.ok && env2.ok) {
      expect(env1.data.id).not.toBe(env2.data.id);
      expect(env1.data.deduplicated).toBe(false);
      expect(env2.data.deduplicated).toBe(false);
    }
  });
});
