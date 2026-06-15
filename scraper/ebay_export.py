"""eBay comp file read-model: manifest loading, JSON export, and file-ledger helpers.

Handles the legacy/offline backend: per-auction JSON files under
public/data/ebay-comps/ that serve as both the read model and the ledger.
Also owns manifest + Parquet loading and the optional warehouse mirror.
"""

import json
from datetime import UTC, datetime
from pathlib import Path

from ebay_fetch import is_ebay_item_url
from ebay_util import text_value, utc_now_text

DATA_DIR = Path(__file__).resolve().parent.parent / "public" / "data"
EBAY_COMPS_DIR = DATA_DIR / "ebay-comps"


# ── Manifest + Parquet loading ─────────────────────────────────────────────────


def manifest_path(data_dir: Path = DATA_DIR, archived: bool = False) -> Path:
    return data_dir / ("archive-manifest.json" if archived else "manifest.json")


def manifest_item_path(entry: dict, data_dir: Path = DATA_DIR) -> Path:
    items_path = text_value(entry.get("itemsPath"))
    if not items_path:
        items_path = f"data/items/{entry.get('safeId')}.parquet"
    return data_dir.parent / items_path


def load_manifest_items(
    data_dir: Path = DATA_DIR,
    include_archived: bool = False,
    auction_safe_id: str | None = None,
) -> list[dict]:
    import pyarrow.parquet as pq

    items = []
    paths = [manifest_path(data_dir, archived=False)]
    if include_archived:
        paths.append(manifest_path(data_dir, archived=True))

    for path in paths:
        if not path.exists():
            continue

        manifest = json.loads(path.read_text())
        entries = (
            manifest if isinstance(manifest, list) else manifest.get("auctions", [])
        )
        for entry in entries:
            safe_id = text_value(
                entry.get("safeId") if isinstance(entry, dict) else entry
            )
            if auction_safe_id and safe_id != auction_safe_id:
                continue
            parquet_path = manifest_item_path(
                entry if isinstance(entry, dict) else {"safeId": safe_id}, data_dir
            )
            if not parquet_path.exists():
                continue
            table = pq.read_table(parquet_path)
            items.extend(table.to_pylist())

    items.sort(
        key=lambda item: (
            -float(item.get("currentBid") or 0),
            -int(item.get("totalBids") or 0),
            text_value(item.get("auctionSafeId")),
            int(item.get("lotNumber") or 0),
        )
    )
    return items


# Fields the comp query builder reads off enrichment (ebay_query):
# enriched_exact_phrase needs enrichmentConfidence + searchQuery/brand/modelOrSku;
# ebay_item_condition needs condition. Overlaid onto the bare lot so a
# Supabase-sourced item behaves identically to one read from the local parquet.
_COMP_ENRICHMENT_FIELDS = (
    "brand",
    "modelOrSku",
    "searchQuery",
    "condition",
    "enrichmentConfidence",
)


def load_supabase_items(
    include_archived: bool = False,
    auction_safe_id: str | None = None,
) -> list[dict]:
    """Load active lots (+enrichment) from Supabase as camelCase item dicts.

    The Supabase-sourced twin of :func:`load_manifest_items`: lets the comp fetch
    run **without a local scrape** (the read model is Supabase-only in prod, so a
    fresh checkout has no manifest/parquet). Each lot is overlaid with its
    enrichment so the query builder's enriched-phrase / category / condition
    filters behave identically. Returns ``[]`` when Supabase is unconfigured, so
    callers can fall back to the file path. The caller sorts (by auction end).
    """
    from supabase_comps import resolve_credentials

    url, key = resolve_credentials()
    if not url or not key:
        return []

    import supabase_enrichment
    import supabase_lots

    items: list[dict] = []
    for archived in (False, *((True,) if include_archived else ())):
        safe_ids = (
            [auction_safe_id]
            if auction_safe_id
            else supabase_lots.list_auction_safe_ids(
                url=url, key=key, archived=archived
            )
        )
        for safe_id in safe_ids:
            lots = supabase_lots.fetch_lots_for_auction(
                safe_id, url=url, key=key, archived=archived
            )
            if not lots:
                continue
            enrichment = supabase_enrichment.load_prior_enrichment_from_supabase(
                safe_id, url=url, key=key
            )
            for lot in lots:
                enr = enrichment.get(lot.get("id"))
                if enr:
                    for field in _COMP_ENRICHMENT_FIELDS:
                        if enr.get(field):
                            lot[field] = enr[field]
                items.append(lot)
    return items


