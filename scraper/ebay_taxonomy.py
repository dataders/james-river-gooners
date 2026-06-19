#!/usr/bin/env python
# /// script
# requires-python = ">=3.11"
# dependencies = ["requests"]
# ///
"""
eBay Taxonomy API — Phase 2 increment 4 (RFC #290 D4).

Fetches the full eBay US category tree via the Taxonomy API
(``getCategoryTree``, tree id 0, marketplace ``EBAY_US``) using an OAuth 2.0
client-credentials token from ``EBAY_CLIENT_ID`` + ``EBAY_CLIENT_SECRET``.
Flattens the ~16 k nodes into rows and upserts them to the Supabase
``ebay_categories`` table (migration ``0034``).

Also provides the leaf-matching helpers consumed by ``ebay_comps.fetch_direct``
when ``GOONERS_EBAY_LEAF_CATEGORIES=1``:

- ``load_leaf_candidates_by_group`` — one Supabase read per distinct category
  group (not per lot), returning the set of eBay leaf categories that fall
  within that group's L1 subtree.
- ``best_leaf_from_candidates`` — pure scoring function: word-overlap between
  a leaf's ``full_path`` and the lot's enrichment ``productType``; returns the
  tightest confident match or ``""`` to keep the L1 fallback.

The L1 YAML in ``ebay_category_ids.yml`` is unchanged and is always the
fallback when no confident leaf is found, so leaf scoping only ever improves
precision, never reduces recall.

CLI::

    uv run --with requests ebay_taxonomy.py           # fetch tree + upsert
    uv run --with requests ebay_taxonomy.py --dump    # fetch + print JSON
"""

import base64
import json
import re
import secrets
import sys

import requests
from config import EbayCompsSettings as _CfgEbay

_EBAY_TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token"
_EBAY_TREE_URL = "https://api.ebay.com/commerce/taxonomy/v1/category_tree/0"
_EBAY_SCOPE = "https://api.ebay.com/oauth/api_scope"

EBAY_CATEGORIES_TABLE = "ebay_categories"

_READ_TIMEOUT = (5, 30)
_LEAF_QUERY_LIMIT = 500

# Maps Cannon's internal category group to the eBay L1 category *name* as it
# appears as the first segment of ``full_path`` in the ``ebay_categories``
# table. Used to scope leaf candidate queries to the right subtree.
# Cross-reference with the id map in ebay_category_ids.yml.
_GROUP_TO_L1_NAME: dict[str, str] = {
    "Art": "Art",
    "China & Glass": "Pottery & Glass",
    "Collectibles": "Collectibles",
    "Coins & Currency": "Coins & Paper Money",
    "Jewelry & Watches": "Jewelry & Watches",
    "Silver & Metal": "Antiques",
    "Furniture": "Home & Garden",
    "Home & Kitchen": "Home & Garden",
    "Lawn & Garden": "Home & Garden",
    "Fashion": "Clothing, Shoes & Accessories",
    "Toys & Games": "Toys & Hobbies",
    "Books & Media": "Books & Magazines",
    "Sporting Goods": "Sporting Goods",
    "Electronics": "Consumer Electronics",
    "Industrial & Equipment": "Business & Industrial",
    "Stamps": "Stamps",
}


# ── OAuth ─────────────────────────────────────────────────────────────────────


def mint_token(client_id: str, client_secret: str) -> str:
    """Exchange eBay Production client credentials for an OAuth access token."""
    credentials = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    response = requests.post(
        _EBAY_TOKEN_URL,
        headers={
            "Authorization": f"Basic {credentials}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        data={
            "grant_type": "client_credentials",
            "scope": _EBAY_SCOPE,
        },
        timeout=30,
    )
    response.raise_for_status()
    return response.json()["access_token"]


# ── Tree fetch + flatten ──────────────────────────────────────────────────────


def fetch_category_tree(token: str) -> list[dict]:
    """Fetch the eBay US category tree and return a flat list of category dicts.

    Each dict has: ``category_id``, ``name``, ``full_path``, ``parent_id``,
    ``level``, ``leaf``.  ``full_path`` is the " > "-joined ancestor chain from
    the L1 root to this node, so a search on ``full_path LIKE 'Pottery & Glass%'``
    returns the entire Pottery & Glass subtree.
    """
    response = requests.get(
        _EBAY_TREE_URL,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
        },
        params={"marketplace_id": "EBAY_US"},
        timeout=60,
    )
    response.raise_for_status()
    tree = response.json()

    rows: list[dict] = []

    def _walk(
        node: dict, parent_id: str | None, ancestors: list[str], level: int
    ) -> None:
        cat = node.get("category") or {}
        cat_id = str(cat.get("categoryId") or "").strip()
        name = str(cat.get("categoryName") or "").strip()
        if not cat_id or not name:
            return
        children = node.get("childCategoryTreeNodes") or []
        full_path = " > ".join(ancestors + [name])
        rows.append(
            {
                "category_id": cat_id,
                "name": name,
                "full_path": full_path,
                "parent_id": parent_id,
                "level": level,
                "leaf": len(children) == 0,
            }
        )
        for child in children:
            _walk(child, cat_id, ancestors + [name], level + 1)

    root = tree.get("rootCategoryNode") or {}
    for child in root.get("childCategoryTreeNodes") or []:
        _walk(child, None, [], 0)

    return rows


# ── Supabase write ────────────────────────────────────────────────────────────


