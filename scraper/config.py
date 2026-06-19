"""
Centralized, typed configuration for all GOONERS_* scraper knobs.

Each feature group has its own Settings class (Pydantic Settings v2) that reads
GOONERS_* environment variables with consistent type coercion and validation.

**Why this exists:** over time each new feature added its own
``os.environ.get("GOONERS_X", default)`` call with its own type parsing and boolean
logic.  That produced a concrete bug: ``GOONERS_ENRICHMENT=true`` was silently OFF
(``== "1"`` check) while ``GOONERS_MOTHERDUCK_SNAPSHOTS=true`` was ON
(``.lower() in {"1","true","yes","on"}`` check).  Pydantic's ``bool`` parsing treats
``1/true/yes/on`` (any case) as ``True`` consistently everywhere.

Usage:
    from config import EnrichmentSettings, CannonsCompsSettings

    cfg = EnrichmentSettings()
    print(cfg.enabled)          # bool — "1"/"true"/"yes"/"on" all work
    print(cfg.workers)          # int, validated ge=1

    # Argparse default (CLI > env > default):
    cfg = CannonsCompsSettings()
    parser.add_argument("--top-k", type=int, default=cfg.top_k)

Each getter constructs a fresh object on every call — ``patch.dict(os.environ, ...)``
works in tests without any cache-busting.

Discovery:
    python config.py            # from scraper/
    python -m config            # from repo root
"""

from __future__ import annotations

import sys
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class _Base(BaseSettings):
    """Shared config for all settings classes.

    ``populate_by_name=True`` lets tests construct instances by field name
    (``EnrichmentSettings(enabled=True)``) while production reads from env vars
    via the ``validation_alias``."""

    model_config = SettingsConfigDict(
        extra="ignore",
        frozen=True,
        populate_by_name=True,
    )


# ── Feature groups ─────────────────────────────────────────────────────────────


class EnrichmentSettings(_Base):
    """LLM enrichment via Claude Haiku (scraper/enrich.py)."""

    enabled: bool = Field(
        default=False,
        validation_alias="GOONERS_ENRICHMENT",
        description=(
            "Enable Claude Haiku lot enrichment. "
            "Also requires ANTHROPIC_API_KEY to be set."
        ),
    )
    text_only: bool = Field(
        default=False,
        validation_alias="GOONERS_ENRICHMENT_TEXT_ONLY",
        description=(
            "Enrich from text only — drop photos. "
            "Much cheaper for fields derivable from text alone."
        ),
    )
    model: str = Field(
        default="claude-haiku-4-5",
        validation_alias="GOONERS_ENRICHMENT_MODEL",
        description="LLM model ID used for enrichment.",
    )
    workers: int = Field(
        default=8,
        validation_alias="GOONERS_ENRICHMENT_WORKERS",
        ge=1,
        le=256,
        description="Concurrent workers for the synchronous (live-scrape) enrichment path.",
    )
    rpm: float = Field(
        default=45.0,
        validation_alias="GOONERS_ENRICHMENT_RPM",
        gt=0,
        description=(
            "Sync-path rate limit (requests/min). "
            "Keeps the org under the URL-fetch ceiling; set to 0 to disable throttling."
        ),
    )
    max_images: int = Field(
        default=3,
        validation_alias="GOONERS_MAX_IMAGES",
        ge=1,
        le=10,
        description=(
            "Photos per lot sent to the model. "
            "Also governs Nomic embedding image count (embed_nomic.py)."
        ),
    )
    batch_inline_size: int = Field(
        default=2_000,
        validation_alias="GOONERS_ENRICHMENT_BATCH_INLINE_SIZE",
        ge=1,
        description=(
            "Max requests per inline-image batch chunk. "
            "Inline batches are smaller than URL batches due to base64 payload size."
        ),
    )
    batch_max_bytes: int = Field(
        default=180 * 1024 * 1024,
        validation_alias="GOONERS_ENRICHMENT_BATCH_MAX_BYTES",
        ge=1,
        description="Byte budget per inline batch (Anthropic hard limit is 256 MB).",
    )
    batch_max_requests: int = Field(
        default=10_000,
        validation_alias="GOONERS_ENRICHMENT_BATCH_SIZE",
        ge=1,
        description="Max requests per Message Batches API submission.",
    )


