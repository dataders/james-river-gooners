# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "prefab-ui>=0.19.0",
#     "pytz",
# ]
# ///
"""Gooners admin monitoring dashboard (prefab-ui → static HTML).

Reads the dbt marts in MotherDuck (`my_db`) and renders a single self-contained
HTML file with four tabs — Engineering / CI, Operations & Cost, Resale
Intelligence, and Product & Users. The HTML bakes its data inline as JSON and
loads the prefab renderer from a CDN, so it stands alone in an <iframe>.

The output is *not* committed or served publicly: the build workflow uploads it
to a private Supabase Storage bucket that only the owner can read (RLS), and the
SPA's /admin route streams it back for the logged-in owner. See dashboard/README.md.

Every query is defensive: a missing or not-yet-built mart degrades to an
"awaiting first refresh" note rather than crashing the build, so the dashboard
renders even before `dbt build` has populated every domain.

Usage:
    MOTHERDUCK_TOKEN=... uv run --with 'prefab-ui>=0.19.0' --with 'duckdb==1.5.2' \
        python app.py -o dist/admin.html
"""

from __future__ import annotations

import argparse
import datetime as dt
import decimal
import os
import sys

try:
    import duckdb
except ImportError:  # pragma: no cover
    sys.exit("Install with: uv run --with 'duckdb==1.5.2' ... python app.py")

from prefab_ui.app import PrefabApp
from prefab_ui.components import (
    H2,
    H3,
    Alert,
    Badge,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    DataTable,
    DataTableColumn,
    Grid,
    Muted,
    Row,
    Separator,
    Text,
)
from prefab_ui.components.charts import AreaChart, BarChart, ChartSeries, LineChart

# Mart schemas in MotherDuck my_db (see dbt/dbt_project.yml).
ENG = "gooners_engineering"  # github_stats-derived CI/PR health
OPS = "gooners_operations"  # supabase perf + scrape SLA + API spend
MARTS = "gooners"  # resale + product marts (default schema)

# Brand-ish palette (Arsenal-red leaning, since these are the "Gooners").
RED = "#ef4444"
GREEN = "#22c55e"
BLUE = "#3b82f6"
AMBER = "#f59e0b"
VIOLET = "#8b5cf6"
SLATE = "#64748b"


def _connect() -> duckdb.DuckDBPyConnection:
    token = os.environ.get("MOTHERDUCK_TOKEN") or os.environ.get(
        "MOTHERDUCK_READ_TOKEN"
    )
    if not token:
        sys.exit("MOTHERDUCK_TOKEN (or MOTHERDUCK_READ_TOKEN) required")
    return duckdb.connect(f"md:my_db?motherduck_token={token}", read_only=True)


_CON: duckdb.DuckDBPyConnection | None = None


def _coerce(v):
    """Make a DuckDB value JSON-serialisable for prefab's inline data block."""
    if isinstance(v, (dt.datetime, dt.date)):
        return v.isoformat()
    if isinstance(v, decimal.Decimal):
        return float(v)
    return v


def q(sql: str) -> list[dict]:
    """Run SQL, returning rows as plain dicts. Any error (missing mart, etc.)
    degrades to an empty list so a not-yet-built domain never breaks the build."""
    assert _CON is not None
    try:
        cur = _CON.execute(sql)
        cols = [d[0] for d in cur.description]
        return [
            {c: _coerce(v) for c, v in zip(cols, row, strict=True)}
            for row in cur.fetchall()
        ]
    except Exception as exc:  # noqa: BLE001 — intentional: degrade, don't crash
        print(
            f"  [warn] query failed ({exc.__class__.__name__}): {str(exc)[:120]}",
            file=sys.stderr,
        )
        return []


def one(sql: str) -> dict:
    rows = q(sql)
    return rows[0] if rows else {}


def fmt_int(v) -> str:
    return f"{int(v):,}" if v is not None else "—"


