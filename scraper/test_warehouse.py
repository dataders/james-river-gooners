import os
import unittest
from unittest.mock import patch

import warehouse


class ResolveDatabaseTest(unittest.TestCase):
    def test_explicit_database_wins(self):
        self.assertEqual(warehouse.resolve_database("local.duckdb"), "local.duckdb")

    def test_defaults_to_motherduck(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(warehouse.resolve_database(), "md:")

    def test_uses_env_database(self):
        with patch.dict(os.environ, {"MOTHERDUCK_DATABASE": "md:custom"}, clear=True):
            self.assertEqual(warehouse.resolve_database(), "md:custom")


class TokenGuardTest(unittest.TestCase):
    def test_motherduck_without_token_raises(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "MOTHERDUCK_TOKEN"):
                warehouse.require_motherduck_token("md:", "do a thing")

    def test_local_database_never_requires_token(self):
        with patch.dict(os.environ, {}, clear=True):
            warehouse.require_motherduck_token("local.duckdb")  # no raise

    def test_motherduck_with_token_ok(self):
        with patch.dict(os.environ, {"MOTHERDUCK_TOKEN": "t"}, clear=True):
            warehouse.require_motherduck_token("md:")  # no raise


class WarehouseKindTest(unittest.TestCase):
    def test_defaults_to_motherduck(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(warehouse.warehouse_kind(), "motherduck")

    def test_reads_env_case_insensitively(self):
        with patch.dict(os.environ, {"GOONERS_WAREHOUSE": "  Supabase "}, clear=True):
            self.assertEqual(warehouse.warehouse_kind(), "supabase")


class GetSinkTest(unittest.TestCase):
    def test_disabled_returns_none(self):
        with patch.dict(os.environ, {"GOONERS_WAREHOUSE": "none"}, clear=True):
            self.assertIsNone(warehouse.get_sink())

    def test_motherduck_returns_sink(self):
        with patch.dict(os.environ, {"GOONERS_WAREHOUSE": "motherduck"}, clear=True):
            self.assertIsInstance(warehouse.get_sink(), warehouse.MotherDuckSink)

    def test_supabase_not_implemented_yet(self):
        with patch.dict(os.environ, {"GOONERS_WAREHOUSE": "supabase"}, clear=True):
            with self.assertRaises(NotImplementedError):
                warehouse.get_sink()

    def test_unknown_kind_raises(self):
        with patch.dict(os.environ, {"GOONERS_WAREHOUSE": "snowflake"}, clear=True):
            with self.assertRaises(ValueError):
                warehouse.get_sink()


class MotherDuckSinkTest(unittest.TestCase):
    def test_listing_append_enforces_token_guard(self):
        sink = warehouse.MotherDuckSink()
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "MOTHERDUCK_TOKEN"):
                sink.append_listing_snapshots([{"id": "x"}], "https://example.test")


if __name__ == "__main__":
    unittest.main()
