#!/usr/bin/env python
"""
Precompute "Cannon's comps": for each active auction item, the most similar
*past* (archived) lots and what they actually sold for.

This is the historical-sold-price counterpart to eBay comps. Matching is CLIP
semantic similarity (image + text), reusing the embeddings pipeline in
``embed.py``. Embeddings are L2-normalised, so cosine similarity is a plain dot
product — the model is only needed at embed time, never at match time.

Pipeline:
  1. Ensure every active auction and every archived auction that *sold* has a
     ``.embeddings`` sidecar (generate the missing ones with the CLIP model).
  2. Build the comp corpus from archived lots with a final price (currentBid > 0)
     across all sources (Cannon's, Rasmus, HiBid).
  3. For each active item, take its embedding, score it against the whole corpus,
     and keep the top-K matches above a similarity threshold.
  4. Write a per-auction static read model under public/data/cannons-comps/
     ``{safeId}.json`` (same envelope shape as the eBay comps read model) that the
     browser renders directly.

Usage (from scraper/):
    uv run --with requests --with beautifulsoup4 --with pyarrow --with pyyaml \
        --with sentence-transformers --with pillow --with numpy \
        python cannons_comps.py --top-k 5 --min-sim 0.75
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

DATA_DIR = Path(__file__).resolve().parent.parent / "public" / "data"
OUTPUT_DIR = DATA_DIR / "cannons-comps"
SCHEMA_VERSION = 1
DEFAULT_TOP_K = 3
DEFAULT_MIN_SIM = 0.80


def utc_now_text() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_manifest(path: Path) -> list[dict]:
    if not path.exists():
        return []
    manifest = json.loads(path.read_text())
    entries = manifest if isinstance(manifest, list) else manifest.get("auctions", [])
    return [e for e in entries if isinstance(e, dict)]


def _rel_to_abs(rel: str) -> Path:
    return DATA_DIR.parent / rel


def load_items(entry: dict) -> list[dict]:
    """Load one auction's items from its NDJSON sidecar (the browser read model)."""
    rel = entry.get("ndjsonPath")
    if not rel:
        safe_id = entry.get("safeId")
        sub = "archive/items" if entry.get("_archived") else "items"
        rel = f"data/{sub}/{safe_id}.ndjson"
    path = _rel_to_abs(rel)
    if not path.exists():
        return []
    items = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if line:
            items.append(json.loads(line))
    return items


def embeddings_path(entry: dict) -> Path:
    rel = entry.get("embeddingsPath")
    if rel:
        return _rel_to_abs(rel)
    items_rel = entry.get("ndjsonPath") or entry.get("itemsPath") or ""
    return _rel_to_abs(items_rel).with_suffix(".embeddings")


def ensure_embeddings(
    entry: dict, items: list[dict], embed_missing: bool = True
) -> dict[str, np.ndarray] | None:
    """Return {item_id: embedding} for an auction, generating the sidecar if absent.

    With ``embed_missing=False`` only existing (length-matched) sidecars are used
    — auctions without one are skipped and the CLIP model is never loaded. Returns
    None when there is nothing usable to embed.
    """
    from embed import read_embeddings

    if not items:
        return None

    emb_path = embeddings_path(entry)
    if emb_path.exists():
        try:
            embeddings, ids = read_embeddings(emb_path)
            if len(ids) == len(items):
                return {item_id: embeddings[i] for i, item_id in enumerate(ids)}
        except Exception:
            pass  # regenerate on any read/shape mismatch

    if not embed_missing:
        return None

    from embed import embed_items, write_embeddings

    print(f"  Embedding {len(items)} items for {entry.get('safeId')}...")
    embeddings, ids = embed_items(items)
    emb_path.parent.mkdir(parents=True, exist_ok=True)
    write_embeddings(embeddings, ids, emb_path)
    return {item_id: embeddings[i] for i, item_id in enumerate(ids)}


def sold_price(item: dict) -> float:
    try:
        return float(item.get("currentBid") or 0)
    except (TypeError, ValueError):
        return 0.0


def first_image(item: dict) -> str | None:
    images = item.get("images") or []
    if isinstance(images, str):
        try:
            images = json.loads(images)
        except Exception:
            images = []
    return images[0] if images else None


_GENERIC_LOT_TITLE = re.compile(r"^\s*lot\s*-?\s*\d+\s*$", re.IGNORECASE)


def display_title(item: dict) -> str:
    """A human label for a comp. Cannon's lot titles are generic ('Lot - 207'),
    so fall back to the description (where the real content lives)."""
    title = (item.get("title") or "").strip()
    if title and not _GENERIC_LOT_TITLE.match(title):
        return title
    description = (item.get("description") or "").strip()
    if description:
        return description[:90]
    return title or item.get("auctionTitle") or ""


def comp_match(item: dict, similarity: float) -> dict:
    """Shape one archived lot as a comp match for the read model."""
    return {
        "title": display_title(item),
        "soldPrice": round(sold_price(item), 2),
        "soldDate": item.get("auctionEndDate") or item.get("endDate") or None,
        "thumbnailUrl": first_image(item),
        "detailUrl": item.get("detailUrl") or None,
        "auctionTitle": item.get("auctionTitle") or None,
        "source": item.get("source") or None,
        "similarity": round(float(similarity), 4),
    }


