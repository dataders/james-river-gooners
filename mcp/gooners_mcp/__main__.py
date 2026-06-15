"""Entrypoint: build the client from config and run the FastMCP server over stdio."""

from __future__ import annotations

from .client import GoonersClient
from .config import load_config
from .server import build_server


def main() -> None:
    cfg = load_config()
    client = GoonersClient(
        url=cfg.url,
        publishable_key=cfg.publishable_key,
        email=cfg.email,
        password=cfg.password,
    )
    server = build_server(client)
    server.run()  # stdio transport by default


if __name__ == "__main__":
    main()
