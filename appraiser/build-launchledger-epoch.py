#!/usr/bin/env python3
"""Export the LaunchLedger labeled outcome dataset as a corpus epoch.

One row per (pool, horizon): the features known AT DISCOVERY (t0_*) joined to
the outcome label written after that horizon closed. This is the shape a model
trains on, and the reason it is worth money is the no-lookahead guarantee.

That guarantee is made MACHINE-CHECKABLE here: the export carries
window_close_ts = t0_ts + horizon_days*86400, and the manifest asks the
appraiser to verify labeled_ts >= window_close_ts on every row. A label
written before its window closed would be a leak, and the appraisal says so
rather than the README claiming it.

usage: python3 build-launchledger-epoch.py [--db PATH] [--out DIR] [--horizons 1,7]
"""
import argparse, csv, hashlib, json, os, sqlite3, sys

COLUMNS = [
    "pool_address", "symbol", "dex", "quote_mint",
    "t0_ts", "t0_liquidity_usd", "t0_volume24h_usd", "t0_price_usd", "t0_fdv_usd", "t0_txns24h",
    "cohort_ts", "cohort_reason",
    "horizon_days", "window_close_ts", "labeled_ts", "label", "evidence",
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="/opt/launchledger/launchledger.db")
    ap.add_argument("--out", default="/opt/agentfeed/corpus-epochs")
    ap.add_argument("--horizons", default="1,7")
    ap.add_argument("--name", default=None)
    args = ap.parse_args()

    horizons = [int(h) for h in args.horizons.split(",") if h.strip()]
    if not os.path.exists(args.db):
        sys.exit(f"no database at {args.db}")

    con = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row

    q = f"""
      SELECT p.pool_address, p.symbol, p.dex, p.quote_mint,
             p.t0_ts, p.t0_liquidity_usd, p.t0_volume24h_usd, p.t0_price_usd,
             p.t0_fdv_usd, p.t0_txns24h, p.cohort_ts, p.cohort_reason,
             l.horizon_days, l.labeled_ts, l.label, l.evidence
        FROM labels l
        JOIN pools p ON p.id = l.pool_id
       WHERE l.horizon_days IN ({','.join('?' * len(horizons))})
         AND p.t0_ts IS NOT NULL
       ORDER BY p.t0_ts ASC, l.horizon_days ASC
    """
    rows = con.execute(q, horizons).fetchall()
    if not rows:
        sys.exit("no labeled rows for those horizons — nothing to export")

    dist = {}
    for r in rows:
        dist.setdefault(r["horizon_days"], {}).setdefault(r["label"], 0)
        dist[r["horizon_days"]][r["label"]] += 1

    os.makedirs(args.out, exist_ok=True)
    name = args.name or f"launch-outcomes-{'-'.join(str(h) + 'd' for h in horizons)}"
    csv_path = os.path.join(args.out, f"{name}.csv")

    first_t0 = min(r["t0_ts"] for r in rows)
    last_lab = max(r["labeled_ts"] for r in rows)

    with open(csv_path, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, quoting=csv.QUOTE_MINIMAL)
        w.writerow(COLUMNS)
        for r in rows:
            close = int(r["t0_ts"]) + int(r["horizon_days"]) * 86400
            w.writerow([
                r["pool_address"], r["symbol"], r["dex"], r["quote_mint"],
                r["t0_ts"], r["t0_liquidity_usd"], r["t0_volume24h_usd"], r["t0_price_usd"],
                r["t0_fdv_usd"], r["t0_txns24h"], r["cohort_ts"], r["cohort_reason"],
                r["horizon_days"], close, r["labeled_ts"], r["label"], r["evidence"],
            ])

    h = hashlib.sha256()
    with open(csv_path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    digest = "0x" + h.hexdigest()

    schema = []
    for c in COLUMNS:
        if c in ("t0_ts", "cohort_ts", "window_close_ts", "labeled_ts"):
            schema.append({"name": c, "type": "timestamp"})
        elif c.endswith("_usd") or c in ("t0_txns24h", "horizon_days"):
            schema.append({"name": c, "type": "number"})
        else:
            schema.append({"name": c, "type": "string"})

    manifest = {
        "name": name,
        "file": f"{name}.csv",
        "description": (
            "Solana launch-to-outcome labeled dataset. One row per pool and horizon: the features "
            "recorded at discovery joined to the outcome label written after that horizon closed. "
            "Labels are mechanical and auditable (active, liquidity_collapsed, lp_removed, inactive, "
            "unresolvable, unknown), never an intent claim, and each carries a JSON evidence blob with "
            "the numbers and the rule that fired. Only pools crossing a traction gate are followed, so "
            "this is the cohort a buyer cares about rather than the dead-on-arrival majority. "
            "NO LOOKAHEAD: a label at horizon H may only read observations at or before t0+H, and the "
            "export carries window_close_ts so an appraiser can verify labeled_ts >= window_close_ts "
            "on every row rather than taking the claim on trust."
        ),
        "schema": schema,
        "expectations": {
            "minRows": 500,
            "maxNullPct": 35,
            "timestampColumn": "t0_ts",
            "monotonic": True,
            "atLeast": [{"col": "labeled_ts", "gteCol": "window_close_ts"}],
        },
        "coverage": {
            "rows": len(rows),
            "pools": len({r["pool_address"] for r in rows}),
            "horizons_days": horizons,
            "first_t0_ts": first_t0,
            "last_labeled_ts": last_lab,
            "label_distribution": dist,
        },
        "contentHash": digest,
        "license": "commercial use permitted for the licence holder; redistribution not permitted",
    }
    mpath = os.path.join(args.out, f"{name}.manifest.json")
    with open(mpath, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)

    print(f"rows     {len(rows)} across {manifest['coverage']['pools']} pools, horizons {horizons}")
    for hz in sorted(dist):
        top = sorted(dist[hz].items(), key=lambda kv: -kv[1])
        print(f"  {hz}d: " + ", ".join(f"{k} {v}" for k, v in top))
    print(f"csv      {csv_path} ({os.path.getsize(csv_path)} bytes)")
    print(f"sha256   {digest}")
    print(f"MANIFEST={mpath}")


if __name__ == "__main__":
    main()
