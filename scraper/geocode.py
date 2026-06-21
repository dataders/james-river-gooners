# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "pyyaml",
#     "requests",
# ]
# ///
"""City/state → (lat, lng) geocoding for auction locations (distance filter).

Every auction must resolve to coordinates so the browser's Facebook-Marketplace-
style distance filter can work. Resolution is **cache-first**: a committed
``geocode_cache.yml`` maps normalized ``"city, st"`` keys to ``{lat, lng}``. A
cache miss raises :class:`GeocodeError`, which the scraper's shared write path
(``persist._stamp_auction_metadata``) lets propagate so the discovery workflow
**fails loudly** rather than storing a null location.

An optional online lookup (Nominatim/OpenStreetMap, opt-in via
``GOONERS_GEOCODE_ONLINE=1``) fills new entries during local dev and appends them
to the cache file for committing. It is deliberately **off in CI** so the gate
stays deterministic and can never be made flaky by a geocoder outage. Nominatim
resolves *place centroids* (city level) — the US Census geocoder only does street
addresses, so it is unsuitable here. The cache file is the source of truth; the
API is a convenience for self-healing the cache.
"""

import os
from pathlib import Path

import yaml

CACHE_FILE = Path(__file__).resolve().parent / "geocode_cache.yml"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "james-river-gooners-geocode/1.0 (https://gooners.anders.omg.lol)"


class GeocodeError(Exception):
    """Raised when a location can't be resolved to coordinates."""


def normalize_key(city: str, state: str) -> str:
    """Normalized cache key: lower-cased, trimmed ``"city, st"``."""
    return f"{(city or '').strip().lower()}, {(state or '').strip().lower()}"


def parse_location(location: str) -> tuple[str, str]:
    """Parse a ``"City, ST"`` string into ``(city, state)``. Raises if malformed."""
    parts = [p.strip() for p in (location or "").split(",")]
    if len(parts) >= 2 and parts[0] and parts[1]:
        return parts[0], parts[1]
    raise GeocodeError(f"cannot parse location {location!r} as 'City, ST'")


def _load_cache(path: Path) -> dict:
    if not path.exists():
        return {}
    return yaml.safe_load(path.read_text()) or {}


def _append_to_cache(path: Path, key: str, lat: float, lng: float) -> None:
    cache = _load_cache(path)
    cache[key] = {"lat": lat, "lng": lng}
    # Sorted keys keep the committed cache diff-friendly.
    path.write_text(yaml.safe_dump(cache, sort_keys=True, default_flow_style=False))


def _online_enabled(online: bool | None) -> bool:
    if online is not None:
        return online
    return os.environ.get("GOONERS_GEOCODE_ONLINE") == "1"


def _nominatim_lookup(city: str, state: str, session=None) -> tuple[float, float]:
    """Resolve a city centroid via Nominatim. Raises GeocodeError on no match."""
    import requests

    sess = session or requests
    resp = sess.get(
        NOMINATIM_URL,
        params={
            "city": city,
            "state": state,
            "country": "USA",
            "format": "json",
            "limit": 1,
        },
        headers={"User-Agent": USER_AGENT},
        timeout=20,
    )
    resp.raise_for_status()
    data = resp.json()
    if not data:
        raise GeocodeError(f"Nominatim found no match for {city!r}, {state!r}")
    return round(float(data[0]["lat"]), 6), round(float(data[0]["lon"]), 6)


def resolve(
    city: str,
    state: str,
    *,
    online: bool | None = None,
    cache_path: Path | None = None,
    session=None,
) -> tuple[float, float]:
    """Resolve ``(city, state)`` to ``(lat, lng)``, cache-first.

    Raises :class:`GeocodeError` on a missing city/state, or on a cache miss when
    online resolution is disabled (the default in CI). When online resolution is
    enabled (``GOONERS_GEOCODE_ONLINE=1`` or ``online=True``) a cache miss is
    resolved via Nominatim and appended to the cache file.
    """
    path = cache_path or CACHE_FILE
    if not city or not state:
        raise GeocodeError(
            f"missing city/state for geocode (city={city!r}, state={state!r})"
        )
    key = normalize_key(city, state)
    cache = _load_cache(path)
    if key in cache:
        entry = cache[key]
        return float(entry["lat"]), float(entry["lng"])
    if _online_enabled(online):
        lat, lng = _nominatim_lookup(city, state, session=session)
        _append_to_cache(path, key, lat, lng)
        return lat, lng
    raise GeocodeError(
        f"no geocode for {key!r} — add it to {path.name} "
        "(or set GOONERS_GEOCODE_ONLINE=1 to resolve it online)"
    )


if __name__ == "__main__":
    # Convenience CLI: populate the cache for one or more "City, ST" args using
    # the online resolver (rate-limited). Used to seed/extend geocode_cache.yml.
    import sys
    import time

    if len(sys.argv) < 2:
        print('Usage: GOONERS_GEOCODE_ONLINE=1 uv run geocode.py "City, ST" ...')
        raise SystemExit(1)
    for i, loc in enumerate(sys.argv[1:]):
        c, s = parse_location(loc)
        if i:
            time.sleep(1.1)  # Nominatim courtesy rate limit
        lat, lng = resolve(c, s, online=True)
        print(f"{c}, {s}: {lat}, {lng}")
