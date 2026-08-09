// corpus appraiser — machine QA over a dataset epoch, producing a signed,
// onchain-postable appraisal: { scoreBps, reportHash, refusal }.
// The AI note generator is pluggable: with ANTHROPIC_API_KEY set it asks the
// model for the narrative section; without it, a deterministic template is
// used so the pipeline runs and tests offline. QA verdicts are ALWAYS
// computed by code, never by the LLM — the model narrates, it does not judge.
const fs = require("fs");
const crypto = require("crypto");
const { Wallet, hashMessage } = require("ethers");

function sha256(buf) {
  return "0x" + crypto.createHash("sha256").update(buf).digest("hex");
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return { header: [], rows: [] };
  const header = lines[0].split(",").map((h) => h.trim());
  const rows = lines.slice(1).map((l) => l.split(",").map((c) => c.trim()));
  return { header, rows };
}

function isNumeric(s) {
  return s !== "" && !Number.isNaN(Number(s));
}

/**
 * manifest: {
 *   file, name,
 *   schema: [{name, type: "number"|"string"|"timestamp"}],
 *   expectations: { minRows, maxNullPct, uniqueKey, timestampColumn, monotonic }
 * }
 */
function appraise(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const dir = require("path").dirname(manifestPath);
  const dataPath = require("path").join(dir, manifest.file);
  const raw = fs.readFileSync(dataPath);
  const contentHash = sha256(raw);

  const checks = [];
  let hardFail = false;
  const add = (name, ok, detail, hard = false) => {
    checks.push({ name, ok, detail });
    if (!ok && hard) hardFail = true;
  };

  let parsed;
  try {
    parsed = parseCSV(raw.toString("utf8"));
    add("parseable", true, `${parsed.rows.length} rows, ${parsed.header.length} columns`);
  } catch (e) {
    add("parseable", false, String(e.message), true);
    return finalize(manifest, contentHash, checks, true);
  }
  const { header, rows } = parsed;
  const exp = manifest.expectations || {};

  // 1. schema conformance (hard)
  const expected = (manifest.schema || []).map((c) => c.name);
  const schemaOk = expected.length === header.length && expected.every((c, i) => header[i] === c);
  add("schema", schemaOk, schemaOk ? "matches manifest" : `expected [${expected}] got [${header}]`, true);

  // 2. row count (hard)
  const minRows = exp.minRows ?? 1;
  add("row_count", rows.length >= minRows, `${rows.length} rows (min ${minRows})`, true);

  if (hardFail) return finalize(manifest, contentHash, checks, true);

  const colIdx = Object.fromEntries(header.map((h, i) => [h, i]));

  // 3. null rate per column (soft, scored)
  const maxNullPct = exp.maxNullPct ?? 5;
  let worstNull = 0;
  for (const h of header) {
    const nulls = rows.filter((r) => r[colIdx[h]] === "" || r[colIdx[h]] === undefined).length;
    worstNull = Math.max(worstNull, (100 * nulls) / rows.length);
  }
  add("null_rate", worstNull <= maxNullPct, `worst column ${worstNull.toFixed(2)}% empty (max ${maxNullPct}%)`);

  // 4. duplicate keys (soft)
  if (exp.uniqueKey && colIdx[exp.uniqueKey] !== undefined) {
    const seen = new Set();
    let dupes = 0;
    for (const r of rows) {
      const k = r[colIdx[exp.uniqueKey]];
      if (seen.has(k)) dupes++;
      seen.add(k);
    }
    add("unique_key", dupes === 0, `${dupes} duplicate ${exp.uniqueKey}`);
  }

  // 5. type conformance on numeric/timestamp columns (soft)
  let badTyped = 0;
  for (const col of manifest.schema || []) {
    if (col.type === "number" || col.type === "timestamp") {
      const i = colIdx[col.name];
      badTyped += rows.filter((r) => r[i] !== "" && !isNumeric(r[i])).length;
    }
  }
  add("types", badTyped === 0, `${badTyped} non-numeric values in numeric columns`);

  // 6. timestamp monotonicity (soft)
  if (exp.monotonic && exp.timestampColumn && colIdx[exp.timestampColumn] !== undefined) {
    const i = colIdx[exp.timestampColumn];
    let breaks = 0;
    for (let r = 1; r < rows.length; r++) {
      if (Number(rows[r][i]) < Number(rows[r - 1][i])) breaks++;
    }
    add("monotonic_time", breaks === 0, `${breaks} ordering breaks in ${exp.timestampColumn}`);
  }

  // 7. outlier scan on numeric columns (informational, scored lightly)
  let outliers = 0, numericCells = 0;
  for (const col of manifest.schema || []) {
    if (col.type !== "number") continue;
    const i = colIdx[col.name];
    const vals = rows.map((r) => Number(r[i])).filter((v) => !Number.isNaN(v));
    if (vals.length < 8) continue;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1;
    outliers += vals.filter((v) => Math.abs(v - mean) / sd > 6).length;
    numericCells += vals.length;
  }
  add("outliers", true, `${outliers} extreme values (>6σ) across ${numericCells} numeric cells`);

  return finalize(manifest, contentHash, checks, false);
}

function finalize(manifest, contentHash, checks, hardFail) {
  const soft = checks.filter((c) => !["parseable", "schema", "row_count"].includes(c.name));
  const softOk = soft.filter((c) => c.ok).length;
  const scoreBps = hardFail ? 0 : soft.length === 0 ? 10000 : Math.round((10000 * softOk) / soft.length);
  const refusal = hardFail;
  const report = {
    dataset: manifest.name,
    contentHash,
    appraisedAt: Math.floor(Date.now() / 1000),
    refusal,
    scoreBps,
    checks,
    note: narrate(manifest, checks, scoreBps, refusal),
    appraiserVersion: "corpus-appraiser/0.1.0",
  };
  return report;
}

function narrate(manifest, checks, scoreBps, refusal) {
  // Deterministic narrative. If ANTHROPIC_API_KEY is present at deploy time,
  // bin/appraise-cli swaps this for a model-written note; the verdict fields
  // above are code-computed either way.
  const failed = checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`);
  if (refusal)
    return `Appraisal REFUSED for ${manifest.name}: hard QA failure — ${failed.join("; ")}. This vault is not purchasable until a corrected epoch is published.`;
  if (failed.length === 0)
    return `${manifest.name} passed all ${checks.length} QA checks. Score ${(scoreBps / 100).toFixed(1)}%.`;
  return `${manifest.name} passed core QA with findings: ${failed.join("; ")}. Score ${(scoreBps / 100).toFixed(1)}%.`;
}

async function signReport(report, privateKey) {
  const body = JSON.stringify(report);
  const reportHash = sha256(Buffer.from(body));
  const wallet = new Wallet(privateKey);
  const signature = await wallet.signMessage(reportHash);
  return { body, reportHash, signature, signer: wallet.address, digest: hashMessage(reportHash) };
}

module.exports = { appraise, signReport, sha256, parseCSV };

if (require.main === module) {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    console.error("usage: node appraiser/appraise.js <manifest.json>");
    process.exit(1);
  }
  const report = appraise(manifestPath);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.refusal ? 2 : 0);
}
