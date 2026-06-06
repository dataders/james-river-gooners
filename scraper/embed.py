"""Nomic Embed (text + vision) generation for auction items.

Activated by setting GOONERS_EMBEDDINGS=1 before running scrape.py or
rescrape_all.py.  Requires extra deps (not in the base scraper):

    uv run --with sentence-transformers --with pillow ...

The first run downloads ~550 MB each for the text and vision model weights,
cached by huggingface in ~/.cache/huggingface.

Output binary format (.embeddings file):
  [4 bytes uint32 LE]  n_items
  [4 bytes uint32 LE]  n_dims  (768 for Nomic Embed v1.5)
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

Embedding strategy per item:
  text_vec  = normalize(text_model.encode("search_document: " + title + " " + description))
  img_vecs  = [normalize(vision_model.encode(img)) for img in images[:GOONERS_MAX_IMAGES]]
  item_vec  = normalize(text_vec + mean(img_vecs))   # text-only if no images

Both models share the same 768-dim space, so combining them is pure averaging
math — no projection layer, no learned fusion weights.
"""

import io
import json
import os
import struct
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import requests as _req


_text_model = None
_vision_model = None

_MAX_IMAGES = int(os.environ.get("GOONERS_MAX_IMAGES", "3"))


def _get_text_model():
    global _text_model
    if _text_model is None:
        from sentence_transformers import SentenceTransformer
        print("Loading Nomic text model (first run: ~550 MB download)...")
        _text_model = SentenceTransformer("nomic-ai/nomic-embed-text-v1.5", trust_remote_code=True)
        print("Nomic text model ready.")
    return _text_model


def _get_vision_model():
    global _vision_model
    if _vision_model is None:
        from sentence_transformers import SentenceTransformer
        print("Loading Nomic vision model (first run: ~550 MB download)...")
        _vision_model = SentenceTransformer("nomic-ai/nomic-embed-vision-v1.5")
        print("Nomic vision model ready.")
    return _vision_model


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
    """Return (embeddings, ids) — float32 (n, 768) L2-normalised, plus item IDs.

    Strategy:
      1. Batch-encode all texts in one model call (much faster than per-item).
      2. Fetch up to GOONERS_MAX_IMAGES images per item concurrently (I/O bound).
      3. Batch-encode all fetched images in one model call.
      4. Per item: mean-pool its image vectors, add to text vector, re-normalise.

    Text-only lots (0 images) use the text vector as-is. Both models project
    into the same 768-dim space so combining them requires no learned fusion.
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

    # 1. Batch-encode all texts with the search_document task prefix
    texts = [
        "search_document: " + (f"{item.get('title', '')} {item.get('description', '')}".strip() or ".")
        for item in items
    ]
    print(f"  Encoding {n} texts...")
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
        print(f"  Fetching {len(url_tasks)} images concurrently...")

        def _fetch_task(task):
            i, j, url = task
            return i, j, _fetch_image(url)

        with ThreadPoolExecutor(max_workers=8) as pool:
            for i, j, img in pool.map(_fetch_task, url_tasks):
                if img is not None:
                    pil_by_key[(i, j)] = img

    # 3. Batch-encode all successfully fetched images
    item_img_embs: list[list[np.ndarray]] = [[] for _ in range(n)]
    img_encode_tasks = sorted(pil_by_key.items())   # sorted by (i, j) for determinism
    if img_encode_tasks:
        keys, imgs = zip(*img_encode_tasks)
        print(f"  Encoding {len(imgs)} images...")
        encoded = vision_model.encode(
            list(imgs),
            convert_to_numpy=True,
            normalize_embeddings=True,
            batch_size=32,
            show_progress_bar=False,
        )
        for (item_idx, _), emb in zip(keys, encoded):
            item_img_embs[item_idx].append(emb)

    # 4. Fuse text + mean(images) and re-normalise; n_dims from model output
    n_dims = text_embs.shape[1]
    embeddings = np.empty((n, n_dims), dtype=np.float32)
    for i in range(n):
        t = text_embs[i]           # already L2-normalised
        img_list = item_img_embs[i]
        if img_list:
            img_mean = np.mean(img_list, axis=0)
            combined = t + img_mean
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


def generate_and_write(items: list[dict], base_path: Path, session=None) -> Path:
    """Embed items and write to {base_path.stem}.embeddings. Returns the path written."""
    print(f"\nGenerating Nomic embeddings for {len(items)} items...")
    embeddings, ids = embed_items(items, session)
    emb_path = base_path.with_suffix(".embeddings")
    write_embeddings(embeddings, ids, emb_path)
    print(f"Wrote {len(items)} embeddings → {emb_path}")
    return emb_path
