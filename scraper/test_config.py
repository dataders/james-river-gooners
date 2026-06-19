"""Tests for scraper/config.py (Pydantic Settings v2) and scraper/secrets.py.

Coverage:
  - Default values for each settings class
  - Env var overrides (validation_alias -> field)
  - Boolean parsing: 1/true/yes/on all ON; 0/false/absent all OFF
  - The old boolean bug: GOONERS_ENRICHMENT=true was silently OFF before config.py; now ON
  - Validation: out-of-range values raise ValidationError
  - describe() runs without error and emits all expected section headers
  - Argparse default pattern: default=cfg.field picks up env var value
  - secrets.py accessors: None when absent, value when present
"""

import argparse
import io
import os
import env_secrets as _secrets
import unittest
from unittest.mock import patch

from config import (
    CannonsCompsSettings,
    EbayCompsSettings,
    EmbeddingSettings,
    EnrichmentSettings,
    SupabaseSettings,
    TelemetrySettings,
    WarehouseSettings,
    describe,
)
from pydantic import ValidationError

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _env(**kwargs):
    """Return a patch.dict context manager with only the given vars set."""
    return patch.dict(os.environ, kwargs, clear=True)


# ---------------------------------------------------------------------------
# EnrichmentSettings
# ---------------------------------------------------------------------------

class EnrichmentDefaultsTest(unittest.TestCase):
    def test_defaults(self):
        with _env():
            cfg = EnrichmentSettings()
        self.assertFalse(cfg.enabled)
        self.assertFalse(cfg.text_only)
        self.assertEqual(cfg.model, "claude-haiku-4-5")
        self.assertEqual(cfg.workers, 8)
        self.assertEqual(cfg.rpm, 45.0)
        self.assertEqual(cfg.max_images, 3)
        self.assertEqual(cfg.batch_inline_size, 2_000)
        self.assertEqual(cfg.batch_max_bytes, 180 * 1024 * 1024)
        self.assertEqual(cfg.batch_max_requests, 10_000)


class EnrichmentEnvOverrideTest(unittest.TestCase):
    def test_enabled_via_env(self):
        with _env(GOONERS_ENRICHMENT="1"):
            self.assertTrue(EnrichmentSettings().enabled)

    def test_model_via_env(self):
        with _env(GOONERS_ENRICHMENT_MODEL="claude-opus-4-8"):
            self.assertEqual(EnrichmentSettings().model, "claude-opus-4-8")

    def test_workers_via_env(self):
        with _env(GOONERS_ENRICHMENT_WORKERS="16"):
            self.assertEqual(EnrichmentSettings().workers, 16)

    def test_rpm_via_env(self):
        with _env(GOONERS_ENRICHMENT_RPM="30.5"):
            self.assertAlmostEqual(EnrichmentSettings().rpm, 30.5)

    def test_max_images_via_env(self):
        with _env(GOONERS_MAX_IMAGES="5"):
            self.assertEqual(EnrichmentSettings().max_images, 5)

    def test_batch_inline_size_via_env(self):
        with _env(GOONERS_ENRICHMENT_BATCH_INLINE_SIZE="500"):
            self.assertEqual(EnrichmentSettings().batch_inline_size, 500)

    def test_batch_max_bytes_via_env(self):
        with _env(GOONERS_ENRICHMENT_BATCH_MAX_BYTES="1048576"):
            self.assertEqual(EnrichmentSettings().batch_max_bytes, 1_048_576)

    def test_batch_max_requests_via_env(self):
        with _env(GOONERS_ENRICHMENT_BATCH_SIZE="500"):
            self.assertEqual(EnrichmentSettings().batch_max_requests, 500)