class EbayCompsSettings(_Base):
    """eBay sold-comps fetch (scraper/ebay_comps.py)."""

    limit: int = Field(
        default=200,
        validation_alias="GOONERS_EBAY_COMPS_LIMIT",
        ge=0,
        description="Max lots to fetch comps for per run (0 = unlimited).",
    )
    monthly_budget: int = Field(
        default=5_000,
        validation_alias="GOONERS_EBAY_COMPS_MONTHLY_BUDGET",
        ge=0,
        description="Shared monthly SoldComps request ceiling across all runs (0 = off).",
    )
    max_queries: int = Field(
        default=0,
        validation_alias="GOONERS_EBAY_COMPS_MAX_QUERIES",
        ge=0,
        description="Hard cap on SoldComps requests this run (0 = unlimited; monthly budget still applies).",
    )
    skip_categories: str = Field(
        default="",
        validation_alias="GOONERS_EBAY_COMPS_SKIP_CATEGORIES",
        description="Comma-separated broad category groups to skip (e.g. 'Collectibles,Jewelry & Watches').",
    )
    soldcomps_min_remaining: int = Field(
        default=0,
        validation_alias="GOONERS_SOLDCOMPS_MIN_REMAINING",
        ge=0,
        description=(
            "Stop the run when the SoldComps provider's X-Usage-* remaining quota "
            "hits this floor. Authoritative meter, independent of the comp ledger."
        ),
    )
    apify_max_listings: int = Field(
        default=10,
        validation_alias="GOONERS_APIFY_MAX_LISTINGS",
        ge=1,
        description="Results to request from Apify per search query (higher = more cost).",
    )
    apify_concurrency: int = Field(
        default=25,
        validation_alias="GOONERS_APIFY_CONCURRENCY",
        ge=1,
        description="Max parallel Apify actor runs.",
    )
    corpus_first: bool = Field(
        default=False,
        validation_alias="GOONERS_CORPUS_FIRST",
        description=(
            "Reuse the sold-listings corpus when it already covers a lot, "
            "skipping the paid SoldComps API call."
        ),
    )
    sold_listings_corpus: bool = Field(
        default=False,
        validation_alias="GOONERS_SOLD_LISTINGS_CORPUS",
        description="Capture the full eBay candidate set into the sold_listings corpus.",
    )
    leaf_categories: bool = Field(
        default=False,
        validation_alias="GOONERS_EBAY_LEAF_CATEGORIES",
        description="Scope queries to eBay leaf categories instead of L1 top-level.",
    )
    browser_fallback: bool = Field(
        default=True,
        validation_alias="GOONERS_EBAY_BROWSER_FALLBACK",
        description="Fall back to browser-based eBay scraping when the HTML parse fails.",
    )
    user_agent: str = Field(
        default="",
        validation_alias="GOONERS_EBAY_USER_AGENT",
        description=(
            "Custom User-Agent for eBay HTML requests and agent-browser sessions. "
            "Empty = rotate randomly (HTML path) / use the code default (agent-browser)."
        ),
    )
    agent_browser_command: str = Field(
        default="",
        validation_alias="GOONERS_AGENT_BROWSER_COMMAND",
        description=(
            "Shell command to invoke the agent browser. "
            "Empty = use the built-in default (npm exec --yes agent-browser@0.27.0 --)."
        ),
    )


class EmbeddingSettings(_Base):
    """Nomic text+vision embeddings (scraper/embed_nomic.py)."""

    enabled: bool = Field(
        default=False,
        validation_alias="GOONERS_NOMIC_EMBEDDINGS",
        description=(
            "Enable Nomic text+vision embedding generation → Supabase pgvector. "
            "Also requires SUPABASE_SECRET_KEY."
        ),
    )
    device: str = Field(
        default="",
        validation_alias="GOONERS_EMBED_DEVICE",
        description=(
            "Torch device override for Nomic embedding (e.g. 'cpu', 'cuda', 'mps'). "
            "Empty = auto-detect (CUDA → MPS → CPU)."
        ),
    )
    max_images: int = Field(
        default=3,
        validation_alias="GOONERS_MAX_IMAGES",
        ge=1,
        le=10,
        description="Same as EnrichmentSettings.max_images — one shared knob keeps them in lockstep.",
    )
    upsert_batch: int = Field(
        default=100,
        validation_alias="GOONERS_NOMIC_UPSERT_BATCH",
        ge=1,
        description=(
            "Max embedding rows per Supabase upsert batch. "
            "Smaller batches keep each request under the PostgREST row cap on busy instances."
        ),
    )


