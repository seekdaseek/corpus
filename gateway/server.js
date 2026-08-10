// corpus gateway — the piece that turns the contract into a product.
//
// The chain knows who holds a valid licence; this serves the bytes to them.
// Public: vault list, manifests, appraisal reports (anyone can verify what
// they would be buying). Gated: the dataset itself, released only to a wallet
// that proves control of its key AND holds an unexpired licence onchain.
//
// Auth is challenge-response, not a password: the server issues a one-time
// nonce, the buyer signs it with the wallet that bought the licence, and the
// server recovers the address from the signature and asks the contract
// hasAccess(vaultId, address). No accounts, no API keys, nothing to leak.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { JsonRpcProvider, Contract, verifyMessage } = require("ethers");

const PORT = Number(process.env.PORT || 3015);
const RPC_URL = process.env.RPC_URL;
const CONTRACT = process.env.CONTRACT;
const DATA_DIR = process.env.DATA_DIR || "/opt/agentfeed/corpus-epochs";
const ART = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "CorpusVault.json"), "utf8"));

if (!RPC_URL || !CONTRACT) {
  console.error("need env: RPC_URL, CONTRACT (optional: PORT, DATA_DIR)");
  process.exit(1);
}

const provider = new JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
const vault = new Contract(CONTRACT, ART.abi, provider);

// ---------------------------------------------------------------- nonces
const NONCE_TTL_MS = 5 * 60 * 1000;
const nonces = new Map(); // nonce -> { vaultId, expires, used }

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of nonces) if (v.expires < now) nonces.delete(k);
}, 60_000).unref();

function issueNonce(vaultId) {
  const nonce = crypto.randomBytes(16).toString("hex");
  nonces.set(nonce, { vaultId: String(vaultId), expires: Date.now() + NONCE_TTL_MS, used: false });
  return nonce;
}

function challengeText(vaultId, nonce) {
  return `corpus: release dataset for vault ${vaultId}\nnonce: ${nonce}`;
}

// ---------------------------------------------------------------- chain reads
async function readVault(id) {
  const [v, a] = await Promise.all([vault.vaults(id), vault.appraisals(id)]);
  let owner = null;
  try { owner = await vault.ownerOf(id); } catch { return null; }
  return {
    id: String(id),
    owner,
    contentHash: v.contentHash,
    manifestURI: v.manifestURI,
    priceWei: v.priceWei.toString(),
    licenseDays: Number(v.licenseDuration) / 86400,
    listed: v.listed,
    appraised: a.exists,
    scoreBps: Number(a.scoreBps),
    refusal: a.refusal,
    reportURI: a.reportURI,
    reportHash: a.reportHash,
    appraisedAt: Number(a.appraisedAt),
    purchasable: v.listed && a.exists && !a.refusal,
  };
}

async function listVaults() {
  const total = Number(await vault.nextVaultId());
  const out = [];
  for (let i = 1; i <= total; i++) {
    const v = await readVault(i);
    if (v) out.push(v);
  }
  return out;
}

// Resolve the local file for a vault by matching its onchain contentHash
// against the files on disk. The hash is the index — a file only serves if
// its bytes hash to exactly what the contract committed to.
const hashCache = new Map();
function sha256File(p) {
  const stat = fs.statSync(p);
  const key = `${p}:${stat.size}:${stat.mtimeMs}`;
  if (hashCache.has(key)) return hashCache.get(key);
  const h = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  const val = "0x" + h;
  hashCache.set(key, val);
  return val;
}

function fileForHash(contentHash) {
  if (!fs.existsSync(DATA_DIR)) return null;
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (!f.endsWith(".csv")) continue;
    const p = path.join(DATA_DIR, f);
    try { if (sha256File(p).toLowerCase() === contentHash.toLowerCase()) return p; } catch {}
  }
  return null;
}

// ---------------------------------------------------------------- app
const app = express();
app.use(express.json({ limit: "16kb" }));
app.disable("x-powered-by");

