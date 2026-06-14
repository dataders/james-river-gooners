# Gooners MCP Server v1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local, read-only Python FastMCP server that lets Claude browse, search, and research the gooners auction read model (lots, enrichment, eBay/Cannon's comps, sold-price stats) and manage the user's favorites/ignored lists, by calling the live Supabase backend over HTTP.

**Architecture:** Three thin layers in a new top-level `mcp/` package. `client.py` owns all HTTP + auth (publishable key for public reads; lazy email/password login → JWT with refresh for gated reads/writes). `schemas.py` has pure row-shaping functions. `server.py` defines the FastMCP `@mcp.tool`s — thin wrappers that call the client, shape via schemas, and never raise (they return `{"error": ...}`). The MCP reads the **live deployed** Supabase project, so it does not depend on local `supabase/` source.

**Tech Stack:** Python 3.11+, [FastMCP](https://gofastmcp.com), `requests` (matches the scraper's HTTP convention), `python-dotenv` (load `.env.local`), `pytest` + `unittest.mock` (matches `scraper/test_supabase_*.py`). Run with `uv`.

**Spec:** `docs/superpowers/specs/2026-06-13-gooners-mcp-design.md`

---

## Backend reference (verified against `supabase/migrations/`)

Base URL `${SUPABASE_URL}`; all calls send header `apikey: ${PUBLISHABLE_KEY}`. Gated
calls also send `Authorization: Bearer ${access_token}`; public calls send
`Authorization: Bearer ${PUBLISHABLE_KEY}`.

| Need | HTTP | Auth | Key columns |
|---|---|---|---|
| Auth (login) | `POST /auth/v1/token?grant_type=password` body `{email,password}` | apikey only | returns `access_token`, `refresh_token`, `expires_in`, `user.id` |
| Auth (refresh) | `POST /auth/v1/token?grant_type=refresh_token` body `{refresh_token}` | apikey only | same |
| Active lots | `GET /rest/v1/public_active_lots` | public | `auction_safe_id, item_id, lot_number, title, description, current_bid, total_bids, unique_bidders, end_date, images, category, raw_category, detail_url, auction_id, auction_title, auction_end_date, scraped_at, source` |
| Enrichment | `GET /rest/v1/public_lot_enrichment` | public | `brand, model_or_sku, condition, product_url, confidence, model, image_url, …` keyed `(auction_safe_id,item_id)` |
| Semantic search | `POST /functions/v1/embed-query` body `{query, match_count}` | public (anon) | returns `{ids: ["<auction_safe_id>:<item_id>", …]}` ranked |
| eBay comps | `GET /rest/v1/public_auction_comps` | **JWT** | `title, price_value, price_currency, sold_date, sold_date_label, item_web_url, condition, match_confidence, source_query, …` |
| Cannon's comps | `GET /rest/v1/public_cannons_comps` | **JWT** | `rank, match_title, sold_price, sold_date, thumbnail_url, detail_url, similarity, …` |
| Category sold stats | `GET /rest/v1/public_category_sold_stats` | **JWT** | `category, sold_count, median_sold, min_sold, max_sold, last_sold_at` |
| Favorites | `GET/POST/DELETE /rest/v1/favorites` | **JWT** | `user_id, item_key` (`item_key = "<auction_safe_id>:<item_id>"`); insert needs explicit `user_id` |
| Ignored | `GET/POST/DELETE /rest/v1/ignored` | **JWT** | same shape as favorites |

PostgREST query notes: filter with `col=eq.VALUE`, `col=lte.VALUE`, `col=ilike.*term*`,
`or=(title.ilike.*x*,description.ilike.*x*)`, `limit=N`, `order=col.desc`,
`select=col1,col2`. The `in` filter: `auction_safe_id=in.(a,b,c)`. Insert upsert: header
`Prefer: resolution=merge-duplicates`. Delete by filter, e.g.
`DELETE /rest/v1/favorites?item_key=eq.<key>` (RLS scopes it to the JWT's user).

`detail_url` is the live source-platform URL for a lot — this is the "deep link to bid".

---

## File Structure

```
mcp/
  pyproject.toml              # deps + console script `gooners-mcp`
  README.md                   # setup + Claude registration snippet
  gooners_mcp/
    __init__.py               # version
    __main__.py               # entrypoint: build client, mcp.run()
    config.py                 # load_config() — env + .env.local
    client.py                 # GoonersClient: HTTP + auth (the only auth layer)
    schemas.py                # pure row-shaping functions
    server.py                 # build_server(client) -> FastMCP with @mcp.tool defs
  tests/
    test_config.py
    test_client.py
    test_schemas.py
    test_server.py
    test_live_smoke.py        # gated behind GOONERS_MCP_LIVE=1
```

Run/registration command (goes in the user's Claude MCP config):
```
uv run --directory <repo>/mcp gooners-mcp
```
`uv` resolves deps from `mcp/pyproject.toml`; `gooners-mcp` is the console script.

---

## Task 1: Scaffold the `mcp/` package

**Files:**
- Create: `mcp/pyproject.toml`
- Create: `mcp/gooners_mcp/__init__.py`
- Create: `mcp/tests/__init__.py`
- Test: `mcp/tests/test_import.py`

- [ ] **Step 1: Write the failing test**

```python
# mcp/tests/test_import.py
def test_package_imports_and_has_version():
    import gooners_mcp
    assert isinstance(gooners_mcp.__version__, str)
    assert gooners_mcp.__version__
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp && uv run --with pytest pytest tests/test_import.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'gooners_mcp'`

- [ ] **Step 3: Write minimal implementation**

```toml
# mcp/pyproject.toml
[project]
name = "gooners-mcp"
version = "0.1.0"
description = "MCP server for the gooners auction read model"
requires-python = ">=3.11"
dependencies = [
    "fastmcp>=2.0",
    "requests>=2.31",
    "python-dotenv>=1.0",
]

[project.optional-dependencies]
dev = ["pytest>=8.0"]

[project.scripts]
gooners-mcp = "gooners_mcp.__main__:main"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.pytest.ini_options]
pythonpath = ["."]
```

```python
# mcp/gooners_mcp/__init__.py
"""MCP server exposing the gooners auction read model to Claude."""

__version__ = "0.1.0"
```

```python
# mcp/tests/__init__.py
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp && uv run --with pytest pytest tests/test_import.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mcp/pyproject.toml mcp/gooners_mcp/__init__.py mcp/tests/__init__.py mcp/tests/test_import.py
git commit -m "feat(mcp): scaffold gooners-mcp package"
```

---

## Task 2: Config loader

**Files:**
- Create: `mcp/gooners_mcp/config.py`
- Test: `mcp/tests/test_config.py`

Reads, in precedence order, real env vars then `.env.local` at the repo root (Vite
convention, gitignored). Accepts `VITE_SUPABASE_URL` or `SUPABASE_URL`, and
`VITE_SUPABASE_PUBLISHABLE_KEY` or `SUPABASE_PUBLISHABLE_KEY`. Email/password are
optional (their absence means gated tools degrade gracefully).

- [ ] **Step 1: Write the failing test**

```python
# mcp/tests/test_config.py
from gooners_mcp.config import Config, load_config


def test_load_config_reads_env(monkeypatch):
    monkeypatch.setenv("VITE_SUPABASE_URL", "https://proj.supabase.co/")
    monkeypatch.setenv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_x")
    monkeypatch.setenv("GOONERS_EMAIL", "me@example.com")
    monkeypatch.setenv("GOONERS_PASSWORD", "pw")
    cfg = load_config(dotenv=False)
    assert cfg.url == "https://proj.supabase.co"   # trailing slash stripped
    assert cfg.publishable_key == "sb_publishable_x"
    assert cfg.email == "me@example.com"
    assert cfg.has_credentials is True


def test_load_config_without_credentials(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://proj.supabase.co")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_x")
    monkeypatch.delenv("GOONERS_EMAIL", raising=False)
    monkeypatch.delenv("GOONERS_PASSWORD", raising=False)
    monkeypatch.delenv("VITE_SUPABASE_URL", raising=False)
    monkeypatch.delenv("VITE_SUPABASE_PUBLISHABLE_KEY", raising=False)
    cfg = load_config(dotenv=False)
    assert cfg.has_credentials is False


def test_load_config_missing_url_raises(monkeypatch):
    for k in ("VITE_SUPABASE_URL", "SUPABASE_URL"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_x")
    import pytest
    with pytest.raises(ValueError, match="SUPABASE_URL"):
        load_config(dotenv=False)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp && uv run --with pytest pytest tests/test_config.py -v`
Expected: FAIL — `ModuleNotFoundError: gooners_mcp.config`

- [ ] **Step 3: Write minimal implementation**

```python
# mcp/gooners_mcp/config.py
"""Configuration for the gooners MCP server.

Reads Supabase connection info + optional user credentials from the environment,
falling back to a repo-root .env.local (the same file the Vite frontend uses).
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_DOTENV_PATH = _REPO_ROOT / ".env.local"


@dataclass(frozen=True)
class Config:
    url: str
    publishable_key: str
    email: str | None
    password: str | None

    @property
    def has_credentials(self) -> bool:
        return bool(self.email and self.password)


def _first_env(*names: str) -> str | None:
    for name in names:
        val = os.environ.get(name)
        if val:
            return val
    return None


def load_config(*, dotenv: bool = True) -> Config:
    if dotenv and _DOTENV_PATH.exists():
        from dotenv import load_dotenv

        load_dotenv(_DOTENV_PATH, override=False)

    url = _first_env("VITE_SUPABASE_URL", "SUPABASE_URL")
    key = _first_env("VITE_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_PUBLISHABLE_KEY")
    if not url:
        raise ValueError("SUPABASE_URL (or VITE_SUPABASE_URL) is required")
    if not key:
        raise ValueError("SUPABASE_PUBLISHABLE_KEY (or VITE_SUPABASE_PUBLISHABLE_KEY) is required")

    return Config(
        url=url.rstrip("/"),
        publishable_key=key,
        email=_first_env("GOONERS_EMAIL"),
        password=_first_env("GOONERS_PASSWORD"),
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp && uv run --with pytest --with python-dotenv pytest tests/test_config.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mcp/gooners_mcp/config.py mcp/tests/test_config.py
git commit -m "feat(mcp): config loader with .env.local fallback"
```

---

## Task 3: GoonersClient — public reads + auth

**Files:**
- Create: `mcp/gooners_mcp/client.py`
- Test: `mcp/tests/test_client.py`

`GoonersClient` is the only place that knows about HTTP, headers, and tokens. It
exposes: `get(path, params, *, auth=False)`, `post(path, json, *, auth=False, prefer=None)`,
`delete(path, params, *, auth=True)`, `edge_fn(name, payload)`, and the user-facing
`login()`. `AuthRequiredError` is raised internally when a gated call is made without
credentials; tools catch it and return a friendly message (Task 5).

- [ ] **Step 1: Write the failing tests**

```python
# mcp/tests/test_client.py
import json
from unittest.mock import MagicMock, patch

import pytest

from gooners_mcp.client import AuthRequiredError, GoonersClient


def _client(**kw):
    return GoonersClient(
        url="https://proj.supabase.co",
        publishable_key="pub_key",
        email=kw.get("email"),
        password=kw.get("password"),
    )


def _resp(status=200, payload=None):
    r = MagicMock()
    r.status_code = status
    r.json.return_value = payload if payload is not None else []
    r.ok = 200 <= status < 300
    r.text = json.dumps(payload) if payload is not None else ""
    return r


def test_public_get_sends_apikey_and_pub_bearer():
    c = _client()
    with patch("gooners_mcp.client.requests.request", return_value=_resp(200, [{"x": 1}])) as req:
        out = c.get("/rest/v1/public_active_lots", {"limit": "2"})
    assert out == [{"x": 1}]
    _, kwargs = req.call_args
    assert kwargs["headers"]["apikey"] == "pub_key"
    assert kwargs["headers"]["Authorization"] == "Bearer pub_key"
    assert kwargs["params"] == {"limit": "2"}


def test_gated_get_without_credentials_raises_auth_required():
    c = _client()  # no email/password
    with pytest.raises(AuthRequiredError):
        c.get("/rest/v1/public_auction_comps", {}, auth=True)


def test_login_then_gated_get_uses_access_token():
    c = _client(email="me@example.com", password="pw")
    login_payload = {"access_token": "AT", "refresh_token": "RT",
                     "expires_in": 3600, "user": {"id": "uid-1"}}
    with patch("gooners_mcp.client.requests.request") as req:
        req.side_effect = [_resp(200, login_payload), _resp(200, [{"ok": True}])]
        out = c.get("/rest/v1/public_auction_comps", {}, auth=True)
    assert out == [{"ok": True}]
    assert c.user_id == "uid-1"
    # second call (the gated GET) carried the user access token
    gated_kwargs = req.call_args_list[1].kwargs
    assert gated_kwargs["headers"]["Authorization"] == "Bearer AT"


def test_edge_fn_posts_to_functions_path():
    c = _client()
    with patch("gooners_mcp.client.requests.request",
               return_value=_resp(200, {"ids": ["a:1", "b:2"]})) as req:
        out = c.edge_fn("embed-query", {"query": "drill", "match_count": 50})
    assert out == {"ids": ["a:1", "b:2"]}
    args, kwargs = req.call_args
    assert args[0] == "POST"
    assert args[1].endswith("/functions/v1/embed-query")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mcp && uv run --with pytest --with requests pytest tests/test_client.py -v`
Expected: FAIL — `ModuleNotFoundError: gooners_mcp.client`

- [ ] **Step 3: Write minimal implementation**

```python
# mcp/gooners_mcp/client.py
"""HTTP + auth for the gooners Supabase backend.

The only layer that knows about URLs, headers, and tokens. Public reads use the
publishable key as the bearer; gated reads/writes lazily sign in with the user's
email/password (password grant) and use the resulting JWT, refreshing it as needed.
A future hosted/multi-user transport would change only how this client is
constructed (where the JWT comes from) — not the tools.
"""
from __future__ import annotations

import time
from typing import Any

import requests

DEFAULT_TIMEOUT = 30
_MAX_RETRIES = 3
_BACKOFF_BASE = 0.5


class AuthRequiredError(Exception):
    """Raised when a gated call is attempted without configured credentials."""


class GoonersClient:
    def __init__(self, url: str, publishable_key: str,
                 email: str | None = None, password: str | None = None):
        self._url = url.rstrip("/")
        self._key = publishable_key
        self._email = email
        self._password = password
        self._access_token: str | None = None
        self._refresh_token: str | None = None
        self._expires_at: float = 0.0
        self.user_id: str | None = None

    # ---- auth -----------------------------------------------------------
    @property
    def has_credentials(self) -> bool:
        return bool(self._email and self._password)

    def login(self) -> None:
        if not self.has_credentials:
            raise AuthRequiredError(
                "This needs a gooners login. Set GOONERS_EMAIL / "
                "GOONERS_PASSWORD in .env.local."
            )
        data = self._auth_request("password", {"email": self._email, "password": self._password})
        self._store_session(data)

    def _refresh(self) -> None:
        data = self._auth_request("refresh_token", {"refresh_token": self._refresh_token})
        self._store_session(data)

    def _store_session(self, data: dict) -> None:
        self._access_token = data["access_token"]
        self._refresh_token = data.get("refresh_token")
        self._expires_at = time.time() + int(data.get("expires_in", 3600)) - 60
        self.user_id = (data.get("user") or {}).get("id") or self.user_id

    def _auth_request(self, grant_type: str, body: dict) -> dict:
        url = f"{self._url}/auth/v1/token"
        resp = requests.request(
            "POST", url, params={"grant_type": grant_type},
            headers={"apikey": self._key, "Content-Type": "application/json"},
            json=body, timeout=DEFAULT_TIMEOUT,
        )
        if not resp.ok:
            raise AuthRequiredError(f"login failed ({resp.status_code}): {resp.text[:200]}")
        return resp.json()

    def _bearer(self, auth: bool) -> str:
        if not auth:
            return self._key
        if not self.has_credentials:
            raise AuthRequiredError(
                "This needs a gooners login. Set GOONERS_EMAIL / "
                "GOONERS_PASSWORD in .env.local."
            )
        if self._access_token is None:
            self.login()
        elif time.time() >= self._expires_at:
            self._refresh()
        return self._access_token  # type: ignore[return-value]

    # ---- transport ------------------------------------------------------
    def _headers(self, auth: bool, prefer: str | None = None) -> dict:
        h = {"apikey": self._key, "Authorization": f"Bearer {self._bearer(auth)}",
             "Content-Type": "application/json"}
        if prefer:
            h["Prefer"] = prefer
        return h

    def _send(self, method: str, url: str, *, auth: bool, params=None,
              json=None, prefer=None) -> requests.Response:
        last_exc = None
        for attempt in range(_MAX_RETRIES):
            try:
                resp = requests.request(
                    method, url, headers=self._headers(auth, prefer),
                    params=params, json=json, timeout=DEFAULT_TIMEOUT,
                )
            except requests.RequestException as exc:  # network error
                last_exc = exc
                time.sleep(_BACKOFF_BASE * (2 ** attempt))
                continue
            if resp.status_code >= 500:  # transient
                last_exc = RuntimeError(f"{resp.status_code}: {resp.text[:200]}")
                time.sleep(_BACKOFF_BASE * (2 ** attempt))
                continue
            return resp
        raise RuntimeError(f"backend unreachable after {_MAX_RETRIES} tries: {last_exc}")

    def get(self, path: str, params: dict | None = None, *, auth: bool = False) -> Any:
        resp = self._send("GET", f"{self._url}{path}", auth=auth, params=params)
        resp.raise_for_status()
        return resp.json()

    def post(self, path: str, json: Any, *, auth: bool = False, prefer: str | None = None) -> Any:
        resp = self._send("POST", f"{self._url}{path}", auth=auth, json=json, prefer=prefer)
        resp.raise_for_status()
        return resp.json() if resp.text else None

    def delete(self, path: str, params: dict, *, auth: bool = True) -> None:
        resp = self._send("DELETE", f"{self._url}{path}", auth=auth, params=params)
        resp.raise_for_status()

    def edge_fn(self, name: str, payload: dict, *, auth: bool = False) -> Any:
        resp = self._send("POST", f"{self._url}/functions/v1/{name}", auth=auth, json=payload)
        resp.raise_for_status()
        return resp.json()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mcp && uv run --with pytest --with requests pytest tests/test_client.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add mcp/gooners_mcp/client.py mcp/tests/test_client.py
git commit -m "feat(mcp): GoonersClient HTTP + lazy auth layer"
```

---

## Task 4: Schemas — pure row shaping

**Files:**
- Create: `mcp/gooners_mcp/schemas.py`
- Test: `mcp/tests/test_schemas.py`

Pure functions that turn raw PostgREST rows into compact, model-friendly dicts.
`shape_lot` merges an active-lot row with an optional enrichment row and always
includes `source_url` (from `detail_url`) and `composite_key`.

- [ ] **Step 1: Write the failing tests**

```python
# mcp/tests/test_schemas.py
from gooners_mcp.schemas import (
    composite_key, shape_lot, shape_ebay_comp, shape_cannons_comp,
    shape_category_stats,
)


def test_composite_key():
    assert composite_key("AbC", 207) == "AbC:207"


def test_shape_lot_merges_enrichment_and_adds_source_url():
    lot = {"auction_safe_id": "A", "item_id": "207", "title": "Lot - 207",
           "current_bid": 42.5, "detail_url": "https://x/207", "images": ["u1", "u2"],
           "category": "Tools", "end_date": "2026-06-20T00:00:00Z"}
    enrich = {"brand": "DeWalt", "model_or_sku": "DCD771", "condition": "used",
              "confidence": "high", "product_url": "https://dewalt/dcd771"}
    out = shape_lot(lot, enrich)
    assert out["composite_key"] == "A:207"
    assert out["source_url"] == "https://x/207"
    assert out["brand"] == "DeWalt"
    assert out["current_bid"] == 42.5
    assert out["image_count"] == 2


def test_shape_lot_without_enrichment():
    lot = {"auction_safe_id": "A", "item_id": "5", "title": "T", "detail_url": "u"}
    out = shape_lot(lot, None)
    assert out["brand"] is None
    assert out["composite_key"] == "A:5"


def test_shape_ebay_comp():
    row = {"title": "DeWalt drill", "price_value": 59.99, "price_currency": "USD",
           "sold_date_label": "Apr 2", "item_web_url": "https://ebay/x",
           "match_confidence": "high"}
    out = shape_ebay_comp(row)
    assert out["price"] == 59.99
    assert out["url"] == "https://ebay/x"


def test_shape_category_stats():
    row = {"category": "Tools", "sold_count": 12, "median_sold": 40,
           "min_sold": 5, "max_sold": 120, "last_sold_at": "2026-06-01T00:00:00Z"}
    out = shape_category_stats(row)
    assert out["median_sold"] == 40
    assert out["sold_count"] == 12
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mcp && uv run --with pytest pytest tests/test_schemas.py -v`
Expected: FAIL — `ModuleNotFoundError: gooners_mcp.schemas`

- [ ] **Step 3: Write minimal implementation**

```python
# mcp/gooners_mcp/schemas.py
"""Pure row-shaping helpers: raw PostgREST rows -> compact model-friendly dicts."""
from __future__ import annotations

from typing import Any


def composite_key(auction_safe_id: str, item_id: Any) -> str:
    return f"{auction_safe_id}:{item_id}"


def shape_lot(lot: dict, enrich: dict | None) -> dict:
    e = enrich or {}
    images = lot.get("images") or []
    return {
        "composite_key": composite_key(lot.get("auction_safe_id"), lot.get("item_id")),
        "auction_safe_id": lot.get("auction_safe_id"),
        "item_id": lot.get("item_id"),
        "lot_number": lot.get("lot_number"),
        "title": lot.get("title"),
        "description": lot.get("description"),
        "category": lot.get("category"),
        "current_bid": lot.get("current_bid"),
        "total_bids": lot.get("total_bids"),
        "unique_bidders": lot.get("unique_bidders"),
        "end_date": lot.get("end_date"),
        "auction_title": lot.get("auction_title"),
        "source": lot.get("source"),
        "source_url": lot.get("detail_url"),
        "image_count": len(images),
        "images": images[:3],
        # enrichment (None when the lot was not identified)
        "brand": e.get("brand"),
        "model_or_sku": e.get("model_or_sku"),
        "condition": e.get("condition"),
        "enrichment_confidence": e.get("confidence"),
        "product_url": e.get("product_url"),
    }


def shape_ebay_comp(row: dict) -> dict:
    return {
        "title": row.get("title"),
        "price": row.get("price_value"),
        "currency": row.get("price_currency"),
        "sold_date": row.get("sold_date_label") or row.get("sold_date"),
        "condition": row.get("condition"),
        "match_confidence": row.get("match_confidence"),
        "url": row.get("item_web_url"),
    }


def shape_cannons_comp(row: dict) -> dict:
    return {
        "rank": row.get("rank"),
        "title": row.get("match_title"),
        "sold_price": row.get("sold_price"),
        "sold_date": row.get("sold_date"),
        "similarity": row.get("similarity"),
        "url": row.get("detail_url"),
    }


def shape_category_stats(row: dict) -> dict:
    return {
        "category": row.get("category"),
        "sold_count": row.get("sold_count"),
        "median_sold": row.get("median_sold"),
        "min_sold": row.get("min_sold"),
        "max_sold": row.get("max_sold"),
        "last_sold_at": row.get("last_sold_at"),
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mcp && uv run --with pytest pytest tests/test_schemas.py -v`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add mcp/gooners_mcp/schemas.py mcp/tests/test_schemas.py
git commit -m "feat(mcp): pure row-shaping schemas"
```

---

## Task 5: Server + tools

**Files:**
- Create: `mcp/gooners_mcp/server.py`
- Test: `mcp/tests/test_server.py`

`build_server(client) -> FastMCP` registers all tools as closures over the client so
tests can inject a fake client. Every tool catches `AuthRequiredError` and any
exception and returns `{"error": "..."}` — tools never raise. Helper `_safe(fn)`
decorator centralizes this.

Tool semantics:
- `list_auctions()` → distinct auctions from `public_active_lots` via
  `select=auction_safe_id,auction_title,auction_end_date` then client-side dedupe
  (small list; YAGNI on a dedicated view).
- `search_lots(query="", semantic=False, category=None, max_price=None, auction_id=None, limit=50)`:
  - `semantic=True` and `query`: `edge_fn("embed-query", {"query": query, "match_count": limit})`
    → ids `"safe:item"`; split, group by safe id, hydrate via
    `auction_safe_id=in.(...)&item_id=in.(...)`; preserve embed-query rank order.
    **The `embed-query` Edge Function is verified to exist on the backend
    (`supabase/functions/embed-query/index.ts`, contract `{query,match_count}` →
    `{ids:[...]}`), but its *live deployment* can't be verified from code. So the
    semantic branch is wrapped in try/except: on ANY failure (404 not-deployed,
    network, HF rate-limit) it logs nothing to the model and transparently falls
    back to the keyword path with the same `query`. Semantic is best-effort; the
    tool always returns results, never an embed-query error.**
  - keyword/filter (also the fallback): `or=(title.ilike.*q*,description.ilike.*q*)`
    (+ `category=eq.`, `current_bid=lte.`, `auction_id=eq.`), `limit`. The raw
    `query` is sanitized first (`_sanitize_ilike`) to strip PostgREST reserved
    chars (`,`, `(`, `)`) that would break the `or=(...)` grouping syntax.
  - In both cases, fetch enrichment for the result keys and merge via `shape_lot`.
- `get_lot(auction_safe_id, item_id)` → one lot + its enrichment.
- `get_comps(auction_safe_id, item_id)` (auth) → `{ebay: [...], cannons: [...]}`.
- `get_category_sold_stats(category)` (auth) → one stats row (or `{}`).
- `list_favorites()` / `add_favorite(auction_safe_id, item_id)` /
  `remove_favorite(auction_safe_id, item_id)` (auth); add posts
  `{"user_id": client.user_id, "item_key": key}` with `Prefer: resolution=merge-duplicates`.
- `list_ignored` / `add_ignored` / `remove_ignored` — identical against `ignored`.

- [ ] **Step 1: Write the failing tests**

```python
# mcp/tests/test_server.py
from unittest.mock import MagicMock

from gooners_mcp.client import AuthRequiredError
from gooners_mcp.server import build_server


def _tools(client):
    # FastMCP stores tools; we call the underlying fns via the registry.
    server = build_server(client)
    return {t.name: t.fn for t in server._tool_manager.list_tools()}


def test_get_lot_merges_enrichment():
    client = MagicMock()
    client.get.side_effect = [
        [{"auction_safe_id": "A", "item_id": "5", "title": "T", "detail_url": "u"}],  # lot
        [{"brand": "DeWalt", "confidence": "high"}],                                  # enrichment
    ]
    tools = _tools(client)
    out = tools["get_lot"]("A", "5")
    assert out["brand"] == "DeWalt"
    assert out["source_url"] == "u"


def test_get_lot_not_found():
    client = MagicMock()
    client.get.return_value = []
    tools = _tools(client)
    out = tools["get_lot"]("A", "999")
    assert "error" in out


def test_get_comps_requires_auth_returns_friendly_error():
    client = MagicMock()
    client.get.side_effect = AuthRequiredError("login needed")
    tools = _tools(client)
    out = tools["get_comps"]("A", "5")
    assert "error" in out
    assert "login" in out["error"].lower()


def test_search_lots_semantic_uses_embed_query():
    client = MagicMock()
    client.edge_fn.return_value = {"ids": ["A:5", "A:6"]}
    client.get.side_effect = [
        [{"auction_safe_id": "A", "item_id": "5", "title": "drill", "detail_url": "u5"},
         {"auction_safe_id": "A", "item_id": "6", "title": "driver", "detail_url": "u6"}],  # lots
        [],  # enrichment
    ]
    tools = _tools(client)
    out = tools["search_lots"]("drill", semantic=True, limit=10)
    client.edge_fn.assert_called_once()
    assert {r["item_id"] for r in out["results"]} == {"5", "6"}


def test_search_lots_semantic_falls_back_to_keyword_when_embed_query_unavailable():
    client = MagicMock()
    client.edge_fn.side_effect = RuntimeError("404 not deployed")
    client.get.side_effect = [
        [{"auction_safe_id": "A", "item_id": "7", "title": "drill", "detail_url": "u7"}],  # keyword lots
        [],  # enrichment
    ]
    tools = _tools(client)
    out = tools["search_lots"]("drill", semantic=True, limit=10)
    # fell back to keyword GET against public_active_lots; no error surfaced
    assert "error" not in out
    assert out["results"][0]["item_id"] == "7"
    assert out.get("semantic_fallback") is True


def test_sanitize_ilike_strips_reserved_chars():
    from gooners_mcp.server import _sanitize_ilike
    assert _sanitize_ilike("a,b(c)") == "abc"


def test_add_favorite_posts_user_id_and_key():
    client = MagicMock()
    client.user_id = "uid-1"
    tools = _tools(client)
    out = tools["add_favorite"]("A", "5")
    client.post.assert_called_once()
    args, kwargs = client.post.call_args
    assert args[0] == "/rest/v1/favorites"
    assert args[1] == {"user_id": "uid-1", "item_key": "A:5"}
    assert out["ok"] is True
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mcp && uv run --with pytest --with fastmcp pytest tests/test_server.py -v`
Expected: FAIL — `ModuleNotFoundError: gooners_mcp.server`

> NOTE on the FastMCP tool-registry access (`server._tool_manager.list_tools()` and
> `.fn`): FastMCP internals shift between versions. If these attributes differ in the
> installed version, adjust the `_tools` helper to whatever the installed FastMCP
> exposes (e.g. `server.get_tools()` returning objects with a callable). The
> production code does not depend on these internals — only the test helper does.

- [ ] **Step 3: Write minimal implementation**

```python
# mcp/gooners_mcp/server.py
"""FastMCP tool definitions for the gooners read model.

Tools are thin closures over a GoonersClient. They never raise: every tool returns
either its result dict/list or {"error": "..."}.
"""
from __future__ import annotations

import functools
from typing import Any, Callable

from fastmcp import FastMCP

from .client import AuthRequiredError, GoonersClient
from .schemas import (
    composite_key, shape_cannons_comp, shape_category_stats,
    shape_ebay_comp, shape_lot,
)


def _safe(fn: Callable) -> Callable:
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except AuthRequiredError as exc:
            return {"error": str(exc)}
        except Exception as exc:  # noqa: BLE001 - tools must never raise
            return {"error": f"{type(exc).__name__}: {exc}"}
    return wrapper


def _sanitize_ilike(query: str) -> str:
    """Strip PostgREST reserved chars that would break the or=(...) filter syntax."""
    for ch in (",", "(", ")"):
        query = query.replace(ch, "")
    return query.strip()


def _enrichment_for(client: GoonersClient, keys: list[tuple[str, str]]) -> dict[str, dict]:
    """Fetch enrichment rows for (safe_id, item_id) pairs -> {composite_key: row}."""
    if not keys:
        return {}
    safe_ids = sorted({k[0] for k in keys})
    item_ids = sorted({k[1] for k in keys})
    rows = client.get("/rest/v1/public_lot_enrichment", {
        "auction_safe_id": f"in.({','.join(safe_ids)})",
        "item_id": f"in.({','.join(item_ids)})",
    })
    return {composite_key(r["auction_safe_id"], r["item_id"]): r for r in rows}


def build_server(client: GoonersClient) -> FastMCP:
    mcp = FastMCP("gooners")

    @mcp.tool
    @_safe
    def list_auctions() -> dict:
        """List the currently active auctions (id, title, end date)."""
        rows = client.get("/rest/v1/public_active_lots", {
            "select": "auction_safe_id,auction_title,auction_end_date",
        })
        seen: dict[str, dict] = {}
        for r in rows:
            sid = r.get("auction_safe_id")
            if sid and sid not in seen:
                seen[sid] = {"auction_safe_id": sid, "title": r.get("auction_title"),
                             "end_date": r.get("auction_end_date")}
        return {"auctions": list(seen.values())}

    def _keyword_lots(query, category, max_price, auction_id, limit) -> list[dict]:
        params: dict[str, Any] = {"limit": str(limit), "order": "current_bid.desc"}
        q = _sanitize_ilike(query)
        if q:
            params["or"] = f"(title.ilike.*{q}*,description.ilike.*{q}*)"
        if category:
            params["category"] = f"eq.{category}"
        if max_price is not None:
            params["current_bid"] = f"lte.{max_price}"
        if auction_id:
            params["auction_id"] = f"eq.{auction_id}"
        return client.get("/rest/v1/public_active_lots", params)

    def _semantic_lots(query, limit) -> list[dict]:
        res = client.edge_fn("embed-query", {"query": query, "match_count": limit})
        ids = [tuple(i.split(":", 1)) for i in res.get("ids", []) if ":" in i][:limit]
        if not ids:
            return []
        safe_ids = sorted({a for a, _ in ids})
        item_ids = sorted({b for _, b in ids})
        lots = client.get("/rest/v1/public_active_lots", {
            "auction_safe_id": f"in.({','.join(safe_ids)})",
            "item_id": f"in.({','.join(item_ids)})",
        })
        by_key = {composite_key(l["auction_safe_id"], l["item_id"]): l for l in lots}
        return [by_key[f"{a}:{b}"] for a, b in ids if f"{a}:{b}" in by_key]  # preserve rank

    @mcp.tool
    @_safe
    def search_lots(query: str = "", semantic: bool = False, category: str | None = None,
                    max_price: float | None = None, auction_id: str | None = None,
                    limit: int = 50) -> dict:
        """Search active auction lots. Keyword/filter by default; set semantic=True
        for meaning-based search. Filters: category, max_price, auction_id."""
        fallback = False
        if semantic and query:
            try:
                ordered = _semantic_lots(query, limit)
            except Exception:  # noqa: BLE001 - embed-query may be undeployed/rate-limited
                fallback = True
                ordered = _keyword_lots(query, category, max_price, auction_id, limit)
        else:
            ordered = _keyword_lots(query, category, max_price, auction_id, limit)

        keys = [(l["auction_safe_id"], str(l["item_id"])) for l in ordered]
        enrich = _enrichment_for(client, keys)
        out = {"results": [shape_lot(l, enrich.get(composite_key(l["auction_safe_id"], l["item_id"])))
                           for l in ordered]}
        if fallback:
            out["semantic_fallback"] = True
        return out

    @mcp.tool
    @_safe
    def get_lot(auction_safe_id: str, item_id: str) -> dict:
        """Full detail for one lot, including resale enrichment when identified."""
        lots = client.get("/rest/v1/public_active_lots", {
            "auction_safe_id": f"eq.{auction_safe_id}", "item_id": f"eq.{item_id}", "limit": "1",
        })
        if not lots:
            return {"error": f"No active lot {auction_safe_id}:{item_id}"}
        enrich = client.get("/rest/v1/public_lot_enrichment", {
            "auction_safe_id": f"eq.{auction_safe_id}", "item_id": f"eq.{item_id}", "limit": "1",
        })
        return shape_lot(lots[0], enrich[0] if enrich else None)

    @mcp.tool
    @_safe
    def get_comps(auction_safe_id: str, item_id: str) -> dict:
        """eBay sold comps + Cannon's similar-lot comps for resale research (login required)."""
        ebay = client.get("/rest/v1/public_auction_comps", {
            "auction_safe_id": f"eq.{auction_safe_id}", "item_id": f"eq.{item_id}",
        }, auth=True)
        cannons = client.get("/rest/v1/public_cannons_comps", {
            "auction_safe_id": f"eq.{auction_safe_id}", "item_id": f"eq.{item_id}",
            "order": "rank.asc",
        }, auth=True)
        return {"ebay": [shape_ebay_comp(r) for r in ebay],
                "cannons": [shape_cannons_comp(r) for r in cannons]}

    @mcp.tool
    @_safe
    def get_category_sold_stats(category: str) -> dict:
        """Median/range/recency of past sold prices for a category (login required)."""
        rows = client.get("/rest/v1/public_category_sold_stats", {
            "category": f"eq.{category}", "limit": "1",
        }, auth=True)
        return shape_category_stats(rows[0]) if rows else {}

    # ---- favorites / ignored (login required) ---------------------------
    def _list_keys(table: str) -> dict:
        rows = client.get(f"/rest/v1/{table}", {"select": "item_key,created_at",
                                                 "order": "created_at.desc"}, auth=True)
        return {table: [r["item_key"] for r in rows]}

    def _add_key(table: str, auction_safe_id: str, item_id: str) -> dict:
        if not client.user_id:
            client.login()
        client.post(f"/rest/v1/{table}",
                    {"user_id": client.user_id, "item_key": composite_key(auction_safe_id, item_id)},
                    auth=True, prefer="resolution=merge-duplicates")
        return {"ok": True}

    def _remove_key(table: str, auction_safe_id: str, item_id: str) -> dict:
        client.delete(f"/rest/v1/{table}",
                      {"item_key": f"eq.{composite_key(auction_safe_id, item_id)}"}, auth=True)
        return {"ok": True}

    @mcp.tool
    @_safe
    def list_favorites() -> dict:
        """List the item keys the user has favorited (login required)."""
        return _list_keys("favorites")

    @mcp.tool
    @_safe
    def add_favorite(auction_safe_id: str, item_id: str) -> dict:
        """Favorite a lot (login required)."""
        return _add_key("favorites", auction_safe_id, item_id)

    @mcp.tool
    @_safe
    def remove_favorite(auction_safe_id: str, item_id: str) -> dict:
        """Remove a favorite (login required)."""
        return _remove_key("favorites", auction_safe_id, item_id)

    @mcp.tool
    @_safe
    def list_ignored() -> dict:
        """List the item keys the user marked 'not interested' (login required)."""
        return _list_keys("ignored")

    @mcp.tool
    @_safe
    def add_ignored(auction_safe_id: str, item_id: str) -> dict:
        """Mark a lot 'not interested' (login required)."""
        return _add_key("ignored", auction_safe_id, item_id)

    @mcp.tool
    @_safe
    def remove_ignored(auction_safe_id: str, item_id: str) -> dict:
        """Remove a lot from the 'not interested' list (login required)."""
        return _remove_key("ignored", auction_safe_id, item_id)

    return mcp
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mcp && uv run --with pytest --with fastmcp --with requests pytest tests/test_server.py -v`
Expected: PASS (7 tests). If the `_tools` helper fails on FastMCP internals, adapt it per the NOTE in Step 2, then re-run.

- [ ] **Step 5: Commit**

```bash
git add mcp/gooners_mcp/server.py mcp/tests/test_server.py
git commit -m "feat(mcp): tools for browse/search/comps/favorites/ignored"
```

---

## Task 6: Entrypoint

**Files:**
- Create: `mcp/gooners_mcp/__main__.py`
- Test: `mcp/tests/test_main.py`

- [ ] **Step 1: Write the failing test**

```python
# mcp/tests/test_main.py
from unittest.mock import MagicMock, patch

import gooners_mcp.__main__ as main_mod


def test_main_builds_server_and_runs():
    fake_cfg = MagicMock(url="https://p.supabase.co", publishable_key="k",
                         email=None, password=None)
    fake_server = MagicMock()
    with patch.object(main_mod, "load_config", return_value=fake_cfg), \
         patch.object(main_mod, "build_server", return_value=fake_server) as build:
        main_mod.main()
    build.assert_called_once()
    fake_server.run.assert_called_once()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp && uv run --with pytest --with fastmcp --with requests pytest tests/test_main.py -v`
Expected: FAIL — `AttributeError`/`ModuleNotFoundError`

- [ ] **Step 3: Write minimal implementation**

```python
# mcp/gooners_mcp/__main__.py
"""Entrypoint: build the client from config and run the FastMCP server over stdio."""
from __future__ import annotations

from .client import GoonersClient
from .config import load_config
from .server import build_server


def main() -> None:
    cfg = load_config()
    client = GoonersClient(
        url=cfg.url, publishable_key=cfg.publishable_key,
        email=cfg.email, password=cfg.password,
    )
    server = build_server(client)
    server.run()  # stdio transport by default


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp && uv run --with pytest --with fastmcp --with requests pytest tests/test_main.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mcp/gooners_mcp/__main__.py mcp/tests/test_main.py
git commit -m "feat(mcp): stdio entrypoint"
```

---

## Task 7: Optional live smoke test

**Files:**
- Create: `mcp/tests/test_live_smoke.py`

Gated behind `GOONERS_MCP_LIVE=1` so it never runs in CI/normal `pytest`. Hits the
real backend read-only to confirm the deployed endpoints (incl. `embed-query`) and
the public views still match this code.

- [ ] **Step 1: Write the test**

```python
# mcp/tests/test_live_smoke.py
import os

import pytest

from gooners_mcp.client import GoonersClient
from gooners_mcp.config import load_config
from gooners_mcp.server import build_server

pytestmark = pytest.mark.skipif(
    os.environ.get("GOONERS_MCP_LIVE") != "1",
    reason="live smoke test; set GOONERS_MCP_LIVE=1 to run",
)


def _tools():
    cfg = load_config()
    client = GoonersClient(cfg.url, cfg.publishable_key, cfg.email, cfg.password)
    server = build_server(client)
    return {t.name: t.fn for t in server._tool_manager.list_tools()}


def test_list_auctions_returns_some():
    out = _tools()["list_auctions"]()
    assert "auctions" in out and len(out["auctions"]) > 0


def test_keyword_search_returns_results():
    out = _tools()["search_lots"](query="table", limit=5)
    assert "results" in out


def test_semantic_search_returns_results():
    out = _tools()["search_lots"](query="cordless drill", semantic=True, limit=5)
    assert "results" in out  # confirms embed-query is deployed
```

- [ ] **Step 2: Verify it is skipped by default**

Run: `cd mcp && uv run --with pytest --with fastmcp --with requests pytest tests/test_live_smoke.py -v`
Expected: 3 skipped

- [ ] **Step 3: (Manual, requires .env.local) run it live**

Run: `cd mcp && GOONERS_MCP_LIVE=1 uv run --with pytest --with fastmcp --with requests --with python-dotenv pytest tests/test_live_smoke.py -v`
Expected: PASS (confirms deployed backend matches). Record the result; if
`test_semantic_search` fails, `embed-query` is not deployed — note it and have
`search_lots` fall back to keyword (already the default when `semantic=False`).

- [ ] **Step 4: Commit**

```bash
git add mcp/tests/test_live_smoke.py
git commit -m "test(mcp): optional live smoke test (GOONERS_MCP_LIVE)"
```

---

## Task 8: README, env example, registration

**Files:**
- Create: `mcp/README.md`
- Modify: `.env.example` (append the two new optional vars)

- [ ] **Step 1: Write `mcp/README.md`**

Document: what it is, the v1 tool list, required/optional env vars, the full run
command, and the Claude registration snippet:

```json
{
  "mcpServers": {
    "gooners": {
      "command": "uv",
      "args": ["run", "--directory", "/ABSOLUTE/PATH/TO/repo/mcp", "gooners-mcp"]
    }
  }
}
```

Note: public tools (`list_auctions`, `search_lots`, `get_lot`) work with no login;
`get_comps`, `get_category_sold_stats`, and favorites/ignored need `GOONERS_EMAIL` /
`GOONERS_PASSWORD` in `.env.local`.

- [ ] **Step 2: Append to `.env.example`**

```
# gooners MCP server (local) — optional user login for comps + favorites.
# Public browse/search work without these. Local only; never commit real values.
GOONERS_EMAIL=you@example.com
GOONERS_PASSWORD=your-gooners-password
```

- [ ] **Step 3: Full test-suite green**

Run: `cd mcp && uv run --with pytest --with fastmcp --with requests --with python-dotenv pytest -v`
Expected: all PASS (live smoke skipped).

- [ ] **Step 4: Commit**

```bash
git add mcp/README.md .env.example
git commit -m "docs(mcp): README + env example + registration snippet"
```

---

## Done criteria

- `cd mcp && uv run --with pytest --with fastmcp --with requests --with python-dotenv pytest -v` → all green (live smoke skipped).
- The server starts: `uv run --directory mcp gooners-mcp` (stdio; Ctrl-C to stop).
- Registered in Claude, the 11 tools appear and `list_auctions` / `search_lots` work
  without login; comps + favorites work after setting credentials in `.env.local`.
- Manual live smoke (`GOONERS_MCP_LIVE=1`) passed at least once, confirming the
  deployed backend (including `embed-query`) matches.

## Notes for the implementer

- **The `mcp/` package is fully additive** — it touches no existing files except
  appending to `.env.example`. No conflicts with the rest of the repo.
- **`requests`, not async** — matches the scraper convention and keeps auth/refresh
  simple; FastMCP runs sync tool fns fine.
- **Tools never raise** — the `_safe` decorator guarantees a structured `{"error":…}`,
  so a backend hiccup degrades gracefully instead of crashing the MCP session.
- **FastMCP version drift** — only the *test* helper reaches into FastMCP internals
  to enumerate tools; if the installed version differs, adapt that helper (see the
  NOTE in Task 5 Step 2). Production code uses only `FastMCP(...)`, `@mcp.tool`, and
  `server.run()`.
