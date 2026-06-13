"""Hermetic unit tests for the supabase_app dlt pipeline helpers.

No network / dlt / MotherDuck: dlt is imported lazily inside run(), so these
cover the env resolution, the table list, and arg parsing in isolation.
"""

import pipeline


def test_app_tables_are_the_public_app_tables():
    # The dbt `gooners` source reads exactly these from my_db.supabase_app.
    assert pipeline.APP_TABLES == [
        "lots",
        "sold_lots",
        "lot_enrichment",
        "ebay_comp_snapshots",
        "cannons_comp_snapshots",
        "favorites",
        "ignored",
        "users",
    ]
    # No private / non-RLS-public tables leak into the copy.
    for forbidden in ("cannon_credentials", "nomic_embeddings"):
        assert forbidden not in pipeline.APP_TABLES


def test_motherduck_credentials(monkeypatch):
    monkeypatch.delenv("MOTHERDUCK_TOKEN", raising=False)
    assert pipeline._motherduck_credentials() is None

    monkeypatch.setenv("MOTHERDUCK_TOKEN", "tok123")
    assert pipeline._motherduck_credentials() == "md:my_db?motherduck_token=tok123"


def test_postgres_url_prefers_ipv4_pooler(monkeypatch):
    monkeypatch.delenv("SUPABASE_POSTGRES_URL_IP4", raising=False)
    monkeypatch.delenv("SUPABASE_POSTGRES_URL", raising=False)
    assert pipeline._postgres_url() is None

    monkeypatch.setenv("SUPABASE_POSTGRES_URL", "postgresql://direct/db")
    assert pipeline._postgres_url() == "postgresql://direct/db"

    # The IPv4 session-pooler URL wins when both are set (CI / IPv4-only runners).
    monkeypatch.setenv("SUPABASE_POSTGRES_URL_IP4", "postgresql://pooler/db")
    assert pipeline._postgres_url() == "postgresql://pooler/db"


def test_run_requires_motherduck_token(monkeypatch):
    monkeypatch.delenv("MOTHERDUCK_TOKEN", raising=False)
    monkeypatch.setenv("SUPABASE_POSTGRES_URL", "postgresql://x/y")
    try:
        pipeline.run()
        assert False, "expected RuntimeError"
    except RuntimeError as exc:
        assert "MOTHERDUCK_TOKEN" in str(exc)


def test_run_requires_postgres_url(monkeypatch):
    monkeypatch.setenv("MOTHERDUCK_TOKEN", "tok")
    monkeypatch.delenv("SUPABASE_POSTGRES_URL_IP4", raising=False)
    monkeypatch.delenv("SUPABASE_POSTGRES_URL", raising=False)
    try:
        pipeline.run()
        assert False, "expected RuntimeError"
    except RuntimeError as exc:
        assert "SUPABASE_POSTGRES_URL" in str(exc)


def test_parse_args_table_subset():
    assert pipeline.parse_args([]).tables is None
    assert pipeline.parse_args(["--tables", "lots", "users"]).tables == ["lots", "users"]