def fmt_pct(v) -> str:
    return f"{float(v):.1f}%" if v is not None else "—"


def fmt_usd(v) -> str:
    return f"${float(v):,.2f}" if v is not None else "—"


def fmt_dur(seconds) -> str:
    if seconds is None:
        return "—"
    s = float(seconds)
    return f"{s / 60:.1f}m" if s >= 90 else f"{s:.0f}s"


def metric_card(label, value, description=None, delta=None, trend=None, sentiment=None):
    from prefab_ui.components import Metric

    kwargs = {"label": label, "value": value}
    if description is not None:
        kwargs["description"] = description
    if delta is not None:
        kwargs["delta"] = delta
    if trend is not None:
        kwargs["trend"] = trend
    if sentiment is not None:
        kwargs["trend_sentiment"] = sentiment
    Metric(**kwargs)


def empty_note(msg: str = "No data yet — awaiting the first scheduled refresh."):
    with Alert(variant="default"):
        Text(content=msg)


def section(title: str, subtitle: str | None = None):
    H3(content=title)
    if subtitle:
        Muted(content=subtitle)


# --------------------------------------------------------------------------- #
# Engineering / CI
# --------------------------------------------------------------------------- #
def tab_engineering():
    ov = one(f"select * from {ENG}.fct_repo_overview")
    section(
        "Repo health",
        "GitHub issues, PRs, commits and CI, loaded hourly via dlt → MotherDuck.",
    )
    if not ov:
        empty_note()
    else:
        with Grid(min_column_width="170px", gap=4, css_class="mb-4"):
            metric_card(
                "Open issues",
                fmt_int(ov.get("open_issues")),
                description=f"{fmt_int(ov.get('closed_issues'))} closed",
            )
            metric_card(
                "Open PRs",
                fmt_int(ov.get("open_prs")),
                description=f"{fmt_int(ov.get('merged_prs'))} merged",
            )
            metric_card(
                "Avg time to merge",
                f"{ov.get('avg_hours_to_merge', 0):.1f}h"
                if ov.get("avg_hours_to_merge") is not None
                else "—",
            )
            metric_card(
                "CI failure rate",
                fmt_pct(ov.get("overall_failure_rate_pct")),
                description=f"{fmt_int(ov.get('workflow_runs_tracked'))} runs tracked",
                trend="down",
                sentiment="positive",
            )
            metric_card(
                "Commits tracked",
                fmt_int(ov.get("commits_tracked")),
                description=f"{fmt_int(ov.get('distinct_authors'))} authors",
            )

    # Per-workflow reliability table
    Separator(spacing=4)
    section("Workflow reliability", "Lifetime failure rate and run-time per workflow.")
    wf = q(f"""
        select workflow_name, total_runs, failed_runs, failure_rate_pct,
               avg_duration_seconds, p95_duration_seconds, days_since_last_run
        from {ENG}.fct_workflow_run_health order by total_runs desc limit 40
    """)
    if not wf:
        empty_note()
    else:
        for r in wf:
            r["failure_rate_pct"] = fmt_pct(r.get("failure_rate_pct"))
            r["avg_duration_seconds"] = fmt_dur(r.get("avg_duration_seconds"))
            r["p95_duration_seconds"] = fmt_dur(r.get("p95_duration_seconds"))
        DataTable(
            columns=[
                DataTableColumn(key="workflow_name", header="Workflow", sortable=True),
                DataTableColumn(
                    key="total_runs", header="Runs", sortable=True, align="right"
                ),
                DataTableColumn(
                    key="failed_runs", header="Failed", sortable=True, align="right"
                ),
                DataTableColumn(
                    key="failure_rate_pct",
                    header="Fail %",
                    sortable=True,
                    align="right",
                ),
                DataTableColumn(
                    key="avg_duration_seconds", header="Avg", align="right"
                ),
                DataTableColumn(
                    key="p95_duration_seconds", header="p95", align="right"
                ),
                DataTableColumn(
                    key="days_since_last_run",
                    header="Days idle",
                    sortable=True,
                    align="right",
                ),
            ],
            rows=wf,
            search=True,
            paginated=True,
            page_size=10,
        )

    # CI failure-rate trend (overall, by day)
    Separator(spacing=4)
    section(
        "CI failure-rate trend",
        "Daily failure rate across all workflows (last 60 days).",
    )
    trend = q(f"""
        select run_date::varchar as day,
               round(100.0 * sum(failures) / nullif(sum(failures)+sum(successes),0), 1) as failure_rate_pct,
               sum(runs) as runs
        from {ENG}.fct_ci_run_daily
        where run_date >= current_date - interval 60 day
        group by run_date order by run_date
    """)
    if not trend:
        empty_note()
    else:
        with Card():
            with CardContent():
                LineChart(
                    data=trend,
                    x_axis="day",
                    height=220,
                    curve="smooth",
                    series=[
                        ChartSeries(
                            data_key="failure_rate_pct", label="Failure %", color=RED
                        )
                    ],
                )

    # Scraper throughput
    Separator(spacing=4)
    section("Scraper throughput", "Items processed per day (parsed from run logs).")
    items = q(f"""
        select metric_date::varchar as day, metric, total
        from {ENG}.fct_scraper_items_daily
        where metric_date >= current_date - interval 30 day
        order by metric_date
    """)
    if not items:
        empty_note()
    else:
        metrics = sorted({r["metric"] for r in items})
        by_day: dict[str, dict] = {}
        for r in items:
            d = by_day.setdefault(r["day"], {"day": r["day"]})
            d[r["metric"]] = r["total"]
        rows = [by_day[d] for d in sorted(by_day)]
        palette = [GREEN, BLUE, AMBER, VIOLET, RED, SLATE]
        with Card():
            with CardContent():
                BarChart(
                    data=rows,
                    x_axis="day",
                    height=240,
                    stacked=True,
                    series=[
                        ChartSeries(
                            data_key=m, label=m, color=palette[i % len(palette)]
                        )
                        for i, m in enumerate(metrics)
                    ],
                )