def build_corpus(
    archive_entries: list[dict], embed_missing: bool = True
) -> tuple[np.ndarray, list[dict]]:
    """Return (embeddings matrix, item rows) for archived lots that sold.

    Only lots with a final price (currentBid > 0) and an embedding become comps.
    """
    vectors: list[np.ndarray] = []
    rows: list[dict] = []
    for entry in archive_entries:
        entry = {**entry, "_archived": True}
        items = load_items(entry)
        priced = [it for it in items if sold_price(it) > 0]
        if not priced:
            continue
        id_to_emb = ensure_embeddings(entry, items, embed_missing=embed_missing)
        if not id_to_emb:
            continue
        for it in priced:
            emb = id_to_emb.get(it.get("id"))
            if emb is None:
                continue
            vectors.append(emb)
            rows.append(it)
    if not vectors:
        return np.empty((0, 0), dtype=np.float32), []
    return np.vstack(vectors).astype(np.float32), rows


def top_matches(
    query_emb: np.ndarray,
    corpus: np.ndarray,
    rows: list[dict],
    top_k: int,
    min_sim: float,
) -> list[dict]:
    """Cosine top-K over the (L2-normalised) corpus, above ``min_sim``."""
    if corpus.shape[0] == 0:
        return []
    sims = corpus @ query_emb  # both L2-normalised → cosine similarity
    # Partial-sort the top candidates, then order them by descending similarity.
    k = min(top_k, sims.shape[0])
    cand = np.argpartition(-sims, k - 1)[:k]
    cand = cand[np.argsort(-sims[cand])]
    out = []
    for idx in cand:
        score = float(sims[idx])
        if score < min_sim:
            break
        out.append(comp_match(rows[idx], score))
    return out


def build_comps(
    data_dir: Path = DATA_DIR,
    output_dir: Path = OUTPUT_DIR,
    top_k: int = DEFAULT_TOP_K,
    min_sim: float = DEFAULT_MIN_SIM,
    active_limit: int | None = None,
    embed_missing: bool = True,
    dry_run: bool = False,
) -> dict:
    """Match active items to archived sold lots and write the comp read model."""
    summary = {"auctions": 0, "items_with_comps": 0, "matches": 0, "files_written": 0}

    archive_entries = read_manifest(data_dir / "archive-manifest.json")
    active_entries = read_manifest(data_dir / "manifest.json")
    if active_limit is not None:
        active_entries = active_entries[:active_limit]
    if not active_entries or not archive_entries:
        print("No active or archived auctions; nothing to do.")
        return summary

    print(f"Building comp corpus from {len(archive_entries)} archived auctions...")
    corpus, rows = build_corpus(archive_entries, embed_missing=embed_missing)
    print(f"  Corpus: {len(rows)} sold lots with embeddings")
    if not rows:
        return summary

    generated_at = utc_now_text()
    for entry in active_entries:
        safe_id = entry.get("safeId")
        items = load_items(entry)
        if not items:
            continue
        id_to_emb = ensure_embeddings(entry, items, embed_missing=embed_missing)
        if not id_to_emb:
            continue

        item_exports: dict[str, dict] = {}
        for it in items:
            emb = id_to_emb.get(it.get("id"))
            if emb is None:
                continue
            matches = top_matches(emb, corpus, rows, top_k, min_sim)
            if not matches:
                continue
            item_exports[it["id"]] = {"matches": matches}
            summary["matches"] += len(matches)

        summary["auctions"] += 1
        summary["items_with_comps"] += len(item_exports)
        if not item_exports:
            continue

        payload = {
            "schemaVersion": SCHEMA_VERSION,
            "generatedAt": generated_at,
            "source": "scraper",
            "items": item_exports,
        }
        if not dry_run:
            output_dir.mkdir(parents=True, exist_ok=True)
            (output_dir / f"{safe_id}.json").write_text(json.dumps(payload, indent=2) + "\n")
            summary["files_written"] += 1
        print(f"  {safe_id}: {len(item_exports)} items matched")

    print(
        f"Cannon's comps: {summary['items_with_comps']} items matched across "
        f"{summary['auctions']} auctions, {summary['matches']} matches, "
        f"{summary['files_written']} files written"
    )
    return summary


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Precompute Cannon's (archive) comps")
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR)
    parser.add_argument("--output-dir", type=Path, default=OUTPUT_DIR)
    parser.add_argument(
        "--top-k", type=int, default=int(os.environ.get("GOONERS_CANNONS_COMPS_TOP_K", DEFAULT_TOP_K))
    )
    parser.add_argument(
        "--min-sim",
        type=float,
        default=float(os.environ.get("GOONERS_CANNONS_COMPS_MIN_SIM", DEFAULT_MIN_SIM)),
    )
    parser.add_argument(
        "--active-limit",
        type=int,
        default=None,
        help="Only process the first N active auctions (for quick validation).",
    )
    parser.add_argument(
        "--no-embed",
        action="store_true",
        help="Use only existing .embeddings sidecars; never load the CLIP model. "
        "Auctions without a cached embedding are skipped (fast incremental runs).",
    )
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    build_comps(
        data_dir=args.data_dir,
        output_dir=args.output_dir,
        top_k=args.top_k,
        min_sim=args.min_sim,
        active_limit=args.active_limit,
        embed_missing=not args.no_embed,
        dry_run=args.dry_run,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
