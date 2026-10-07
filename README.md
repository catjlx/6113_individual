# Rental Deposit Escrow DApp

SC6113 individual assignment: a financial decentralized application that holds a tenant's rental deposit in a
smart contract, so the landlord can no longer keep it arbitrarily and the tenant can no longer be left waiting
indefinitely.

> **Project status**
> - [x] Smart contract (`contracts/RentalDepositEscrow.sol`) and Hardhat test suite
> - [x] Deployment script
> - [ ] Node.js (Express) backend: event indexer, file-hash verification, history API
> - [ ] Web frontend with MetaMask
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
  Evidence files stay off-chain; only their hashes are stored.
- **Pull payments.** Settlement only credits internal balances. Each party then calls `withdraw()`.

## Prerequisites (WSL2 / Linux / macOS)

- Node.js 20 or newer (installed with nvm is fine)
- Git
- MetaMask in your browser (for the frontend, a later step)

Keep the project inside the WSL filesystem (for example `~/6113individual`), not under `/mnt/c/...`; it is much
faster.

## Setup

```bash
cd ~/6113individual
npm install
npx hardhat compile
npx hardhat test
```

Optional reports for the written report:

```bash
npm run gas        # gas usage per function
npm run coverage   # test coverage
```

## Deploy to Sepolia

1. Create three accounts in MetaMask (they share one seed phrase). They stand in for the three roles during the demo:
   Account 1 = landlord, Account 2 = tenant, Account 3 = platform/arbiter.
2. Fund Account 3 with a little Sepolia test ETH from a faucet, then send some to Accounts 1 and 2 for gas.
   Accounts 2 also needs the deposit amount (use something small such as 0.01 ETH).
3. Copy `.env.example` to `.env` and fill in the RPC URL and the private key of **Account 3 only**.
   Use a throw-away test account. Never reuse a real wallet, and never commit `.env`.
4. Deploy:

```bash
npm run deploy:sepolia
```

The script writes `deployments/sepolia.json` (address, ABI, deploy block), which the backend and frontend read.
Optionally verify the source on Etherscan: `npx hardhat verify --network sepolia <address>`.

## Project structure

```
contracts/
  RentalDepositEscrow.sol        main contract
  mocks/ReentrancyAttacker.sol   test-only malicious contract (never deployed)
test/RentalDepositEscrow.test.js Hardhat tests
scripts/deploy.js                deployment script
deployments/                     <network>.json written by the deploy script
hardhat.config.js
.env.example                     template for secrets (copy to .env, never commit)
```

## Security notes

- Roles are enforced by modifiers (`onlyLandlord`, `onlyTenant`, `onlyParty`, `onlyArbiter`); the arbiter can
  never be a landlord or tenant of any lease.
- Checks-effects-interactions plus OpenZeppelin `ReentrancyGuard` on `withdraw`; covered by a test with a malicious
  contract that tries to re-enter.
- Custom errors instead of revert strings (cheaper, and carry data); structs packed to save storage slots.
- Inputs validated in the contract: non-zero tenant distinct from landlord/arbiter, non-zero deposit, sane times,
  windows within `[MIN_WINDOW, MAX_WINDOW]`, non-empty hashes, exact deposit amount.
- The contract has no `receive`/`fallback`, so ether cannot be sent to it by accident.
- Private keys live only in `.env` (git-ignored). No key is ever sent to or stored by the backend.

## Known limitations

- The contract cannot judge whether damage really happened; evidence validity depends on the arbiter.
- The arbiter is a single trusted account. If it never rules, a disputed deposit stays locked.
- Deposits are held in ETH, so their fiat value can change during the lease.
- `MIN_WINDOW` is one minute so the timeout paths can be demonstrated on a testnet; a production deployment would
  use a much larger minimum.
