import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import embed_nomic
import numpy as np


def _items(ids):
    return [{"id": i, "title": i, "description": "", "images": []} for i in ids]


def _fake_embed_items(items, session=None):
    ids = [it["id"] for it in items]
    embs = np.zeros((len(ids), 768), dtype=np.float32)
    return embs, ids, [0] * len(ids)


class SupabaseUserAgentTest(unittest.TestCase):
    """Supabase rejects the secret key from a browser-looking request; the
    scrapers pass a Chrome-UA session, so the embed REST calls must override UA."""

    def _capture_get(self, session):
        captured = {}

        def fake_get(url, headers=None, params=None, timeout=None):
            captured["headers"] = headers
            resp = mock.Mock(status_code=200)
            resp.raise_for_status = mock.Mock()
            resp.json = mock.Mock(return_value=[])
            return resp

        session.get = fake_get
        return captured

    def test_existing_item_ids_overrides_user_agent(self):
        session = mock.Mock()
        captured = self._capture_get(session)
        with mock.patch(
            "supabase_comps.resolve_credentials",
            return_value=("https://x.supabase.co", "sb_secret_x"),
        ):
            embed_nomic.existing_item_ids("auc", session=session)
        self.assertEqual(
            captured["headers"].get("User-Agent"), embed_nomic._SUPABASE_UA
        )
        self.assertNotIn("Mozilla", captured["headers"].get("User-Agent", ""))

    def test_upsert_overrides_user_agent(self):
        session = mock.Mock()
        captured = {}

        def fake_post(url, headers=None, data=None, timeout=None):
            captured["headers"] = headers
            return mock.Mock(status_code=200)

        session.post = fake_post
        with mock.patch(
            "supabase_comps.resolve_credentials",
            return_value=("https://x.supabase.co", "sb_secret_x"),
        ):
            embed_nomic.upsert_embeddings(
                np.zeros((1, 768), dtype=np.float32), ["a"], [0], "auc", session=session
            )
        self.assertEqual(
            captured["headers"].get("User-Agent"), embed_nomic._SUPABASE_UA
        )


class NomicIncrementalTest(unittest.TestCase):
    def setUp(self):
        self.env = mock.patch.dict(
            os.environ,
            {"GOONERS_NOMIC_EMBEDDINGS": "1", "SUPABASE_SECRET_KEY": "secret"},
        )
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_noop_without_flag(self):
        with mock.patch.dict(os.environ, {"GOONERS_NOMIC_EMBEDDINGS": "0"}):
            with mock.patch.object(embed_nomic, "embed_items") as m:
                embed_nomic.maybe_generate_and_upsert(_items(["a"]), "auc")
            m.assert_not_called()

    def test_noop_without_secret_key(self):
        with mock.patch.dict(os.environ, {"SUPABASE_SECRET_KEY": ""}, clear=False):
            os.environ.pop("SUPABASE_SECRET_KEY", None)
            with mock.patch.object(embed_nomic, "embed_items") as m:
                embed_nomic.maybe_generate_and_upsert(_items(["a"]), "auc")
            m.assert_not_called()

    def test_only_new_lots_embedded(self):
        with (
            mock.patch.object(
                embed_nomic, "existing_item_ids", return_value={"a", "b"}
            ),
            mock.patch.object(
                embed_nomic, "embed_items", side_effect=_fake_embed_items
            ) as m_embed,
            mock.patch.object(embed_nomic, "upsert_embeddings", return_value=1) as m_up,
        ):
            embed_nomic.maybe_generate_and_upsert(_items(["a", "b", "c"]), "auc")
        m_embed.assert_called_once()
        self.assertEqual([it["id"] for it in m_embed.call_args.args[0]], ["c"])
        m_up.assert_called_once()

    def test_all_already_embedded_skips_model(self):
        with (
            mock.patch.object(
                embed_nomic, "existing_item_ids", return_value={"a", "b"}
            ),
            mock.patch.object(embed_nomic, "embed_items") as m_embed,
            mock.patch.object(embed_nomic, "upsert_embeddings") as m_up,
        ):
            embed_nomic.maybe_generate_and_upsert(_items(["a", "b"]), "auc")
        m_embed.assert_not_called()
        m_up.assert_not_called()

    def test_read_failure_falls_back_to_embedding_all(self):
        with (
            mock.patch.object(
                embed_nomic, "existing_item_ids", side_effect=RuntimeError("boom")
            ),
            mock.patch.object(
                embed_nomic, "embed_items", side_effect=_fake_embed_items
            ) as m_embed,
            mock.patch.object(embed_nomic, "upsert_embeddings", return_value=2),
        ):
            embed_nomic.maybe_generate_and_upsert(_items(["a", "b"]), "auc")
        m_embed.assert_called_once()
        self.assertEqual([it["id"] for it in m_embed.call_args.args[0]], ["a", "b"])


class NomicBackfillTest(unittest.TestCase):
    def test_backfill_iterates_active_sidecars(self):
        with (
            tempfile.TemporaryDirectory() as tmp,
            mock.patch.dict(os.environ, {"SUPABASE_SECRET_KEY": "secret"}),
        ):
            items_dir = Path(tmp)
            (items_dir / "auc1.ndjson").write_text(
                "\n".join(json.dumps({"id": i, "title": i}) for i in ["a", "b"]) + "\n"
            )
            (items_dir / "auc2.ndjson").write_text(
                json.dumps({"id": "x", "title": "x"}) + "\n"
            )

            calls = []

            def _fake_gen(items, safe_id, session=None, force=False, batch_size=None):
                calls.append((safe_id, [it["id"] for it in items]))
                return len(items)

            with (
                mock.patch.object(embed_nomic, "_ACTIVE_ITEMS_DIR", items_dir),
                mock.patch.object(
                    embed_nomic, "generate_and_upsert", side_effect=_fake_gen
                ),
            ):
                total = embed_nomic.backfill_from_read_model()

        self.assertEqual(total, 3)
        self.assertEqual(sorted(calls), [("auc1", ["a", "b"]), ("auc2", ["x"])])

    def test_backfill_requires_secret_key(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SUPABASE_SECRET_KEY", None)
            with self.assertRaises(RuntimeError):
                embed_nomic.backfill_from_read_model()


if __name__ == "__main__":
    unittest.main()
