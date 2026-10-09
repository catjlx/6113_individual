// Passwordless authentication with a MetaMask signature (similar to "Sign-In with Ethereum").
//
//   1. GET  /api/auth/nonce?address=0x...   -> server returns a one-time message
//   2. the wallet signs the message (personal_sign, free, no transaction)
//   3. POST /api/auth/login {address, signature} -> server recovers the signer address and, if it
//      matches, returns a short-lived bearer token
//
// The backend never sees a private key. Challenges are single-use and expire after 5 minutes;
// sessions last one hour. Both live in memory, so restarting the server logs everyone out.

const crypto = require("crypto");
const { ethers } = require("ethers");

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 60 * 60 * 1000;

const challenges = new Map(); // lowercase address -> { message, expiresAt }
const sessions = new Map(); // token -> { address, expiresAt }

class AuthError extends Error {
  constructor(message) {
    super(message);
    this.status = 401;
  }
}

function prune() {
  const now = Date.now();
  for (const [key, c] of challenges) if (c.expiresAt < now) challenges.delete(key);
  for (const [key, s] of sessions) if (s.expiresAt < now) sessions.delete(key);
}

function createChallenge(address) {
  prune();
  const checksummed = ethers.getAddress(address); // throws on an invalid address
  const nonce = crypto.randomBytes(16).toString("hex");
  const issuedAt = new Date().toISOString();
  const message =
    "Sign in to Rental Deposit Escrow\n\n" +
    `Address: ${checksummed}\n` +
    `Nonce: ${nonce}\n` +
    `Issued at: ${issuedAt}\n\n` +
    "This signature is free and does not authorize any transaction.";
  challenges.set(checksummed.toLowerCase(), { message, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  return message;
}

function login(address, signature) {
  prune();
  const checksummed = ethers.getAddress(address);
  const key = checksummed.toLowerCase();

  const challenge = challenges.get(key);
  if (!challenge) throw new AuthError("No active challenge for this address. Request a new one.");
  challenges.delete(key); // single use, even if the signature turns out to be wrong

  let recovered;
  try {
    recovered = ethers.verifyMessage(challenge.message, signature);
  } catch {
    throw new AuthError("Invalid signature.");
  }
  if (recovered.toLowerCase() !== key) throw new AuthError("The signature does not match the address.");

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(token, { address: key, expiresAt });
  return { token, expiresAt };
}

// Express middleware: sets req.user to the lowercase address of the signed-in wallet.
function requireAuth(req, res, next) {
  prune();
  const match = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || "");
  const session = match ? sessions.get(match[1]) : null;
  if (!session) {
    return res.status(401).json({ error: "Not signed in. Sign the login message with your wallet." });
  }
  req.user = session.address;
  next();
}

module.exports = { AuthError, createChallenge, login, requireAuth };
