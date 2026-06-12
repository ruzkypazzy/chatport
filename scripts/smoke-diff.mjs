// One-off smoke test for AC-9: diff_sessions (message-level diff).
//
// Sets up an in-memory DB, imports two sessions with controlled message
// lists, calls the real diffSessions handler, and asserts:
//   - identical message lists -> { added: [], removed: [], modified: [] }
//   - B has extra messages past A's length -> those are `added`
//   - A has extra messages past B's length -> those are `removed`
//   - messages at the same index with different role/content -> `modified`
//   - both messages are surfaced with their full { role, content, created_at }
//   - only `role + content` matters for equality (different created_at at
//     the same index with the same role+content is "unchanged", not
//     "modified"; same role+content but different created_at is unchanged)
//   - same role but content with a `:` separator collision is treated as
//     different (NUL separator in the hash)
//   - NOT_FOUND on either missing session id
//   - empty messages arrays round-trip cleanly
import { importSession } from "../dist/tools/import_session.js";
import { diffSessions } from "../dist/tools/diff_sessions.js";
import { openDatabase } from "../dist/db/sqlite.js";

const makeBlob = (session_id, messages) => ({
  session_id,
  source_llm: "openai",
  messages,
  metadata: { tag: `diff-smoke-${session_id}` },
});

const msg = (role, content, created_at) => ({ role, content, created_at });

let seedCounter = 0;
async function seedPair(db, a, b, tag = "diff") {
  // Unique external_session_ids per call so importSession's dedup-by-(source_llm, external_id)
  // path doesn't make later cases return an earlier case's row.
  const idx = ++seedCounter;
  const envA = await importSession(
    { blob: makeBlob(`conv_${tag}_a`, a), external_session_id: `${tag}-${idx}-a` },
    db,
  );
  if (envA.ok !== true) throw new Error(`seedA: ${JSON.stringify(envA)}`);
  const envB = await importSession(
    { blob: makeBlob(`conv_${tag}_b`, b), external_session_id: `${tag}-${idx}-b` },
    db,
  );
  if (envB.ok !== true) throw new Error(`seedB: ${JSON.stringify(envB)}`);
  return { idA: envA.data.id, idB: envB.data.id };
}

