#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "pyyaml",
# ]
# ///
"""
Build + validate the canonical category mapping, and report coverage.

`category_canonical.yml` is the single source of truth. This script:

  1. Validates it (every subcategory used in `mappings` is declared; every
     subcategory rolls up to a declared group).
  2. Emits the generated artifacts that mirror the YAML:
       - supabase/migrations/<ts>_category_mappings.sql  (table + seed)
       - public/data/category-mappings.json               (browser/debug export)
  3. Replays the canonical resolver over the real NDJSON corpus (active +
     archive) and prints a per-source coverage report comparing the canonical
     `Other` rate against whatever the data was scraped with.

Resolution order (deterministic, source-aware):
    raw -> mappings[source][raw] or mappings.common[raw] -> subcategory
    if missing or __unknown__: keyword inference over title+description
    subcategory -> group (via `subcategories`)

Run from scraper/:
    uv run --with pyyaml python3 build_category_table.py            # validate + report
    uv run --with pyyaml python3 build_category_table.py --write    # also (re)write artifacts
"""

import argparse
import collections
import json
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
CANONICAL = HERE / "category_canonical.yml"
JSON_EXPORT = ROOT / "public" / "data" / "category-mappings.json"
MIGRATIONS_DIR = ROOT / "supabase" / "migrations"


# --------------------------------------------------------------------------- #
# Load + validate
# --------------------------------------------------------------------------- #
def load():
    with open(CANONICAL) as f:
        cfg = yaml.safe_load(f)
    return cfg


def validate(cfg):
    errors = []
    groups = set(cfg["groups"])
    subs = cfg["subcategories"]
    # every subcategory rolls up to a known group
    for sub, grp in subs.items():
        if grp not in groups:
            errors.append(f"subcategory {sub!r} -> unknown group {grp!r}")
    # every subcategory used in mappings is declared
    for source, table in cfg["mappings"].items():
        for raw, sub in table.items():
            if sub not in subs:
                errors.append(
                    f"mappings.{source}[{raw!r}] -> undeclared subcategory {sub!r}"
                )
    # inference targets must be declared subcategories
    for kw, sub in cfg.get("inference", {}).items():
        if sub not in subs:
            errors.append(f"inference[{kw!r}] -> undeclared subcategory {sub!r}")
    if errors:
        raise SystemExit("VALIDATION FAILED:\n  " + "\n  ".join(errors))
    return True


# --------------------------------------------------------------------------- #
# Resolver (the canonical, deterministic mapping)
# --------------------------------------------------------------------------- #
class Resolver:
    def __init__(self, cfg):
        self.subs = cfg["subcategories"]
        # A subcategory display name is always a valid raw input for itself, so
        # the upstream pipeline's own canonical names round-trip. This identity
        # layer sits just under `common`.
        self.identity = {
            name.lower(): name for name in self.subs if name != "__unknown__"
        }
        self.common = {
            k.lower(): v for k, v in cfg["mappings"].get("common", {}).items()
        }
        self.per_source = {
            src: {k.lower(): v for k, v in tbl.items()}
            for src, tbl in cfg["mappings"].items()
            if src != "common"
        }
        self.inference = [(k.lower(), v) for k, v in cfg.get("inference", {}).items()]

    def subcategory(self, source, raw, text=""):
        raw = (raw or "").strip().lower()
        sub = None
        # Per-source lookup (full path OR leaf-only for legacy entries)
        if source in self.per_source:
            tbl = self.per_source[source]
            if raw in tbl:
                sub = tbl[raw]
            elif " > " in raw:
                leaf = raw.split(" > ")[-1].strip()
                if leaf in tbl:
                    sub = tbl[leaf]
        if sub is None:
            if raw in self.common:
                sub = self.common[raw]
            elif " > " in raw:
                leaf = raw.split(" > ")[-1].strip()
                if leaf in self.common:
                    sub = self.common[leaf]
                elif leaf in self.identity:
                    sub = self.identity[leaf]
            elif raw in self.identity:
                sub = self.identity[raw]
        if sub is None or sub == "__unknown__":
            inferred = self._infer(text)
            if inferred:
                return inferred, "inference"
            return "__unknown__", ("unmapped" if sub is None else "ambiguous")
        return sub, "table"

    def group(self, sub):
        return self.subs.get(sub, "Other")

    def _infer(self, text):
        low = (text or "").lower()
        for kw, sub in self.inference:
            if kw in low:
                return sub
        return None