class EnrichmentBoolParsingTest(unittest.TestCase):
    """Pydantic v2 accepts 1/true/yes/on (any case) as True."""

    _TRUE_VALS = ["1", "true", "True", "TRUE", "yes", "YES", "on", "ON"]
    _FALSE_VALS = ["0", "false", "False", "FALSE", "no", "NO", "off", "OFF"]

    def test_enabled_true_variants(self):
        for v in self._TRUE_VALS:
            with self.subTest(v=v), _env(GOONERS_ENRICHMENT=v):
                self.assertTrue(EnrichmentSettings().enabled, f"Expected True for {v!r}")

    def test_enabled_false_variants(self):
        for v in self._FALSE_VALS:
            with self.subTest(v=v), _env(GOONERS_ENRICHMENT=v):
                self.assertFalse(EnrichmentSettings().enabled, f"Expected False for {v!r}")

    def test_enabled_absent_is_false(self):
        with _env():
            self.assertFalse(EnrichmentSettings().enabled)

    def test_text_only_true_variants(self):
        for v in self._TRUE_VALS:
            with self.subTest(v=v), _env(GOONERS_ENRICHMENT_TEXT_ONLY=v):
                self.assertTrue(EnrichmentSettings().text_only, f"Expected True for {v!r}")

    def test_old_boolean_bug_is_fixed(self):
        # Before config.py: `== "1"` meant GOONERS_ENRICHMENT=true was silently OFF.
        # Now Pydantic handles it correctly.
        with _env(GOONERS_ENRICHMENT="true"):
            self.assertTrue(EnrichmentSettings().enabled)
        with _env(GOONERS_ENRICHMENT="yes"):
            self.assertTrue(EnrichmentSettings().enabled)
        with _env(GOONERS_ENRICHMENT="on"):
            self.assertTrue(EnrichmentSettings().enabled)


class EnrichmentValidationTest(unittest.TestCase):
    def test_workers_below_min_raises(self):
        with self.assertRaises(ValidationError), _env(GOONERS_ENRICHMENT_WORKERS="0"):
            EnrichmentSettings()

    def test_workers_above_max_raises(self):
        with self.assertRaises(ValidationError), _env(GOONERS_ENRICHMENT_WORKERS="257"):
            EnrichmentSettings()

    def test_rpm_zero_raises(self):
        with self.assertRaises(ValidationError), _env(GOONERS_ENRICHMENT_RPM="0"):
            EnrichmentSettings()

    def test_max_images_below_min_raises(self):
        with self.assertRaises(ValidationError), _env(GOONERS_MAX_IMAGES="0"):
            EnrichmentSettings()

    def test_max_images_above_max_raises(self):
        with self.assertRaises(ValidationError), _env(GOONERS_MAX_IMAGES="11"):
            EnrichmentSettings()


# ---------------------------------------------------------------------------
# EbayCompsSettings
# ---------------------------------------------------------------------------

class EbayCompsDefaultsTest(unittest.TestCase):
    def test_defaults(self):
        with _env():
            cfg = EbayCompsSettings()
        self.assertEqual(cfg.limit, 200)
        self.assertEqual(cfg.monthly_budget, 5_000)
        self.assertEqual(cfg.max_queries, 0)
        self.assertEqual(cfg.skip_categories, "")
        self.assertEqual(cfg.soldcomps_min_remaining, 0)
        self.assertEqual(cfg.apify_max_listings, 10)
        self.assertEqual(cfg.apify_concurrency, 25)
        self.assertFalse(cfg.corpus_first)
        self.assertFalse(cfg.sold_listings_corpus)
        self.assertFalse(cfg.leaf_categories)
        self.assertTrue(cfg.browser_fallback)


class EbayCompsEnvOverrideTest(unittest.TestCase):
    def test_limit_via_env(self):
        with _env(GOONERS_EBAY_COMPS_LIMIT="50"):
            self.assertEqual(EbayCompsSettings().limit, 50)

    def test_monthly_budget_via_env(self):
        with _env(GOONERS_EBAY_COMPS_MONTHLY_BUDGET="1000"):
            self.assertEqual(EbayCompsSettings().monthly_budget, 1000)

    def test_skip_categories_via_env(self):
        with _env(GOONERS_EBAY_COMPS_SKIP_CATEGORIES="Collectibles,Jewelry"):
            self.assertEqual(EbayCompsSettings().skip_categories, "Collectibles,Jewelry")

    def test_corpus_first_via_env(self):
        with _env(GOONERS_CORPUS_FIRST="1"):
            self.assertTrue(EbayCompsSettings().corpus_first)

    def test_browser_fallback_false_via_env(self):
        with _env(GOONERS_EBAY_BROWSER_FALLBACK="false"):
            self.assertFalse(EbayCompsSettings().browser_fallback)


