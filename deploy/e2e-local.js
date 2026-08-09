// Local end-to-end smoke test. Boots a throwaway anvil, then runs the REAL
// CLI scripts (deploy.js, mint.js, post-appraisal.js) as child processes and
// verifies the full flow onchain: deploy -> mint -> appraise -> buy ->
// access granted, plus the refusal path: corrupted epoch -> refusal posted ->
// purchase hard-blocked with AppraisalRefused.
//
// Keys below are the canonical PUBLIC anvil/hardhat dev keys for the local
// throwaway chain only. Never put a real key in this file.
const { spawn, execSync } = require("child_process");
const path = require("path");
const { JsonRpcProvider, Wallet, Contract, parseEther } = require("ethers");

const RPC = "http://127.0.0.1:8602";
const PK0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // deployer/appraiser (anvil #0)
const PK1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // buyer (anvil #1)
const ROOT = path.join(__dirname, "..");
const FIXG = path.join(ROOT, "appraiser", "fixtures", "manifest_good.json");
const FIXB = path.join(ROOT, "appraiser", "fixtures", "manifest_bad.json");

function run(cmd, env) {
  return execSync(cmd, { cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8" });
}

async function main() {
  try { execSync("pkill -f 'anvil --port 8602' || true"); } catch {}
  const anvil = spawn("anvil", ["--port", "8602", "--silent"], { stdio: "ignore" });
  const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true, pollingInterval: 50, cacheTimeout: -1 });
  for (let i = 0; i < 100; i++) { try { await provider.getBlockNumber(); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

  const results = [];
  const check = (name, ok, detail = "") => { results.push([name, ok, detail]); console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`); };

  try {
    // 1. deploy via the real CLI
    const dep = run(`node deploy/deploy.js`, { RPC_URL: RPC, PRIVATE_KEY: PK0 });
    const contract = (dep.match(/^CONTRACT=(0x[0-9a-fA-F]{40})$/m) || [])[1];
    check("deploy CLI prints CONTRACT", Boolean(contract), contract || dep);
    if (!contract) throw new Error("no contract address");

    // 2. mint good epoch via the real CLI
    const m1 = run(`node deploy/mint.js ${FIXG} 0.05 7 https://example.com/manifest_good.json`, { RPC_URL: RPC, PRIVATE_KEY: PK0, CONTRACT: contract });
    const id1 = (m1.match(/^VAULT_ID=(\d+)$/m) || [])[1];
    check("mint CLI prints VAULT_ID", id1 === "1", `got ${id1}`);

    // 3. post appraisal (good) via the real CLI
    const p1 = run(`node deploy/post-appraisal.js ${id1} ${FIXG}`, { RPC_URL: RPC, PRIVATE_KEY: PK0, CONTRACT: contract });
    check("good epoch appraised score 10000, no refusal", /score 10000 bps, refusal false/.test(p1));

    // 4. buy with a second account, verify access
    const art = require(path.join(ROOT, "artifacts", "CorpusVault.json"));
    const buyer = new Wallet(PK1, provider);
    const c = new Contract(contract, art.abi, buyer);
    await (await c.buyLicense(id1, { value: parseEther("0.05") })).wait();
    const access = await c.hasAccess(id1, buyer.address);
    check("buyer purchased license and hasAccess", access === true);

    // 5. mint corrupted epoch, appraise -> refusal, buy must revert AppraisalRefused
    const m2 = run(`node deploy/mint.js ${FIXB} 0.05 7 https://example.com/manifest_bad.json`, { RPC_URL: RPC, PRIVATE_KEY: PK0, CONTRACT: contract });
    const id2 = (m2.match(/^VAULT_ID=(\d+)$/m) || [])[1];
    let p2ExitedNonzero = false, p2out = "";
    try { p2out = run(`node deploy/post-appraisal.js ${id2} ${FIXB}`, { RPC_URL: RPC, PRIVATE_KEY: PK0, CONTRACT: contract }); }
    catch (e) { p2ExitedNonzero = true; p2out = String(e.stdout || e.message); }
    check("bad epoch posts refusal onchain", /refusal true/.test(p2out), p2ExitedNonzero ? "(cli exit nonzero)" : "");

    const data = c.interface.encodeFunctionData("buyLicense", [id2]);
    let sel = null;
    try {
      await provider.send("eth_call", [{ from: buyer.address, to: contract, data, value: "0x" + parseEther("0.05").toString(16) }, "latest"]);
    } catch (e) {
      const d = e?.error?.data ?? e?.info?.error?.data ?? e?.data;
      sel = typeof d === "string" ? d.slice(0, 10) : null;
    }
    const refusedSel = c.interface.getError("AppraisalRefused").selector;
    check("purchase of refused vault reverts AppraisalRefused", sel === refusedSel, `selector ${sel}`);
  } finally {
    provider.destroy();
    anvil.kill();
  }

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\ne2e: ${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error("e2e error:", e.shortMessage || e.message); process.exit(1); });
