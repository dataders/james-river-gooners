"""Nomic Embed (text + vision) generation → Supabase pgvector table.

Activated by setting GOONERS_NOMIC_EMBEDDINGS=1 before running scrape.py or
rescrape_all.py.  Requires extra deps (not in the base scraper). Note:
  - `einops` — nomic_bert's trust_remote_code modeling file imports it; without
    it the model fails to load and every upsert is skipped.
  - `transformers==4.49.0` — transformers 5.x's strict config validation rejects
    nomic_bert's remote config (`n_inner=2048.0` float), so the vision model
    won't load on the latest release; pin to 4.49.
  - `torchvision` — required by the vision model's AutoImageProcessor.

    uv run --with sentence-transformers --with 'transformers==4.49.0' \
      --with torchvision --with pillow --with einops ...

The first run downloads ~550 MB each for the text and vision model weights,
cached by huggingface in ~/.cache/huggingface.

Models:
  nomic-ai/nomic-embed-text-v1.5  — text embeddings, 768-dim (trust_remote_code)
  nomic-ai/nomic-embed-vision-v1.5 — image embeddings in the same 768-dim space

Embedding strategy per item:
  text_vec  = normalize(text_model.encode("search_document: " + title + " " + desc))
  img_vecs  = [normalize(vision_model.encode(img)) for img in images[:GOONERS_MAX_IMAGES]]
  item_vec  = normalize(text_vec + mean(img_vecs))   # text-only when no images

Both models project into the same 768-dim space by design, so combining them
is pure averaging — no projection layer, no learned fusion weights.

Output: upserted to the Supabase ``nomic_embeddings`` table (see
supabase/migrations/0010_nomic_embeddings.sql). Writes use the service-role
secret key, which bypasses RLS. Generation is incremental — only lots not
already in the table are embedded, so the two models load only when there's
new work.

Backfill the table from the on-disk NDJSON read model (resumable; skips lots
already embedded):

    SUPABASE_URL=… SUPABASE_SECRET_KEY=… \
      uv run --with sentence-transformers --with pillow --with einops \
        --with numpy --with requests python embed_nomic.py [--archive] [<safeId> ...]
"""

import io
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import requests as _req

_MAX_IMAGES = int(os.environ.get("GOONERS_MAX_IMAGES", "3"))

_ACTIVE_ITEMS_DIR = Path(__file__).resolve().parent.parent / "public" / "data" / "items"
_ARCHIVE_ITEMS_DIR = (
    Path(__file__).resolve().parent.parent / "public" / "data" / "archive" / "items"
)

_text_model = None
_vision_model = None
_vision_processor = None
_device = None

NOMIC_TABLE = "nomic_embeddings"
NOMIC_TEXT_MODEL = "nomic-embed-text-v1.5"
NOMIC_VISION_MODEL = "nomic-embed-vision-v1.5"

# Non-browser UA for Supabase REST calls. The scrapers pass their own session
# (which carries a Chrome User-Agent for the auction sites); Supabase rejects the
# secret key from anything that looks browser-originated, so we override it here.
_SUPABASE_UA = "gooners-embed/1.0 (+scraper)"


def _get_device() -> str:
    """Best available torch device: CUDA (NVIDIA) → MPS (Apple Silicon) → CPU.

    Lets a GPU laptop or GPU CI runner accelerate encoding ~10-30× without
    config; falls back to CPU on the standard runners. Override with
    GOONERS_EMBED_DEVICE (e.g. 'cpu') if a backend misbehaves.
    """
    global _device
    if _device is None:
        forced = os.environ.get("GOONERS_EMBED_DEVICE")
        if forced:
            _device = forced
        else:
            import torch
            if torch.cuda.is_available():
                _device = "cuda"
            elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
                _device = "mps"
            else:
                _device = "cpu"
        print(f"[nomic] embedding device: {_device}")
    return _device


def _get_text_model():
    global _text_model
    if _text_model is None:
        from sentence_transformers import SentenceTransformer
        print("Loading Nomic text model (first run: ~550 MB download)...")
        _text_model = SentenceTransformer(
            f"nomic-ai/{NOMIC_TEXT_MODEL}", trust_remote_code=True, device=_get_device()
        )
        print("Nomic text model ready.")
    return _text_model


