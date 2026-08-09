// Creates a vault for one dataset epoch.
// usage: node deploy/mint.js <manifest.json> <priceNative> <durationDays> <manifestURI>
// env: RPC_URL, PRIVATE_KEY, CONTRACT
// contentHash = sha256 of the data file named in the manifest — computed here,
// so what goes onchain is the hash of the actual bytes being sold.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { JsonRpcProvider, Wallet, Contract, parseEther } = require("ethers");

async function main() {
  const [manifestPath, priceNative, durationDays, manifestURI] = process.argv.slice(2);
  const { RPC_URL, PRIVATE_KEY, CONTRACT } = process.env;
  if (!manifestPath || !priceNative || !durationDays || !manifestURI || !RPC_URL || !PRIVATE_KEY || !CONTRACT) {
    console.error("usage: node deploy/mint.js <manifest.json> <priceNative> <durationDays> <manifestURI>");
    console.error("env: RPC_URL, PRIVATE_KEY, CONTRACT");
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const dataPath = path.join(path.dirname(manifestPath), manifest.file);
  const raw = fs.readFileSync(dataPath);
  const contentHash = "0x" + crypto.createHash("sha256").update(raw).digest("hex");

  const provider = new JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
  const wallet = new Wallet(PRIVATE_KEY, provider);
  const art = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "CorpusVault.json"), "utf8"));
  const c = new Contract(CONTRACT, art.abi, wallet);

  const price = parseEther(priceNative);
  const duration = BigInt(Math.round(Number(durationDays) * 86400));
  const tx = await c.createVault(contentHash, manifestURI, price, duration);
  const rcpt = await tx.wait();

  let vaultId = null;
  for (const log of rcpt.logs) {
    try {
      const p = c.interface.parseLog(log);
      if (p && p.name === "VaultCreated") vaultId = p.args.vaultId;
    } catch {}
  }
  console.log(`minted "${manifest.name}" contentHash ${contentHash}`);
  console.log(`price ${priceNative} native, duration ${durationDays} days, manifest ${manifestURI}`);
  console.log(`VAULT_ID=${vaultId}`);
}

main().catch((e) => {
  console.error("mint failed:", e.shortMessage || e.message);
  process.exit(1);
});
