// Express application: REST API, evidence file handling and static frontend.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { ethers } = require("ethers");

const config = require("./config");
const store = require("./db");
const auth = require("./auth");

const ZERO_HASH = "0x" + "0".repeat(64);
const STATUS_NAMES = ["Created", "Funded", "DeductionProposed", "Disputed", "Settled", "Cancelled"];
const arbiterAddress = config.deployment.arbiter.toLowerCase();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// input validation helpers (the backend never trusts what the browser sends)
// ---------------------------------------------------------------------------
function parseAddress(value) {
  if (typeof value !== "string" || !ethers.isAddress(value)) {
    throw new HttpError(400, "A valid Ethereum address is required.");
  }
  return value.toLowerCase();
}

function parseLeaseId(value) {
  if (!/^[1-9][0-9]{0,9}$/.test(String(value))) throw new HttpError(400, "Invalid lease id.");
  return Number(value);
}

function parseHash(value) {
  const hash = String(value).toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(hash)) throw new HttpError(400, "Invalid file hash.");
  return hash;
}

function cleanFilename(name) {
  const base = path
    .basename(String(name || "file"))
    .replace(/[\x00-\x1f\x7f"\\/<>:|?*]/g, "_")
    .trim();
  return (base || "file").slice(0, 120);
}

function filePathFor(hash) {
  // `hash` has already been validated against ^0x[a-f0-9]{64}$, so it cannot contain path separators.
  return path.join(config.uploadDir, hash.slice(2));
}

function sha256OfFile(filePath) {
  return "0x" + crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function toApiLease(row) {
  return {
    id: row.id,
    landlord: row.landlord,
    tenant: row.tenant,
    depositWei: row.deposit_wei,
    deductionWei: row.deduction_wei,
    startTime: row.start_time,
    endTime: row.end_time,
    proposalWindow: row.proposal_window,
    responseWindow: row.response_window,
    proposedAt: row.proposed_at,
    status: row.status,
    statusName: STATUS_NAMES[row.status] || "Unknown",
    conditionReportHash: row.condition_report_hash,
    evidenceHash: row.evidence_hash,
  };
}

function toApiEvent(row) {
  return {
    id: row.id,
    name: row.name,
    args: JSON.parse(row.args_json),
    txHash: row.tx_hash,
    logIndex: row.log_index,
    blockNumber: row.block_number,
    blockTime: row.block_time,
  };
}

// Evidence files are private: the uploader, the two parties of a lease that references the file's
// hash, and the platform arbiter may read them. Everyone else gets a 403.
function canAccessFile(hash, user) {
  if (store.isUploader(hash, user)) return true;
  const leases = store.leasesReferencingHash(hash);
  if (user === arbiterAddress && leases.length > 0) return true;
  return leases.some((l) => l.landlord === user || l.tenant === user);
}

// ---------------------------------------------------------------------------
// app factory
// ---------------------------------------------------------------------------
function createApp({ triggerSync }) {
  const app = express();
  app.disable("x-powered-by");

  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "no-referrer");
    res.set("X-Frame-Options", "DENY");
    next();
  });
  app.use(express.json({ limit: "10kb" }));

  // --- public chain data -----------------------------------------------------
  app.get("/api/config", (req, res) => {
    res.json({
      network: config.network,
      chainId: config.deployment.chainId,
      contractAddress: config.deployment.address,
      arbiter: config.deployment.arbiter,
      abi: config.deployment.abi,
      explorer: config.explorer,
      maxFileBytes: config.maxFileBytes,
      allowedMimeTypes: config.allowedMimeTypes,
    });
  });

  app.get("/api/leases", (req, res) => {
    const address = parseAddress(req.query.address);
    const rows = store.listLeases(address, address === arbiterAddress);
    res.json({ leases: rows.map(toApiLease) });
  });

  app.get("/api/leases/:id", (req, res) => {
    const id = parseLeaseId(req.params.id);
    const row = store.getLease(id);
    if (!row) throw new HttpError(404, "Lease not found (it may not be indexed yet).");
    res.json({ lease: toApiLease(row), events: store.getEvents(id).map(toApiEvent) });
  });

  app.post("/api/sync", async (req, res) => {
    try {
      await triggerSync();
      res.json({ ok: true });
    } catch (error) {
      res.status(502).json({ ok: false, error: "Could not reach the blockchain node." });
    }
  });

  // --- authentication ----------------------------------------------------------
  app.get("/api/auth/nonce", (req, res) => {
    const address = parseAddress(req.query.address);
    res.json({ message: auth.createChallenge(address) });
  });

  app.post("/api/auth/login", (req, res) => {
    const { address, signature } = req.body || {};
    parseAddress(address);
    if (typeof signature !== "string" || !/^0x[a-fA-F0-9]{130}$/.test(signature)) {
      throw new HttpError(400, "A valid signature is required.");
    }
    const { token, expiresAt } = auth.login(address, signature);
    res.json({ token, expiresAt });
  });

  // --- evidence files ----------------------------------------------------------
  // Upload raw bytes (Content-Type: application/octet-stream). The server computes the SHA-256,
  // which is the value that goes on-chain as the lease's bytes32 hash.
  app.post(
    "/api/files",
    auth.requireAuth,
    express.raw({ type: "application/octet-stream", limit: config.maxFileBytes }),
    (req, res) => {
      const mime = String(req.query.type || "");
      if (!config.allowedMimeTypes.includes(mime)) {
        throw new HttpError(400, `File type not allowed. Use one of: ${config.allowedMimeTypes.join(", ")}.`);
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw new HttpError(400, "The file is empty.");
      }

      const hash = "0x" + crypto.createHash("sha256").update(req.body).digest("hex");
      try {
        fs.writeFileSync(filePathFor(hash), req.body, { flag: "wx" }); // identical content is stored once
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }

      const filename = cleanFilename(req.query.filename);
      store.addFile({ hash, uploader: req.user, filename, mime, size: req.body.length });
      res.status(201).json({ hash, size: req.body.length, filename });
    }
  );

  app.get("/api/files/:hash", auth.requireAuth, (req, res) => {
    const hash = parseHash(req.params.hash);
    if (!canAccessFile(hash, req.user)) throw new HttpError(403, "You are not allowed to read this file.");

    const meta = store.getFileMeta(hash, req.user);
    const filePath = filePathFor(hash);
    if (!meta || !fs.existsSync(filePath)) throw new HttpError(404, "File not found.");

    res.sendFile(filePath, {
      dotfiles: "allow", // the path is built by us, never taken from the request
      headers: {
        "Content-Type": meta.mime,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(meta.filename)}`,
      },
    });
  });

  // Files referenced by a lease, each re-hashed and compared with the hash recorded on-chain.
  app.get("/api/leases/:id/files", auth.requireAuth, (req, res) => {
    const id = parseLeaseId(req.params.id);
    const lease = store.getLease(id);
    if (!lease) throw new HttpError(404, "Lease not found (it may not be indexed yet).");
    if (req.user !== lease.landlord && req.user !== lease.tenant && req.user !== arbiterAddress) {
      throw new HttpError(403, "Only the parties of this lease and the arbiter can see its files.");
    }

    const files = [];
    for (const [kind, hash] of [
      ["conditionReport", lease.condition_report_hash],
      ["evidence", lease.evidence_hash],
    ]) {
      if (hash === ZERO_HASH) continue; // no evidence submitted yet
      const meta = store.getFileMeta(hash, req.user);
      const filePath = filePathFor(hash);
      const available = !!meta && fs.existsSync(filePath);
      files.push({
        kind,
        hash,
        available,
        filename: meta ? meta.filename : null,
        size: meta ? meta.size : null,
        intact: available ? sha256OfFile(filePath) === hash : null,
      });
    }
    res.json({ files });
  });

  // --- frontend ----------------------------------------------------------------
  // Serve the browser build of ethers from node_modules so the page works without a CDN.
  const ethersBundle = path.resolve(path.dirname(require.resolve("ethers")), "..", "dist", "ethers.umd.min.js");
  if (!fs.existsSync(ethersBundle)) {
    console.warn(`[app] Could not find ${ethersBundle}; the web page will not load ethers.`);
  }
  app.get("/vendor/ethers.umd.min.js", (req, res) => res.sendFile(ethersBundle, { dotfiles: "allow" }));
  app.use(express.static(path.join(__dirname, "..", "frontend")));

  app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));

  // --- errors ------------------------------------------------------------------
  app.use((err, req, res, next) => {
    if (err.type === "entity.too.large") {
      return res.status(413).json({ error: `File too large (limit ${config.maxFileBytes / 1024 / 1024} MB).` });
    }
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Malformed JSON." });

    // ethers throws on malformed addresses inside auth; treat those as client errors
    if (err.code === "INVALID_ARGUMENT") return res.status(400).json({ error: "Invalid input." });

    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? "Internal server error." : err.message });
  });

  return app;
}

module.exports = { createApp };
