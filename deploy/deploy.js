// Deploys CorpusVault. Reads env: RPC_URL, PRIVATE_KEY, and optionally
// TREASURY (default: deployer), FEE_BPS (default: 500 = 5%), APPRAISER
// (default: deployer). Prints CONTRACT=<address> for scripting.
//
// X Layer (verified from OKX docs, Aug 9 2026):
//   testnet "terigon"  chainId 1952  https://testrpc.xlayer.tech/terigon
//   mainnet            chainId 196   https://rpc.xlayer.tech
// Gas token is OKB on both. Chain 195 configs found on ChainList are the
// DEPRECATED old testnet — do not use them.
const fs = require("fs");
const path = require("path");
const { JsonRpcProvider, Wallet, ContractFactory } = require("ethers");

async function main() {
  const { RPC_URL, PRIVATE_KEY } = process.env;
  if (!RPC_URL || !PRIVATE_KEY) {
    console.error("need env: RPC_URL, PRIVATE_KEY");
    process.exit(1);
  }
  const provider = new JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
  const wallet = new Wallet(PRIVATE_KEY, provider);
  const net = await provider.getNetwork();
  const bal = await provider.getBalance(wallet.address);
  console.log(`deployer ${wallet.address} on chainId ${net.chainId}, balance ${bal} wei`);
  if (bal === 0n) {
    console.error("deployer has zero balance on this chain — fund it first (faucet for testnet)");
    process.exit(1);
  }

  const art = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "CorpusVault.json"), "utf8"));
  const treasury = process.env.TREASURY || wallet.address;
  const feeBps = Number(process.env.FEE_BPS || 500);
  const appraiser = process.env.APPRAISER || wallet.address;

  const factory = new ContractFactory(art.abi, art.bytecode, wallet);
  const c = await factory.deploy(wallet.address, treasury, feeBps);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log(`deployed CorpusVault at ${addr} (treasury ${treasury}, fee ${feeBps} bps)`);

  const role = await c.APPRAISER_ROLE();
  const tx = await c.grantRole(role, appraiser);
  await tx.wait();
  console.log(`granted APPRAISER_ROLE to ${appraiser}`);
  console.log(`CONTRACT=${addr}`);
}

main().catch((e) => {
  console.error("deploy failed:", e.shortMessage || e.message);
  process.exit(1);
});