# --------------------------------------------------------------------------- #
# Operations & Cost
# --------------------------------------------------------------------------- #
def tab_operations():
    section(
        "Supabase platform",
        "Host load & database reliability from the privileged Prometheus endpoint.",
    )
    host = one(
        f"select * from {OPS}.fct_supabase_host_load order by scraped_hour desc limit 1"
    )
    db = one(
        f"select * from {OPS}.fct_supabase_db_reliability order by scraped_hour desc limit 1"
    )
    if not host and not db:
        empty_note()
    else:
        with Grid(min_column_width="160px", gap=4, css_class="mb-4"):
            metric_card("CPU busy", fmt_pct(host.get("cpu_busy_pct")))
            metric_card("Memory used", fmt_pct(host.get("mem_used_pct")))
            metric_card("Disk used", fmt_pct(host.get("disk_used_pct")))
            metric_card(
                "Load (1m)",
                f"{host.get('load1'):.2f}" if host.get("load1") is not None else "—",
            )
            metric_card("Cache hit", fmt_pct(db.get("cache_hit_pct")))
            metric_card(
                "Connections",
                fmt_pct(db.get("connection_used_pct")),
                description=f"{db.get('connections_avg', '—')} avg",
            )
            metric_card("Rollback %", fmt_pct(db.get("rollback_pct")))
            metric_card("Deadlocks", fmt_int(db.get("deadlocks")))

        load_series = q(f"""
            select scraped_hour::varchar as hour, cpu_busy_pct, mem_used_pct
            from {OPS}.fct_supabase_host_load
            where scraped_hour >= now() - interval 48 hour order by scraped_hour
        """)
        if load_series:
            with Card():
                with CardHeader():
                    CardTitle(content="Host load — last 48h")
                with CardContent():
                    AreaChart(
                        data=load_series,
                        x_axis="hour",
                        height=200,
                        curve="smooth",
                        series=[
                            ChartSeries(
                                data_key="cpu_busy_pct", label="CPU %", color=BLUE
                            ),
                            ChartSeries(
                                data_key="mem_used_pct", label="Mem %", color=VIOLET
                            ),
                        ],
                    )

    # Scrape SLA
    Separator(spacing=4)
    section(
        "Scrape pipeline SLA",
        "Per-source enrichment / eBay / Cannon's coverage and silent-failure watch.",
    )
    sla = q(f"""
        select source, scrape_date::varchar as day, lots_scraped, enrichment_rate_pct,
               ebay_match_rate_pct, cannons_coverage_pct,
               days_since_enrichment, days_since_ebay_comps
        from {OPS}.fct_daily_scrape_activity
        where scrape_date = (select max(scrape_date) from {OPS}.fct_daily_scrape_activity)
        order by source
    """)
    if not sla:
        empty_note()
    else:
        for r in sla:
            r["enrichment_rate_pct"] = fmt_pct(r.get("enrichment_rate_pct"))
            r["ebay_match_rate_pct"] = fmt_pct(r.get("ebay_match_rate_pct"))
            r["cannons_coverage_pct"] = fmt_pct(r.get("cannons_coverage_pct"))
        DataTable(
            columns=[
                DataTableColumn(key="source", header="Source", sortable=True),
                DataTableColumn(key="day", header="Last scrape"),
                DataTableColumn(key="lots_scraped", header="Lots", align="right"),
                DataTableColumn(
                    key="enrichment_rate_pct", header="Enrich %", align="right"
                ),
                DataTableColumn(
                    key="ebay_match_rate_pct", header="eBay %", align="right"
                ),
                DataTableColumn(
                    key="cannons_coverage_pct", header="Cannon's %", align="right"
                ),
                DataTableColumn(
                    key="days_since_enrichment", header="Idle enrich (d)", align="right"
                ),
            ],
            rows=sla,
        )

    # API spend
    Separator(spacing=4)
    section(
        "API spend",
        "Anthropic enrichment + eBay comp budget (cumulative & 30-day burn).",
    )
    spend_latest = one(f"""
        select cumulative_total_cost_usd, cumulative_anthropic_cost_usd, cumulative_ebay_cost_usd,
               rolling_30d_total_cost_usd, anthropic_cost_per_enriched_lot
        from {OPS}.fct_api_spend order by activity_date desc limit 1
    """)
    if not spend_latest:
        empty_note()
    else:
        with Grid(min_column_width="180px", gap=4, css_class="mb-4"):
            metric_card(
                "Total spend (all-time)",
                fmt_usd(spend_latest.get("cumulative_total_cost_usd")),
            )
            metric_card(
                "Anthropic (all-time)",
                fmt_usd(spend_latest.get("cumulative_anthropic_cost_usd")),
            )
            metric_card(
                "eBay (all-time)", fmt_usd(spend_latest.get("cumulative_ebay_cost_usd"))
            )
            metric_card(
                "Last 30 days", fmt_usd(spend_latest.get("rolling_30d_total_cost_usd"))
            )
        burn = q(f"""
            select activity_date::varchar as day, total_api_cost_usd, cumulative_total_cost_usd
            from {OPS}.fct_api_spend
            where activity_date >= current_date - interval 60 day order by activity_date
        """)
        if burn:
            with Card():
                with CardHeader():
                    CardTitle(content="Cumulative API cost")
                with CardContent():
                    AreaChart(
                        data=burn,
                        x_axis="day",
                        height=200,
                        curve="smooth",
                        series=[
                            ChartSeries(
                                data_key="cumulative_total_cost_usd",
                                label="Cumulative $",
                                color=AMBER,
                            )
                        ],
                    )


