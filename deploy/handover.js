// Hands a deployed CorpusVault over from the deploy key to a cold wallet.
// Moves: DEFAULT_ADMIN_ROLE, treasury, and (optionally) the vault NFTs, which
// is what actually controls where future revenue is credited (payout goes to
// ownerOf(vaultId), not to the immutable creator field).
//
// The deploy key keeps APPRAISER_ROLE, because that key runs unattended on a
// server signing appraisal reports. After renouncing admin it can post
// appraisals and nothing else — it cannot move funds or change the fee.
//
// usage: node deploy/handover.js
// env: RPC_URL, PRIVATE_KEY (current admin), CONTRACT, NEW_ADMIN (required)
//      TRANSFER_VAULTS=true   also send every vault NFT held by the sender
//      RENOUNCE=true          drop the sender's admin role (done LAST, after
//                             verifying NEW_ADMIN actually holds it)
//
// Already-credited pull balances are NOT moved — they belong to whoever earned
// them. Withdraw before renouncing if the sender has a balance; the script
// warns and refuses to renounce while one is outstanding.
const fs = require("fs");
const path = require("path");
const { JsonRpcProvider, Wallet, Contract } = require("ethers");

const ADMIN_ROLE = "0x" + "00".repeat(32); // DEFAULT_ADMIN_ROLE

async function main() {
  const { RPC_URL, PRIVATE_KEY, CONTRACT, NEW_ADMIN } = process.env;
  if (!RPC_URL || !PRIVATE_KEY || !CONTRACT || !NEW_ADMIN) {
    console.error("need env: RPC_URL, PRIVATE_KEY (current admin), CONTRACT, NEW_ADMIN");
    process.exit(1);
  }
  const provider = new JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
  const wallet = new Wallet(PRIVATE_KEY, provider);
  const art = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "CorpusVault.json"), "utf8"));
  const c = new Contract(CONTRACT, art.abi, wallet);

  const isAdmin = await c.hasRole(ADMIN_ROLE, wallet.address);
  if (!isAdmin) {
    console.error(`${wallet.address} does not hold DEFAULT_ADMIN_ROLE on ${CONTRACT} — wrong key or wrong contract`);
    process.exit(1);
  }
  console.log(`current admin ${wallet.address} -> new admin ${NEW_ADMIN}`);

  // 1. grant admin to the cold wallet
  if (await c.hasRole(ADMIN_ROLE, NEW_ADMIN)) {
    console.log("new admin already holds DEFAULT_ADMIN_ROLE");
  } else {
    await (await c.grantRole(ADMIN_ROLE, NEW_ADMIN)).wait();
    console.log("granted DEFAULT_ADMIN_ROLE");
  }

  // 2. point the protocol fee at the cold wallet
  const treasury = await c.treasury();
  if (treasury.toLowerCase() === NEW_ADMIN.toLowerCase()) {
    console.log("treasury already set to new admin");
  } else {
    await (await c.setTreasury(NEW_ADMIN)).wait();
    console.log(`treasury moved ${treasury} -> ${NEW_ADMIN}`);
  }

  // 3. optionally move the vault NFTs (controls future creator revenue)
  if (String(process.env.TRANSFER_VAULTS).toLowerCase() === "true") {
    const total = await c.nextVaultId();
    let moved = 0;
    for (let i = 1n; i <= total; i++) {
      let owner;
      try { owner = await c.ownerOf(i); } catch { continue; }
      if (owner.toLowerCase() !== wallet.address.toLowerCase()) continue;
      await (await c["safeTransferFrom(address,address,uint256)"](wallet.address, NEW_ADMIN, i)).wait();
      moved++;
      console.log(`vault ${i} -> ${NEW_ADMIN}`);
    }
    console.log(`moved ${moved} vault NFT(s)`);
  }

  // 4. renounce LAST, and only after verifying the new admin is real
  if (String(process.env.RENOUNCE).toLowerCase() === "true") {
    const confirmed = await c.hasRole(ADMIN_ROLE, NEW_ADMIN);
    if (!confirmed) {
      console.error("refusing to renounce: new admin does not hold the role");
      process.exit(1);
    }
    const owed = await c.balances(wallet.address);
    if (owed > 0n) {
      console.error(`refusing to renounce: ${owed} wei still credited to the sender — run withdraw first`);
      process.exit(1);
    }
    await (await c.renounceRole(ADMIN_ROLE, wallet.address)).wait();
    console.log(`renounced admin for ${wallet.address}`);
  }

  const appraiserRole = await c.APPRAISER_ROLE();
  console.log("--- final state ---");
  console.log(`admin(new)      ${await c.hasRole(ADMIN_ROLE, NEW_ADMIN)}`);
  console.log(`admin(old)      ${await c.hasRole(ADMIN_ROLE, wallet.address)}`);
  console.log(`appraiser(old)  ${await c.hasRole(appraiserRole, wallet.address)}`);
  console.log(`treasury        ${await c.treasury()}`);
  console.log("HANDOVER=done");
}

main().catch((e) => {
  console.error("handover failed:", e.shortMessage || e.message);
  process.exit(1);
});