class CannonsCompsSettings(_Base):
    """Cannon's pgvector comps (scraper/cannons_comps.py)."""

    top_k: int = Field(
        default=3,
        validation_alias="GOONERS_CANNONS_COMPS_TOP_K",
        ge=1,
        le=20,
        description="Max archived-lot matches to keep per active item.",
    )
    min_sim: float = Field(
        default=0.80,
        validation_alias="GOONERS_CANNONS_COMPS_MIN_SIM",
        ge=0.0,
        le=1.0,
        description="Minimum Nomic cosine similarity for a Cannon's comp to be kept.",
    )


class SupabaseSettings(_Base):
    """Supabase client tuning (scraper/supabase_comps.py, scraper/supabase_lots.py)."""

    read_timeout: int = Field(
        default=90,
        validation_alias="GOONERS_SUPABASE_READ_TIMEOUT",
        ge=1,
        description=(
            "PostgREST read timeout in seconds. "
            "Generous because the comp_item_freshness view can take >30s on a cold Micro instance."
        ),
    )
    page_size: int = Field(
        default=1_000,
        validation_alias="GOONERS_SUPABASE_PAGE",
        ge=1,
        le=1_000,
        description=(
            "Rows per paginated PostgREST read. "
            "Must not exceed the server's max-rows cap (1000 by default) or short pages "
            "will be mistaken for the last page."
        ),
    )


class WarehouseSettings(_Base):
    """Warehouse / MotherDuck snapshot (scraper/warehouse.py, scraper/motherduck.py)."""

    warehouse: Literal["motherduck", "supabase", "none"] = Field(
        default="motherduck",
        validation_alias="GOONERS_WAREHOUSE",
        description="Warehouse backend for lot snapshots.",
    )
    motherduck_snapshots: bool = Field(
        default=False,
        validation_alias="GOONERS_MOTHERDUCK_SNAPSHOTS",
        description="Snapshot listing data to MotherDuck after each scrape.",
    )


# ── Discovery CLI ──────────────────────────────────────────────────────────────

_SETTINGS_CLASSES: list[tuple[str, type[_Base]]] = [
    ("EnrichmentSettings", EnrichmentSettings),
    ("EbayCompsSettings", EbayCompsSettings),
    ("EmbeddingSettings", EmbeddingSettings),
    ("CannonsCompsSettings", CannonsCompsSettings),
    ("SupabaseSettings", SupabaseSettings),
    ("WarehouseSettings", WarehouseSettings),
]


def _type_name(annotation) -> str:
    """Human-readable type string for a field annotation."""
    if hasattr(annotation, "__name__"):
        return annotation.__name__
    return str(annotation).replace("typing.", "")


def _constraints(field_info) -> str:
    """Extract ge/le/gt/lt constraint strings from FieldInfo metadata."""
    parts = []
    for m in field_info.metadata:
        for attr in ("ge", "gt", "le", "lt"):
            val = getattr(m, attr, None)
            if val is not None:
                parts.append(f"{attr}={val}")
    return f"  [{', '.join(parts)}]" if parts else ""


def describe(out=None) -> None:
    """Print all settings groups, their env var names, types, defaults, and descriptions."""
    if out is None:
        out = sys.stdout
    for class_name, cls in _SETTINGS_CLASSES:
        out.write(f"\n{class_name}\n")
        out.write("=" * len(class_name) + "\n")
        for field_name, field_info in cls.model_fields.items():
            alias = field_info.validation_alias or field_name.upper()
            annotation = field_info.annotation
            default = field_info.default
            type_str = _type_name(annotation)
            constraint_str = _constraints(field_info)
            description_str = field_info.description or ""

            out.write(f"  {field_name:<26} {type_str:<8}  default={default!r:<20}  env: {alias}{constraint_str}\n")
            if description_str:
                out.write(f"    {description_str}\n")
        out.write("\n")


if __name__ == "__main__":
    describe()