def _get_vision_model():
    """Load nomic-embed-vision via transformers (AutoModel + image processor).

    The vision model is NOT a sentence-transformers text model — loading it with
    SentenceTransformer builds a text tower (word_embeddings, vocab_size 0) and
    crashes. It must be loaded as an image encoder; we take the CLS token of the
    last hidden state and L2-normalise, which lands in the same 768-dim space as
    nomic-embed-text by design. (`AutoImageProcessor` needs torchvision.)
    """
    global _vision_model, _vision_processor
    if _vision_model is None:
        from transformers import AutoImageProcessor, AutoModel
        print("Loading Nomic vision model (first run: ~550 MB download)...")
        _vision_processor = AutoImageProcessor.from_pretrained(
            f"nomic-ai/{NOMIC_VISION_MODEL}"
        )
        _vision_model = AutoModel.from_pretrained(
            f"nomic-ai/{NOMIC_VISION_MODEL}", trust_remote_code=True
        ).eval().to(_get_device())
        print("Nomic vision model ready.")
    return _vision_model, _vision_processor


def _encode_images(images: list, batch_size: int = 32) -> np.ndarray:
    """Return an (n, 768) L2-normalised array of Nomic vision embeddings."""
    import torch
    import torch.nn.functional as F

    model, processor = _get_vision_model()
    device = _get_device()
    chunks = []
    with torch.no_grad():
        for start in range(0, len(images), batch_size):
            batch = images[start : start + batch_size]
            inputs = processor(images=batch, return_tensors="pt").to(device)
            hidden = model(**inputs).last_hidden_state
            emb = F.normalize(hidden[:, 0], p=2, dim=1)  # CLS token
            chunks.append(emb.cpu().numpy())
    return np.concatenate(chunks, axis=0)


def _fetch_image(url: str):
    """Fetch url and return a PIL Image, or None on any failure."""
    from PIL import Image
    try:
        resp = _req.get(url, timeout=15)
        resp.raise_for_status()
        return Image.open(io.BytesIO(resp.content)).convert("RGB")
    except Exception:
        return None


# Enrichment identity fields (camelCase, as the read model / overlay carry them)
# folded into the embedded text so semantic search AND the Cannon's-comps pgvector
# similarity match on the lot's *resale identity*, not just its raw listing text.
_ENRICH_TEXT_FIELDS = ("brand", "modelOrSku", "productType", "searchQuery")


def _enrichment_text(item: dict) -> str:
    """The resale-identity phrase for a lot: brand/model/type/searchQuery plus the
    v6 category-detail values (furniture style/material/form, art artist/medium/
    subject, ceramics maker/pattern/material). '' when the lot has no enrichment
    overlaid, so an unenriched lot embeds exactly as before (title+description)."""
    parts: list[str] = []
    for field in _ENRICH_TEXT_FIELDS:
        value = str(item.get(field) or "").strip()
        if value:
            parts.append(value)
    raw_details = item.get("details")
    if raw_details:
        try:
            bag = json.loads(raw_details) if isinstance(raw_details, str) else raw_details
        except (ValueError, TypeError):
            bag = None
        if isinstance(bag, dict):
            parts.extend(str(v).strip() for v in bag.values() if str(v or "").strip())
    # De-dup at the word level, case-insensitively, preserving order: searchQuery
    # usually repeats the brand/model words already listed, and this is a keyword
    # bag for the embedding, so collapsing repeats keeps the text clean without
    # over-weighting any one term.
    seen: set[str] = set()
    tokens: list[str] = []
    for word in " ".join(parts).split():
        key = word.lower()
        if key not in seen:
            seen.add(key)
            tokens.append(word)
    return " ".join(tokens)


def _document_text(item: dict) -> str:
    """The ``search_document:`` text encoded for a lot — title + description, with
    the resale-identity phrase appended when enrichment is present."""
    base = f"{item.get('title', '')} {item.get('description', '')}".strip()
    enrich = _enrichment_text(item)
    combined = f"{base} {enrich}".strip() if enrich else base
    return "search_document: " + (combined or ".")


