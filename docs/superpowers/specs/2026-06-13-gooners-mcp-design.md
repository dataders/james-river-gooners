# Gooners MCP Server — Design

**Date:** 2026-06-13
**Status:** Approved (design); pending implementation plan
**Scope:** v1 — read-only research/discovery surface over the gooners auction backend

## Problem

The gooners site (a better browsing UI over Cannon's / HiBid / Rasmus auctions in
Richmond VA) exposes a rich backend — Supabase PostgREST views plus several Edge
Functions — that today only the React SPA consumes. We want to drive the same
capabilities from Claude via an MCP server, so a user can browse, search, inspect
resale comps, and manage their favorites/ignored lists conversationally.

The site is **not** a read-only scraper front-end as first assumed: it already has
production Edge Functions for bidding (`cannon-proxy`), FB Marketplace listing
drafts (`facebook-listing`), query embedding (`embed-query`), and image search
(`image-search`), all authenticated by a Supabase user JWT. v1 deliberately wraps
only the read/research surface; bidding and FB drafting are out of scope for v1
(the endpoints already exist and can be wrapped later without new automation).

## Goals

- A local **FastMCP** (Python) server, run via `uv`, registered as a stdio MCP in
  the user's Claude client.
- Expose browse, search (keyword/filter + semantic), lot detail, resale comps +
  sold-price stats, and favorites/ignored management.
- Each lot result carries a ready-to-click **source URL** to the live lot — the
  "deep link to bid" affordance — since v1 does not automate bid placement.
- Auth/transport isolated in one layer so the server can graduate to a hosted,
  multi-user transport later **without rewriting the tools**.

## Non-goals (v1)

- Placing bids (`cannon-proxy: place_bid`) — spends real money; deferred.
- Checking placed bids (`cannon-proxy: get_bids/refresh_bid_statuses`) — deferred.
- Drafting Facebook Marketplace listings (`facebook-listing`) — deferred to v2.
- Image search (`image-search`) — deferred.
- Any local scraping or data generation; the MCP only reads existing backend data.

## Approach

**Chosen: thin client over Supabase PostgREST + Edge Functions.** The MCP calls the
same endpoints the website uses. Data is always fresh, there is no local data to
maintain, and it reuses the production backend and its row-level security. The cost
is a network dependency and a login for gated data (comps, favorites).

Rejected alternatives:

- **Read local NDJSON/Parquet read model.** Works offline but is stale (only as
  fresh as the last local scrape) and *cannot* serve comps or favorites — those
  live only in Supabase.
- **Import the scraper's Python modules directly.** Those modules
  (`supabase_lots.py`, etc.) are write/backfill-oriented (whole-auction pulls),
  the wrong shape for interactive search, and would couple the MCP to scraper
  internals.

## Architecture

A new top-level **`mcp/`** package, separate from `scraper/`. Three layers:

### `client.py` — `GoonersClient`

Owns **all** auth and HTTP. Holds the Supabase URL + publishable (anon) key; does
email/password sign-in → JWT with automatic refresh; exposes typed helpers:

- `get(view, *, params)` — PostgREST GET against a view/table.
- `rpc(fn, payload)` — PostgREST RPC call (e.g. `match_lots` if used directly).
- `edge_fn(name, payload)` — invoke a Supabase Edge Function (`embed-query`).

Auth posture:

- Publishable key alone (no login) → public reads work: lots, enrichment,
  `embed-query` semantic search.
- A user JWT is required for gated reads/writes: comps views, sold-price stats,
  `favorites`, `ignored`. The client signs in lazily on the first gated call.
- **Graceful degradation:** if no credentials are configured, gated tools return a
  clear structured "log in to enable this" message rather than raising; browse and
  search keep working.

This is the only layer a future hosted/multi-user transport would change (how the
client is constructed / where the JWT comes from). Tools stay untouched.

### `server.py` — FastMCP instance + tools

Defines the `FastMCP` app and the `@mcp.tool` functions. Tools are thin: validate
inputs, call `GoonersClient`, shape results via `schemas.py`, return structured
data. Tools **never raise** — failures return `{"error": "..."}` so Claude can
recover and explain.

### `schemas.py` — output shapes

Small dataclasses / TypedDicts for lot, comp, favorite, and auction shapes so tool
outputs are consistent, documented, and stable for the model to consume.

## Tools (v1)

| Tool | Backend | Auth |
|---|---|---|
| `list_auctions()` | distinct auctions over `public_active_lots` (see note) | none |
| `search_lots(query, *, semantic=False, category=None, max_price=None, auction_id=None, limit=50)` | PostgREST filters; `semantic=True` → `embed-query` then hydrate ids | none |
| `get_lot(auction_safe_id, item_id)` | `public_active_lots` + `public_lot_enrichment` | none |
| `get_comps(auction_safe_id, item_id)` | `public_auction_comps` + `public_cannons_comps` | login |
| `get_category_sold_stats(category)` | `public_category_sold_stats` | login |
| `list_favorites()` / `add_favorite(...)` / `remove_favorite(...)` | `favorites` table | login |
| `list_ignored()` / `add_ignored(...)` / `remove_ignored(...)` | `ignored` table | login |

### Semantic search detail

`search_lots(semantic=True)` POSTs `{query, match_count}` to the `embed-query` Edge
Function (which embeds via the HF Inference API and runs `match_lots` server-side),
receives composite `auction_safe_id:item_id` ids ranked by similarity, then
hydrates full rows from `public_active_lots`. No local embedding model is needed.

### `list_auctions` derivation