# ── JSON export helpers ────────────────────────────────────────────────────────


def normalize_match_row(row: dict) -> tuple[str, str, dict] | None:
    item_web_url = text_value(row.get("item_web_url"))
    title = text_value(row.get("title"))
    price_value = text_value(row.get("price_value"))

    if not title or not price_value or not is_ebay_item_url(item_web_url):
        return None

    auction_safe_id = text_value(row.get("auction_safe_id"))
    item_id = text_value(row.get("item_id"))
    if not auction_safe_id or not item_id:
        return None

    match = {
        "ebayItemId": text_value(row.get("ebay_item_id")) or None,
        "title": title,
        "price": {
            "value": price_value,
            "currency": text_value(row.get("price_currency"), "USD"),
        },
        "shippingLabel": text_value(row.get("shipping_label")) or None,
        "soldDate": text_value(row.get("sold_date")) or None,
        "soldDateLabel": text_value(row.get("sold_date_label")) or None,
        "thumbnailUrl": text_value(row.get("thumbnail_url")) or None,
        "itemWebUrl": item_web_url,
        "condition": text_value(row.get("condition")) or None,
        "sourceQuery": text_value(row.get("source_query")) or None,
        "matchConfidence": text_value(row.get("match_confidence")) or None,
    }
    return auction_safe_id, item_id, {k: v for k, v in match.items() if v is not None}


def build_public_exports(
    rows: list[dict], generated_at: str | None = None
) -> dict[str, dict]:
    generated_at = generated_at or utc_now_text()
    exports: dict[str, dict] = {}

    for row in rows:
        normalized = normalize_match_row(row)
        if normalized is None:
            continue

        auction_safe_id, item_id, match = normalized
        auction_export = exports.setdefault(
            auction_safe_id,
            {
                "schemaVersion": 2,
                "generatedAt": generated_at,
                "marketplaceId": "EBAY_US",
                "source": "scraper",
                "items": {},
            },
        )
        item_export = auction_export["items"].setdefault(
            item_id,
            {
                "status": text_value(row.get("status"), "ok"),
                "query": text_value(row.get("query")),
                "searchUrl": text_value(row.get("search_url")),
                "fetchedAt": text_value(row.get("fetched_at")) or generated_at,
                "warning": text_value(row.get("warning")) or None,
                "matches": [],
            },
        )
        item_export["matches"].append(match)

    return exports