def embed_items(items: list[dict], session=None) -> tuple[np.ndarray, list[str], list[int]]:
    """Return (embeddings, ids, n_images_used) — float32 (n, 768) L2-normalised,
    the item IDs, and the image count fused into each vector.

    Strategy:
      1. Batch-encode all texts in one model call.
      2. Fetch up to GOONERS_MAX_IMAGES images per item concurrently (I/O bound).
      3. Batch-encode all fetched images in one vision-model call.
      4. Per item: mean-pool its image vectors, add to text vector, re-normalise.
    """
    text_model = _get_text_model()
    n = len(items)
    ids = [item["id"] for item in items]

    # Parse up to _MAX_IMAGES http image URLs from each item
    item_image_urls: list[list[str]] = []
    for item in items:
        images = item.get("images") or []
        if isinstance(images, str):
            try:
                images = json.loads(images)
            except Exception:
                images = []
        valid = [u for u in images if isinstance(u, str) and u.startswith("http")]
        item_image_urls.append(valid[:_MAX_IMAGES])

    # 1. Batch-encode all texts with search_document: task prefix. The text folds
    #    in the lot's enrichment identity (brand/model/type/searchQuery + v6 detail
    #    keys) when present — see _document_text — so search + comps match on it.
    texts = [_document_text(item) for item in items]
    print(f"  [nomic] Encoding {n} texts...")
    text_embs = text_model.encode(
        texts,
        convert_to_numpy=True,
        normalize_embeddings=True,
        batch_size=64,
        show_progress_bar=False,
    )

    # 2. Flatten (item_idx, img_idx, url) → fetch all images concurrently
    url_tasks = [
        (i, j, url)
        for i, urls in enumerate(item_image_urls)
        for j, url in enumerate(urls)
    ]
    pil_by_key: dict[tuple[int, int], object] = {}
    if url_tasks:
        print(f"  [nomic] Fetching {len(url_tasks)} images concurrently...")

        def _fetch_task(task):
            i, j, url = task
            return i, j, _fetch_image(url)

        with ThreadPoolExecutor(max_workers=8) as pool:
            for i, j, img in pool.map(_fetch_task, url_tasks):
                if img is not None:
                    pil_by_key[(i, j)] = img

    # 3. Batch-encode all fetched images
    item_img_embs: list[list[np.ndarray]] = [[] for _ in range(n)]
    img_encode_tasks = sorted(pil_by_key.items())
    if img_encode_tasks:
        keys, imgs = zip(*img_encode_tasks)
        print(f"  [nomic] Encoding {len(imgs)} images...")
        encoded = _encode_images(list(imgs))
        for (item_idx, _), emb in zip(keys, encoded):
            item_img_embs[item_idx].append(emb)

    # 4. Fuse text + mean(images) and re-normalise
    n_dims = text_embs.shape[1]
    embeddings = np.empty((n, n_dims), dtype=np.float32)
    n_images_used = []
    for i in range(n):
        t = text_embs[i]
        img_list = item_img_embs[i]
        n_images_used.append(len(img_list))
        if img_list:
            img_mean = np.mean(img_list, axis=0)
            combined = t + img_mean
            norm = np.linalg.norm(combined)
            embeddings[i] = combined / norm if norm > 0 else t
        else:
            embeddings[i] = t

    return embeddings, ids, n_images_used


def _vec_to_pg(v: np.ndarray) -> str:
    """Format a float32 numpy vector as a pgvector literal: [f1,f2,...]."""
    return "[" + ",".join(f"{x:.8g}" for x in v.tolist()) + "]"


def upsert_embeddings(
    embeddings: np.ndarray,
    ids: list[str],
    n_images_used: list[int],
    safe_id: str,
    url: str | None = None,
    key: str | None = None,
    session=None,
    batch_size: int | None = None,
) -> int:
    """Upsert (auction_safe_id, item_id) embeddings to the nomic_embeddings table.

    Returns the number of rows written. Uses the service-role key (secret),
    which bypasses RLS. On conflict on the primary key, the embedding is replaced.

    Each insert updates the HNSW vector index, which gets slower as the table
    grows, so a large batch can exceed the Postgres statement timeout (57014).
    We keep batches modest (``GOONERS_NOMIC_UPSERT_BATCH``, default 100) and, on a
    timeout, split the batch and retry down to a single row so a big auction
    always completes.
    """
    from supabase_comps import resolve_credentials

    url, key = resolve_credentials(url, key)
    if not url:
        raise RuntimeError("SUPABASE_URL is required to upsert Nomic embeddings")
    if not key:
        raise RuntimeError("SUPABASE_SECRET_KEY is required to upsert Nomic embeddings")

    if session is None:
        import requests
        session = requests.Session()

    if batch_size is None:
        batch_size = int(os.environ.get("GOONERS_NOMIC_UPSERT_BATCH", "100"))

    rows = [
        {
            "auction_safe_id": safe_id,
            "item_id": str(item_id),
            "embedding": _vec_to_pg(embeddings[i]),
            "n_images": n_images_used[i],
            "model": f"{NOMIC_TEXT_MODEL}+{NOMIC_VISION_MODEL}",
        }
        for i, item_id in enumerate(ids)
    ]

    endpoint = f"{url.rstrip('/')}/rest/v1/{NOMIC_TABLE}"
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
        # Override the scraper session's browser User-Agent: Supabase rejects the
        # secret API key when the request looks browser-originated ("Forbidden use
        # of secret API key in browser"), which the scrapers' Chrome UA triggers.
        "User-Agent": _SUPABASE_UA,
    }

    def _post(batch: list[dict]) -> int:
        resp = session.post(endpoint, headers=headers, data=json.dumps(batch), timeout=120)
        if resp.status_code < 400:
            return len(batch)
        # Statement timeout (57014) from HNSW index pressure → split and retry.
        is_timeout = resp.status_code in (500, 503, 504) and (
            "57014" in resp.text or "timeout" in resp.text.lower()
        )
        if is_timeout and len(batch) > 1:
            mid = len(batch) // 2
            return _post(batch[:mid]) + _post(batch[mid:])
        raise RuntimeError(
            f"Nomic embeddings upsert failed ({resp.status_code}): {resp.text[:300]}"
        )

    written = 0
    for start in range(0, len(rows), batch_size):
        written += _post(rows[start : start + batch_size])

    return written


