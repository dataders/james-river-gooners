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
        try:
            data = self._auth_request("refresh_token", {"refresh_token": self._refresh_token})
        except AuthRequiredError:
            self.login()   # refresh token expired/revoked; fall back to password grant
            return
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