def write_comp_file(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n")


def load_comp_file(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def empty_comp_export(generated_at: str) -> dict:
    return {
        "schemaVersion": 2,
        "generatedAt": generated_at,
        "marketplaceId": "EBAY_US",
        "source": "scraper",
        "items": {},
        "attempts": {},
    }


# ── File-ledger freshness + budget ─────────────────────────────────────────────


def parse_fetched_at(value: str) -> float | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _iter_attempt_records(output_dir: Path):
    for json_path in output_dir.glob("*.json"):
        payload = load_comp_file(json_path)
        if not payload:
            continue
        yield from payload.get("attempts", {}).values()


def requests_used_in_bucket(output_dir: Path, bucket: str, fmt: str) -> int:
    """Sum recorded request counts for attempts whose fetch time is in bucket."""
    used = 0
    for record in _iter_attempt_records(output_dir):
        ts = parse_fetched_at(record.get("fetchedAt", ""))
        if ts is None:
            continue
        if datetime.fromtimestamp(ts, UTC).strftime(fmt) != bucket:
            continue
        used += int(record.get("queries") or 1)
    return used


def requests_used_in_month(output_dir: Path, now: datetime | None = None) -> int:
    now = now or datetime.now(UTC)
    return requests_used_in_bucket(output_dir, now.strftime("%Y-%m"), "%Y-%m")


def requests_used_today(output_dir: Path, now: datetime | None = None) -> int:
    now = now or datetime.now(UTC)
    return requests_used_in_bucket(output_dir, now.strftime("%Y-%m-%d"), "%Y-%m-%d")


def fresh_comp_keys_from_files(
    output_dir: Path, stale_hours: int, skip_attempted: bool = False
) -> set[str]:
    """Return ``{auction_safe_id:item_id}`` for items already fetched recently.

    Reads the ``attempts`` map (v2 files) and falls back to ``items`` fetch
    times (v1 files). When ``skip_attempted`` is set, every recorded attempt
    counts as done regardless of age.
    """
    if skip_attempted:
        cutoff = float("-inf")
    elif stale_hours <= 0:
        return set()
    else:
        cutoff = datetime.now(UTC).timestamp() - stale_hours * 3600
    fresh = set()
    for json_path in output_dir.glob("*.json"):
        payload = load_comp_file(json_path)
        if not payload:
            continue
        safe_id = json_path.stem
        records = {}
        records.update(payload.get("items", {}))
        records.update(payload.get("attempts", {}))
        for item_id, record in records.items():
            fetched_at = parse_fetched_at(record.get("fetchedAt", ""))
            if fetched_at is not None and fetched_at >= cutoff:
                fresh.add(f"{safe_id}:{item_id}")
    return fresh


def merge_comp_files(
    new_exports: dict[str, dict],
    attempts: dict[str, dict[str, dict]],
    output_dir: Path,
    generated_at: str,
) -> int:
    """Merge freshly fetched comps into the per-auction JSON read model.

    Only auctions touched this run are rewritten; untouched files are left as-is.
    """
    touched = set(new_exports) | set(attempts)
    written = 0
    for safe_id in sorted(touched):
        path = output_dir / f"{safe_id}.json"
        payload = load_comp_file(path) or empty_comp_export(generated_at)
        payload.setdefault("items", {})
        payload.setdefault("attempts", {})
        payload["schemaVersion"] = 2
        payload["source"] = "scraper"
        payload["generatedAt"] = generated_at

        new_items = new_exports.get(safe_id, {}).get("items", {})
        for item_id, entry in new_items.items():
            payload["items"][item_id] = entry

        for item_id, attempt in attempts.get(safe_id, {}).items():
            payload["attempts"][item_id] = attempt
            if item_id not in new_items:
                payload["items"].pop(item_id, None)

        write_comp_file(path, payload)
        written += 1
    return written


# ── Warehouse mirror ───────────────────────────────────────────────────────────


def mirror_rows_to_warehouse(rows: list[dict]) -> int:
    """Best-effort append of comp rows to the optional warehouse mirror."""
    if not rows:
        return 0
    try:
        from warehouse import get_sink

        sink = get_sink()
        if sink is None:
            return 0
        mirrored = sink.append_comp_snapshots(rows)
        print(f"Mirrored {mirrored} eBay comp rows to the warehouse")
        return mirrored
    except Exception as exc:
        print(f"Warehouse mirror skipped: {exc}")
        return 0


# ── Sorting helpers ────────────────────────────────────────────────────────────


def auction_end_sort_key(item: dict) -> float:
    """Sort key putting soonest-ending auctions first.

    Spends the request budget on auctions that close soonest. Items whose end
    date can't be parsed sort last.
    """
    raw = item.get("auctionEndDate") or item.get("endDate")
    if isinstance(raw, datetime):
        dt = raw if raw.tzinfo else raw.replace(tzinfo=UTC)
        return dt.timestamp()
    text = text_value(raw)
    if not text:
        return float("inf")
    parsed = parse_fetched_at(text)
    if parsed is not None:
        return parsed
    for fmt in ("%Y-%m-%d %I:%M:%S %p", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=UTC).timestamp()
        except ValueError:
            continue
    return float("inf")
