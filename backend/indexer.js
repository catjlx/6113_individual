// Event indexer.
//
// Polls the chain for RentalDepositEscrow logs, stores them in `events`, and refreshes the
// affected leases by reading their current state back from the contract (getLease). Reading the
// state from the contract, instead of re-implementing the state machine here, means the index can
// never disagree with the chain about what a lease looks like.

const { ethers } = require("ethers");
const config = require("./config");
const store = require("./db");

const { address, abi, chainId, deployBlock } = config.deployment;

const provider = new ethers.JsonRpcProvider(config.rpcUrl, chainId, { staticNetwork: true });
const contract = new ethers.Contract(address, abi, provider);
const iface = contract.interface;

// bigint -> string so that the arguments can be stored as JSON.
function serializeArgs(parsed) {
  const out = {};
  parsed.fragment.inputs.forEach((input, i) => {
    const value = parsed.args[i];
    out[input.name] = typeof value === "bigint" ? value.toString() : value;
  });
  return out;
}

async function readLease(id, blockTag) {
  let l;
  try {
    l = await contract.getLease(id, { blockTag });
  } catch {
    // Some RPC nodes prune old state; fall back to the latest state (it is still the truth).
    l = await contract.getLease(id);
  }
  return {
    id,
    landlord: l.landlord.toLowerCase(),
    tenant: l.tenant.toLowerCase(),
    deposit_wei: l.depositAmount.toString(),
    deduction_wei: l.deductionAmount.toString(),
    start_time: Number(l.startTime),
    end_time: Number(l.endTime),
    proposal_window: Number(l.proposalWindow),
    response_window: Number(l.responseWindow),
    proposed_at: Number(l.proposedAt),
    status: Number(l.status),
    condition_report_hash: l.conditionReportHash,
    evidence_hash: l.evidenceHash,
  };
}

async function processRange(from, to) {
  const logs = await provider.getLogs({ address, fromBlock: from, toBlock: to });

  const blockTimes = new Map();
  const events = [];
  const leaseIds = new Set();

  for (const log of logs) {
    const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
    if (!parsed) continue;

    if (!blockTimes.has(log.blockNumber)) {
      const block = await provider.getBlock(log.blockNumber);
      blockTimes.set(log.blockNumber, block ? block.timestamp : 0);
    }

    const args = serializeArgs(parsed);
    const leaseId = args.leaseId !== undefined ? Number(args.leaseId) : null;
    if (leaseId !== null) leaseIds.add(leaseId);

    events.push({
      lease_id: leaseId,
      name: parsed.name,
      args_json: JSON.stringify(args),
      tx_hash: log.transactionHash,
      log_index: log.index,
      block_number: log.blockNumber,
      block_time: blockTimes.get(log.blockNumber),
    });
  }

  // Read each touched lease at the end of the processed range so that it matches the events.
  const leases = [];
  for (const id of leaseIds) leases.push(await readLease(id, to));

  store.applyBatch({ events, leases, lastBlock: to });
  return events.length;
}

let syncing = false;

async function syncOnce() {
  if (syncing) return { skipped: true };
  syncing = true;
  try {
    const latest = await provider.getBlockNumber();
    let last = Number(store.getMeta("last_block") ?? deployBlock - 1);

    // A local development chain that was restarted has fewer blocks than we already indexed.
    if (last > latest) {
      console.warn("[indexer] The chain is behind the index (was the local node restarted?). Re-indexing.");
      store.resetIndex();
      last = deployBlock - 1;
    }

    const target = latest - config.confirmations;
    let from = last + 1;
    let count = 0;
    while (from <= target) {
      const to = Math.min(from + config.logChunk - 1, target);
      count += await processRange(from, to);
      from = to + 1;
    }
    return { latest, events: count };
  } finally {
    syncing = false;
  }
}

function start() {
  const run = async () => {
    try {
      await syncOnce();
    } catch (error) {
      console.error("[indexer] sync failed:", error.shortMessage || error.message);
    }
  };
  run();
  return setInterval(run, config.pollIntervalMs);
}

module.exports = { syncOnce, start };
