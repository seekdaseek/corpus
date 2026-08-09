#!/usr/bin/env python3
"""Carve a licensable epoch out of the AgentFeed nightly liquidation export.

Rationale: rows up to 2026-08-06 23:59:42 UTC are already published free under
CC BY 4.0 at huggingface.co/datasets/ochinimus/crypto-liquidation-ticks. Only
rows AFTER that boundary are unpublished and can honestly be licensed. This
script filters strictly after the cutoff, sorts by ts_ms, and emits the CSV
plus a corpus manifest.

Reads the newest /opt/agentfeed/exports/agentfeed-liq-dataset_*.zip. Does not
touch the DB or the nightly cron.

usage: python3 build-epoch.py [--cutoff-ms N] [--out DIR] [--name NAME]
"""
import argparse, csv, glob, hashlib, io, json, os, sys, zipfile

HF_CUTOFF_MS = 1786060782999  # end of 2026-08-06 23:59:42 UTC; HF documents its last row to the second, so exclude the whole second
EXPECTED = ["ts_ms", "utc_time", "symbol", "exchange", "event", "size", "price", "usd"]


def newest_export(exports_dir):
    zips = sorted(glob.glob(os.path.join(exports_dir, "agentfeed-liq-dataset_*.zip")))
    zips = [z for z in zips if "SAMPLE" not in os.path.basename(z)]
    if not zips:
        sys.exit(f"no full export zips found in {exports_dir}")
    return zips[-1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--exports", default="/opt/agentfeed/exports")
    ap.add_argument("--cutoff-ms", type=int, default=HF_CUTOFF_MS)
    ap.add_argument("--out", default="/opt/agentfeed/corpus-epochs")
    ap.add_argument("--name", default=None)
    args = ap.parse_args()

    zpath = newest_export(args.exports)
    print(f"source: {zpath}")
    os.makedirs(args.out, exist_ok=True)

    with zipfile.ZipFile(zpath) as z:
        members = [n for n in z.namelist() if n.endswith(".csv") and "coverage" not in n]
        if not members:
            sys.exit(f"no full CSV inside {zpath}; members: {z.namelist()}")
        member = members[0]
        print(f"member: {member}")
        with z.open(member) as fh:
            reader = csv.reader(io.TextIOWrapper(fh, encoding="utf-8"))
            header = next(reader)
            header = [h.strip() for h in header]
            if header != EXPECTED:
                sys.exit(f"UNEXPECTED SCHEMA.\n  expected {EXPECTED}\n  got      {header}\n"
                         "Refusing to build — fix the manifest schema before minting.")
            rows = []
            total = 0
            for r in reader:
                total += 1
                if not r or not r[0].strip():
                    continue
                try:
                    ts = int(r[0])
                except ValueError:
                    continue
                if ts > args.cutoff_ms:
                    rows.append((ts, r))

    if not rows:
        sys.exit(f"zero rows after cutoff {args.cutoff_ms} — the export predates the boundary; "
                 "wait for tonight's 03:40 build.")

    rows.sort(key=lambda t: t[0])
    first_ms, last_ms = rows[0][0], rows[-1][0]
    name = args.name or f"liq-tape-epoch-{rows[0][1][1].strip().strip(chr(34))[:10]}"
    csv_path = os.path.join(args.out, f"{name}.csv")

    with open(csv_path, "w", newline="", encoding="utf-8") as out:
        w = csv.writer(out)
        w.writerow(EXPECTED)
        for _, r in rows:
            w.writerow(r)

    h = hashlib.sha256()
    with open(csv_path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    digest = "0x" + h.hexdigest()

    symbols = sorted({r[2] for _, r in rows})
    venues = sorted({r[3] for _, r in rows})

    manifest = {
        "name": name,
        "file": f"{name}.csv",
        "description": (
            "Cross-venue perpetual-futures liquidation prints (Binance, Bybit, OKX) captured live. "
            "This epoch begins strictly after the free CC BY 4.0 snapshot at "
            "huggingface.co/datasets/ochinimus/crypto-liquidation-ticks, which ends 2026-08-06 23:59:42 UTC. "
            "Bybit allLiquidation is a complete unthrottled stream; Binance and OKX undercount at "
            "max one update per symbol per second, worst during cascades. Binance published no archive, "
            "so this window cannot be reconstructed after the fact."
        ),
        "schema": [
            {"name": "ts_ms", "type": "timestamp"},
            {"name": "utc_time", "type": "string"},
            {"name": "symbol", "type": "string"},
            {"name": "exchange", "type": "string"},
            {"name": "event", "type": "string"},
            {"name": "size", "type": "number"},
            {"name": "price", "type": "number"},
            {"name": "usd", "type": "number"},
        ],
        "expectations": {
            "minRows": 1000,
            "maxNullPct": 1,
            "timestampColumn": "ts_ms",
            "monotonic": True,
        },
        "coverage": {
            "rows": len(rows),
            "first_ms": first_ms,
            "last_ms": last_ms,
            "first_utc": rows[0][1][1].strip().strip('"'),
            "last_utc": rows[-1][1][1].strip().strip('"'),
            "symbols": len(symbols),
            "venues": venues,
        },
        "contentHash": digest,
        "license": "commercial use permitted for the licence holder; redistribution not permitted",
    }
    mpath = os.path.join(args.out, f"{name}.manifest.json")
    with open(mpath, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)

    print(f"scanned {total} rows, kept {len(rows)} after cutoff")
    print(f"range   {manifest['coverage']['first_utc']} -> {manifest['coverage']['last_utc']}")
    print(f"symbols {len(symbols)} across {venues}")
    print(f"csv     {csv_path} ({os.path.getsize(csv_path)} bytes)")
    print(f"sha256  {digest}")
    print(f"MANIFEST={mpath}")


if __name__ == "__main__":
    main()