# --------------------------------------------------------------------------- #
# Artifact emitters
# --------------------------------------------------------------------------- #
def _effective_mappings(cfg):
    """mappings with the identity layer materialized into `common`, so the
    emitted table/JSON are self-contained (an explicit `common` entry wins)."""
    subs = cfg["subcategories"]
    identity = {name.lower(): name for name in subs if name != "__unknown__"}
    out = {k: dict(v) for k, v in cfg["mappings"].items()}
    common = dict(identity)
    common.update({k.lower(): v for k, v in out.get("common", {}).items()})
    out["common"] = common
    return out


def emit_json(cfg):
    JSON_EXPORT.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": cfg["version"],
        "groups": cfg["groups"],
        "subcategories": cfg["subcategories"],
        "mappings": _effective_mappings(cfg),
        "inference": cfg.get("inference", {}),
    }
    JSON_EXPORT.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    return JSON_EXPORT


def _sql_lit(s):
    return "'" + str(s).replace("'", "''") + "'"


def emit_migration(cfg, write):
    MIGRATIONS_DIR.mkdir(parents=True, exist_ok=True)
    ddl = """-- Canonical category mapping (generated from scraper/category_canonical.yml
-- by scraper/build_category_table.py — DO NOT EDIT BY HAND; edit the YAML and
-- regenerate). Browsers read it via the publishable key; only the scraper /
-- service role writes.

create table if not exists public.category_mappings (
  source         text not null,           -- 'common' | 'cannons' | 'hibid' | 'rasmus'
  raw_category   text not null,           -- lowercased site category / breadcrumb leaf
  subcategory    text not null,           -- canonical mid-level name ('__unknown__' allowed)
  category_group text not null,           -- top-level display group
  primary key (source, raw_category)
);

create table if not exists public.category_groups (
  category_group text primary key,
  sort_order     int  not null
);

create table if not exists public.category_inference (
  keyword     text primary key,           -- lowercased title/description keyword
  subcategory text not null,
  priority    int  not null               -- lower = checked first
);

alter table public.category_mappings   enable row level security;
alter table public.category_groups      enable row level security;
alter table public.category_inference   enable row level security;

do $$ begin
  create policy "category_mappings_read"  on public.category_mappings  for select using (true);
  create policy "category_groups_read"    on public.category_groups     for select using (true);
  create policy "category_inference_read" on public.category_inference  for select using (true);
exception when duplicate_object then null; end $$;

-- Public read view (mirrors the public_auction_comps pattern).
create or replace view public.public_category_mappings as
  select source, raw_category, subcategory, category_group
  from public.category_mappings;

-- Idempotent reseed.
truncate public.category_mappings;
truncate public.category_groups;
truncate public.category_inference;
"""
    subs = cfg["subcategories"]

    grp_rows = ",\n".join(
        f"  ({_sql_lit(g)}, {i})" for i, g in enumerate(cfg["groups"])
    )
    seed = [
        f"insert into public.category_groups (category_group, sort_order) values\n{grp_rows};\n"
    ]

    map_rows = []
    for source, table in _effective_mappings(cfg).items():
        for raw in sorted(table):
            sub = table[raw]
            grp = subs.get(sub, "Other")
            map_rows.append(
                f"  ({_sql_lit(source)}, {_sql_lit(raw.lower())}, {_sql_lit(sub)}, {_sql_lit(grp)})"
            )
    seed.append(
        "insert into public.category_mappings (source, raw_category, subcategory, category_group) values\n"
        + ",\n".join(map_rows)
        + ";\n"
    )

    inf_rows = [
        f"  ({_sql_lit(kw.lower())}, {_sql_lit(sub)}, {i})"
        for i, (kw, sub) in enumerate(cfg.get("inference", {}).items())
    ]
    if inf_rows:
        seed.append(
            "insert into public.category_inference (keyword, subcategory, priority) values\n"
            + ",\n".join(inf_rows)
            + ";\n"
        )

    sql = ddl + "\n" + "\n".join(seed)

    if write:
        # Reuse an existing generated migration filename if present, so repeated
        # runs overwrite in place instead of piling up duplicates.
        existing = sorted(MIGRATIONS_DIR.glob("*_category_mappings.sql"))
        path = (
            existing[0] if existing else MIGRATIONS_DIR / "0006_category_mappings.sql"
        )
        path.write_text(sql)
        return path
    return None


