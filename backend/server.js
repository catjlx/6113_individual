const config = require("./config");
const indexer = require("./indexer");
const { createApp } = require("./app");

const app = createApp({ triggerSync: indexer.syncOnce });

app.listen(config.port, () => {
  console.log(`Rental Deposit Escrow backend`);
  console.log(`  network:  ${config.network} (chainId ${config.deployment.chainId})`);
  console.log(`  contract: ${config.deployment.address}`);
  console.log(`  arbiter:  ${config.deployment.arbiter}`);
  console.log(`  open:     http://localhost:${config.port}`);
  indexer.start();
});