# --------------------------------------------------------------------------- #
# Resale Intelligence
# --------------------------------------------------------------------------- #
def tab_resale():
    section(
        "Enrichment coverage",
        "How many active lots Claude identified a product for, by auction.",
    )
    enr = q(f"""
        select auction_title, source, total_lots, enriched_lots, enrichment_coverage_pct,
               pct_high_confidence, pct_brand_extracted, pct_model_extracted
        from {MARTS}.fct_enrichment_coverage order by total_lots desc limit 60
    """)
    agg = one(f"""
        select sum(total_lots) as lots, sum(enriched_lots) as enriched,
               round(100.0*sum(enriched_lots)/nullif(sum(total_lots),0),1) as coverage
        from {MARTS}.fct_enrichment_coverage
    """)
    if not enr:
        empty_note()
    else:
        with Grid(min_column_width="180px", gap=4, css_class="mb-4"):
            metric_card("Lots tracked", fmt_int(agg.get("lots")))
            metric_card("Enriched lots", fmt_int(agg.get("enriched")))
            metric_card("Overall coverage", fmt_pct(agg.get("coverage")))
        for r in enr:
            r["enrichment_coverage_pct"] = fmt_pct(r.get("enrichment_coverage_pct"))
            r["pct_high_confidence"] = fmt_pct(r.get("pct_high_confidence"))
            r["pct_brand_extracted"] = fmt_pct(r.get("pct_brand_extracted"))
        DataTable(
            columns=[
                DataTableColumn(key="auction_title", header="Auction", sortable=True),
                DataTableColumn(key="source", header="Src", sortable=True),
                DataTableColumn(
                    key="total_lots", header="Lots", align="right", sortable=True
                ),
                DataTableColumn(
                    key="enriched_lots", header="Enriched", align="right", sortable=True
                ),
                DataTableColumn(
                    key="enrichment_coverage_pct",
                    header="Coverage",
                    align="right",
                    sortable=True,
                ),
                DataTableColumn(
                    key="pct_high_confidence", header="High-conf", align="right"
                ),
                DataTableColumn(
                    key="pct_brand_extracted", header="Brand", align="right"
                ),
            ],
            rows=enr,
            search=True,
            paginated=True,
            page_size=8,
        )

    # eBay comp coverage
    Separator(spacing=4)
    section(
        "eBay comp coverage", "Share of lots with at least one eBay sold-listing comp."
    )
    comp = one(f"""
        select sum(total_lots) as lots, sum(items_with_comp) as with_comp,
               round(100.0*sum(items_with_comp)/nullif(sum(total_lots),0),1) as coverage
        from {MARTS}.fct_ebay_comp_coverage
    """)
    if not comp or comp.get("lots") is None:
        empty_note()
    else:
        with Grid(min_column_width="180px", gap=4):
            metric_card("Lots", fmt_int(comp.get("lots")))
            metric_card("With eBay comp", fmt_int(comp.get("with_comp")))
            metric_card("Coverage", fmt_pct(comp.get("coverage")))

    # Price accuracy
    Separator(spacing=4)
    section(
        "Comp accuracy",
        "How close our comps were to the realised hammer price (sold lots).",
    )
    acc = one(f"""
        select
          round(median(ebay_comp_abs_error_pct),1)    as ebay_med_err,
          round(median(cannons_comp_abs_error_pct),1) as cannons_med_err,
          count(*) filter (where better_comp_source = 'ebay_closer')    as ebay_closer,
          count(*) filter (where better_comp_source = 'cannons_closer') as cannons_closer
        from {MARTS}.fct_price_accuracy
        where has_ebay_comp or has_cannons_comp
    """)
    if not acc or (
        acc.get("ebay_med_err") is None and acc.get("cannons_med_err") is None
    ):
        empty_note()
    else:
        with Grid(min_column_width="190px", gap=4):
            metric_card(
                "eBay median error",
                fmt_pct(acc.get("ebay_med_err")),
                description="abs % vs hammer price",
            )
            metric_card(
                "Cannon's median error",
                fmt_pct(acc.get("cannons_med_err")),
                description="abs % vs hammer price",
            )
            metric_card(
                "eBay closer",
                fmt_int(acc.get("ebay_closer")),
                description=f"vs {fmt_int(acc.get('cannons_closer'))} Cannon's",
            )