app.get("/healthz", (_req, res) => res.json({ ok: true, contract: CONTRACT }));

app.get("/api/vaults", async (_req, res) => {
  try { res.json({ contract: CONTRACT, vaults: await listVaults() }); }
  catch (e) { res.status(502).json({ error: "chain read failed", detail: e.shortMessage || e.message }); }
});

app.get("/api/vaults/:id", async (req, res) => {
  try {
    const v = await readVault(req.params.id);
    if (!v) return res.status(404).json({ error: "no such vault" });
    const local = fileForHash(v.contentHash);
    res.json({ ...v, available: Boolean(local), bytes: local ? fs.statSync(local).size : null });
  } catch (e) { res.status(502).json({ error: "chain read failed", detail: e.shortMessage || e.message }); }
});

// The signed appraisal report, served verbatim so a buyer can check the
// signature and the report hash against what is onchain.
app.get("/api/vaults/:id/report", async (req, res) => {
  const dir = path.join(__dirname, "..", "appraiser", "reports");
  if (fs.existsSync(dir) === false) return res.status(404).json({ error: "no reports on this host" });
  let onchain;
  try { onchain = await vault.vaults(req.params.id); } catch { return res.status(404).json({ error: "unknown vault" }); }
  const want = String(onchain.contentHash).toLowerCase();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
    const got = String((j.report || j).contentHash || "").toLowerCase();
    if (got === want) return res.type("application/json").send(fs.readFileSync(path.join(dir, f), "utf8"));
  }
  return res.status(404).json({ error: "contentHash does not match this vault on chain" });
});

app.get("/api/challenge", (req, res) => {
  const { vaultId } = req.query;
  if (!vaultId) return res.status(400).json({ error: "vaultId required" });
  const nonce = issueNonce(vaultId);
  res.json({ nonce, message: challengeText(vaultId, nonce), expiresInSec: NONCE_TTL_MS / 1000 });
});

app.post("/api/download", async (req, res) => {
  const { vaultId, nonce, signature } = req.body || {};
  if (!vaultId || !nonce || !signature) return res.status(400).json({ error: "vaultId, nonce and signature required" });

  const rec = nonces.get(nonce);
  if (!rec) return res.status(401).json({ error: "unknown or expired nonce" });
  if (rec.used) return res.status(401).json({ error: "nonce already used" });
  if (rec.expires < Date.now()) { nonces.delete(nonce); return res.status(401).json({ error: "nonce expired" }); }
  if (rec.vaultId !== String(vaultId)) return res.status(401).json({ error: "nonce was issued for a different vault" });

  let address;
  try { address = verifyMessage(challengeText(vaultId, nonce), signature); }
  catch { return res.status(401).json({ error: "bad signature" }); }

  let allowed, v;
  try {
    [allowed, v] = await Promise.all([vault.hasAccess(vaultId, address), readVault(vaultId)]);
  } catch (e) {
    return res.status(502).json({ error: "chain read failed", detail: e.shortMessage || e.message });
  }
  if (!v) return res.status(404).json({ error: "no such vault" });
  if (!allowed) return res.status(402).json({ error: "no active licence for this address", address, vaultId: String(vaultId) });

  const local = fileForHash(v.contentHash);
  if (!local) return res.status(503).json({ error: "licence valid but the dataset is not on this host" });

  rec.used = true; // one download per challenge
  res.setHeader("content-type", "text/csv");
  res.setHeader("content-disposition", `attachment; filename="${path.basename(local)}"`);
  res.setHeader("x-corpus-content-sha256", v.contentHash);
  fs.createReadStream(local).pipe(res);
});

app.get("/", (_req, res) => {
  res.type("html").send(fs.readFileSync(path.join(__dirname, "index.html"), "utf8"));
});

const server = app.listen(PORT, () => console.log(`corpus gateway on :${PORT} -> ${CONTRACT}`));
module.exports = { app, server, challengeText };
