// One-off smoke test for AC-12: verify_session (tamper detection).
//
// Sets up an in-memory DB, imports a session, calls the real
// verifySession handler, and asserts:
//   1. happy path (intact blob, no expected_hash): computed_hash is
//      64 lowercase hex chars and equals the stored blob_hash;
//      matches=true.
//   2. with the correct expected_hash: matches=true (and
//      computed_hash matches the caller's expected_hash too).
//   3. with a wrong expected_hash (64 zero chars): matches=false,
//      but computed_hash is still the blob's actual hash (the
//      recomputation is invariant — the wrong expected_hash doesn't
//      poison the output).
//   4. tamper detection: directly modify the row's blob_json via
//      SQL UPDATE, then verify_session with no expected_hash detects
//      the tamper (matches=false) because the recomputed hash no
//      longer equals the stored blob_hash.
//   4a. after tampering, passing expected_hash = the new computed
//       hash matches (matches=true) — proves the comparison is a
//       straight recompute, not a fixed-reference check.
//   4b. after tampering, passing expected_hash = the original hash
//       does not match (matches=false) — proves the original hash
//       no longer describes the row.
//   5. NOT_FOUND on a missing session_id (the message must include
//      the specific id).
import { importSession } from "../dist/tools/import_session.js";
import { verifySession } from "../dist/tools/verify_session.js";
import { openDatabase } from "../dist/db/sqlite.js";

async function seed(db, tag = "verify") {
  const blob = {
    session_id: `conv_${tag}_1`,
    source_llm: "openai",
    messages: [
      { role: "user", content: "u1", created_at: 1_700_000_000 },
      { role: "assistant", content: "a1", created_at: 1_700_000_001 },
    ],
    metadata: { tag: `${tag}-smoke` },
  };
  const env = await importSession(
    { blob, external_session_id: `${tag}-ext-1` },
    db,
  );
  if (env.ok !== true) throw new Error(`seed: ${JSON.stringify(env)}`);
  return { id: env.data.id, blob_hash: env.data.blob_hash };
}

async function main() {
  const db = openDatabase(":memory:");
  const { id, blob_hash } = await seed(db);

  // Case 1: happy path, no expected_hash.
  {
    const env = await verifySession({ session_id: id }, db);
    if (env.ok !== true) throw new Error(`case1: ${JSON.stringify(env)}`);
    if (env.data.session_id !== id) {
      throw new Error(`case1: session_id=${env.data.session_id} (want ${id})`);
    }
    if (env.data.matches !== true) {
      throw new Error(`case1: matches=${env.data.matches} (want true)`);
    }
    if (env.data.computed_hash !== blob_hash) {
      throw new Error(
        `case1: computed_hash=${env.data.computed_hash} (want ${blob_hash})`,
      );
    }
    if (!/^[0-9a-f]{64}$/.test(env.data.computed_hash)) {
      throw new Error(
        `case1: computed_hash is not 64 lowercase hex chars: ${env.data.computed_hash}`,
      );
    }
    console.log(
      `case1: intact blob -> matches=true, computed_hash=${env.data.computed_hash.slice(0, 12)}...`,
    );
  }

  // Case 2: correct expected_hash.
  {
    const env = await verifySession(
      { session_id: id, expected_hash: blob_hash },
      db,
    );
    if (env.ok !== true) throw new Error(`case2: ${JSON.stringify(env)}`);
    if (env.data.matches !== true) {
      throw new Error(`case2: matches=${env.data.matches} (want true)`);
    }
    if (env.data.computed_hash !== blob_hash) {
      throw new Error(
        `case2: computed_hash=${env.data.computed_hash} (want ${blob_hash})`,
      );
    }
    console.log(`case2: correct expected_hash -> matches=true`);
  }

  // Case 3: wrong expected_hash.
  {
    const wrong = "0".repeat(64);
    const env = await verifySession(
      { session_id: id, expected_hash: wrong },
      db,
    );
    if (env.ok !== true) throw new Error(`case3: ${JSON.stringify(env)}`);
    if (env.data.matches !== false) {
      throw new Error(`case3: matches=${env.data.matches} (want false)`);
    }
    if (env.data.computed_hash !== blob_hash) {
      throw new Error(
        `case3: computed_hash should still be the actual blob hash: ${env.data.computed_hash}`,
      );
    }
    console.log(`case3: wrong expected_hash -> matches=false (computed_hash unchanged)`);
  }

  // Case 4: tamper detection. Modify the row's blob_json directly via
  // SQL (simulating a row-level mutation that bypasses the DB layer's
  // hash invariant).
  {
    const origRow = db.getSession(id);
    if (origRow === null) throw new Error(`case4: row missing`);
    const tamperedJson = origRow.blob_json.replace('"u1"', '"u1-TAMPERED"');
    if (tamperedJson === origRow.blob_json) {
      throw new Error(`case4: tamper .replace did not modify the blob_json`);
    }
    db.raw()
      .prepare("UPDATE sessions SET blob_json = ? WHERE id = ?")
      .run(tamperedJson, id);

    // 4a. No expected_hash: matches=false (stored hash != recomputed hash).
    const env1 = await verifySession({ session_id: id }, db);
    if (env1.ok !== true) throw new Error(`case4a: ${JSON.stringify(env1)}`);
    if (env1.data.matches !== false) {
      throw new Error(
        `case4a: tampered blob should not match: matches=${env1.data.matches}`,
      );
    }
    if (env1.data.computed_hash === blob_hash) {
      throw new Error(
        `case4a: recomputed hash should differ from the original stored hash: ${env1.data.computed_hash}`,
      );
    }

    // 4b. expected_hash = new computed hash -> matches=true.
    const env2 = await verifySession(
      { session_id: id, expected_hash: env1.data.computed_hash },
      db,
    );
    if (env2.ok !== true) throw new Error(`case4b: ${JSON.stringify(env2)}`);
    if (env2.data.matches !== true) {
      throw new Error(
        `case4b: matches=true when expected_hash = new computed hash: ${env2.data.matches}`,
      );
    }

    // 4c. expected_hash = original hash -> matches=false.
    const env3 = await verifySession(
      { session_id: id, expected_hash: blob_hash },
      db,
    );
    if (env3.ok !== true) throw new Error(`case4c: ${JSON.stringify(env3)}`);
    if (env3.data.matches !== false) {
      throw new Error(
        `case4c: matches=false when expected_hash = original hash: ${env3.data.matches}`,
      );
    }

    console.log(
      `case4: tamper detection -> matches=false (4a no-hash: tamper detected; 4b/4c: comparison is a straight recompute)`,
    );
  }

  // Case 5: NOT_FOUND on a missing session_id.
  {
    try {
      await verifySession({ session_id: 9999 }, db);
      throw new Error("case5: expected NOT_FOUND, got success");
    } catch (err) {
      if (err?.code !== "NOT_FOUND") {
        throw new Error(`case5: expected NOT_FOUND, got ${err?.code}: ${err?.message}`);
      }
      if (err?.tool !== "verify_session") {
        throw new Error(`case5: tool=${err?.tool} (want verify_session)`);
      }
      if (!err?.message?.includes("9999")) {
        throw new Error(`case5: message should include 9999: ${err?.message}`);
      }
      console.log(`case5: missing session -> NOT_FOUND (${err.message})`);
    }
  }

  db.close();
  console.log("OK");
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
