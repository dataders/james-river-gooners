"""Hermetic unit tests for the supabase_app dlt pipeline helpers.

No network / dlt / MotherDuck: dlt is imported lazily inside run(), and the
PostgREST pagination is exercised against a fake requests session.
"""

import pipeline


def test_app_tables_are_the_public_app_tables():
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
    for forbidden in ("cannon_credentials", "nomic_embeddings"):
        assert forbidden not in pipeline.APP_TABLES


def test_motherduck_credentials(monkeypatch):
    monkeypatch.delenv("MOTHERDUCK_TOKEN", raising=False)
    assert pipeline._motherduck_credentials() is None
    monkeypatch.setenv("MOTHERDUCK_TOKEN", "tok123")
    assert pipeline._motherduck_credentials() == "md:my_db?motherduck_token=tok123"


def test_rest_config(monkeypatch):
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SECRET_KEY", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    assert pipeline._rest_config() is None

    monkeypatch.setenv("SUPABASE_URL", "https://ref.supabase.co/")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "sb_secret_x")
    config = pipeline._rest_config()
    assert config is not None
    base, key = config
    assert base == "https://ref.supabase.co/rest/v1"  # trailing slash trimmed
    assert key == "sb_secret_x"

    # SERVICE_ROLE_KEY is an accepted fallback.
    monkeypatch.delenv("SUPABASE_SECRET_KEY", raising=False)
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "svc")
    config = pipeline._rest_config()
    assert config is not None
    _, key = config
    assert key == "svc"


class _FakeResp:
    def __init__(self, rows, total, start):
        self._rows = rows
        end = start + len(rows) - 1 if rows else start
        self.headers = {"content-range": f"{start}-{end}/{total}"}

    def raise_for_status(self):
        pass

    def json(self):
        return self._rows


class _FakeSession:
    """Returns `total` rows in pages, recording each requested Range header."""

    def __init__(self, total):
        self._all = [{"id": i} for i in range(total)]
        self._total = total
        self.ranges = []

    def get(self, url, headers=None, params=None, timeout=None):
        assert headers is not None
        rng = headers["Range"]
        self.ranges.append(rng)
        start, end = (int(x) for x in rng.split("-"))
        page = self._all[start : end + 1]
        return _FakeResp(page, self._total, start)


def test_iter_rows_paginates_to_total():
    sess = _FakeSession(total=2500)
    rows = list(
        pipeline.iter_rows("http://b", "k", "lots", page_size=1000, session=sess)
    )
    assert [r["id"] for r in rows] == list(range(2500))
    # 1000 + 1000 + 500 → three requests, offsets advancing by the page size.
    assert sess.ranges == ["0-999", "1000-1999", "2000-2999"]


def test_iter_rows_empty_table():
    sess = _FakeSession(total=0)
    assert (
        list(
            pipeline.iter_rows(
                "http://b", "k", "favorites", page_size=1000, session=sess
            )
        )
        == []
    )


def test_run_requires_motherduck_token(monkeypatch):
    monkeypatch.delenv("MOTHERDUCK_TOKEN", raising=False)
    monkeypatch.setenv("SUPABASE_URL", "https://x.supabase.co")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "k")
    try:
        pipeline.run()
        raise AssertionError("expected RuntimeError")
    except RuntimeError as exc:
        assert "MOTHERDUCK_TOKEN" in str(exc)


def test_run_requires_rest_config(monkeypatch):
    monkeypatch.setenv("MOTHERDUCK_TOKEN", "tok")
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SECRET_KEY", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    try:
        pipeline.run()
        raise AssertionError("expected RuntimeError")
    except RuntimeError as exc:
        assert "SUPABASE_URL" in str(exc)


def test_parse_args_table_subset():
    assert pipeline.parse_args([]).tables is None
    assert pipeline.parse_args(["--tables", "lots", "users"]).tables == [
        "lots",
        "users",
    ]
