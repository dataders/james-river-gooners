"""Nomic Embed (text + vision) generation → Supabase pgvector table.

Activated by setting GOONERS_NOMIC_EMBEDDINGS=1 before running scrape.py or
rescrape_all.py.  Requires extra deps (not in the base scraper):

    uv run --with sentence-transformers --with pillow ...

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
secret key, which bypasses RLS.
"""

import io
import json
import os
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import requests as _req

_MAX_IMAGES = int(os.environ.get("GOONERS_MAX_IMAGES", "3"))

_text_model = None
_vision_model = None

NOMIC_TABLE = "nomic_embeddings"
NOMIC_TEXT_MODEL = "nomic-embed-text-v1.5"
NOMIC_VISION_MODEL = "nomic-embed-vision-v1.5"


def _get_text_model():
    global _text_model
    if _text_model is None:
        from sentence_transformers import SentenceTransformer
        print("Loading Nomic text model (first run: ~550 MB download)...")
        _text_model = SentenceTransformer(
            f"nomic-ai/{NOMIC_TEXT_MODEL}", trust_remote_code=True
        )
        print("Nomic text model ready.")
    return _text_model


def _get_vision_model():
    global _vision_model
    if _vision_model is None:
        from sentence_transformers import SentenceTransformer
        print("Loading Nomic vision model (first run: ~550 MB download)...")
        _vision_model = SentenceTransformer(f"nomic-ai/{NOMIC_VISION_MODEL}")
        print("Nomic vision model ready.")
    return _vision_model


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
    vision_model = _get_vision_model()
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
        encoded = vision_model.encode(
            list(imgs),
            convert_to_numpy=True,
            normalize_embeddings=True,
            batch_size=32,
            show_progress_bar=False,
        )
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
    batch_size: int = 200,
) -> int:
    """Upsert (auction_safe_id, item_id) embeddings to the nomic_embeddings table.

    Returns the number of rows written. Uses the service-role key (secret),
    which bypasses RLS. On conflict on the primary key, the embedding is replaced.
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

    written = 0
    for start in range(0, len(rows), batch_size):
        batch = rows[start : start + batch_size]
        resp = session.post(endpoint, headers=headers, data=json.dumps(batch), timeout=60)
        if resp.status_code >= 400:
            raise RuntimeError(
                f"Nomic embeddings upsert failed ({resp.status_code}): {resp.text[:300]}"
            )
        written += len(batch)

    return written


def maybe_generate_and_upsert(items: list[dict], safe_id: str, session=None) -> None:
    """Opt-in entry point called from scrape.py.

    No-op unless GOONERS_NOMIC_EMBEDDINGS=1 AND SUPABASE_SECRET_KEY is set.
    Failures warn rather than aborting the scrape (the CLIP .embeddings sidecar
    is the primary embedding deliverable).
    """
    if os.environ.get("GOONERS_NOMIC_EMBEDDINGS") != "1":
        return
    if not os.environ.get("SUPABASE_SECRET_KEY"):
        print("[nomic] SUPABASE_SECRET_KEY not set — skipping Nomic embeddings")
        return

    try:
        print(f"\nGenerating Nomic embeddings for {len(items)} items ({safe_id})...")
        embeddings, ids, n_images_used = embed_items(items, session)
        n = upsert_embeddings(embeddings, ids, n_images_used, safe_id, session=session)
        print(f"  [nomic] Upserted {n} embeddings → Supabase {NOMIC_TABLE}")
    except Exception as exc:
        print(f"  [nomic] WARNING: Nomic embedding upsert failed for {safe_id}: {exc}")