# --------------------------------------------------------------------------- #
# Product & Users
# --------------------------------------------------------------------------- #
def tab_product():
    section(
        "Engagement (PostHog)",
        "Anonymous, cookieless product analytics — daily aggregates.",
    )
    eng_latest = one(f"""
        select daily_active_users, pageviews, item_opens, total_searches, swipe_deck_opens
        from {MARTS}.fct_posthog_engagement order by day desc limit 1
    """)
    if not eng_latest:
        empty_note("No PostHog data yet — run the posthog export, then dbt build.")
    else:
        with Grid(min_column_width="150px", gap=4, css_class="mb-4"):
            metric_card("DAU (latest)", fmt_int(eng_latest.get("daily_active_users")))
            metric_card("Pageviews", fmt_int(eng_latest.get("pageviews")))
            metric_card("Item opens", fmt_int(eng_latest.get("item_opens")))
            metric_card("Searches", fmt_int(eng_latest.get("total_searches")))
            metric_card("Swipe sessions", fmt_int(eng_latest.get("swipe_deck_opens")))
        series = q(f"""
            select day::varchar as day, daily_active_users, item_opens, total_searches
            from {MARTS}.fct_posthog_engagement
            where day >= current_date - interval 60 day order by day
        """)
        if series:
            with Card():
                with CardHeader():
                    CardTitle(content="Activity — last 60 days")
                with CardContent():
                    LineChart(
                        data=series,
                        x_axis="day",
                        height=220,
                        curve="smooth",
                        series=[
                            ChartSeries(
                                data_key="daily_active_users", label="DAU", color=GREEN
                            ),
                            ChartSeries(
                                data_key="item_opens", label="Item opens", color=BLUE
                            ),
                            ChartSeries(
                                data_key="total_searches", label="Searches", color=AMBER
                            ),
                        ],
                    )

    # User engagement tiers
    Separator(spacing=4)
    section("Users", "Registered users by engagement tier (favorites + ignores).")
    tiers = q(f"""
        select engagement_tier as tier, count(*) as users
        from {MARTS}.fct_user_engagement group by engagement_tier
    """)
    totals = one(f"""
        select count(*) as users, sum(favorites_count) as favs, sum(ignores_count) as igns,
               count(*) filter (where is_active_30d) as active30
        from {MARTS}.fct_user_engagement
    """)
    if not tiers:
        empty_note()
    else:
        with Grid(min_column_width="160px", gap=4, css_class="mb-4"):
            metric_card("Users", fmt_int(totals.get("users")))
            metric_card("Active (30d)", fmt_int(totals.get("active30")))
            metric_card("Favorites", fmt_int(totals.get("favs")))
            metric_card("Ignores", fmt_int(totals.get("igns")))
        order = {"heavy": 0, "moderate": 1, "light": 2, "inactive": 3}
        tiers.sort(key=lambda r: order.get(r["tier"], 9))
        with Card():
            with CardContent():
                BarChart(
                    data=tiers,
                    x_axis="tier",
                    height=200,
                    series=[ChartSeries(data_key="users", label="Users", color=VIOLET)],
                )

    # Most-loved items
    Separator(spacing=4)
    section(
        "Top items", "Highest net engagement (favorites − ignores) across all lots."
    )
    items = q(f"""
        select coalesce(title,'(lot '||item_id||')') as title, category, source,
               favorited_by, ignored_by, net_score, final_bid
        from {MARTS}.fct_item_engagement
        where favorited_by + ignored_by > 0
        order by net_score desc, favorited_by desc limit 25
    """)
    if not items:
        empty_note()
    else:
        for r in items:
            r["final_bid"] = (
                fmt_usd(r.get("final_bid")) if r.get("final_bid") is not None else "—"
            )
        DataTable(
            columns=[
                DataTableColumn(key="title", header="Item", sortable=True),
                DataTableColumn(key="category", header="Category", sortable=True),
                DataTableColumn(
                    key="favorited_by", header="❤", align="right", sortable=True
                ),
                DataTableColumn(
                    key="ignored_by", header="✕", align="right", sortable=True
                ),
                DataTableColumn(
                    key="net_score", header="Net", align="right", sortable=True
                ),
                DataTableColumn(key="final_bid", header="Sold", align="right"),
            ],
            rows=items,
            search=True,
            paginated=True,
            page_size=8,
        )