async function main() {
  const db = openDatabase(":memory:");

  // Case 1: identical message lists -> all three arrays are empty.
  {
    const msgs = [
      msg("user", "hello", 1_700_000_000),
      msg("assistant", "hi", 1_700_000_001),
      msg("user", "ok ship it", 1_700_000_002),
    ];
    const { idA, idB } = await seedPair(db, msgs, msgs, "case1");
    const env = await diffSessions({ session_id_a: idA, session_id_b: idB }, db);
    if (env.ok !== true) throw new Error(`case1: ${JSON.stringify(env)}`);
    if (env.data.added.length !== 0) {
      throw new Error(`case1: added.length=${env.data.added.length} (want 0)`);
    }
    if (env.data.removed.length !== 0) {
      throw new Error(`case1: removed.length=${env.data.removed.length} (want 0)`);
    }
    if (env.data.modified.length !== 0) {
      throw new Error(`case1: modified.length=${env.data.modified.length} (want 0)`);
    }
    console.log(`case1: identical messages -> added=0 removed=0 modified=0`);
  }

  // Case 2: B has 2 extra messages at the end -> both are `added`.
  {
    const a = [msg("user", "u1", 1), msg("assistant", "a1", 2)];
    const b = [
      msg("user", "u1", 1),
      msg("assistant", "a1", 2),
      msg("user", "u2", 3), // added
      msg("assistant", "a2", 4), // added
    ];
    const { idA, idB } = await seedPair(db, a, b, "case2");
    const env = await diffSessions({ session_id_a: idA, session_id_b: idB }, db);
    if (env.ok !== true) throw new Error(`case2: ${JSON.stringify(env)}`);
    if (env.data.added.length !== 2) {
      throw new Error(`case2: added.length=${env.data.added.length} (want 2)`);
    }
    if (env.data.added[0].content !== "u2" || env.data.added[1].content !== "a2") {
      throw new Error(`case2: added content wrong: ${JSON.stringify(env.data.added)}`);
    }
    if (env.data.removed.length !== 0) {
      throw new Error(`case2: removed.length=${env.data.removed.length} (want 0)`);
    }
    if (env.data.modified.length !== 0) {
      throw new Error(`case2: modified.length=${env.data.modified.length} (want 0)`);
    }
    console.log(`case2: B has 2 extra -> added=2 removed=0 modified=0`);
  }

  // Case 3: A has 2 extra messages at the end -> both are `removed`.
  {
    const a = [
      msg("user", "u1", 1),
      msg("assistant", "a1", 2),
      msg("user", "u2", 3), // removed
      msg("assistant", "a2", 4), // removed
    ];
    const b = [msg("user", "u1", 1), msg("assistant", "a1", 2)];
    const { idA, idB } = await seedPair(db, a, b, "case3");
    const env = await diffSessions({ session_id_a: idA, session_id_b: idB }, db);
    if (env.ok !== true) throw new Error(`case3: ${JSON.stringify(env)}`);
    if (env.data.removed.length !== 2) {
      throw new Error(`case3: removed.length=${env.data.removed.length} (want 2)`);
    }
    if (env.data.removed[0].content !== "u2" || env.data.removed[1].content !== "a2") {
      throw new Error(`case3: removed content wrong: ${JSON.stringify(env.data.removed)}`);
    }
    if (env.data.added.length !== 0) {
      throw new Error(`case3: added.length=${env.data.added.length} (want 0)`);
    }
    if (env.data.modified.length !== 0) {
      throw new Error(`case3: modified.length=${env.data.modified.length} (want 0)`);
    }
    console.log(`case3: A has 2 extra -> added=0 removed=2 modified=0`);
  }

  // Case 4: messages at the same index with different content -> `modified`.
  {
    const a = [
      msg("user", "u1", 1),
      msg("assistant", "a1", 2),
      msg("user", "u2", 3),
    ];
    const b = [
      msg("user", "u1", 1),
      msg("assistant", "a1-CHANGED", 99), // modified at index 1
      msg("user", "u2", 3),
    ];
    const { idA, idB } = await seedPair(db, a, b, "case4");
    const env = await diffSessions({ session_id_a: idA, session_id_b: idB }, db);
    if (env.ok !== true) throw new Error(`case4: ${JSON.stringify(env)}`);
    if (env.data.modified.length !== 1) {
      throw new Error(`case4: modified.length=${env.data.modified.length} (want 1)`);
    }
    const m = env.data.modified[0];
    if (m.index !== 1) throw new Error(`case4: index=${m.index} (want 1)`);
    if (m.a.content !== "a1" || m.b.content !== "a1-CHANGED") {
      throw new Error(`case4: a/b content wrong: ${JSON.stringify(m)}`);
    }
    // created_at should be the A side (2) and the B side (99) — both surfaced.
    if (m.a.created_at !== 2 || m.b.created_at !== 99) {
      throw new Error(`case4: created_at wrong: a=${m.a.created_at} b=${m.b.created_at}`);
    }
    if (env.data.added.length !== 0 || env.data.removed.length !== 0) {
      throw new Error(`case4: added/removed should be empty: added=${env.data.added.length} removed=${env.data.removed.length}`);
    }
    console.log(`case4: index 1 differs -> modified[0]={index:1, a:..., b:...}`);
  }

  // Case 5: full mix at the same length — some unchanged, some modified
  // at different indices. (Index-by-index: same length + different content
  // at the same index = "modified" at that index, NOT a set-difference
  // "removed + added" pair. Cases 2/3 already cover the "different
  // length" set-difference paths; this case covers "same length,
  // different content at multiple indices".)
  {
    const a = [
      msg("user", "u1", 1), // unchanged
      msg("assistant", "a1", 2), // modified at index 1
      msg("user", "u2", 3), // modified at index 2
    ];
    const b = [
      msg("user", "u1", 1), // unchanged
      msg("assistant", "a1-NEW", 22), // modified at index 1
      msg("user", "u2-NEW", 33), // modified at index 2
    ];
    const { idA, idB } = await seedPair(db, a, b, "case5");
    const env = await diffSessions({ session_id_a: idA, session_id_b: idB }, db);
    if (env.ok !== true) throw new Error(`case5: ${JSON.stringify(env)}`);
    if (env.data.added.length !== 0 || env.data.removed.length !== 0) {
      throw new Error(
        `case5: added/removed should be empty (same length): added=${env.data.added.length} removed=${env.data.removed.length}`,
      );
    }
    if (env.data.modified.length !== 2) {
      throw new Error(`case5: modified.length=${env.data.modified.length} (want 2)`);
    }
    if (env.data.modified[0].index !== 1 || env.data.modified[0].a.content !== "a1" || env.data.modified[0].b.content !== "a1-NEW") {
      throw new Error(`case5: modified[0] wrong: ${JSON.stringify(env.data.modified[0])}`);
    }
    if (env.data.modified[1].index !== 2 || env.data.modified[1].a.content !== "u2" || env.data.modified[1].b.content !== "u2-NEW") {
      throw new Error(`case5: modified[1] wrong: ${JSON.stringify(env.data.modified[1])}`);
    }
    console.log(
      `case5: same length, 2 modifications -> added=0 removed=0 modified=2 (indices 1 and 2)`,
    );
  }

  // Case 6: created_at difference alone does NOT trigger `modified` —
  // only role+content matters.
  {
    const a = [
      msg("user", "u1", 1000),
      msg("assistant", "a1", 2000),
    ];
    const b = [
      msg("user", "u1", 9999), // same role+content, different created_at
      msg("assistant", "a1", 8888), // same role+content, different created_at
    ];
    const { idA, idB } = await seedPair(db, a, b, "case6");
    const env = await diffSessions({ session_id_a: idA, session_id_b: idB }, db);
    if (env.ok !== true) throw new Error(`case6: ${JSON.stringify(env)}`);
    if (env.data.added.length !== 0 || env.data.removed.length !== 0 || env.data.modified.length !== 0) {
      throw new Error(
        `case6: created_at should be ignored: added=${env.data.added.length} removed=${env.data.removed.length} modified=${env.data.modified.length}`,
      );
    }
    console.log(`case6: created_at difference alone -> all 3 arrays empty (role+content equality only)`);
  }

  // Case 7: same role but different content separator collision test.
  // { role: "u", content: "1:2" } vs { role: "u:1", content: "2" } — naive
  // ":"-join would collide; the NUL separator keeps them distinct.
  {
    const a = [msg("u", "1:2", 1)];
    const b = [msg("u:1", "2", 1)];
    const { idA, idB } = await seedPair(db, a, b, "case7");
    const env = await diffSessions({ session_id_a: idA, session_id_b: idB }, db);
    if (env.ok !== true) throw new Error(`case7: ${JSON.stringify(env)}`);
    if (env.data.modified.length !== 1) {
      throw new Error(
        `case7: separator collision not detected: modified.length=${env.data.modified.length} (want 1)`,
      );
    }
    if (env.data.modified[0].a.role !== "u" || env.data.modified[0].b.role !== "u:1") {
      throw new Error(`case7: roles wrong: ${JSON.stringify(env.data.modified[0])}`);
    }
    console.log(`case7: separator collision -> modified=1 (NUL separator works)`);
  }

  // Case 8: NOT_FOUND on missing session_id_a.
  {
    const msgs = [msg("user", "u", 1)];
    const { idA: _idA, idB } = await seedPair(db, msgs, msgs, "case8");
    try {
      await diffSessions({ session_id_a: 9999, session_id_b: idB }, db);
      throw new Error("case8: expected NOT_FOUND, got success");
    } catch (err) {
      if (err?.code !== "NOT_FOUND") {
        throw new Error(`case8: expected NOT_FOUND, got ${err?.code}: ${err?.message}`);
      }
      if (err?.tool !== "diff_sessions") {
        throw new Error(`case8: tool=${err?.tool} (want diff_sessions)`);
      }
      if (!err?.message?.includes("9999")) {
        throw new Error(`case8: message should mention session id 9999: ${err?.message}`);
      }
      console.log(`case8: missing session_id_a -> NOT_FOUND (${err.message})`);
    }
  }

  // Case 9: NOT_FOUND on missing session_id_b.
  {
    const msgs = [msg("user", "u", 1)];
    const { idA, idB: _idB } = await seedPair(db, msgs, msgs, "case9");
    try {
      await diffSessions({ session_id_a: idA, session_id_b: 9999 }, db);
      throw new Error("case9: expected NOT_FOUND, got success");
    } catch (err) {
      if (err?.code !== "NOT_FOUND") {
        throw new Error(`case9: expected NOT_FOUND, got ${err?.code}: ${err?.message}`);
      }
      if (!err?.message?.includes("9999")) {
        throw new Error(`case9: message should mention session id 9999: ${err?.message}`);
      }
      console.log(`case9: missing session_id_b -> NOT_FOUND (${err.message})`);
    }
  }

  // Case 10: both empty -> all three arrays empty.
  {
    const { idA, idB } = await seedPair(db, [], [], "case10");
    const env = await diffSessions({ session_id_a: idA, session_id_b: idB }, db);
    if (env.ok !== true) throw new Error(`case10: ${JSON.stringify(env)}`);
    if (env.data.added.length !== 0 || env.data.removed.length !== 0 || env.data.modified.length !== 0) {
      throw new Error(`case10: empty vs empty should be all empty: ${JSON.stringify(env.data)}`);
    }
    console.log(`case10: empty vs empty -> added=0 removed=0 modified=0`);
  }

  // Case 11: A is empty, B has messages -> all B's messages are `added`.
  {
    const { idA, idB } = await seedPair(db, [], [
      msg("user", "u1", 1),
      msg("assistant", "a1", 2),
    ], "case11");
    const env = await diffSessions({ session_id_a: idA, session_id_b: idB }, db);
    if (env.ok !== true) throw new Error(`case11: ${JSON.stringify(env)}`);
    if (env.data.added.length !== 2) {
      throw new Error(`case11: added.length=${env.data.added.length} (want 2)`);
    }
    if (env.data.removed.length !== 0 || env.data.modified.length !== 0) {
      throw new Error(`case11: removed/modified should be 0: ${JSON.stringify(env.data)}`);
    }
    console.log(`case11: A=[] B=2 messages -> added=2 removed=0 modified=0`);
  }

  db.close();
  console.log("OK");
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