def existing_item_ids(
    safe_id: str,
    url: str | None = None,
    key: str | None = None,
    session=None,
) -> set[str]:
    """Return the set of item_ids already embedded for an auction.

    Lets the scrape skip lots that are already in the table — the two heavy
    models only load when there is genuinely new work. (Reuse is keyed on
    presence, so an edit to an already-embedded lot keeps its prior vector
    until the row is deleted; acceptable for the hourly scrape, where only bids
    move.) Returns an empty set on any read failure so the caller falls back to
    embedding everything rather than silently skipping.
    """
    from supabase_comps import resolve_credentials

    url, key = resolve_credentials(url, key)
    if not url or not key:
        return set()

    if session is None:
        import requests
        session = requests.Session()

    endpoint = f"{url.rstrip('/')}/rest/v1/{NOMIC_TABLE}"
    params = {"select": "item_id", "auction_safe_id": f"eq.{safe_id}"}

    # Page through with Range headers so PostgREST's max-rows cap can't silently
    # truncate large auctions (some carry >1k lots) — a short read would make us
    # re-embed the missing tail every run.
    ids: set[str] = set()
    page = 1000
    start = 0
    while True:
        headers = {
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Range-Unit": "items",
            "Range": f"{start}-{start + page - 1}",
            "User-Agent": _SUPABASE_UA,  # see upsert_embeddings note
        }
        resp = session.get(endpoint, headers=headers, params=params, timeout=60)
        resp.raise_for_status()
        rows = resp.json()
        ids.update(str(row["item_id"]) for row in rows)
        if len(rows) < page:
            break
        start += page
    return ids


# lot_enrichment columns (snake_case) -> the camelCase keys _document_text reads.
_ENRICH_OVERLAY_COLUMNS = {
    "brand": "brand",
    "model_or_sku": "modelOrSku",
    "product_type": "productType",
    "search_query": "searchQuery",
    "details": "details",
}


def fetch_enrichment_overlay(
    safe_id: str,
    *,
    url: str | None = None,
    key: str | None = None,
    session=None,
) -> dict[str, dict]:
    """Return ``{item_id: {camelCase enrichment fields}}`` for one auction from the
    Supabase ``lot_enrichment`` table, so the from-Supabase backfill can fold each
    lot's resale identity into its embedded text. Empty dict when unconfigured or
    none found. Pages with Range headers like ``existing_item_ids``."""
    from supabase_comps import resolve_credentials

    url, key = resolve_credentials(url, key)
    if not url or not key:
        return {}
    if session is None:
        import requests
        session = requests.Session()

    endpoint = f"{url.rstrip('/')}/rest/v1/lot_enrichment"
    select = ",".join(["item_id", *_ENRICH_OVERLAY_COLUMNS])
    params = {"select": select, "auction_safe_id": f"eq.{safe_id}"}
    out: dict[str, dict] = {}
    page = 1000
    start = 0
    while True:
        headers = {
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Range-Unit": "items",
            "Range": f"{start}-{start + page - 1}",
            "User-Agent": _SUPABASE_UA,
        }
        resp = session.get(endpoint, headers=headers, params=params, timeout=60)
        resp.raise_for_status()
        rows = resp.json()
        for row in rows:
            overlay = {
                cc: row.get(sc)
                for sc, cc in _ENRICH_OVERLAY_COLUMNS.items()
                if str(row.get(sc) or "").strip()
            }
            if overlay:
                out[str(row.get("item_id"))] = overlay
        if len(rows) < page:
            break
        start += page
    return out