# --------------------------------------------------------------------------- #
# Pipeline health (the analytics pipeline monitoring itself)
# --------------------------------------------------------------------------- #
def tab_pipeline():
    section(
        "Last build",
        "Most recent dbt build (run_results) captured to MotherDuck after each refresh.",
    )
    latest = one("""
        select invocation_id, max(captured_at)::varchar as captured_at
        from meta.dbt_run_results
        group by invocation_id order by max(captured_at) desc limit 1
    """)
    if not latest:
        empty_note("No pipeline metrics yet — captured after the next dbt build.")
    else:
        inv = latest["invocation_id"]
        s = one(f"""
            select
              count(*) filter (where resource_type='model' and status='success') as models_ok,
              count(*) filter (where resource_type='model' and status='error')   as models_err,
              count(*) filter (where resource_type='test'  and status='pass')    as tests_pass,
              count(*) filter (where resource_type='test'  and status in ('fail','error')) as tests_fail,
              count(*) filter (where status='skipped')                           as skipped,
              round(sum(execution_time),1)                                       as runtime_s
            from meta.dbt_run_results where invocation_id = '{inv}'
        """)
        tp, tf = s.get("tests_pass") or 0, s.get("tests_fail") or 0
        pass_rate = f"{100.0 * tp / (tp + tf):.0f}%" if (tp + tf) else "—"
        with Grid(min_column_width="150px", gap=4, css_class="mb-4"):
            metric_card(
                "Models built",
                fmt_int(s.get("models_ok")),
                description=(
                    f"{fmt_int(s.get('models_err'))} errored"
                    if s.get("models_err")
                    else "all green"
                ),
            )
            metric_card(
                "Tests passed", fmt_int(tp), description=f"{fmt_int(tf)} failed"
            )
            metric_card("Test pass rate", pass_rate)
            metric_card("Skipped", fmt_int(s.get("skipped")))
            metric_card(
                "Build time",
                f"{s.get('runtime_s')}s" if s.get("runtime_s") is not None else "—",
            )

        # Anything not green in the latest build.
        problems = q(f"""
            select resource_type, name, status, message
            from meta.dbt_run_results
            where invocation_id = '{inv}' and status in ('error','fail','warn')
            order by resource_type, name limit 30
        """)
        if problems:
            section("Needs attention", "Models / tests not green in the last build.")
            DataTable(
                columns=[
                    DataTableColumn(key="resource_type", header="Type", sortable=True),
                    DataTableColumn(key="name", header="Node", sortable=True),
                    DataTableColumn(key="status", header="Status", sortable=True),
                    DataTableColumn(key="message", header="Message"),
                ],
                rows=problems,
                search=True,
                paginated=True,
                page_size=8,
            )

    # Test pass/fail trend
    Separator(spacing=4)
    section("dbt test results over time", "Passed vs failed dbt tests per build.")
    trend = q("""
        select captured_at::date::varchar as day,
               count(*) filter (where resource_type='test' and status='pass') as passed,
               count(*) filter (where resource_type='test' and status in ('fail','error')) as failed
        from meta.dbt_run_results
        where captured_at >= current_date - interval 60 day
        group by 1 order by 1
    """)
    if not trend:
        empty_note()
    else:
        with Card():
            with CardContent():
                BarChart(
                    data=trend,
                    x_axis="day",
                    height=200,
                    stacked=True,
                    series=[
                        ChartSeries(data_key="passed", label="Passed", color=GREEN),
                        ChartSeries(data_key="failed", label="Failed", color=RED),
                    ],
                )

    # Rows per source table (latest snapshot)
    Separator(spacing=4)
    section(
        "Rows processed",
        "Row count per warehouse-native source table (latest snapshot).",
    )
    rows = q("""
        select schema_name as schema, table_name as table, row_count
        from meta.source_row_counts
        where captured_at = (select max(captured_at) from meta.source_row_counts)
        order by row_count desc limit 25
    """)
    if not rows:
        empty_note()
    else:
        for r in rows:
            r["row_count"] = fmt_int(r.get("row_count"))
        DataTable(
            columns=[
                DataTableColumn(key="schema", header="Schema", sortable=True),
                DataTableColumn(key="table", header="Table", sortable=True),
                DataTableColumn(
                    key="row_count", header="Rows", align="right", sortable=True
                ),
            ],
            rows=rows,
            search=True,
            paginated=True,
            page_size=10,
        )

    # Slowest models
    Separator(spacing=4)
    section("Slowest models", "Longest-running models in the last build.")
    if latest:
        slow = q(f"""
            select name, round(execution_time,2) as seconds, coalesce(rows_affected,0) as rows
            from meta.dbt_run_results
            where invocation_id = '{latest["invocation_id"]}' and resource_type='model'
            order by execution_time desc limit 12
        """)
        if slow:
            DataTable(
                columns=[
                    DataTableColumn(key="name", header="Model", sortable=True),
                    DataTableColumn(
                        key="seconds", header="Seconds", align="right", sortable=True
                    ),
                    DataTableColumn(
                        key="rows", header="Rows", align="right", sortable=True
                    ),
                ],
                rows=slow,
            )
        else:
            empty_note()


