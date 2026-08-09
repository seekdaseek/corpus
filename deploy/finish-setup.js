// Completes setup for an already-deployed CorpusVault. Idempotent: safe to
// re-run. Handles the real-world failure mode on public load-balanced RPCs,
// where a read immediately after deploy hits a replica that has not yet
// indexed the block ("could not decode result data" / empty 0x return).
//
// usage: node deploy/finish-setup.js
// env: RPC_URL, PRIVATE_KEY (admin), CONTRACT, optional APPRAISER (default: sender),
//      optional RPC_URL_ALT (tried when the primary keeps returning empty)
const fs = require("fs");
const path = require("path");
const { JsonRpcProvider, Wallet, Contract, id } = require("ethers");

// keccak256("APPRAISER_ROLE") — used if the constant getter cannot be read
const APPRAISER_ROLE_CONST = id("APPRAISER_ROLE");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForCode(provider, address, label, attempts = Number(process.env.WAIT_ATTEMPTS || 40)) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const code = await provider.getCode(address);
      if (code && code !== "0x") {
        console.log(`code present at ${address} via ${label} (attempt ${i}, ${(code.length - 2) / 2} bytes)`);
        return true;
      }
    } catch (e) {
      // fall through to retry
    }
    if (i % 5 === 0) console.log(`  waiting for RPC to serve contract code... (${i}/${attempts})`);
    await sleep(3000);
  }
  return false;
}

async function main() {
  const { RPC_URL, PRIVATE_KEY, CONTRACT, RPC_URL_ALT } = process.env;
  if (!RPC_URL || !PRIVATE_KEY || !CONTRACT) {
    console.error("need env: RPC_URL, PRIVATE_KEY, CONTRACT");
    process.exit(1);
  }

  const endpoints = [[RPC_URL, "primary"]];
  if (RPC_URL_ALT) endpoints.push([RPC_URL_ALT, "alt"]);

  let provider = null, label = null;
  for (const [url, name] of endpoints) {
    const p = new JsonRpcProvider(url, undefined, { cacheTimeout: -1 });
    if (await waitForCode(p, CONTRACT, name)) { provider = p; label = name; break; }
    p.destroy();
    console.log(`no code served by ${name} endpoint, trying next`);
  }
  if (!provider) {
    console.error(`no endpoint served code at ${CONTRACT}. Either the address is wrong or the network is badly lagged — re-run later.`);
    process.exit(1);
  }

  const wallet = new Wallet(PRIVATE_KEY, provider);
  const art = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "CorpusVault.json"), "utf8"));
  const c = new Contract(CONTRACT, art.abi, wallet);

  let role = null;
  for (let i = 0; i < 5; i++) {
    try { role = await c.APPRAISER_ROLE(); break; } catch (e) { await sleep(2000); }
  }
  if (!role) {
    role = APPRAISER_ROLE_CONST;
    console.log("could not read APPRAISER_ROLE() from chain; using computed keccak256 constant");
  }
  console.log(`APPRAISER_ROLE = ${role}`);

  const appraiser = process.env.APPRAISER || wallet.address;
  const already = await c.hasRole(role, appraiser);
  if (already) {
    console.log(`APPRAISER_ROLE already held by ${appraiser} — nothing to do`);
  } else {
    const tx = await c.grantRole(role, appraiser);
    console.log(`grantRole tx ${tx.hash}`);
    await tx.wait();
    const ok = await c.hasRole(role, appraiser);
    if (!ok) { console.error("grantRole mined but hasRole still false — investigate before minting"); process.exit(1); }
    console.log(`granted APPRAISER_ROLE to ${appraiser}`);
  }

  const [treasury, fee, next] = await Promise.all([c.treasury(), c.protocolFeeBps(), c.nextVaultId()]);
  console.log(`--- state via ${label} endpoint ---`);
  console.log(`contract  ${CONTRACT}`);
  console.log(`treasury  ${treasury}`);
  console.log(`feeBps    ${fee}`);
  console.log(`vaults    ${next}`);
  console.log("READY=true");
}

main().catch((e) => {
  console.error("finish-setup failed:", e.shortMessage || e.message);
  process.exit(1);
});