class EbayCompsValidationTest(unittest.TestCase):
    def test_limit_negative_raises(self):
        with self.assertRaises(ValidationError), _env(GOONERS_EBAY_COMPS_LIMIT="-1"):
            EbayCompsSettings()

    def test_apify_max_listings_below_min_raises(self):
        with self.assertRaises(ValidationError), _env(GOONERS_APIFY_MAX_LISTINGS="0"):
            EbayCompsSettings()


class EbayCompsNewFieldsTest(unittest.TestCase):
    def test_user_agent_default_empty(self):
        with _env():
            self.assertEqual(EbayCompsSettings().user_agent, "")

    def test_user_agent_via_env(self):
        with _env(GOONERS_EBAY_USER_AGENT="CustomBot/1.0"):
            self.assertEqual(EbayCompsSettings().user_agent, "CustomBot/1.0")

    def test_agent_browser_command_default_empty(self):
        with _env():
            self.assertEqual(EbayCompsSettings().agent_browser_command, "")

    def test_agent_browser_command_via_env(self):
        with _env(GOONERS_AGENT_BROWSER_COMMAND="npx my-browser --"):
            self.assertEqual(EbayCompsSettings().agent_browser_command, "npx my-browser --")


# ---------------------------------------------------------------------------
# EmbeddingSettings
# ---------------------------------------------------------------------------

class EmbeddingDefaultsTest(unittest.TestCase):
    def test_defaults(self):
        with _env():
            cfg = EmbeddingSettings()
        self.assertFalse(cfg.enabled)
        self.assertEqual(cfg.device, "")
        self.assertEqual(cfg.max_images, 3)
        self.assertEqual(cfg.upsert_batch, 100)


class EmbeddingEnvOverrideTest(unittest.TestCase):
    def test_enabled_via_env(self):
        with _env(GOONERS_NOMIC_EMBEDDINGS="1"):
            self.assertTrue(EmbeddingSettings().enabled)

    def test_device_via_env(self):
        with _env(GOONERS_EMBED_DEVICE="cpu"):
            self.assertEqual(EmbeddingSettings().device, "cpu")

    def test_max_images_shared_knob(self):
        # GOONERS_MAX_IMAGES is shared between EnrichmentSettings and EmbeddingSettings.
        with _env(GOONERS_MAX_IMAGES="7"):
            self.assertEqual(EmbeddingSettings().max_images, 7)
            self.assertEqual(EnrichmentSettings().max_images, 7)

    def test_upsert_batch_via_env(self):
        with _env(GOONERS_NOMIC_UPSERT_BATCH="50"):
            self.assertEqual(EmbeddingSettings().upsert_batch, 50)

    def test_upsert_batch_validation_ge1(self):
        with self.assertRaises(ValidationError), _env(GOONERS_NOMIC_UPSERT_BATCH="0"):
            EmbeddingSettings()


# ---------------------------------------------------------------------------
# SupabaseSettings
# ---------------------------------------------------------------------------

class SupabaseDefaultsTest(unittest.TestCase):
    def test_defaults(self):
        with _env():
            cfg = SupabaseSettings()
        self.assertEqual(cfg.read_timeout, 90)
        self.assertEqual(cfg.page_size, 1_000)


class SupabaseEnvOverrideTest(unittest.TestCase):
    def test_read_timeout_via_env(self):
        with _env(GOONERS_SUPABASE_READ_TIMEOUT="120"):
            self.assertEqual(SupabaseSettings().read_timeout, 120)

    def test_page_size_via_env(self):
        with _env(GOONERS_SUPABASE_PAGE="500"):
            self.assertEqual(SupabaseSettings().page_size, 500)


class SupabaseValidationTest(unittest.TestCase):
    def test_read_timeout_below_min_raises(self):
        with self.assertRaises(ValidationError), _env(GOONERS_SUPABASE_READ_TIMEOUT="0"):
            SupabaseSettings()

    def test_page_size_above_max_raises(self):
        with self.assertRaises(ValidationError), _env(GOONERS_SUPABASE_PAGE="1001"):
            SupabaseSettings()

    def test_page_size_below_min_raises(self):
        with self.assertRaises(ValidationError), _env(GOONERS_SUPABASE_PAGE="0"):
            SupabaseSettings()