# The five mart domains, rendered as one long scrollable page rather than tabs.
# prefab's interactive Tabs freeze the CDN renderer on pointerdown for a payload
# this size (a real mouse click locks the page; only a synthetic click switches),
# so tabs gated four of five domains behind an interaction that doesn't work.
# Stacking every domain under a heading sidesteps the broken interaction entirely —
# the whole dashboard is always visible by scrolling.
DOMAINS = [
    ("Engineering / CI", tab_engineering),
    ("Operations & Cost", tab_operations),
    ("Resale Intelligence", tab_resale),
    ("Product & Users", tab_product),
    ("Pipeline Health", tab_pipeline),
]


def render() -> str:
    generated = dt.datetime.now(dt.UTC).strftime("%Y-%m-%d %H:%M UTC")
    with PrefabApp(
        title="Gooners · Admin", css_class="max-w-7xl mx-auto p-6 space-y-4"
    ) as app:
        with Row(justify="between", align="center"):
            H2(content="James River Gooners — Admin")
            with Badge(variant="secondary"):
                Text(content=f"Generated {generated}")
        Muted(
            content="Operational, engineering, resale and product metrics. "
            "Built from the dbt marts in MotherDuck; visible only to the signed-in owner."
        )
        for i, (title, fn) in enumerate(DOMAINS):
            if i:
                Separator(spacing=8)
            H2(content=title)
            fn()
    return app.html()


def main():
    global _CON
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--out", default="dist/admin.html")
    args = ap.parse_args()

    _CON = _connect()
    try:
        html = render()
    finally:
        _CON.close()

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(html)
    print(f"Wrote {args.out} ({len(html):,} bytes)")


if __name__ == "__main__":
    main()
