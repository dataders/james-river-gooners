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
