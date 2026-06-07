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


def embed_items(items: list[dict], session=None) -> tuple[np.ndarray, list[str]]:
    """Return (embeddings, ids) — float32 (n, 768) L2-normalised, plus item IDs.

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

    # 1. Batch-encode all texts with search_document: task prefix
    texts = [
        "search_document: " + (f"{item.get('title', '')} {item.get('description', '')}".strip() or ".")
        for item in items
    ]
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
        }
        resp = session.get(endpoint, headers=headers, params=params, timeout=60)
        resp.raise_for_status()
        rows = resp.json()
        ids.update(str(row["item_id"]) for row in rows)
        if len(rows) < page:
            break
        start += page
    return ids


def generate_and_upsert(items: list[dict], safe_id: str, session=None) -> int:
    """Embed the lots not already in the table for one auction and upsert them.

    Incremental: reads the auction's already-embedded item_ids and embeds only
    the new ones, so the two ~550 MB Nomic models load only when there's new
    work. Returns the number of rows written. Raises on failure (the caller
    decides whether to warn or abort).
    """
    if not items:
        return 0
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
) -> int:
    """Populate ``nomic_embeddings`` from the on-disk NDJSON read model.

    One auction at a time (each sidecar is one auction), incrementally — lots
    already in the table are skipped, so the backfill is resumable: re-running
    only embeds what's still missing. Returns total rows written.
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
            total += generate_and_upsert(items, safe_id, session=session)
        except Exception as exc:
            print(f"  [nomic] WARNING: backfill failed for {safe_id}: {exc}")
    print(f"\n[nomic] backfill complete: {total} embeddings upserted")
    return total


if __name__ == "__main__":
    # Backfill the table from already-scraped NDJSON sidecars:
    #   uv run --with sentence-transformers --with 'transformers==4.49.0' \
    #     --with torchvision --with pillow --with einops --with numpy \
    #     --with requests python embed_nomic.py [--archive] [<safeId> ...]
    args = sys.argv[1:]
    include_archive = "--archive" in args
    ids = [a for a in args if not a.startswith("--")]
    backfill_from_read_model(ids or None, include_archive=include_archive)
