"""CLIP embedding generation for auction items.

Activated by setting GOONERS_EMBEDDINGS=1 before running scrape.py or
rescrape_all.py.  Requires extra deps (not in the base scraper):

    uv run --with sentence-transformers --with pillow ...

The first run downloads ~350 MB of CLIP model weights which are then cached
by huggingface in ~/.cache/huggingface.

Output binary format (.embeddings file):
  [4 bytes uint32 LE]  n_items
  [4 bytes uint32 LE]  n_dims  (derived from model at runtime)
  [n_items × n_dims × 4 bytes float32]  L2-normalised embeddings, row-major
  [remaining bytes]  UTF-8 JSON array of item ID strings (same order as rows)

This layout lets the browser slice the float32 block directly with a
TypedArray and parse the IDs with JSON.parse.

The IDs stored here are the *bare* item ids, which are unique only within a
single auction. That is safe because each .embeddings file holds exactly one
auction's items; the frontend loader (src/hooks/useEmbeddings.js) namespaces
them with the auction's safeId — `${safeId}:${id}` — when it merges multiple
auctions in-browser, producing the globally-unique composite keys that search
and filtering compare against. So there is no need to store composite ids here.
"""

import io
import json
import struct
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import requests as _req


_model = None


def _get_model():
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer
        print("Loading CLIP model (first run: ~350 MB download)...")
        _model = SentenceTransformer("clip-ViT-B-32")
        print("CLIP model ready.")
    return _model


def _fetch_image(url: str):
    """Fetch url and return a PIL Image, or None on any failure.

    Uses bare requests (not a session) so this is safe to call from
    thread-pool workers. Item images are public S3 URLs that need no auth.
    """
    from PIL import Image
    try:
        resp = _req.get(url, timeout=15)
        resp.raise_for_status()
        return Image.open(io.BytesIO(resp.content)).convert("RGB")
    except Exception:
        return None


def embed_items(items: list[dict], session=None) -> tuple[np.ndarray, list[str]]:
    """Return (embeddings, ids) — float32 (n, n_dims) L2-normalised, plus item IDs.

    Strategy:
      1. Batch-encode all texts in one model call (much faster than per-item).
      2. Fetch all first images concurrently via a thread pool (I/O bound).
      3. Batch-encode fetched images in one model call.
      4. Combine text + image per item, re-normalise.

    n_dims is derived from the model at runtime — not hardcoded.
    """
    model = _get_model()
    n = len(items)
    ids = [item["id"] for item in items]

    # Parse the first image URL from each item (images may be a list or JSON string)
    image_urls = []
    for item in items:
        images = item.get("images") or []
        if isinstance(images, str):
            try:
                images = json.loads(images)
            except Exception:
                images = []
        image_urls.append(images[0] if images else None)

    # 1. Batch-encode all texts at once
    texts = [
        (f"{item.get('title', '')} {item.get('description', '')}".strip() or ".")
        for item in items
    ]
    print(f"  Encoding {n} texts...")
    text_embs = model.encode(
        texts,
        convert_to_numpy=True,
        normalize_embeddings=True,
        batch_size=64,
        show_progress_bar=False,
    )

    # 2. Fetch all first images concurrently (thread-pool, bare requests)
    urls_to_fetch = [(i, u) for i, u in enumerate(image_urls) if u]
    pil_images: list = [None] * n
    if urls_to_fetch:
        fetch_indices, fetch_urls = zip(*urls_to_fetch)
        print(f"  Fetching {len(fetch_urls)} images concurrently...")
        with ThreadPoolExecutor(max_workers=8) as pool:
            fetched = pool.map(_fetch_image, fetch_urls)
        for idx, img in zip(fetch_indices, fetched):
            pil_images[idx] = img

    # 3. Batch-encode images that were successfully fetched
    img_embs: list = [None] * n
    to_encode = [(i, img) for i, img in enumerate(pil_images) if img is not None]
    if to_encode:
        enc_indices, enc_imgs = zip(*to_encode)
        print(f"  Encoding {len(enc_imgs)} images...")
        encoded = model.encode(
            list(enc_imgs),
            convert_to_numpy=True,
            normalize_embeddings=True,
            batch_size=32,
            show_progress_bar=False,
        )
        for idx, emb in zip(enc_indices, encoded):
            img_embs[idx] = emb

    # 4. Combine and re-normalise; n_dims derived from model output, not hardcoded
    n_dims = text_embs.shape[1]
    embeddings = np.empty((n, n_dims), dtype=np.float32)
    for i in range(n):
        t = text_embs[i]           # already L2-normalised
        img = img_embs[i]
        if img is not None:
            combined = (t + img) * 0.5
            norm = np.linalg.norm(combined)
            # If combined is degenerate (extremely rare), keep the text embedding
            embeddings[i] = combined / norm if norm > 0 else t
        else:
            embeddings[i] = t      # already L2-normalised

    return embeddings, ids


