// Deploys RentalDepositEscrow and writes deployments/<network>.json
// (address + ABI + deploy block) for the backend and frontend to read.
//
//   npx hardhat run scripts/deploy.js --network sepolia
//
// The deploying account becomes the platform arbiter, so use MetaMask "Account 3"
// (the account whose private key is in DEPLOYER_PRIVATE_KEY).

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const { ethers, network, artifacts } = hre;

  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Network:  ${network.name}`);
  console.log(`Deployer: ${deployer.address} (this account will be the arbiter)`);
  console.log(`Balance:  ${ethers.formatEther(balance)} ETH`);

  if (balance === 0n) {
    throw new Error("The deployer account has no ETH. Get Sepolia test ETH from a faucet first.");
  }

  const Escrow = await ethers.getContractFactory("RentalDepositEscrow");
  const escrow = await Escrow.deploy();
  await escrow.waitForDeployment();

  const address = await escrow.getAddress();
  const deployTx = escrow.deploymentTransaction();
  const receipt = await deployTx.wait();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log(`\nRentalDepositEscrow deployed to: ${address}`);
  console.log(`Transaction: ${deployTx.hash}`);
  console.log(`Block:       ${receipt.blockNumber}`);

  // The in-process Hardhat network disappears when the script ends, so there is
  // nothing worth saving for it.
  if (network.name === "hardhat") {
    console.log("\n(in-process hardhat network: no deployment file written)");
    return;
  }

  const artifact = await artifacts.readArtifact("RentalDepositEscrow");
  const output = {
    contract: "RentalDepositEscrow",
    network: network.name,
    chainId,
    address,
    arbiter: deployer.address,
    deployTxHash: deployTx.hash,
    deployBlock: receipt.blockNumber,
    deployedAt: new Date().toISOString(),
    abi: artifact.abi,
  };

  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(output, null, 2) + "\n");
  console.log(`\nSaved deployment info to ${path.relative(process.cwd(), file)}`);

  if (network.name === "sepolia") {
    console.log(`Etherscan: https://sepolia.etherscan.io/address/${address}`);
    console.log(`To verify the source: npx hardhat verify --network sepolia ${address}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