def overlay_enrichment(items: list[dict], safe_id: str, session=None) -> int:
    """Merge the auction's lot_enrichment fields onto each lot in place (matched by
    item id) so ``embed_items`` folds the resale identity into the text. Returns the
    count of lots that got enrichment; warns (not raises) on a read failure so the
    embed still runs on title+description."""
    try:
        emap = fetch_enrichment_overlay(safe_id, session=session)
    except Exception as exc:
        print(f"  [nomic] WARNING: could not load enrichment for {safe_id} "
              f"({exc}); embedding on listing text only")
        return 0
    if not emap:
        return 0
    n = 0
    for item in items:
        enr = emap.get(str(item.get("id")))
        if enr:
            item.update(enr)
            n += 1
    return n


def generate_and_upsert(
    items: list[dict], safe_id: str, session=None, force: bool = False
) -> int:
    """Embed the lots not already in the table for one auction and upsert them.

    Incremental: reads the auction's already-embedded item_ids and embeds only
    the new ones, so the two ~550 MB Nomic models load only when there's new
    work. Returns the number of rows written. Raises on failure (the caller
    decides whether to warn or abort).
    """
    if not items:
        return 0
    if force:
        # Re-embed every lot regardless of presence — used when the embedded text
        # changed (e.g. enrichment was folded in), since reuse is keyed on presence
        # not content, so an incremental run would otherwise keep the stale vector.
        todo = items
    else:
        try:
            already = existing_item_ids(safe_id, session=session)
        except Exception as exc:
            print(f"  [nomic] WARNING: could not read existing ids for {safe_id} "
                  f"({exc}); embedding all {len(items)} lots")
            already = set()

        todo = [it for it in items if str(it["id"]) not in already]
    if not todo:
        print(f"[nomic] {safe_id}: all {len(items)} lots already embedded — skipping")
        return 0

    n_reused = len(items) - len(todo)
    print(
        f"\nGenerating Nomic embeddings for {len(todo)} new lots ({safe_id})"
        + (f"; {n_reused} already embedded" if n_reused else "")
        + "..."
    )
    embeddings, ids, n_images_used = embed_items(todo, session)
    n = upsert_embeddings(embeddings, ids, n_images_used, safe_id, session=session)
    print(f"  [nomic] Upserted {n} embeddings → Supabase {NOMIC_TABLE}")
    return n


def maybe_generate_and_upsert(items: list[dict], safe_id: str, session=None) -> None:
    """Opt-in entry point called from scrape.py.

    No-op unless GOONERS_NOMIC_EMBEDDINGS=1 AND SUPABASE_SECRET_KEY is set.
    Failures warn rather than aborting the scrape (the local read model is
    primary).
    """
    if os.environ.get("GOONERS_NOMIC_EMBEDDINGS") != "1":
        return
    if not os.environ.get("SUPABASE_SECRET_KEY"):
        print("[nomic] SUPABASE_SECRET_KEY not set — skipping Nomic embeddings")
        return

    try:
        generate_and_upsert(items, safe_id, session=session)
    except Exception as exc:
        print(f"  [nomic] WARNING: Nomic embedding upsert failed for {safe_id}: {exc}")


def _iter_ndjson(path: Path):
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            try:
                yield json.loads(line)
            except ValueError:
                continue


def backfill_from_read_model(
    safe_ids: list[str] | None = None,
    *,
    include_archive: bool = False,
    session=None,
    force: bool = False,
) -> int:
    """Populate ``nomic_embeddings`` from the on-disk NDJSON read model.

    One auction at a time (each sidecar is one auction), incrementally — lots
    already in the table are skipped (unless ``force``), so the backfill is
    resumable: re-running only embeds what's still missing. The NDJSON rows
    already carry enrichment fields, so the embedded text folds in the resale
    identity without a separate overlay. Returns total rows written.
    """
    if not os.environ.get("SUPABASE_SECRET_KEY"):
        raise RuntimeError("SUPABASE_SECRET_KEY is required to backfill Nomic embeddings")

    dirs = [_ACTIVE_ITEMS_DIR] + ([_ARCHIVE_ITEMS_DIR] if include_archive else [])
    if safe_ids:
        paths = [d / f"{sid}.ndjson" for sid in safe_ids for d in dirs]
    else:
        paths = [p for d in dirs if d.exists() for p in sorted(d.glob("*.ndjson"))]

    if session is None:
        session = _req.Session()

    total = 0
    for path in paths:
        if not path.exists():
            print(f"[nomic] skip (missing): {path}")
            continue
        safe_id = path.stem
        items = list(_iter_ndjson(path))
        if not items:
            continue
        try:
            total += generate_and_upsert(items, safe_id, session=session, force=force)
        except Exception as exc:
            print(f"  [nomic] WARNING: backfill failed for {safe_id}: {exc}")
    print(f"\n[nomic] backfill complete: {total} embeddings upserted")
    return total


