"""CLIP embedding generation for auction items.

Activated by setting GOONERS_EMBEDDINGS=1 before running scrape.py or
rescrape_all.py.  Requires extra deps (not in the base scraper):

    uv run --with sentence-transformers --with pillow ...

The first run downloads ~350 MB of CLIP model weights which are then cached
by huggingface in ~/.cache/huggingface.

Output binary format (.embeddings file):
  [4 bytes uint32 LE]  n_items
  [4 bytes uint32 LE]  n_dims  (512 for clip-ViT-B-32)
  [n_items × n_dims × 4 bytes float32]  L2-normalised embeddings, row-major
  [remaining bytes]  UTF-8 JSON array of item ID strings (same order as rows)

This layout lets the browser slice the float32 block directly with a
TypedArray and parse the IDs with JSON.parse.
"""

import io
import json
import struct
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


def _fetch_image(url: str, session=None):
    from PIL import Image
    try:
        resp = (session or _req).get(url, timeout=15)
        resp.raise_for_status()
        return Image.open(io.BytesIO(resp.content)).convert("RGB")
    except Exception:
        return None


def embed_items(items: list[dict], session=None) -> tuple[np.ndarray, list[str]]:
    """Return (embeddings, ids) — float32 (n, 512) L2-normalised, plus item IDs."""
    model = _get_model()
    n = len(items)
    ids = [item["id"] for item in items]
    embeddings = np.zeros((n, 512), dtype=np.float32)

    for i, item in enumerate(items):
        # Text: title + description
        text = f"{item.get('title', '')} {item.get('description', '')}".strip()
        text_emb = model.encode(text, convert_to_numpy=True, normalize_embeddings=True)

        # Image: first URL only
        img_emb = None
        images = item.get("images") or []
        if isinstance(images, str):
            # Already JSON-stringified (Parquet path) — shouldn't happen here, but guard
            try:
                images = json.loads(images)
            except Exception:
                images = []
        first_url = images[0] if images else None
        if first_url:
            img = _fetch_image(first_url, session)
            if img is not None:
                img_emb = model.encode(img, convert_to_numpy=True, normalize_embeddings=True)

        # Average text + image then re-normalise; fall back to text-only
        combined = (text_emb + img_emb) * 0.5 if img_emb is not None else text_emb
        norm = np.linalg.norm(combined)
        embeddings[i] = combined / norm if norm > 0 else combined

        if (i + 1) % 50 == 0 or (i + 1) == n:
            print(f"  Embedded {i + 1}/{n} items")

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
    n_items, n_dims = struct.unpack_from("<II", data, 0)
    float_bytes = n_items * n_dims * 4
    embeddings = np.frombuffer(data, dtype=np.float32, count=n_items * n_dims, offset=8)
    embeddings = embeddings.reshape(n_items, n_dims).copy()
    ids = json.loads(data[8 + float_bytes:].decode("utf-8"))
    return embeddings, ids


def generate_and_write(items: list[dict], base_path: Path, session=None) -> Path:
    """Embed items and write to {base_path.stem}.embeddings. Returns the path written."""
    print(f"\nGenerating CLIP embeddings for {len(items)} items...")
    embeddings, ids = embed_items(items, session)
    emb_path = base_path.with_suffix(".embeddings")
    write_embeddings(embeddings, ids, emb_path)
    print(f"Wrote {len(items)} embeddings → {emb_path}")
    return emb_path
