// Full buyer path against a LIVE deployment: buy a licence onchain, then
// collect the dataset through the gateway and verify the delivered bytes
// hash to exactly what the vault committed to.
//
// This is the demo. It is also the only check that proves the contract, the
// gateway and the data agree with each other on a real chain rather than in
// a test harness.
//
// usage: node deploy/buy-and-collect.js <vaultId>
// env: RPC_URL, PRIVATE_KEY (the BUYER, not the owner), CONTRACT, GATEWAY
//      optional OUT_DIR (default ./collected), SKIP_BUY=true to only collect
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { JsonRpcProvider, Wallet, Contract, formatEther } = require("ethers");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const vaultId = process.argv[2];
  const { RPC_URL, PRIVATE_KEY, CONTRACT, GATEWAY } = process.env;
  if (!vaultId || !RPC_URL || !PRIVATE_KEY || !CONTRACT || !GATEWAY) {
    console.error("usage: node deploy/buy-and-collect.js <vaultId>");
    console.error("env: RPC_URL, PRIVATE_KEY (buyer), CONTRACT, GATEWAY");
    process.exit(1);
  }
  const outDir = process.env.OUT_DIR || path.join(__dirname, "..", "collected");
  const art = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "CorpusVault.json"), "utf8"));
  const provider = new JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
  const buyer = new Wallet(PRIVATE_KEY, provider);
  const c = new Contract(CONTRACT, art.abi, buyer);

  console.log(`buyer    ${buyer.address}`);
  const bal = await provider.getBalance(buyer.address);
  console.log(`balance  ${formatEther(bal)}`);

  const v = await c.vaults(vaultId);
  const a = await c.appraisals(vaultId);
  if (!a.exists) { console.error("vault is not appraised — the contract will refuse the sale"); process.exit(1); }
  if (a.refusal) { console.error("vault appraisal is in REFUSAL state — the contract blocks purchase by design"); process.exit(1); }
  if (!v.listed) { console.error("vault is not listed"); process.exit(1); }
  console.log(`price    ${formatEther(v.priceWei)} for ${Number(v.licenseDuration) / 86400} days`);
  console.log(`score    ${Number(a.scoreBps) / 100}%`);

  let has = await c.hasAccess(vaultId, buyer.address);
  if (has) {
    console.log("this address already holds an active licence — skipping purchase");
  } else if (String(process.env.SKIP_BUY).toLowerCase() === "true") {
    console.error("no licence and SKIP_BUY is set — nothing to collect");
    process.exit(1);
  } else {
    if (bal <= v.priceWei) { console.error(`insufficient balance: need more than ${formatEther(v.priceWei)} plus gas`); process.exit(1); }
    const tx = await c.buyLicense(vaultId, { value: v.priceWei });
    console.log(`buy tx   ${tx.hash}`);
    const rcpt = await tx.wait();
    console.log(`mined    block ${rcpt.blockNumber}`);
    // public RPCs are load-balanced; a read straight after the write can lag
    for (let i = 0; i < 12 && !has; i++) {
      has = await c.hasAccess(vaultId, buyer.address);
      if (!has) await sleep(3000);
    }
    if (!has) { console.error("licence not visible yet on this RPC — re-run with SKIP_BUY=true shortly"); process.exit(2); }
  }
  const expiry = await c.licenseExpiry(vaultId, buyer.address);
  console.log(`licence  active until ${new Date(Number(expiry) * 1000).toISOString()}`);

  // collect through the gateway
  const ch = await (await fetch(`${GATEWAY}/api/challenge?vaultId=${vaultId}`)).json();
  if (!ch.message) { console.error("gateway did not issue a challenge", ch); process.exit(1); }
  const signature = await buyer.signMessage(ch.message);
  const res = await fetch(`${GATEWAY}/api/download`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ vaultId, nonce: ch.nonce, signature }),
  });
  if (!res.ok) {
    const t = await res.text();
    console.error(`gateway refused: HTTP ${res.status} ${t.slice(0, 200)}`);
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const cd = res.headers.get("content-disposition") || "";
  const nameMatch = cd.match(/filename="?([^"]+)"?/);
  const outFile = path.join(outDir, nameMatch ? nameMatch[1] : `vault-${vaultId}.csv`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outFile, buf);

  const got = "0x" + crypto.createHash("sha256").update(buf).digest("hex");
  const want = v.contentHash;
  console.log(`file     ${outFile} (${buf.length} bytes)`);
  console.log(`onchain  ${want}`);
  console.log(`received ${got}`);
  if (got.toLowerCase() !== want.toLowerCase()) {
    console.error("HASH MISMATCH — the delivered bytes are not what the vault committed to");
    process.exit(1);
  }
  console.log("VERIFIED=true  bytes match the hash the contract stores");
}

main().catch((e) => { console.error("buy-and-collect failed:", e.shortMessage || e.message); process.exit(1); });
