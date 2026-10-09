# Rental Deposit Escrow DApp

SC6113 individual assignment: a financial decentralized application that holds a tenant's rental deposit in a
smart contract, so the landlord can no longer keep it arbitrarily and the tenant can no longer be left waiting
indefinitely.

> **Project status**
> - [x] Smart contract (`contracts/RentalDepositEscrow.sol`) and Hardhat test suite (73 tests)
> - [x] Deployment script
> - [x] Node.js (Express) backend: event indexer, MetaMask-signature login, evidence files, history API
> - [x] Web frontend with MetaMask
> - [ ] Report and screenshots

## Problem

Rental deposits are normally handed to the landlord. Disputes about deductions are common, the refund timing is
uncertain, and the tenant has little recourse. This DApp moves the deposit into a contract that neither party can
spend alone, defines what happens when someone stays silent, and brings in a platform arbiter only when the two
sides disagree.

## How it works

Three roles, each identified by an Ethereum address:

| Role | Who | Can do |
| --- | --- | --- |
| Landlord | creates the lease | create lease, return the deposit, propose a deduction (after the lease ends) |
| Tenant | pays the deposit | pay deposit, accept or reject a deduction |
| Arbiter | the platform = the account that deploys the contract | rule on disputed deductions only |

Lease lifecycle:

```
Created --payDeposit--> Funded --(lease ends)--+--releaseDeposit-------------------> Settled (full refund)
   |                                           |
   +--cancelLease--> Cancelled                 +--landlord silent for proposalWindow
                                               |      --claimByTimeout-------------> Settled (full refund)
                                               |
                                               +--proposeDeduction--> DeductionProposed
                                                      |--acceptDeduction-----------> Settled (as proposed)
                                                      |--tenant silent for responseWindow
                                                      |      --claimByTimeout------> Settled (as proposed)
                                                      +--rejectDeduction--> Disputed
                                                             --resolveDispute------> Settled (arbiter's split)
```

Design rules:

- **The contract is the only custodian.** The tenant pays into the contract; nobody can pull the money out
  except through the rules above.
- **Silence has a defined outcome.** A contract cannot force anyone to act, so deadlines decide: if the landlord
  does not propose a deduction in time, the tenant gets the full deposit; if the tenant does not answer a proposal
  in time, the proposal applies.
- **The arbiter is bounded.** It cannot award the landlord more than the landlord claimed, and it only acts on
  disputed leases.
- **Move-in baseline.** The landlord stores the hash of the move-in condition report when creating the lease. The
  tenant's `payDeposit` must supply the same hash, which is the tenant's on-chain acknowledgement of the baseline.
  Evidence files stay off-chain; only their SHA-256 hashes are stored.
- **Pull payments.** Settlement only credits internal balances. Each party then calls `withdraw()`.

## Architecture

```
 Browser (frontend/)                         Backend (backend/, Express)              Blockchain
 ┌───────────────────────┐   REST /api/*    ┌──────────────────────────┐             ┌────────────────────┐
 │ HTML / CSS / JS       │ ───────────────▶ │ auth   (signature login) │             │ RentalDepositEscrow│
 │ ethers v6 + MetaMask  │                  │ files  (upload/download) │ ◀── logs ── │  (Sepolia testnet) │
 │                       │ ◀─────────────── │ indexer (events → SQLite)│  getLease   └────────────────────┘
 │                       │                  └──────────────────────────┘                  ▲
 │                       │ ── transactions signed by MetaMask ─────────────────────────────┘
 └───────────────────────┘
```

- Transactions are signed in MetaMask and sent straight to the contract. The backend never holds a private key.
- Lease state shown on the page is read from the contract; the lease list and history come from the backend
  index, which is rebuilt from contract events.
- Evidence files are uploaded to the backend (signed-in users only). The backend returns their SHA-256, which is
  the `bytes32` stored on-chain, and can later re-hash a stored file to prove it still matches the chain.

## Prerequisites (WSL2 / Linux / macOS)

- Node.js 20 or newer (installed with nvm is fine)
- Git
- MetaMask in your browser

Keep the project inside the WSL filesystem (for example `~/6113individual`), not under `/mnt/c/...`; it is much
faster. If `npm install` fails while building `better-sqlite3`, install the build tools:
`sudo apt install build-essential python3`.

## Setup and tests

```bash
cd ~/6113individual
npm install
npx hardhat compile
npx hardhat test
```

Optional reports: `npm run gas` (gas per function) and `npm run coverage` (test coverage).

## Run it locally first (no testnet needed)

1. Start a local chain: `npm run node`. It prints 20 funded test accounts and their private keys.
2. In MetaMask add a network: RPC `http://127.0.0.1:8545`, chain id `31337`. Import three of the printed private
   keys (these keys are public test keys; use them only on this local chain):
   account #0 = platform arbiter, #1 = landlord, #2 = tenant.
