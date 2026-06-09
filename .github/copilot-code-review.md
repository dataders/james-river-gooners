# Copilot code review

Every PR automatically gets a **GitHub Copilot code review** requested via
[`.github/workflows/copilot-review.yml`](workflows/copilot-review.yml) (fires on
`opened` / `reopened` / `ready_for_review`; drafts are skipped). The workflow
only *requests* the review — the feature itself is toggled in repo/org settings,
and so are the MCP servers the reviewer may use.

## One-time settings (GitHub UI)

1. **Enable the feature** — Settings → Copilot → Code review. Requires a Copilot
   Business/Enterprise plan. Until this is on, the workflow no-ops with a
   `::notice::` (Copilot won't appear among the repo's suggested reviewers) and
   the check still passes green.
2. **Let the reviewer use MCP tools** — Settings → Code & automation → Copilot →
   MCP servers → keep *"Allow Copilot to use MCP tools when reviewing pull
   requests"* enabled (it's on by default).

## Recommended MCP servers for this repo

The reviewer (and the cloud agent) share one repo-level MCP config. What's worth
having here:

- **GitHub MCP** — on by default, read-only on this repo. Keep it: the code is
  full of issue/PR cross-references (`#99`, `#104`, `#132`, `#149`…) the reviewer
  can then resolve.
- **Playwright MCP** — on by default. Keep it: `CLAUDE.md` requires mobile +
  desktop screenshots for any visual change, so a browser-capable reviewer can
  actually look at UI diffs.
- **Supabase MCP — read-only, project-scoped** — worth adding. Correctness here
  leans on schema the diff doesn't show: the RLS auth-gates (`0008…`, `0009…`),
  the public views the browser reads (`public_lot_enrichment`,
  `public_cannons_comps`, `public_sold_lots`, `public_auction_comps`), and the
  migrations under `supabase/migrations/`. Read-only access lets the reviewer
  confirm a migration matches what the frontend reads and that a new SELECT
  policy really gates anon access.

Paste the Supabase block into the **MCP servers** settings page (GitHub MCP and
Playwright are implicit defaults — no need to list them):

```json
{
  "mcpServers": {
    "supabase": {
      "type": "local",
      "command": "npx",
      "args": [
        "-y",
        "@supabase/mcp-server-supabase@latest",
        "--read-only",
        "--features=database",
        "--project-ref=cjvllfqldyzsnsjiucks"
      ],
      "tools": ["*"],
      "env": { "SUPABASE_ACCESS_TOKEN": "COPILOT_MCP_SUPABASE_TOKEN" }
    }
  }
}
```

`SUPABASE_ACCESS_TOKEN` resolves from a `COPILOT_MCP_SUPABASE_TOKEN` secret in
the repo's **`copilot` environment** (Settings → Environments → `copilot` →
Secrets).

### Guardrail: read-only token only

Mint a **read-only** Supabase personal access token for this — never the
`sb_secret_…` / service-role key. `CLAUDE.md` keeps the secret key backend-only;
that rule extends to the review bot. The `--read-only` flag is belt-and-braces on
top of a read-scoped token.

## Limits to know

- Code review uses MCP **tools** only — not resources or prompts.
- **No remote OAuth MCP servers** are supported (the Supabase server above runs
  locally with a token, so it's fine).
- PostHog / MotherDuck MCP aren't worth wiring in — a PR reviewer doesn't need to
  query analytics or the snapshot warehouse, and they'd only add token surface.