There is no dedicated "auctions" view. `list_auctions()` derives the distinct
active auctions from `public_active_lots` (group by `auction_safe_id` / auction
title / end date). The implementation plan decides whether to do this with a
PostgREST `select=...&distinct` style query or a small client-side reduction over a
projected column fetch; either is fine — it is not a blocker.

### Source URL / deep-link-to-bid

Every lot shape includes the live source-platform URL for the lot, derived from the
existing lot fields (the same URL the SPA links to). v1 does not place bids; this
link lets the user bid manually on Cannon's/HiBid/Rasmus.

## Data flow

```
Claude ── MCP tool call ──▶ server.py ──▶ GoonersClient ──▶ Supabase
                                              │                 │
                                              │   (login if     ├─ PostgREST views (public + gated)
                                              │    gated)       └─ embed-query Edge Function
                                              ▼
                                      schemas.py shaping
                                              ▼
                              structured result back to Claude
```

## Configuration

Reuse the repo's `.env.local` (gitignored), adding two vars:

| Var | Purpose | Notes |
|---|---|---|
| `VITE_SUPABASE_URL` | Supabase project URL | already in `.env.example` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | anon/publishable key | already in `.env.example`; browser-safe |
| `GOONERS_EMAIL` | user's gooners login email | **new**; for gated reads/favorites |
| `GOONERS_PASSWORD` | user's gooners login password | **new**; local only, never committed |

Without `GOONERS_EMAIL`/`GOONERS_PASSWORD`, public tools work; gated tools degrade
gracefully. The secret key (`sb_secret_…`) is **not** used — the MCP authenticates
as the user, exactly like the browser, so it can graduate to multi-user cleanly.

Registration: a stdio entry in the user's Claude MCP config running
`uv run --with fastmcp --with <deps> python -m gooners_mcp` (exact invocation
finalized in the implementation plan).

## Error handling

- Network errors / 5xx: retried with backoff in the client; on exhaustion the tool
  returns `{"error": "transient backend error, try again"}` — no stack traces reach
  the model.
- 4xx: surfaced as an actionable message (e.g. auth required, not found).
- Missing credentials on a gated tool: `{"error": "This needs a gooners login.
  Set GOONERS_EMAIL / GOONERS_PASSWORD in .env.local."}`.
- Tools never raise; all paths return structured data or `{"error": ...}`.

## Testing

- `pytest`, mirroring the existing `scraper/test_supabase_*.py` pattern: mock the
  Supabase HTTP layer, assert query-param construction and result shaping.
- Pure functions (param building, id hydration, result shaping) unit-tested
  directly.
- One optional live smoke test gated behind an env flag (`GOONERS_MCP_LIVE=1`) that
  hits the real backend with read-only calls.

## Open questions / future work

- **v2 — more tools:** wrap `cannon-proxy` (place_bid with a confirmation guardrail,
  get_bids/refresh_bid_statuses) and `facebook-listing` (draft FB Marketplace
  listings), plus `image-search`.

- **v2 — hosted multi-user transport via Supabase OAuth 2.1 Server.** The clean
  Supabase-native path (not refresh-token reuse, not hand-rolled tokens) is the
  **OAuth 2.1 Server** (currently *beta*): the gooners project becomes an OAuth
  2.1 / OIDC authorization server, and a *remote* (HTTP) MCP server authenticates
  as an existing end user via a browser consent flow, with RLS applied
  automatically. Supabase supplies only the IdP half — we still build the MCP
  server (FastMCP has a built-in Supabase integration that handles the OAuth /
  token / discovery plumbing). Concretely this v2 entails:

  1. **Signing-key migration (HS256 → asymmetric RS256/ES256).** The only
     potentially breaking step — but **low-risk for this repo**: a code audit found
     *no* use of `JWT_SECRET` / `jose` / `jsonwebtoken` / `verify_jwt` / `HS256` in
     `supabase/` or `scraper/`; all Edge Functions validate via
     `supabase.auth.getUser()` (signing-scheme-agnostic) and use the service-role
     key. The `sb_publishable_`/`sb_secret_` keys are decoupled from the signing
     key and unaffected. Rotation keeps existing sessions alive. Don't *revoke* the
     legacy secret until access-token-expiry + ~15 min (JWKS caches ~10+10 min).
  2. **Consent UI in the SPA** — reuse `useAuth`; call `getAuthorizationDetails` →
     render client/scopes → `approveAuthorization`/`denyAuthorization`. Real new
     frontend work; the biggest hidden cost.
  3. **Build the remote MCP server** (HTTP transport) pointed at
     `https://<ref>.supabase.co/auth/v1`; FastMCP + Supabase integration is the
     documented shortcut. Source the per-user JWT from the OAuth flow instead of
     `.env.local` — only `client.py` construction changes from v1.
  4. **RLS decision:** existing `auth.uid()` policies keep working unchanged.
     **No custom scopes in beta**, so an MCP token = *full* user-level access
     (it would unlock the resale-intelligence tables exactly like a browser login).
     To narrow what the MCP app can touch, add `client_id` predicates, e.g.
     `(auth.jwt() ->> 'client_id') = '<mcp-client-id>'`.
  5. **Gotchas to track:** OAuth 2.1 Server is beta (free during beta, pricing TBD);
     CLI ≥ 2.54.11 for local config; user-facing "revoke this app" UX appears to be
     our responsibility (undocumented turnkey screen); the
     `/.well-known/oauth-protected-resource` metadata endpoint is the MCP server's
     job (FastMCP handles it).

  Tracked in GitHub issue #280.

  Docs: `oauth-server`, `oauth-server/getting-started`,
  `oauth-server/mcp-authentication`, `oauth-server/token-security`, `signing-keys`.
