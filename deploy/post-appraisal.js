// Runs the appraiser over a manifest, signs the report, saves it locally,
// and posts the appraisal onchain (score, reportHash, refusal).
// usage: node deploy/post-appraisal.js <vaultId> <manifest.json> [reportURI]
// env: RPC_URL, PRIVATE_KEY (must hold APPRAISER_ROLE), CONTRACT
// The QA verdict (score + refusal) is computed by code in appraiser/appraise.js.
// A refusal HARD-BLOCKS purchases in the contract until a clean epoch is re-appraised.
const fs = require("fs");
const path = require("path");
const { JsonRpcProvider, Wallet, Contract } = require("ethers");
const { appraise, signReport } = require("../appraiser/appraise");

async function main() {
  const [vaultId, manifestPath, reportURIArg] = process.argv.slice(2);
  const { RPC_URL, PRIVATE_KEY, CONTRACT } = process.env;
  if (!vaultId || !manifestPath || !RPC_URL || !PRIVATE_KEY || !CONTRACT) {
    console.error("usage: node deploy/post-appraisal.js <vaultId> <manifest.json> [reportURI]");
    console.error("env: RPC_URL, PRIVATE_KEY (appraiser), CONTRACT");
    process.exit(1);
  }

  const report = appraise(manifestPath);
  const signed = await signReport(report, PRIVATE_KEY);

  const outDir = path.join(__dirname, "..", "appraiser", "reports");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `vault-${vaultId}-${report.appraisedAt}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ report, signature: signed.signature, signer: signed.signer, reportHash: signed.reportHash }, null, 2));

  const reportURI = reportURIArg || `report:${path.basename(outFile)}`;

  const provider = new JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
  const wallet = new Wallet(PRIVATE_KEY, provider);
  const art = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "CorpusVault.json"), "utf8"));
  const c = new Contract(CONTRACT, art.abi, wallet);

  const tx = await c.setAppraisal(vaultId, report.scoreBps, signed.reportHash, reportURI, report.refusal);
  await tx.wait();

  console.log(`appraised vault ${vaultId}: score ${report.scoreBps} bps, refusal ${report.refusal}`);
  console.log(`report saved ${outFile}`);
  console.log(`signer ${signed.signer}, reportHash ${signed.reportHash}`);
  if (report.refusal) console.log("NOTE: refusal posted — purchases for this vault are now blocked onchain.");
}

main().catch((e) => {
  console.error("post-appraisal failed:", e.shortMessage || e.message);
  process.exit(1);
});