def write_embeddings(embeddings: np.ndarray, ids: list[str], path: Path) -> None:
    """Write the .embeddings binary (see module docstring for format)."""
    n_items, n_dims = embeddings.shape
    ids_bytes = json.dumps(ids, separators=(",", ":")).encode("utf-8")
    with open(path, "wb") as f:
        f.write(struct.pack("<II", n_items, n_dims))
        f.write(embeddings.astype(np.float32).tobytes())
        f.write(ids_bytes)


def read_embeddings(path: Path) -> tuple[np.ndarray, list[str]]:
    """Round-trip reader — returns (embeddings float32 array, ids list)."""
    data = path.read_bytes()
    if len(data) < 8:
        raise ValueError(f"Truncated embeddings file ({len(data)} bytes): {path}")
    n_items, n_dims = struct.unpack_from("<II", data, 0)
    float_bytes = n_items * n_dims * 4
    if len(data) < 8 + float_bytes:
        raise ValueError(
            f"Truncated embeddings file: expected {8 + float_bytes} bytes, "
            f"got {len(data)}: {path}"
        )
    embeddings = np.frombuffer(data, dtype=np.float32, count=n_items * n_dims, offset=8)
    embeddings = embeddings.reshape(n_items, n_dims).copy()
    ids = json.loads(data[8 + float_bytes:].decode("utf-8"))
    return embeddings, ids


def generate_and_write(items: list[dict], base_path: Path, session=None, *, reuse: bool = True) -> Path:
    """Embed items and write to {base_path.stem}.embeddings. Returns the path written.

    Incremental by default: vectors for item ids already present in the existing
    sidecar are reused, and only new ids are embedded. Most hourly scrapes only
    change *bids* (not photos/text), so the embedding-relevant content of a lot is
    effectively immutable once listed — re-embedding every lot every run just to
    capture bid deltas was the bulk of the scrape's wall-clock. With reuse, an
    unchanged auction loads the model zero times and re-embeds nothing.

    Caveat: reuse is keyed on item id alone, so an edit to an *existing* lot's
    photo/description keeps its prior vector until the lot is re-listed. That is
    an acceptable trade for the speed-up; pass reuse=False to force a full
    regeneration (e.g. a one-off recompute after a model change).
    """
    emb_path = base_path.with_suffix(".embeddings")
    n = len(items)
    item_ids = [item["id"] for item in items]

    cached: dict[str, np.ndarray] = {}
    if reuse and emb_path.exists():
        try:
            old_emb, old_ids = read_embeddings(emb_path)
            cached = {old_ids[i]: old_emb[i] for i in range(len(old_ids))}
        except Exception:
            cached = {}  # unreadable/stale sidecar → regenerate from scratch

    to_embed = [i for i, iid in enumerate(item_ids) if iid not in cached]
    new_by_id: dict[str, np.ndarray] = {}
    if to_embed:
        n_reused = n - len(to_embed)
        print(
            f"\nGenerating CLIP embeddings: {len(to_embed)} new/changed of {n} items"
            + (f" ({n_reused} reused from cache)" if n_reused else "")
            + "..."
        )
        subset = [items[i] for i in to_embed]
        new_emb, new_ids = embed_items(subset, session)
        new_by_id = {new_ids[k]: new_emb[k] for k in range(len(new_ids))}
    else:
        print(f"\nReusing all {n} cached CLIP embeddings (none re-embedded).")

    # Determine vector width from whichever source we have.
    if new_by_id:
        n_dims = next(iter(new_by_id.values())).shape[0]
    elif cached:
        n_dims = next(iter(cached.values())).shape[0]
    else:
        n_dims = 0  # nothing to write (empty auction)

    embeddings = np.empty((n, n_dims), dtype=np.float32)
    for i, iid in enumerate(item_ids):
        vec = new_by_id.get(iid)
        if vec is None:
            vec = cached[iid]
        embeddings[i] = vec

    write_embeddings(embeddings, item_ids, emb_path)
    print(f"Wrote {n} embeddings → {emb_path}")
    return emb_path
