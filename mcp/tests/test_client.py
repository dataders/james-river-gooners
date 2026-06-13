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


def test_expired_access_token_triggers_refresh():
    c = _client(email="me@example.com", password="pw")
    login_payload = {"access_token": "AT1", "refresh_token": "RT1",
                     "expires_in": 3600, "user": {"id": "uid-1"}}
    refresh_payload = {"access_token": "AT2", "refresh_token": "RT2",
                       "expires_in": 3600, "user": {"id": "uid-1"}}
    with patch("gooners_mcp.client.requests.request") as req:
        req.side_effect = [_resp(200, login_payload), _resp(200, [{"first": True}])]
        c.get("/rest/v1/public_auction_comps", {}, auth=True)  # initial login + call
        # force the stored token to look expired, then call again
        c._expires_at = 0
        req.side_effect = [_resp(200, refresh_payload), _resp(200, [{"second": True}])]
        out = c.get("/rest/v1/public_auction_comps", {}, auth=True)
    assert out == [{"second": True}]
    # the second gated call carried the refreshed access token (last call in the list)
    assert req.call_args_list[-1].kwargs["headers"]["Authorization"] == "Bearer AT2"


def test_refresh_failure_falls_back_to_login():
    c = _client(email="me@example.com", password="pw")
    login_payload = {"access_token": "AT1", "refresh_token": "RT1",
                     "expires_in": 3600, "user": {"id": "uid-1"}}
    relogin_payload = {"access_token": "AT3", "refresh_token": "RT3",
                       "expires_in": 3600, "user": {"id": "uid-1"}}
    with patch("gooners_mcp.client.requests.request") as req:
        req.side_effect = [_resp(200, login_payload), _resp(200, [])]
        c.get("/rest/v1/public_auction_comps", {}, auth=True)
        c._expires_at = 0
        # refresh attempt fails (401), then a fresh password-grant login succeeds
        req.side_effect = [_resp(401, {"error": "invalid"}),
                           _resp(200, relogin_payload), _resp(200, [{"ok": True}])]
        out = c.get("/rest/v1/public_auction_comps", {}, auth=True)
    assert out == [{"ok": True}]
    assert req.call_args_list[-1].kwargs["headers"]["Authorization"] == "Bearer AT3"
