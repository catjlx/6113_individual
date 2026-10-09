// Central configuration for the backend.
//
// The backend reads its OWN backend/.env (only a public RPC URL lives there). It deliberately never
// loads the repository-root .env, so the deployer private key never enters this process.

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, ".env") });

const network = process.env.NETWORK || "sepolia";

const deploymentFile = path.join(__dirname, "..", "deployments", `${network}.json`);
if (!fs.existsSync(deploymentFile)) {
  const script = network === "sepolia" ? "npm run deploy:sepolia" : "npm run deploy:local";
  throw new Error(
    `Deployment file not found: ${deploymentFile}\nDeploy the contract first (${script}) or set NETWORK in backend/.env.`
  );
}
const deployment = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));

const rpcUrl = process.env.RPC_URL || (network === "sepolia" ? "" : "http://127.0.0.1:8545");
if (!rpcUrl) {
  throw new Error("RPC_URL is not set. Copy backend/.env.example to backend/.env and fill it in.");
}

const dataDir = path.join(__dirname, "data");

module.exports = {
  network,
  rpcUrl,
  deployment, // { address, abi, chainId, deployBlock, arbiter, deployTxHash, ... }
  port: Number(process.env.PORT) || 3000,
  dataDir,
  uploadDir: path.join(dataDir, "uploads"),
  maxFileBytes: 10 * 1024 * 1024, // 10 MB
  allowedMimeTypes: ["image/png", "image/jpeg", "application/pdf", "text/plain"],
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS) || 8000,
  // 0 keeps the demo snappy; raise it on a real network to be safer against re-orgs.
  confirmations: Number(process.env.CONFIRMATIONS ?? 0),
  // Some RPC providers limit eth_getLogs ranges (free tiers can be as small as 10 blocks).
  logChunk: Number(process.env.LOG_CHUNK) || 500,
  explorer: network === "sepolia" ? "https://sepolia.etherscan.io" : null,
};
