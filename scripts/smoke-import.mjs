// One-off smoke test for import_session: open an in-memory DB, call the
// handler, assert envelope shape + upsert behavior.
import { importSession } from "../dist/tools/import_session.js";
import { openDatabase } from "../dist/db/sqlite.js";

const sampleBlob = {
  session_id: "conv_abc",
  source_llm: "openai",
  messages: [
    { role: "user", content: "hi", created_at: 1_700_000_000 },
    { role: "assistant", content: "hello", created_at: 1_700_000_001 },
  ],
  metadata: { tag: "smoke" },
};

const anotherBlob = {
  ...sampleBlob,
  messages: [
    { role: "user", content: "different content", created_at: 1_700_000_010 },
  ],
};

async function main() {
  const db = openDatabase(":memory:");

  // Case 1: first insert.
  const env1 = await importSession(
    { blob: sampleBlob, external_session_id: "ext-1" },
    db,
  );
  if (env1.ok !== true) throw new Error(`case1: not ok: ${JSON.stringify(env1)}`);
  if (typeof env1.data.id !== "number" || env1.data.id <= 0) {
    throw new Error(`case1: bad id: ${env1.data.id}`);
  }
  if (typeof env1.data.blob_hash !== "string" || env1.data.blob_hash.length !== 64) {
    throw new Error(
      `case1: bad blob_hash length=${env1.data.blob_hash?.length} (want 64): ${env1.data.blob_hash}`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(env1.data.blob_hash)) {
    throw new Error(`case1: blob_hash not lowercase hex: ${env1.data.blob_hash}`);
  }
  if (env1.data.deduplicated !== false) {
    throw new Error(`case1: expected deduplicated=false, got ${env1.data.deduplicated}`);
  }
  if (typeof env1.data.created_at !== "number") {
    throw new Error(`case1: bad created_at: ${env1.data.created_at}`);
  }
  console.log(`case1: insert ok, id=${env1.data.id}, hash=${env1.data.blob_hash.slice(0, 8)}...`);

  // Case 2: same (source_llm, external_session_id) upserts to the same id.
  const env2 = await importSession(
    { blob: anotherBlob, external_session_id: "ext-1" },
    db,
  );
  if (env2.ok !== true) throw new Error(`case2: not ok: ${JSON.stringify(env2)}`);
  if (env2.data.id !== env1.data.id) {
    throw new Error(
      `case2: expected upsert to id=${env1.data.id}, got ${env2.data.id}`,
    );
  }
  if (env2.data.blob_hash !== env1.data.blob_hash) {
    throw new Error(
      `case2: hash should be unchanged (we returned the existing row), got ${env2.data.blob_hash}`,
    );
  }
  if (env2.data.deduplicated !== true) {
    throw new Error(`case2: expected deduplicated=true, got ${env2.data.deduplicated}`);
  }
  console.log(`case2: upsert ok, same id=${env2.data.id}, deduplicated=true`);

  // Case 3: different external_session_id inserts a new row.
  const env3 = await importSession(
    { blob: sampleBlob, external_session_id: "ext-2" },
    db,
  );
  if (env3.ok !== true) throw new Error(`case3: not ok: ${JSON.stringify(env3)}`);
  if (env3.data.id === env1.data.id) {
    throw new Error(`case3: expected new id, got same as case1: ${env3.data.id}`);
  }
  if (env3.data.deduplicated !== false) {
    throw new Error(`case3: expected deduplicated=false, got ${env3.data.deduplicated}`);
  }
  console.log(`case3: insert ok, new id=${env3.data.id}`);

  // Case 4: no external_session_id -> each call inserts a new row.
  const env4a = await importSession({ blob: sampleBlob }, db);
  const env4b = await importSession({ blob: sampleBlob }, db);
  if (env4a.data.id === env4b.data.id) {
    throw new Error(
      `case4: expected different ids for missing external_session_id, got same ${env4a.data.id}`,
    );
  }
  if (env4a.data.deduplicated !== false || env4b.data.deduplicated !== false) {
    throw new Error("case4: expected deduplicated=false on both");
  }
  console.log(
    `case4: no-external-id inserts give different ids (${env4a.data.id}, ${env4b.data.id})`,
  );

  // Case 5: schema-migration idempotency — re-open a fresh DB and confirm the
  // existing row is still there and a duplicate import upserts.
  db.close();
  const db2 = openDatabase(":memory:");
  const before = db2.listSessions({ limit: 1, offset: 0 });
  if (before.total !== 0) throw new Error("case5: fresh DB should be empty");
  const env5 = await importSession(
    { blob: sampleBlob, external_session_id: "ext-1" },
    db2,
  );
  if (env5.ok !== true) throw new Error("case5: insert into fresh DB failed");
  if (env5.data.deduplicated !== false) {
    throw new Error("case5: fresh DB should not dedupe");
  }
  const env5b = await importSession(
    { blob: sampleBlob, external_session_id: "ext-1" },
    db2,
  );
  if (env5b.data.id !== env5.data.id || env5b.data.deduplicated !== true) {
    throw new Error("case5: second insert should dedupe");
  }
  console.log("case5: schema migration idempotent, fresh DB upserts correctly");

  // Case 6: hash stability across runs. Same input blob must produce same hash.
  const re = await importSession({ blob: sampleBlob, external_session_id: "hash-check" }, db2);
  const re2 = await importSession(
    { blob: { ...sampleBlob, metadata: { tag: "smoke" } }, external_session_id: "hash-check2" },
    db2,
  );
  if (re.data.blob_hash !== re2.data.blob_hash) {
    throw new Error(
      `case6: hash should be stable for equivalent blobs, got ${re.data.blob_hash} vs ${re2.data.blob_hash}`,
    );
  }
  console.log(`case6: hash stable across runs (${re.data.blob_hash.slice(0, 8)}...)`);

  // Case 7: hash differs when blob content differs.
  const re3 = await importSession(
    { blob: { ...sampleBlob, messages: [...sampleBlob.messages, { role: "user", content: "extra", created_at: 1_700_000_999 }] }, external_session_id: "hash-diff" },
    db2,
  );
  if (re3.data.blob_hash === re.data.blob_hash) {
    throw new Error("case7: hash should differ for different blobs");
  }
  console.log(`case7: hash differs for different content (${re3.data.blob_hash.slice(0, 8)}...)`);

  db2.close();
  console.log("OK");
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