# ---------------------------------------------------------------------------
# CannonsCompsSettings
# ---------------------------------------------------------------------------

class CannonsCompsDefaultsTest(unittest.TestCase):
    def test_defaults(self):
        with _env():
            cfg = CannonsCompsSettings()
        self.assertEqual(cfg.top_k, 3)
        self.assertAlmostEqual(cfg.min_sim, 0.80)


class CannonsCompsEnvOverrideTest(unittest.TestCase):
    def test_top_k_via_env(self):
        with _env(GOONERS_CANNONS_COMPS_TOP_K="5"):
            self.assertEqual(CannonsCompsSettings().top_k, 5)

    def test_min_sim_via_env(self):
        with _env(GOONERS_CANNONS_COMPS_MIN_SIM="0.9"):
            self.assertAlmostEqual(CannonsCompsSettings().min_sim, 0.9)


class CannonsCompsValidationTest(unittest.TestCase):
    def test_top_k_below_min_raises(self):
        with self.assertRaises(ValidationError), _env(GOONERS_CANNONS_COMPS_TOP_K="0"):
            CannonsCompsSettings()

    def test_top_k_above_max_raises(self):
        with self.assertRaises(ValidationError), _env(GOONERS_CANNONS_COMPS_TOP_K="21"):
            CannonsCompsSettings()

    def test_min_sim_below_zero_raises(self):
        with self.assertRaises(ValidationError), _env(GOONERS_CANNONS_COMPS_MIN_SIM="-0.1"):
            CannonsCompsSettings()

    def test_min_sim_above_one_raises(self):
        with self.assertRaises(ValidationError), _env(GOONERS_CANNONS_COMPS_MIN_SIM="1.1"):
            CannonsCompsSettings()


# ---------------------------------------------------------------------------
# WarehouseSettings
# ---------------------------------------------------------------------------

class WarehouseDefaultsTest(unittest.TestCase):
    def test_defaults(self):
        with _env():
            cfg = WarehouseSettings()
        self.assertEqual(cfg.warehouse, "motherduck")
        self.assertFalse(cfg.motherduck_snapshots)


class WarehouseEnvOverrideTest(unittest.TestCase):
    def test_warehouse_supabase(self):
        with _env(GOONERS_WAREHOUSE="supabase"):
            self.assertEqual(WarehouseSettings().warehouse, "supabase")

    def test_warehouse_none(self):
        with _env(GOONERS_WAREHOUSE="none"):
            self.assertEqual(WarehouseSettings().warehouse, "none")

    def test_motherduck_snapshots_via_env(self):
        with _env(GOONERS_MOTHERDUCK_SNAPSHOTS="true"):
            self.assertTrue(WarehouseSettings().motherduck_snapshots)


class WarehouseValidationTest(unittest.TestCase):
    def test_invalid_warehouse_raises(self):
        with self.assertRaises(ValidationError), _env(GOONERS_WAREHOUSE="redshift"):
            WarehouseSettings()

    def test_warehouse_case_and_whitespace_normalised(self):
        with _env(GOONERS_WAREHOUSE="  Supabase "):
            self.assertEqual(WarehouseSettings().warehouse, "supabase")


# ---------------------------------------------------------------------------
# TelemetrySettings
# ---------------------------------------------------------------------------

class TelemetryDefaultsTest(unittest.TestCase):
    def test_defaults(self):
        with _env():
            cfg = TelemetrySettings()
        self.assertEqual(cfg.posthog_host, "")


class TelemetryEnvOverrideTest(unittest.TestCase):
    def test_posthog_host_via_env(self):
        with _env(GOONERS_POSTHOG_HOST="https://eu.i.posthog.com"):
            self.assertEqual(TelemetrySettings().posthog_host, "https://eu.i.posthog.com")


# ---------------------------------------------------------------------------
# Argparse default pattern: CLI > env > default
# ---------------------------------------------------------------------------

