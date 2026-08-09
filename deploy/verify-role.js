const fs = require("fs");
const path = require("path");
const { JsonRpcProvider, Wallet, Contract, id } = require("ethers");

const APPRAISER_ROLE = id("APPRAISER_ROLE");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { RPC_URL, PRIVATE_KEY, CONTRACT, RPC_URL_ALT } = process.env;
  if (!RPC_URL || !PRIVATE_KEY || !CONTRACT) {
    console.error("need env: RPC_URL, PRIVATE_KEY, CONTRACT");
    process.exit(1);
  }
  const txHash = process.argv[2];
  const art = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "CorpusVault.json"), "utf8"));

  const endpoints = [[RPC_URL, "primary"]];
  if (RPC_URL_ALT) endpoints.push([RPC_URL_ALT, "alt"]);

  const providers = endpoints.map(([url, name]) => [new JsonRpcProvider(url, undefined, { cacheTimeout: -1 }), name]);
  const wallet = new Wallet(PRIVATE_KEY, providers[0][0]);
  const appraiser = process.env.APPRAISER || wallet.address;
  console.log(`checking APPRAISER_ROLE for ${appraiser} on ${CONTRACT}`);

  let grantBlock = null;
  if (txHash) {
    for (const [p, name] of providers) {
      try {
        const rcpt = await p.getTransactionReceipt(txHash);
        if (rcpt) {
          console.log(`receipt via ${name}: status ${rcpt.status} in block ${rcpt.blockNumber}`);
          if (rcpt.status === 1) grantBlock = rcpt.blockNumber;
          break;
        }
      } catch {}
    }
    if (grantBlock === null) console.log("no successful receipt found for that tx hash yet");
  }

  const attempts = Number(process.env.WAIT_ATTEMPTS || 20);
  for (let i = 1; i <= attempts; i++) {
    for (const [p, name] of providers) {
      try {
        const c = new Contract(CONTRACT, art.abi, p);
        const [has, bn] = await Promise.all([c.hasRole(APPRAISER_ROLE, appraiser), p.getBlockNumber()]);
        console.log(`  ${name} @ block ${bn}: hasRole = ${has}${grantBlock !== null && bn < grantBlock ? "  (BEHIND the grant block — lagging replica)" : ""}`);
        if (has) {
          console.log(`ROLE_OK=true  (confirmed via ${name} at block ${bn})`);
          providers.forEach(([pp]) => pp.destroy());
          return;
        }
      } catch (e) {
        console.log(`  ${name}: read failed (${e.shortMessage || e.message})`);
      }
    }
    await sleep(3000);
  }

  console.log("role not visible on any endpoint after polling");
  if (grantBlock !== null) {
    console.log(`NOTE: a grantRole tx succeeded in block ${grantBlock}. If reads still say false, the RPC set is badly lagged — re-run this script later before re-granting.`);
  }
  if (String(process.env.REGRANT).toLowerCase() === "true") {
    const c = new Contract(CONTRACT, art.abi, wallet);
    const tx = await c.grantRole(APPRAISER_ROLE, appraiser);
    console.log(`re-grant tx ${tx.hash}`);
    const rcpt = await tx.wait();
    console.log(`re-grant mined status ${rcpt.status} in block ${rcpt.blockNumber} — re-run this script to confirm`);
  } else {
    console.log("re-run later, or set REGRANT=true to send another grantRole");
  }
  providers.forEach(([pp]) => pp.destroy());
  process.exit(1);
}

main().catch((e) => {
  console.error("verify-role failed:", e.shortMessage || e.message);
  process.exit(1);
});