# --------------------------------------------------------------------------- #
# Coverage report over the real corpus
# --------------------------------------------------------------------------- #
def _srcfam(s):
    return "cannons" if s == "cannons" else ("rasmus" if s == "rasmus" else "hibid")


def coverage(cfg):
    resolver = Resolver(cfg)
    rows = []
    for mf in (
        ROOT / "public/data/manifest.json",
        ROOT / "public/data/archive-manifest.json",
    ):
        if not mf.exists():
            continue
        m = json.loads(mf.read_text())
        auctions = m["auctions"] if isinstance(m, dict) else m
        for a in auctions:
            nd = a.get("ndjsonPath")
            if not nd:
                continue
            p = ROOT / "public" / nd
            if not p.exists():
                continue
            fam = _srcfam(a.get("source"))
            for line in p.read_text().splitlines():
                line = line.strip()
                if not line:
                    continue
                it = json.loads(line)
                raw = it.get("rawCategory") or ""
                text = f"{it.get('title', '')} {it.get('description', '')}"
                old_group = (it.get("category") or "Other").strip()
                sub, how = resolver.subcategory(fam, raw, text)
                new_group = resolver.group(sub)
                rows.append((fam, raw, old_group, new_group, sub, how))

    print("\n================ COVERAGE (canonical vs scraped) ================")
    overall = collections.Counter()
    for fam in ("cannons", "hibid", "rasmus"):
        sub = [r for r in rows if r[0] == fam]
        if not sub:
            continue
        n = len(sub)
        old_other = sum(1 for r in sub if r[2] == "Other")
        new_other = sum(1 for r in sub if r[3] == "Other")
        via_table = sum(1 for r in sub if r[5] == "table")
        via_infer = sum(1 for r in sub if r[5] == "inference")
        unmapped = sum(1 for r in sub if r[5] in ("unmapped", "ambiguous"))
        # Items whose source actually gave a category (raw is not empty/literal
        # "Other") — the honest signal, since literal "Other" can never improve.
        real = [r for r in sub if r[1].strip().lower() not in ("", "other")]
        real_unres = sum(1 for r in real if r[5] in ("unmapped", "ambiguous"))
        print(f"\n-- {fam}: {n} items --")
        print(
            f"   Other rate:   scraped {100 * old_other / n:5.1f}%  ->  canonical {100 * new_other / n:5.1f}%"
        )
        print(
            f"   resolved via: table {100 * via_table / n:4.1f}%   inference {100 * via_infer / n:4.1f}%   "
            f"unresolved {100 * unmapped / n:4.1f}%"
        )
        if real:
            print(
                f"   of the {len(real)} items WITH a real source category: "
                f"{100 * (len(real) - real_unres) / len(real):.1f}% mapped, "
                f"{real_unres} left unresolved"
            )
        overall["n"] += n
        overall["old"] += old_other
        overall["new"] += new_other
    if overall["n"]:
        print(
            f"\n-- ALL {overall['n']} items: Other {100 * overall['old'] / overall['n']:.1f}% "
            f"-> {100 * overall['new'] / overall['n']:.1f}% --"
        )

    # Remaining unresolved raw values worth a human's attention (count >= 3).
    print("\n---- top still-unresolved raw categories (per source) ----")
    for fam in ("cannons", "hibid", "rasmus"):
        c = collections.Counter(
            r[1]
            for r in rows
            if r[0] == fam and r[5] in ("unmapped", "ambiguous") and r[1]
        )
        top = [(raw, k) for raw, k in c.most_common() if k >= 3]
        if top:
            print(f"  {fam}: " + ", ".join(f"{raw!r}×{k}" for raw, k in top[:12]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--write", action="store_true", help="(re)write JSON + migration artifacts"
    )
    args = ap.parse_args()

    cfg = load()
    validate(cfg)
    print(
        f"OK: {CANONICAL.name} valid — "
        f"{len(cfg['groups'])} groups, {len(cfg['subcategories']) - 1} subcategories, "
        f"{sum(len(t) for t in cfg['mappings'].values())} raw mappings, "
        f"{len(cfg.get('inference', {}))} inference keywords."
    )

    if args.write:
        j = emit_json(cfg)
        mig = emit_migration(cfg, write=True)
        print(f"wrote {j.relative_to(ROOT)}")
        print(f"wrote {mig.relative_to(ROOT)}")
    else:
        emit_migration(cfg, write=False)  # dry validate of SQL generation

    coverage(cfg)


if __name__ == "__main__":
    main()
