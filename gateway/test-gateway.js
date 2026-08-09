// Verifies the gateway against a throwaway anvil + a real deployed contract.
// The point of these checks is the gate: a licensed wallet gets bytes, an
// unlicensed one gets 402, and none of the obvious forgeries work.
const { spawn, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const { JsonRpcProvider, Wallet, Contract, parseEther } = require("ethers");

const RPC = "http://127.0.0.1:8620";
const PORT = 3099;
const PK_OWNER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const PK_BUYER = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const PK_STRANGER = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const ROOT = path.join(__dirname, "..");
const FIX = path.join(ROOT, "appraiser", "fixtures", "manifest_good.json");
const DATA_DIR = path.join(ROOT, "appraiser", "fixtures");

const run = (cmd, env) => execSync(cmd, { cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  try { execSync("pkill -f 'anvil --port 8620' || true"); } catch {}
  const anvil = spawn("anvil", ["--port", "8620", "--silent"], { stdio: "ignore" });
  const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true, pollingInterval: 50, cacheTimeout: -1 });
  for (let i = 0; i < 100; i++) { try { await provider.getBlockNumber(); break; } catch { await sleep(100); } }

  const results = [];
  const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n} ${d}`); };
  let gw = null;

  try {
    const env = { RPC_URL: RPC, PRIVATE_KEY: PK_OWNER };
    const contract = (run("node deploy/deploy.js", env).match(/^CONTRACT=(0x[0-9a-fA-F]{40})$/m) || [])[1];
    const id = (run(`node deploy/mint.js ${FIX} 0.05 7 https://example.com/m.json`, { ...env, CONTRACT: contract }).match(/^VAULT_ID=(\d+)$/m) || [])[1];
    run(`node deploy/post-appraisal.js ${id} ${FIX}`, { ...env, CONTRACT: contract });

    gw = spawn("node", ["gateway/server.js"], {
      cwd: ROOT, stdio: "ignore",
      env: { ...process.env, RPC_URL: RPC, CONTRACT: contract, PORT: String(PORT), DATA_DIR },
    });
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/healthz`); if (r.ok) break; } catch {}
      await sleep(200);
    }

    // public surfaces
    const list = await (await fetch(`http://127.0.0.1:${PORT}/api/vaults`)).json();
    check("vault list served from chain", list.vaults.length === 1 && list.vaults[0].id === id);
    const one = await (await fetch(`http://127.0.0.1:${PORT}/api/vaults/${id}`)).json();
    check("vault detail shows appraisal + local availability", one.scoreBps === 10000 && one.refusal === false && one.available === true, `bytes ${one.bytes}`);
    check("purchasable flag true after clean appraisal", one.purchasable === true);
    const rep = await fetch(`http://127.0.0.1:${PORT}/api/vaults/${id}/report`);
    check("signed report served publicly", rep.ok);

    async function attempt(pk, opts = {}) {
      const c = await (await fetch(`http://127.0.0.1:${PORT}/api/challenge?vaultId=${opts.vaultId || id}`)).json();
      const w = new Wallet(pk);
      const msg = opts.tamperMessage ? c.message.replace(/vault \d+/, "vault 999") : c.message;
      const sig = await w.signMessage(msg);
      const r = await fetch(`http://127.0.0.1:${PORT}/api/download`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ vaultId: opts.vaultId || id, nonce: opts.nonce || c.nonce, signature: opts.signature || sig }),
      });
      return { r, nonce: c.nonce, sig };
    }

    // unlicensed wallet must be refused
    const stranger = await attempt(PK_STRANGER);
    check("unlicensed wallet refused with 402", stranger.r.status === 402, `got ${stranger.r.status}`);

    // buy a licence, then the same wallet must get bytes
    const art = require(path.join(ROOT, "artifacts", "CorpusVault.json"));
    const buyer = new Wallet(PK_BUYER, provider);
    await (await new Contract(contract, art.abi, buyer).buyLicense(id, { value: parseEther("0.05") })).wait();

    const ok = await attempt(PK_BUYER);
    check("licensed wallet gets 200", ok.r.status === 200, `got ${ok.r.status}`);
    const body = Buffer.from(await ok.r.arrayBuffer());
    const onDisk = fs.readFileSync(path.join(DATA_DIR, "epoch_good.csv"));
    check("bytes delivered match the file the hash commits to", body.equals(onDisk), `${body.length} bytes`);
    check("response carries the onchain content hash header", (ok.r.headers.get("x-corpus-content-sha256") || "").startsWith("0x"));

    // replay of a spent challenge must fail
    const replay = await fetch(`http://127.0.0.1:${PORT}/api/download`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ vaultId: id, nonce: ok.nonce, signature: ok.sig }),
    });
    check("spent nonce cannot be replayed", replay.status === 401, `got ${replay.status}`);

    // signature over a different message must not authorise
    const tampered = await attempt(PK_BUYER, { tamperMessage: true });
    check("signature over a different message is rejected", tampered.r.status !== 200, `got ${tampered.r.status}`);

    // garbage signature
    const garbage = await fetch(`http://127.0.0.1:${PORT}/api/download`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ vaultId: id, nonce: (await (await fetch(`http://127.0.0.1:${PORT}/api/challenge?vaultId=${id}`)).json()).nonce, signature: "0xdeadbeef" }),
    });
    check("malformed signature rejected", garbage.status === 401, `got ${garbage.status}`);

    // unknown nonce
    const unknown = await fetch(`http://127.0.0.1:${PORT}/api/download`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ vaultId: id, nonce: "00".repeat(16), signature: ok.sig }),
    });
    check("unknown nonce rejected", unknown.status === 401, `got ${unknown.status}`);

    // refusal state must close the gate even for a paying holder
    const appr = new Wallet(PK_OWNER, provider);
    await (await new Contract(contract, art.abi, appr).setAppraisal(id, 0, "0x" + "99".repeat(32), "refused", true)).wait();
    const afterRefusal = await (await fetch(`http://127.0.0.1:${PORT}/api/vaults/${id}`)).json();
    check("refusal flips purchasable to false", afterRefusal.purchasable === false && afterRefusal.refusal === true);
  } finally {
    if (gw) gw.kill();
    provider.destroy();
    anvil.kill();
  }

  const failed = results.filter((r) => !r).length;
  console.log(`\ngateway: ${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("test error:", e.shortMessage || e.message); process.exit(1); });
