from gooners_mcp.config import load_config


def test_load_config_reads_env(monkeypatch):
    monkeypatch.setenv("VITE_SUPABASE_URL", "https://proj.supabase.co/")
    monkeypatch.setenv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_x")
    monkeypatch.setenv("GOONERS_EMAIL", "me@example.com")
    monkeypatch.setenv("GOONERS_PASSWORD", "pw")
    cfg = load_config(dotenv=False)
    assert cfg.url == "https://proj.supabase.co"  # trailing slash stripped
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
