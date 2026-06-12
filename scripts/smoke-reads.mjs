// One-off smoke test for AC-5 read paths: list_sessions and get_session.
// Open an in-memory DB, insert N sessions with deterministic content, then
// call the real handlers and assert envelope shape, ordering, pagination,
// and NOT_FOUND behavior.
import { importSession } from "../dist/tools/import_session.js";
import { listSessions } from "../dist/tools/list_sessions.js";
import { getSession } from "../dist/tools/get_session.js";
import { openDatabase } from "../dist/db/sqlite.js";

const baseBlob = (i) => ({
  session_id: `conv_${i}`,
  source_llm: "openai",
  messages: [
    { role: "user", content: `hi ${i}`, created_at: 1_700_000_000 + i },
    { role: "assistant", content: `hello ${i}`, created_at: 1_700_000_001 + i },
  ],
  metadata: { tag: `smoke-${i}` },
});

async function main() {
  const db = openDatabase(":memory:");

  // Case 1: empty DB -> total=0, items=[].
  const empty = await listSessions({ limit: 20, offset: 0 }, db);
  if (empty.ok !== true) throw new Error(`case1: not ok: ${JSON.stringify(empty)}`);
  if (empty.data.total !== 0) throw new Error(`case1: total=${empty.data.total} (want 0)`);
  if (empty.data.items.length !== 0) {
    throw new Error(`case1: items.length=${empty.data.items.length} (want 0)`);
  }
  if (empty.data.limit !== 20 || empty.data.offset !== 0) {
    throw new Error(`case1: limit/offset echo wrong: ${JSON.stringify(empty.data)}`);
  }
  console.log("case1: empty DB returns total=0 items=[]");

  // Case 2: insert 5 sessions, list_sessions returns all 5, total=5,
  // ordered by created_at DESC, id DESC (newest first).
  const insertedIds = [];
  for (let i = 0; i < 5; i++) {
    const env = await importSession({ blob: baseBlob(i), external_session_id: `ext-${i}` }, db);
    if (env.ok !== true) throw new Error(`case2.${i}: import failed: ${JSON.stringify(env)}`);
    insertedIds.push(env.data.id);
  }
  const list2 = await listSessions({ limit: 20, offset: 0 }, db);
  if (list2.data.total !== 5) {
    throw new Error(`case2: total=${list2.data.total} (want 5)`);
  }
  if (list2.data.items.length !== 5) {
    throw new Error(`case2: items.length=${list2.data.items.length} (want 5)`);
  }
  // Newest first -> items[0].id should be the last inserted.
  for (let i = 0; i < 5; i++) {
    const expectedId = insertedIds[4 - i];
    const gotId = list2.data.items[i]?.id;
    if (gotId !== expectedId) {
      throw new Error(`case2: items[${i}].id=${gotId} (want ${expectedId})`);
    }
  }
  console.log(`case2: 5 inserts -> total=5 items=5 ordered newest-first (ids: ${list2.data.items.map((it) => it.id).join(",")})`);

  // Case 3: pagination via limit + offset. limit=2 offset=1 -> 2 items,
  // total stays 5. Items[0] in page 1 is the second-newest overall.
  const page1 = await listSessions({ limit: 2, offset: 0 }, db);
  const page2 = await listSessions({ limit: 2, offset: 2 }, db);
  const page3 = await listSessions({ limit: 2, offset: 4 }, db);
  if (page1.data.items.length !== 2) throw new Error(`case3: page1 items=${page1.data.items.length} (want 2)`);
  if (page2.data.items.length !== 2) throw new Error(`case3: page2 items=${page2.data.items.length} (want 2)`);
  if (page3.data.items.length !== 1) throw new Error(`case3: page3 items=${page3.data.items.length} (want 1)`);
  if (page1.data.total !== 5 || page2.data.total !== 5 || page3.data.total !== 5) {
    throw new Error(`case3: total drifted across pages (${page1.data.total},${page2.data.total},${page3.data.total})`);
  }
  // No overlap across pages.
  const seen = new Set();
  for (const it of [...page1.data.items, ...page2.data.items, ...page3.data.items]) {
    if (seen.has(it.id)) throw new Error(`case3: id ${it.id} appears on multiple pages`);
    seen.add(it.id);
  }
  if (seen.size !== 5) throw new Error(`case3: pages covered ${seen.size} ids (want 5)`);
  console.log(
    `case3: pagination limit=2 -> page1=[${page1.data.items.map((i) => i.id).join(",")}] page2=[${page2.data.items.map((i) => i.id).join(",")}] page3=[${page3.data.items.map((i) => i.id).join(",")}], no overlap`,
  );

  // Case 4: each item includes the parsed blob, blob_hash, and metadata fields.
  const sample = list2.data.items[0];
  if (typeof sample?.blob_hash !== "string" || sample.blob_hash.length !== 64) {
    throw new Error(`case4: bad blob_hash: ${sample?.blob_hash}`);
  }
  if (typeof sample?.id !== "number" || sample.id <= 0) {
    throw new Error(`case4: bad id: ${sample?.id}`);
  }
  if (sample?.source_llm !== "openai") {
    throw new Error(`case4: bad source_llm: ${sample?.source_llm}`);
  }
  if (!sample?.blob || typeof sample.blob !== "object") {
    throw new Error(`case4: missing blob: ${JSON.stringify(sample)}`);
  }
  const blob = sample.blob;
  if (blob.session_id !== `conv_${4}`) {
    throw new Error(`case4: blob.session_id=${blob.session_id} (want conv_4)`);
  }
  if (!Array.isArray(blob.messages) || blob.messages.length !== 2) {
    throw new Error(`case4: blob.messages shape wrong: ${JSON.stringify(blob.messages)}`);
  }
  if (blob.metadata?.tag !== "smoke-4") {
    throw new Error(`case4: blob.metadata.tag=${blob.metadata?.tag} (want smoke-4)`);
  }
  console.log(`case4: items include id=${sample.id} blob_hash=${sample.blob_hash.slice(0, 8)}... source_llm=${sample.source_llm} blob.session_id=${blob.session_id} messages=${blob.messages.length}`);

  // Case 5: get_session(id) returns the full blob.
  const targetId = insertedIds[2];
  const got = await getSession({ session_id: targetId }, db);
  if (got.ok !== true) throw new Error(`case5: not ok: ${JSON.stringify(got)}`);
  if (got.data.id !== targetId) throw new Error(`case5: id mismatch: ${got.data.id} vs ${targetId}`);
  if (got.data.blob_hash.length !== 64) throw new Error(`case5: bad hash length`);
  if (got.data.blob.session_id !== `conv_2`) {
    throw new Error(`case5: blob.session_id=${got.data.blob.session_id} (want conv_2)`);
  }
  if (got.data.blob.messages.length !== 2) {
    throw new Error(`case5: blob.messages.length=${got.data.blob.messages.length} (want 2)`);
  }
  if (got.data.source_llm !== "openai") {
    throw new Error(`case5: source_llm=${got.data.source_llm} (want openai)`);
  }
  console.log(`case5: get_session(id=${targetId}) -> id=${got.data.id} blob.session_id=${got.data.blob.session_id} messages=${got.data.blob.messages.length}`);

  // Case 6: get_session on a missing id throws NOT_FOUND.
  try {
    await getSession({ session_id: 9999 }, db);
    throw new Error("case6: expected NOT_FOUND error, got success");
  } catch (err) {
    if (err?.code !== "NOT_FOUND") {
      throw new Error(`case6: expected NOT_FOUND, got ${err?.code}: ${err?.message}`);
    }
    if (err?.tool !== "get_session") {
      throw new Error(`case6: tool=${err?.tool} (want get_session)`);
    }
    console.log(`case6: get_session(9999) -> NOT_FOUND (message: ${err.message})`);
  }

  // Case 7: list_sessions external_session_id / parent_session_id round-trip
  // (inserted sessions had external_session_id set; check it's surfaced).
  const target = list2.data.items.find((it) => it.id === insertedIds[1]);
  if (target?.external_session_id !== "ext-1") {
    throw new Error(`case7: external_session_id=${target?.external_session_id} (want ext-1)`);
  }
  if (target?.parent_session_id !== null) {
    throw new Error(`case7: parent_session_id=${target?.parent_session_id} (want null)`);
  }
  console.log(`case7: list surfaces external_session_id=${target.external_session_id} parent_session_id=${target.parent_session_id}`);

  // Case 8: list_sessions after close-on-write reopen round-trip — open a
  // tmpfile DB, insert, close, reopen, list and get both still work.
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const tmp = path.join(os.tmpdir(), `chatport-ac5-${Date.now()}.db`);
  try {
    const db2 = openDatabase(tmp);
    const ins = await importSession({ blob: baseBlob(99), external_session_id: "ext-99" }, db2);
    if (ins.ok !== true) throw new Error(`case8: import failed: ${JSON.stringify(ins)}`);
    db2.close();
    const db3 = openDatabase(tmp);
    const lst = await listSessions({ limit: 20, offset: 0 }, db3);
    if (lst.data.total !== 1) throw new Error(`case8: reopen total=${lst.data.total} (want 1)`);
    const got2 = await getSession({ session_id: ins.data.id }, db3);
    if (got2.ok !== true || got2.data.blob.session_id !== "conv_99") {
      throw new Error(`case8: reopen get failed: ${JSON.stringify(got2)}`);
    }
    db3.close();
    console.log(`case8: file DB round-trip list+get (id=${ins.data.id}, blob.session_id=${got2.data.blob.session_id})`);
  } finally {
    await fs.unlink(tmp).catch(() => undefined);
    await fs.unlink(`${tmp}-wal`).catch(() => undefined);
    await fs.unlink(`${tmp}-shm`).catch(() => undefined);
  }

  db.close();
  console.log("OK");
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