def upsert_categories(
    rows: list[dict],
    url: str | None = None,
    key: str | None = None,
    batch_size: int = 1000,
) -> int:
    """Upsert category rows to Supabase ``ebay_categories``. Returns rows written."""
    from supabase_comps import _request_with_retry, resolve_credentials

    url, key = resolve_credentials(url, key)
    if not url:
        raise RuntimeError("SUPABASE_URL is required to upsert eBay categories")
    if not key:
        raise RuntimeError("SUPABASE_SECRET_KEY is required to upsert eBay categories")

    endpoint = f"{url.rstrip('/')}/rest/v1/{EBAY_CATEGORIES_TABLE}"
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates",
        "User-Agent": "james-river-gooners/ebay-taxonomy",
    }
    written = 0
    for i in range(0, len(rows), batch_size):
        batch = rows[i : i + batch_size]
        _request_with_retry(
            lambda b=batch: requests.post(
                endpoint, headers=headers, json=b, timeout=(10, 60)
            ),
            describe=f"upsert ebay_categories batch {i // batch_size + 1}",
        )
        written += len(batch)
    return written


# ── Leaf lookup ───────────────────────────────────────────────────────────────


def leaf_categories_enabled() -> bool:
    """Whether to use Supabase leaf-level categoryIds (opt-in, default off)."""
    return _CfgEbay().leaf_categories


def _score_path(full_path: str, product_type: str) -> float:
    """Word-overlap score between an eBay ``full_path`` and enrichment ``productType``.

    Counts how many space-split tokens from ``product_type`` (length > 3)
    appear case-insensitively in ``full_path``, normalised to [0, 1].
    """
    if not product_type:
        return 0.0
    path_lower = full_path.lower()
    tokens = [t for t in re.split(r"\W+", product_type.lower()) if len(t) > 3]
    if not tokens:
        return 0.0
    return sum(1 for t in tokens if t in path_lower) / len(tokens)


def _fetch_leaf_candidates(group: str, url: str, key: str) -> list[dict]:
    """Query Supabase for leaf categories in the given Cannon's group's L1 subtree.

    Returns a list of ``{category_id, full_path}`` dicts, or ``[]`` when the
    group has no L1 mapping, Supabase is unreachable, or the table is empty.
    """
    l1_name = _GROUP_TO_L1_NAME.get(group, "")
    if not l1_name:
        return []

    endpoint = f"{url.rstrip('/')}/rest/v1/{EBAY_CATEGORIES_TABLE}"
    params = {
        "select": "category_id,full_path",
        "leaf": "eq.true",
        "full_path": f"like.{l1_name}%",
        "limit": str(_LEAF_QUERY_LIMIT),
    }
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
    }
    try:
        resp = requests.get(
            endpoint, headers=headers, params=params, timeout=_READ_TIMEOUT
        )
        if resp.status_code != 200:
            return []
        return resp.json() or []
    except Exception:
        return []


def best_leaf_from_candidates(candidates: list[dict], product_type: str) -> str:
    """Return the tightest-matching leaf ``category_id`` from pre-loaded candidates.

    Scores each candidate's ``full_path`` against the lot's enrichment
    ``productType`` by word overlap.  Returns ``""`` when there are no
    candidates, no ``product_type`` to match against, or no candidate scores
    above the minimum threshold (at least one token must hit).
    """
    if not candidates or not product_type:
        return ""
    tokens = [t for t in re.split(r"\W+", product_type.lower()) if len(t) > 3]
    if not tokens:
        return ""
    min_score = 1.0 / len(tokens)
    best_id = ""
    best_score = 0.0
    for row in candidates:
        score = _score_path(row["full_path"], product_type)
        if score > best_score:
            best_score = score
            best_id = row["category_id"]
    return best_id if best_score >= min_score else ""


def load_leaf_candidates_by_group(
    groups: set[str],
    url: str | None = None,
    key: str | None = None,
) -> dict[str, list[dict]]:
    """Batch-fetch leaf candidates for each distinct category group.

    One Supabase query per group (not per lot), so a run with 200 lots across
    10 category groups costs 10 reads instead of 200.  Returns an empty dict
    when Supabase isn't configured.
    """
    from supabase_comps import resolve_credentials

    url, key = resolve_credentials(url, key)
    if not url or not key:
        return {}

    result: dict[str, list[dict]] = {}
    for group in groups:
        result[group] = _fetch_leaf_candidates(group, url, key)
    return result


# ── CLI ───────────────────────────────────────────────────────────────────────


def _cli() -> None:
    import argparse

    parser = argparse.ArgumentParser(
        description="Fetch the eBay US category tree and upsert to Supabase."
    )
    parser.add_argument(
        "--dump",
        action="store_true",
        help="Print flattened tree as JSON to stdout instead of writing to Supabase.",
    )
    args = parser.parse_args()

    client_id = secrets.ebay_client_id() or ""
    client_secret = secrets.ebay_client_secret() or ""
    if not client_id or not client_secret:
        print(
            "Error: EBAY_CLIENT_ID and EBAY_CLIENT_SECRET must be set.",
            file=sys.stderr,
        )
        sys.exit(1)

    print("Minting eBay OAuth token …", file=sys.stderr)
    token = mint_token(client_id, client_secret)

    print("Fetching category tree …", file=sys.stderr)
    rows = fetch_category_tree(token)
    leaf_count = sum(1 for r in rows if r["leaf"])
    print(f"Fetched {len(rows)} categories ({leaf_count} leaves).", file=sys.stderr)

    if args.dump:
        print(json.dumps(rows, indent=2))
        return

    written = upsert_categories(rows)
    print(f"Upserted {written} rows to Supabase {EBAY_CATEGORIES_TABLE}.")


if __name__ == "__main__":
    _cli()