class ArgparseDefaultPatternTest(unittest.TestCase):
    """Verifies that default=cfg.field gives CLI > env > schema-default precedence."""

    def _make_parser(self):
        cfg = CannonsCompsSettings()
        parser = argparse.ArgumentParser()
        parser.add_argument("--top-k", type=int, default=cfg.top_k)
        parser.add_argument("--min-sim", type=float, default=cfg.min_sim)
        return parser

    def test_schema_default_when_nothing_set(self):
        with _env():
            parser = self._make_parser()
        args = parser.parse_args([])
        self.assertEqual(args.top_k, 3)
        self.assertAlmostEqual(args.min_sim, 0.80)

    def test_env_overrides_schema_default(self):
        with _env(GOONERS_CANNONS_COMPS_TOP_K="10", GOONERS_CANNONS_COMPS_MIN_SIM="0.9"):
            parser = self._make_parser()
        args = parser.parse_args([])
        self.assertEqual(args.top_k, 10)
        self.assertAlmostEqual(args.min_sim, 0.9)

    def test_cli_flag_overrides_env(self):
        with _env(GOONERS_CANNONS_COMPS_TOP_K="10"):
            parser = self._make_parser()
        args = parser.parse_args(["--top-k", "20"])
        self.assertEqual(args.top_k, 20)

    def test_fresh_construction_per_call(self):
        # No module-level cache: each call to Settings() reads os.environ fresh,
        # so patch.dict works correctly.
        with _env(GOONERS_CANNONS_COMPS_TOP_K="7"):
            self.assertEqual(CannonsCompsSettings().top_k, 7)
        with _env(GOONERS_CANNONS_COMPS_TOP_K="9"):
            self.assertEqual(CannonsCompsSettings().top_k, 9)


# ---------------------------------------------------------------------------
# describe() output
# ---------------------------------------------------------------------------

class DescribeTest(unittest.TestCase):
    def test_runs_without_error(self):
        buf = io.StringIO()
        describe(out=buf)
        output = buf.getvalue()
        self.assertGreater(len(output), 0)

    def test_all_section_headers_present(self):
        buf = io.StringIO()
        describe(out=buf)
        output = buf.getvalue()
        for header in [
            "EnrichmentSettings",
            "EbayCompsSettings",
            "EmbeddingSettings",
            "CannonsCompsSettings",
            "WarehouseSettings",
            "TelemetrySettings",
        ]:
            self.assertIn(header, output, f"Missing section: {header}")

    def test_env_var_names_present(self):
        buf = io.StringIO()
        describe(out=buf)
        output = buf.getvalue()
        for alias in [
            "GOONERS_ENRICHMENT",
            "GOONERS_ENRICHMENT_WORKERS",
            "GOONERS_MAX_IMAGES",
            "GOONERS_EBAY_COMPS_LIMIT",
            "GOONERS_NOMIC_EMBEDDINGS",
            "GOONERS_CANNONS_COMPS_TOP_K",
            "GOONERS_WAREHOUSE",
            "GOONERS_POSTHOG_HOST",
        ]:
            self.assertIn(alias, output, f"Missing env var: {alias}")

    def test_defaults_appear_in_output(self):
        buf = io.StringIO()
        describe(out=buf)
        output = buf.getvalue()
        # A few representative defaults
        self.assertIn("claude-haiku-4-5", output)
        self.assertIn("motherduck", output)


# ---------------------------------------------------------------------------
# secrets.py
# ---------------------------------------------------------------------------