def backfill_from_supabase(
    safe_ids: list[str] | None = None,
    *,
    include_archive: bool = False,
    session=None,
    force: bool = False,
) -> int:
    """Populate ``nomic_embeddings`` by fetching lot items from the Supabase
    ``lots`` table instead of on-disk NDJSON files. Each lot's ``lot_enrichment``
    row (when present) is overlaid first, so the embedded text carries the resale
    identity (brand/model/searchQuery + v6 detail keys).

    Incrementally resumes — lots already in ``nomic_embeddings`` are skipped —
    unless ``force`` re-embeds every lot (use after enrichment changes the text).
    Requires ``SUPABASE_SECRET_KEY`` (reads and writes to Supabase).
    """
    if not os.environ.get("SUPABASE_SECRET_KEY"):
        raise RuntimeError("SUPABASE_SECRET_KEY is required to backfill Nomic embeddings from Supabase")

    from supabase_lots import list_auction_safe_ids, fetch_lots_for_auction

    if session is None:
        session = _req.Session()

    scopes = [(False, "active")]
    if include_archive:
        scopes.append((True, "archive"))

    if safe_ids:
        pairs = [(sid, archived) for archived in ([False] + ([True] if include_archive else [])) for sid in safe_ids]
    else:
        pairs = []
        for archived, label in scopes:
            ids = list_auction_safe_ids(archived=archived, session=session)
            print(f"[nomic] {label}: {len(ids)} auction(s) discovered in Supabase")
            pairs.extend((sid, archived) for sid in ids)

    total = 0
    for safe_id, archived in pairs:
        items = fetch_lots_for_auction(safe_id, archived=archived, session=session)
        if not items:
            print(f"[nomic] skip (empty): {safe_id} (archived={archived})")
            continue
        n_enriched = overlay_enrichment(items, safe_id, session=session)
        if n_enriched:
            print(f"[nomic] {safe_id}: overlaid enrichment on {n_enriched}/{len(items)} lots")
        targets = items
        if force:
            # Re-embed only what would actually change: lots whose text gained
            # enrichment, plus any not-yet-embedded lots. Unenriched + already-
            # embedded lots keep their (identical) vectors — avoids re-fetching
            # their images and re-encoding for no change.
            try:
                already = existing_item_ids(safe_id, session=session)
            except Exception:
                already = set()
            targets = [
                it for it in items
                if _enrichment_text(it) or str(it["id"]) not in already
            ]
            skipped = len(items) - len(targets)
            if skipped:
                print(f"[nomic] {safe_id}: {skipped} unenriched, already-embedded lots kept as-is")
            if not targets:
                continue
        try:
            total += generate_and_upsert(targets, safe_id, session=session, force=force)
        except Exception as exc:
            print(f"  [nomic] WARNING: backfill failed for {safe_id}: {exc}")
    print(f"\n[nomic] Supabase backfill complete: {total} embeddings upserted")
    return total


if __name__ == "__main__":
    # Backfill the table from already-scraped NDJSON sidecars:
    #   uv run --with sentence-transformers --with 'transformers==4.49.0' \
    #     --with torchvision --with pillow --with einops --with numpy \
    #     --with requests python embed_nomic.py [--archive] [<safeId> ...]
    #
    # Or from the Supabase lots table (no NDJSON needed):
    #   ... python embed_nomic.py --from-supabase [--archive] [<safeId> ...]
    # Add --force to re-embed every lot (not just missing ones) — needed after the
    # embedded text changes, e.g. a re-embed that folds in new enrichment.
    args = sys.argv[1:]
    include_archive = "--archive" in args
    from_supabase = "--from-supabase" in args
    force = "--force" in args
    ids = [a for a in args if not a.startswith("--")]
    if from_supabase:
        backfill_from_supabase(ids or None, include_archive=include_archive, force=force)
    else:
        backfill_from_read_model(ids or None, include_archive=include_archive, force=force)
