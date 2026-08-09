// Verifies deploy/handover.js against a throwaway anvil, including the safety
// rails: it must refuse to renounce while the sender still has credited
// balance, and after renouncing the old key must lose admin powers while
// keeping APPRAISER_ROLE.
const { spawn, execSync } = require("child_process");
const path = require("path");
const { JsonRpcProvider, Wallet, Contract, parseEther } = require("ethers");

const RPC = "http://127.0.0.1:8607";
const PK_DEPLOY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil #0
const PK_BUYER = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";  // anvil #1
const COLD = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";                              // anvil #2
const ROOT = path.join(__dirname, "..");
const FIXG = path.join(ROOT, "appraiser", "fixtures", "manifest_good.json");
const ADMIN_ROLE = "0x" + "00".repeat(32);

const run = (cmd, env) => execSync(cmd, { cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8" });

async function main() {
  try { execSync("pkill -f 'anvil --port 8607' || true"); } catch {}
  const anvil = spawn("anvil", ["--port", "8607", "--silent"], { stdio: "ignore" });
  const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true, pollingInterval: 50, cacheTimeout: -1 });
  for (let i = 0; i < 100; i++) { try { await provider.getBlockNumber(); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

  const results = [];
  const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n} ${d}`); };

  try {
    const env = { RPC_URL: RPC, PRIVATE_KEY: PK_DEPLOY };
    const contract = (run("node deploy/deploy.js", env).match(/^CONTRACT=(0x[0-9a-fA-F]{40})$/m) || [])[1];
    const id = (run(`node deploy/mint.js ${FIXG} 0.05 7 https://example.com/m.json`, { ...env, CONTRACT: contract }).match(/^VAULT_ID=(\d+)$/m) || [])[1];
    run(`node deploy/post-appraisal.js ${id} ${FIXG}`, { ...env, CONTRACT: contract });

    const art = require(path.join(ROOT, "artifacts", "CorpusVault.json"));
    const buyer = new Wallet(PK_BUYER, provider);
    const asBuyer = new Contract(contract, art.abi, buyer);
    await (await asBuyer.buyLicense(id, { value: parseEther("0.05") })).wait();

    const deployer = new Wallet(PK_DEPLOY, provider);
    const asDeployer = new Contract(contract, art.abi, deployer);
    const owed = await asDeployer.balances(deployer.address);
    // deploy key is BOTH creator (95%) and treasury (5%) here, so it is owed the full price
    check("sale credited the deploy key", owed === parseEther("0.05"), `${owed} wei`);

    // rail 1: renounce must be refused while a balance is outstanding
    let refused = false;
    try { run("node deploy/handover.js", { ...env, CONTRACT: contract, NEW_ADMIN: COLD, RENOUNCE: "true" }); }
    catch (e) { refused = /refusing to renounce/.test(String(e.stdout) + String(e.stderr)); }
    check("refuses to renounce with balance outstanding", refused);
    check("still admin after refused renounce", await asDeployer.hasRole(ADMIN_ROLE, deployer.address));

    // withdraw, then full handover
    await (await asDeployer.withdraw()).wait();
    const out = run("node deploy/handover.js", { ...env, CONTRACT: contract, NEW_ADMIN: COLD, TRANSFER_VAULTS: "true", RENOUNCE: "true" });
    check("handover reports done", /HANDOVER=done/.test(out));
    check("cold wallet holds admin", await asDeployer.hasRole(ADMIN_ROLE, COLD));
    check("deploy key lost admin", (await asDeployer.hasRole(ADMIN_ROLE, deployer.address)) === false);
    const apr = await asDeployer.APPRAISER_ROLE();
    check("deploy key KEEPS appraiser role", await asDeployer.hasRole(apr, deployer.address));
    check("treasury is the cold wallet", (await asDeployer.treasury()).toLowerCase() === COLD.toLowerCase());
    check("vault NFT moved to cold wallet", (await asDeployer.ownerOf(id)).toLowerCase() === COLD.toLowerCase());

    // old key can still appraise but can no longer touch money
    await (await asDeployer.setAppraisal(id, 9000, "0x" + "aa".repeat(32), "u", false)).wait();
    check("old key can still post appraisals", (await asDeployer.appraisals(id)).scoreBps === 9000n);
    let feeBlocked = false;
    try { await asDeployer.setProtocolFee.staticCall(100); } catch { feeBlocked = true; }
    check("old key can no longer change the fee", feeBlocked);

    // new revenue now credits the cold wallet
    const before = await asDeployer.balances(COLD);
    await (await asBuyer.buyLicense(id, { value: parseEther("0.05") })).wait();
    const after = await asDeployer.balances(COLD);
    check("new sales credit the cold wallet", after - before > 0n, `+${after - before} wei`);
  } finally {
    provider.destroy();
    anvil.kill();
  }

  const failed = results.filter((r) => !r).length;
  console.log(`\nhandover: ${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("test error:", e.shortMessage || e.message); process.exit(1); });