class SecretsTest(unittest.TestCase):
    def test_anthropic_key_absent(self):
        with _env():
            self.assertIsNone(_secrets.anthropic_key())

    def test_anthropic_key_present(self):
        with _env(ANTHROPIC_API_KEY="sk-test"):
            self.assertEqual(_secrets.anthropic_key(), "sk-test")

    def test_anthropic_key_empty_string_is_none(self):
        with _env(ANTHROPIC_API_KEY=""):
            self.assertIsNone(_secrets.anthropic_key())

    def test_supabase_url_absent(self):
        with _env():
            self.assertIsNone(_secrets.supabase_url())

    def test_supabase_url_primary_var(self):
        with _env(SUPABASE_URL="https://abc.supabase.co"):
            self.assertEqual(_secrets.supabase_url(), "https://abc.supabase.co")

    def test_supabase_url_vite_fallback(self):
        with _env(VITE_SUPABASE_URL="https://abc.supabase.co"):
            self.assertEqual(_secrets.supabase_url(), "https://abc.supabase.co")

    def test_supabase_url_primary_takes_precedence(self):
        with _env(SUPABASE_URL="https://primary.supabase.co", VITE_SUPABASE_URL="https://vite.supabase.co"):
            self.assertEqual(_secrets.supabase_url(), "https://primary.supabase.co")

    def test_supabase_secret_key_absent(self):
        with _env():
            self.assertIsNone(_secrets.supabase_secret_key())

    def test_supabase_secret_key_present(self):
        with _env(SUPABASE_SECRET_KEY="sb_secret_abc"):
            self.assertEqual(_secrets.supabase_secret_key(), "sb_secret_abc")

    def test_supabase_creds_none_when_url_missing(self):
        with _env(SUPABASE_SECRET_KEY="sb_secret_abc"):
            self.assertIsNone(_secrets.supabase_creds())

    def test_supabase_creds_none_when_key_missing(self):
        with _env(SUPABASE_URL="https://abc.supabase.co"):
            self.assertIsNone(_secrets.supabase_creds())

    def test_supabase_creds_returns_tuple(self):
        with _env(SUPABASE_URL="https://abc.supabase.co", SUPABASE_SECRET_KEY="sb_secret_abc"):
            result = _secrets.supabase_creds()
        self.assertEqual(result, ("https://abc.supabase.co", "sb_secret_abc"))

    def test_soldcomps_key_absent(self):
        with _env():
            self.assertIsNone(_secrets.soldcomps_key())

    def test_soldcomps_key_present(self):
        with _env(SOLDCOMPS_API_KEY="sold-xyz"):
            self.assertEqual(_secrets.soldcomps_key(), "sold-xyz")

    def test_apify_key_absent(self):
        with _env():
            self.assertIsNone(_secrets.apify_key())

    def test_apify_key_present(self):
        with _env(APIFY_API_KEY="apify-xyz"):
            self.assertEqual(_secrets.apify_key(), "apify-xyz")

    def test_motherduck_token_absent(self):
        with _env():
            self.assertIsNone(_secrets.motherduck_token())

    def test_motherduck_token_present(self):
        with _env(MOTHERDUCK_TOKEN="md-tok"):
            self.assertEqual(_secrets.motherduck_token(), "md-tok")

    def test_posthog_key_absent(self):
        with _env():
            self.assertIsNone(_secrets.posthog_key())

    def test_posthog_key_present(self):
        with _env(GOONERS_POSTHOG_KEY="phc_test"):
            self.assertEqual(_secrets.posthog_key(), "phc_test")

    def test_posthog_key_whitespace_only_is_none(self):
        with _env(GOONERS_POSTHOG_KEY="   "):
            self.assertIsNone(_secrets.posthog_key())

    def test_posthog_personal_key_absent(self):
        with _env():
            self.assertIsNone(_secrets.posthog_personal_key())

    def test_posthog_personal_key_present(self):
        with _env(POSTHOG_PERSONAL_KEY="phx_admin"):
            self.assertEqual(_secrets.posthog_personal_key(), "phx_admin")

    def test_ebay_client_id_absent(self):
        with _env():
            self.assertIsNone(_secrets.ebay_client_id())

    def test_ebay_client_id_present(self):
        with _env(EBAY_CLIENT_ID="ebay-id-123"):
            self.assertEqual(_secrets.ebay_client_id(), "ebay-id-123")

    def test_ebay_client_secret_absent(self):
        with _env():
            self.assertIsNone(_secrets.ebay_client_secret())

    def test_ebay_client_secret_present(self):
        with _env(EBAY_CLIENT_SECRET="ebay-secret-456"):
            self.assertEqual(_secrets.ebay_client_secret(), "ebay-secret-456")

    def test_motherduck_database_default(self):
        with _env():
            self.assertEqual(_secrets.motherduck_database(), "my_db")

    def test_motherduck_database_via_env(self):
        with _env(MOTHERDUCK_DATABASE="prod_db"):
            self.assertEqual(_secrets.motherduck_database(), "prod_db")


if __name__ == "__main__":
    unittest.main()
