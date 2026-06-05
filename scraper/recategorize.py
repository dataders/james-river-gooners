"""Re-derive item categories across the read model from the current mappings.

Many archived Cannon's lots sit in category "Other": their site Type was
"Other" (or an unmapped crumb) and their detail lives entirely in the
description (the title is a "Lot - N" placeholder). This re-runs the current
``categories.py`` inference (``category_mappings.yml`` description_keywords) over
the stored lots and rewrites ``category``/``rawCategory`` where it now resolves
to something better.

Idempotent and conservative: a lot that already has a real rawCategory keeps it
(``normalize_raw_with_description`` only re-infers when the stored value is
"Other"/empty), so this only ever *improves* the "Other" bucket — it never
regresses a categorized lot. Rewrites NDJSON (images as arrays) + Parquet
(images stringified), mirroring scrape.py.

    python recategorize.py [--dry-run] [--active-only|--archive-only]
"""

import argparse
import json
import sys
from pathlib import Path

from categories import normalize_category, normalize_raw_with_description
from rescrape_all import ARCHIVE_ITEMS_DIR
from scrape import ITEMS_DIR


def recategorized_row(row: dict) -> bool:
    """Update a lot's category/rawCategory in place. Returns True when changed."""
    raw = row.get("rawCategory") or ""
    desc = row.get("description") or ""
    new_raw = normalize_raw_with_description(raw, desc)
    new_cat = normalize_category(raw, desc)
    changed = new_raw != row.get("rawCategory") or new_cat != row.get("category")
    if changed:
        row["rawCategory"] = new_raw
        row["category"] = new_cat
    return changed


def process_file(path: Path, dry_run: bool) -> tuple[int, int]:
    """Recategorize one parquet's NDJSON sidecar. Returns (rows, changed)."""
    ndjson_path = path.with_suffix(".ndjson")
    if not ndjson_path.exists():
        return 0, 0
    rows = [json.loads(line) for line in ndjson_path.read_text().splitlines() if line.strip()]
    if not rows:
        return 0, 0

    changed = sum(recategorized_row(row) for row in rows)
    if changed and not dry_run:
        ndjson_path.write_text(
            "\n".join(json.dumps(r, separators=(",", ":")) for r in rows) + "\n",
            encoding="utf-8",
        )
        import pyarrow as pa
        import pyarrow.parquet as pq

        for r in rows:
            if isinstance(r.get("images"), list):
                r["images"] = json.dumps(r["images"])
        pq.write_table(pa.Table.from_pylist(rows), path, compression="snappy")
    return len(rows), changed


def iter_dirs(active_only: bool, archive_only: bool):
    if not archive_only and ITEMS_DIR.exists():
        yield ITEMS_DIR
    if not active_only and ARCHIVE_ITEMS_DIR.exists():
        yield ARCHIVE_ITEMS_DIR


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Recategorize read-model lots from current mappings")
    parser.add_argument("--dry-run", action="store_true", help="Report changes without writing")
    parser.add_argument("--active-only", action="store_true", help="Only the active items dir")
    parser.add_argument("--archive-only", action="store_true", help="Only the archive items dir")
    parser.add_argument("--sample", type=int, default=0, help="Print N example reclassifications (dry-run insight)")
    args = parser.parse_args(argv if argv is not None else sys.argv[1:])

    total_rows = total_changed = 0
    samples = []
    for directory in iter_dirs(args.active_only, args.archive_only):
        for path in sorted(directory.glob("*.parquet")):
            if args.sample and len(samples) < args.sample:
                ndjson_path = path.with_suffix(".ndjson")
                if ndjson_path.exists():
                    for line in ndjson_path.read_text().splitlines():
                        if not line.strip():
                            continue
                        row = json.loads(line)
                        before = row.get("category")
                        if recategorized_row(dict(row)) and before == "Other" and len(samples) < args.sample:
                            new_cat = normalize_category(row.get("rawCategory") or "", row.get("description") or "")
                            samples.append((new_cat, (row.get("description") or "")[:70]))
            rows, changed = process_file(path, args.dry_run)
            total_rows += rows
            total_changed += changed

    verb = "would change" if args.dry_run else "changed"
    print(f"Recategorize: {verb} {total_changed} of {total_rows} lots")
    for cat, desc in samples:
        print(f"  → {cat:24s} {desc}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