3. In a second terminal deploy (account #0 becomes the arbiter): `npm run deploy:local`.
4. Configure the backend: `cp backend/.env.example backend/.env`, then set `NETWORK=localhost` in it.
5. Start the backend: `npm start`, then open <http://localhost:3000>.

If you restart `npm run node`, the chain starts from scratch: redeploy, and in MetaMask use
Settings → Developer tools → “Delete activity and nonce data” so its transaction counter resets.

## Deploy to Sepolia

1. Create three accounts in MetaMask (they share one seed phrase). They stand in for the three roles during the demo:
   Account 1 = landlord, Account 2 = tenant, Account 3 = platform/arbiter.
2. Fund Account 3 with Sepolia test ETH from a faucet, then send some to Accounts 1 and 2 for gas. Account 2 also
   needs the deposit amount (use something small such as 0.01 ETH).
3. Copy `.env.example` to `.env` and fill in the RPC URL and the private key of **Account 3 only**. Use a
   throw-away test account; never reuse a real wallet and never commit `.env`.
4. Deploy: `npm run deploy:sepolia`. This writes `deployments/sepolia.json` (address, ABI, deploy block).
   Optionally verify the source on Etherscan: `npx hardhat verify --network sepolia <address>`.
5. Configure the backend: `cp backend/.env.example backend/.env` and set `NETWORK=sepolia` and `RPC_URL`.
   This file is separate from the root `.env` on purpose, so the backend never sees the deployer key.
6. Start it: `npm start` and open <http://localhost:3000> in the browser that has MetaMask.

## Demo walkthrough (one person, three MetaMask accounts)

The page shows only what the current account can do. Switching the account in MetaMask reloads the page.

1. **Landlord** (Account 1): *New lease*. Enter the tenant's address (Account 2), a 0.01 ETH deposit, a lease length of
   a few minutes, short windows (e.g. 3 minutes), and upload a move-in report. MetaMask asks for one free signature
   (login) and one transaction.
2. **Tenant** (Account 2): open the lease, download the report, tick the acknowledgement and pay the deposit.
3. Wait for the lease to end (the page shows a countdown). Then **landlord**: *Propose deduction* with an amount and an
   evidence file, or *Return full deposit*.
4. **Tenant**: *Accept*, *Reject*, or do nothing. After the response window, anyone can press *Finalize* to record the default result (the deduction applies).
5. If rejected, **arbiter** (Account 3): review the files and submit a ruling.
6. Each party uses the *Withdraw* button at the top to collect their share.

`MIN_WINDOW` in the contract is one minute so that the silence paths can be shown on a testnet in minutes.

## Backend API

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `GET /api/config` | no | contract address, ABI, chain id, upload limits |
| `GET /api/leases?address=0x…` | no | leases where the address is landlord or tenant (the arbiter sees all) |
| `GET /api/leases/:id` | no | one lease and its event history |
| `POST /api/sync` | no | ask the indexer to catch up with the chain now |
| `GET /api/auth/nonce?address=0x…` | no | one-time message to sign |
| `POST /api/auth/login` | no | `{address, signature}` → bearer token (1 hour) |
| `POST /api/files?filename=…&type=…` | yes | upload raw bytes, returns the SHA-256 |
| `GET /api/files/:hash` | yes | download; only uploader, parties of a lease using that hash, or the arbiter |
| `GET /api/leases/:id/files` | yes | files of a lease, each re-hashed and compared with the on-chain hash |

On-chain data is public, so the first four endpoints need no login; only evidence files are protected.

## Project structure

```
contracts/
  RentalDepositEscrow.sol        main contract
  mocks/ReentrancyAttacker.sol   test-only malicious contract (never deployed)
test/RentalDepositEscrow.test.js Hardhat tests
scripts/deploy.js                deployment script
deployments/                     <network>.json written by the deploy script
backend/
  config.js db.js                configuration, SQLite schema and queries
  indexer.js                     polls contract events, keeps the index in sync
  auth.js                        signature login and sessions
  app.js server.js               REST API, file handling, static hosting
  .env.example                   backend settings (RPC URL only)
frontend/
  index.html style.css app.js    single-page UI using ethers and MetaMask
hardhat.config.js
.env.example                     deployer secrets template (copy to .env, never commit)
```

## Security notes

- **Authorization on-chain:** modifiers `onlyLandlord`, `onlyTenant`, `onlyParty`, `onlyArbiter`; the arbiter can
  never be a landlord or tenant of any lease.
- **Reentrancy:** checks-effects-interactions plus OpenZeppelin `ReentrancyGuard` on `withdraw`, covered by a test
  with a malicious contract that tries to re-enter.
- **Cheaper and safer code:** custom errors, packed structs, pull payments (no transfers inside settlement loops).
- **Input validation in three layers:** the page checks inputs before anything is sent; the backend re-validates
  addresses, ids, hashes, file type and size; the contract enforces every rule again, so a modified frontend cannot
  bypass it. Before sending, the page also simulates each transaction so reverts show a readable message.
- **Authentication without passwords:** a free MetaMask signature on a single-use challenge; sessions are random
  tokens that expire after an hour. No private key ever reaches the backend (it has its own `.env`).
- **Data privacy:** evidence files are never public. Only their hashes are on-chain, downloads require login and a
  role in the lease, files are served as attachments with `nosniff`, and `backend/data/` is git-ignored.
- **Private keys:** only in the root `.env` (git-ignored) for deployment, using a throw-away test account.
- **No markup injection:** the frontend writes all dynamic text with `textContent`, never `innerHTML`.
- The contract has no `receive`/`fallback`, so ether cannot be sent to it by accident.

## Known limitations

- The contract cannot judge whether damage really happened; evidence validity depends on the arbiter.
- The arbiter is a single trusted account. If it never rules, a disputed deposit stays locked.
- Deposits are held in ETH, so their fiat value can change during the lease.
- `MIN_WINDOW` is one minute so the timeout paths can be demonstrated on a testnet; a production deployment would
  use a much larger minimum.
- Sessions and login challenges are kept in memory (restarting the backend signs everyone out) and there is no rate
  limiting; a production system would use a shared store and throttling.
- File type checks rely on the browser-declared type; files are served as attachments to limit the risk.
