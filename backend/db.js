// SQLite storage (better-sqlite3).
//
//   leases : latest on-chain state of every lease (read back from the contract by the indexer)
//   events : every contract event, in order, used for the history view
//   files  : metadata of uploaded evidence files (content lives in data/uploads/<sha256>)
//   meta   : indexer bookkeeping (last processed block, which deployment the data belongs to)
//
// The chain is the source of truth. This database is a rebuildable index plus file metadata.
// All addresses are stored lowercase; hashes are lowercase 0x-prefixed hex.

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const config = require("./config");

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.uploadDir, { recursive: true });

const db = new Database(path.join(config.dataDir, `${config.network}.db`));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS leases (
    id                    INTEGER PRIMARY KEY,
    landlord              TEXT    NOT NULL,
    tenant                TEXT    NOT NULL,
    deposit_wei           TEXT    NOT NULL,
    deduction_wei         TEXT    NOT NULL,
    start_time            INTEGER NOT NULL,
    end_time              INTEGER NOT NULL,
    proposal_window       INTEGER NOT NULL,
    response_window       INTEGER NOT NULL,
    proposed_at           INTEGER NOT NULL,
    status                INTEGER NOT NULL,
    condition_report_hash TEXT    NOT NULL,
    evidence_hash         TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_leases_landlord ON leases(landlord);
  CREATE INDEX IF NOT EXISTS idx_leases_tenant   ON leases(tenant);

  CREATE TABLE IF NOT EXISTS events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    lease_id     INTEGER,
    name         TEXT    NOT NULL,
    args_json    TEXT    NOT NULL,
    tx_hash      TEXT    NOT NULL,
    log_index    INTEGER NOT NULL,
    block_number INTEGER NOT NULL,
    block_time   INTEGER NOT NULL,
    UNIQUE (tx_hash, log_index)
  );
  CREATE INDEX IF NOT EXISTS idx_events_lease ON events(lease_id);

  CREATE TABLE IF NOT EXISTS files (
    hash       TEXT    NOT NULL,
    uploader   TEXT    NOT NULL,
    filename   TEXT    NOT NULL,
    mime       TEXT    NOT NULL,
    size       INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (hash, uploader)
  );
`);

// ---------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------
const getMetaStmt = db.prepare("SELECT value FROM meta WHERE key = ?");
const setMetaStmt = db.prepare(
  "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
);

function getMeta(key) {
  const row = getMetaStmt.get(key);
  return row ? row.value : null;
}

function setMeta(key, value) {
  setMetaStmt.run(key, String(value));
}

function resetIndex() {
  db.exec("DELETE FROM events; DELETE FROM leases; DELETE FROM meta WHERE key = 'last_block';");
}

// If the contract was redeployed, the old index no longer applies.
{
  const deploymentId = `${config.deployment.address.toLowerCase()}:${config.deployment.deployTxHash || ""}`;
  const saved = getMeta("deployment");
  if (saved && saved !== deploymentId) {
    console.warn("[db] The contract deployment changed; clearing the old index.");
    resetIndex();
  }
  setMeta("deployment", deploymentId);
}

// ---------------------------------------------------------------------------
// leases and events (written by the indexer)
// ---------------------------------------------------------------------------
const insertEventStmt = db.prepare(`
  INSERT OR IGNORE INTO events (lease_id, name, args_json, tx_hash, log_index, block_number, block_time)
  VALUES (@lease_id, @name, @args_json, @tx_hash, @log_index, @block_number, @block_time)
`);

const upsertLeaseStmt = db.prepare(`
  INSERT INTO leases (
    id, landlord, tenant, deposit_wei, deduction_wei, start_time, end_time,
    proposal_window, response_window, proposed_at, status, condition_report_hash, evidence_hash
  ) VALUES (
    @id, @landlord, @tenant, @deposit_wei, @deduction_wei, @start_time, @end_time,
    @proposal_window, @response_window, @proposed_at, @status, @condition_report_hash, @evidence_hash
  )
  ON CONFLICT(id) DO UPDATE SET
    landlord = excluded.landlord,
    tenant = excluded.tenant,
    deposit_wei = excluded.deposit_wei,
    deduction_wei = excluded.deduction_wei,
    start_time = excluded.start_time,
    end_time = excluded.end_time,
    proposal_window = excluded.proposal_window,
    response_window = excluded.response_window,
    proposed_at = excluded.proposed_at,
    status = excluded.status,
    condition_report_hash = excluded.condition_report_hash,
    evidence_hash = excluded.evidence_hash
`);

// Everything for one block range is written atomically, together with the new cursor.
const applyBatch = db.transaction(({ events, leases, lastBlock }) => {
  for (const e of events) insertEventStmt.run(e);
  for (const l of leases) upsertLeaseStmt.run(l);
  setMeta("last_block", lastBlock);
});

// ---------------------------------------------------------------------------
// queries used by the API
// ---------------------------------------------------------------------------
function listLeases(address, all) {
  if (all) return db.prepare("SELECT * FROM leases ORDER BY id DESC").all();
  return db
    .prepare("SELECT * FROM leases WHERE landlord = ? OR tenant = ? ORDER BY id DESC")
    .all(address, address);
}

function getLease(id) {
  return db.prepare("SELECT * FROM leases WHERE id = ?").get(id) || null;
}

function getEvents(leaseId) {
  return db
    .prepare("SELECT * FROM events WHERE lease_id = ? ORDER BY block_number ASC, log_index ASC")
    .all(leaseId);
}

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------
const addFileStmt = db.prepare(`
  INSERT OR IGNORE INTO files (hash, uploader, filename, mime, size, created_at)
  VALUES (@hash, @uploader, @filename, @mime, @size, @created_at)
`);

function addFile({ hash, uploader, filename, mime, size }) {
  addFileStmt.run({ hash, uploader, filename, mime, size, created_at: Math.floor(Date.now() / 1000) });
}

function getFileMeta(hash, preferredUploader) {
  const rows = db.prepare("SELECT * FROM files WHERE hash = ?").all(hash);
  return rows.find((r) => r.uploader === preferredUploader) || rows[0] || null;
}

function isUploader(hash, address) {
  return !!db.prepare("SELECT 1 FROM files WHERE hash = ? AND uploader = ?").get(hash, address);
}

function leasesReferencingHash(hash) {
  return db
    .prepare("SELECT * FROM leases WHERE condition_report_hash = ? OR evidence_hash = ?")
    .all(hash, hash);
}

module.exports = {
  getMeta,
  setMeta,
  resetIndex,
  applyBatch,
  listLeases,
  getLease,
  getEvents,
  addFile,
  getFileMeta,
  isUploader,
  leasesReferencingHash,
};
