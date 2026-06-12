// Vitest tests for verify_session.
// Asserts envelope shape (session_id, matches, computed_hash) and the
// tamper detection contract: matches=true on intact blob, false on
// wrong expected_hash, false on a directly-modified row. Also covers
// the 64-hex-char format of computed_hash and NOT_FOUND.
import { describe, test, expect } from "vitest";
import { importSession } from "../../src/tools/import_session.js";
import { verifySession } from "../../src/tools/verify_session.js";
import { makeBlob, makeTestDeps } from "../_helpers.js";

describe("verify_session", () => {
  test("happy path: matches=true, computed_hash is 64 hex chars and equals stored hash", async () => {
    const deps = makeTestDeps();
    const ins = await importSession(
      {
        blob: makeBlob({ session_id: "conv_v_1" }),
        external_session_id: "ext-v",
      },
      deps.db,
    );
    if (!ins.ok) throw new Error("seed failed");
    const env = await verifySession({ session_id: ins.data.id }, deps.db);
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data.session_id).toBe(ins.data.id);
      expect(env.data.matches).toBe(true);
      expect(env.data.computed_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(env.data.computed_hash).toBe(ins.data.blob_hash);
    }
  });

  test("correct expected_hash: matches=true", async () => {
    const deps = makeTestDeps();
    const ins = await importSession(
      { blob: makeBlob({ session_id: "conv_v_2" }), external_session_id: "ext-v2" },
      deps.db,
    );
    if (!ins.ok) throw new Error("seed failed");
    const env = await verifySession(
      { session_id: ins.data.id, expected_hash: ins.data.blob_hash },
      deps.db,
    );
    expect(env.ok).toBe(true);
    if (env.ok) expect(env.data.matches).toBe(true);
  });

  test("wrong expected_hash: matches=false, computed_hash unchanged", async () => {
    const deps = makeTestDeps();
    const ins = await importSession(
      { blob: makeBlob({ session_id: "conv_v_3" }), external_session_id: "ext-v3" },
      deps.db,
    );
    if (!ins.ok) throw new Error("seed failed");
    const env = await verifySession(
      { session_id: ins.data.id, expected_hash: "0".repeat(64) },
      deps.db,
    );
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data.matches).toBe(false);
      expect(env.data.computed_hash).toBe(ins.data.blob_hash);
    }
  });

  test("tamper detection: direct SQL UPDATE on blob_json -> matches=false", async () => {
    const deps = makeTestDeps();
    const ins = await importSession(
      { blob: makeBlob({ session_id: "conv_v_4" }), external_session_id: "ext-v4" },
      deps.db,
    );
    if (!ins.ok) throw new Error("seed failed");
    const origRow = deps.db.getSession(ins.data.id);
    if (!origRow) throw new Error("row missing");
    const tampered = origRow.blob_json.replace('"hi"', '"hi-TAMPERED"');
    deps.db.raw().prepare("UPDATE sessions SET blob_json = ? WHERE id = ?").run(tampered, ins.data.id);
    const env = await verifySession({ session_id: ins.data.id }, deps.db);
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data.matches).toBe(false);
      expect(env.data.computed_hash).not.toBe(ins.data.blob_hash);
    }
  });

  test("NOT_FOUND: missing session_id", async () => {
    const deps = makeTestDeps();
    let err: unknown;
    try {
      await verifySession({ session_id: 9999 }, deps.db);
    } catch (e) {
      err = e;
    }
    const toolErr = err as { code: string; tool: string; message: string };
    expect(toolErr.code).toBe("NOT_FOUND");
    expect(toolErr.tool).toBe("verify_session");
    expect(toolErr.message).toContain("9999");
  });
});
