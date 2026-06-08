import struct
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

import embed
from embed import generate_and_write, read_embeddings, write_embeddings


DIM = 8


def _fake_embed_items(items, session=None):
    """Deterministic stand-in for the CLIP model: vector i is all-(hash) so we
    can assert which ids were (re)embedded, and record the call."""
    ids = [it["id"] for it in items]
    embs = np.array(
        [[float(hash(iid) % 100)] * DIM for iid in ids], dtype=np.float32
    )
    return embs, ids


class EmbeddingsRoundTripTest(unittest.TestCase):
    def test_write_and_read_round_trip(self):
        embs = np.random.randn(10, 512).astype(np.float32)
        ids = [f"item-{i}" for i in range(10)]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "test.embeddings"
            write_embeddings(embs, ids, path)
            loaded_embs, loaded_ids = read_embeddings(path)
        np.testing.assert_array_almost_equal(embs, loaded_embs)
        self.assertEqual(ids, loaded_ids)

    def test_header_encodes_shape(self):
        import struct
        embs = np.zeros((5, 512), dtype=np.float32)
        ids = [str(i) for i in range(5)]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "test.embeddings"
            write_embeddings(embs, ids, path)
            data = path.read_bytes()
        n_items, n_dims = struct.unpack_from("<II", data, 0)
        self.assertEqual(n_items, 5)
        self.assertEqual(n_dims, 512)

    def test_ids_stored_as_json_at_end(self):
        import json
        embs = np.zeros((3, 512), dtype=np.float32)
        ids = ["abc", "def", "ghi"]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "test.embeddings"
            write_embeddings(embs, ids, path)
            data = path.read_bytes()
        float_bytes = 3 * 512 * 4
        tail = data[8 + float_bytes:].decode("utf-8")
        self.assertEqual(json.loads(tail), ids)


    def test_read_embeddings_raises_on_truncated_header(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.embeddings"
            path.write_bytes(b"\x01\x02")  # less than 8 bytes
            with self.assertRaises(ValueError):
                read_embeddings(path)

    def test_read_embeddings_raises_on_truncated_body(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.embeddings"
            # Header says 10 items × 512 dims but body is empty
            path.write_bytes(struct.pack("<II", 10, 512))
            with self.assertRaises(ValueError):
                read_embeddings(path)


class IncrementalGenerateTest(unittest.TestCase):
    def _items(self, ids):
        return [{"id": i, "title": i, "description": "", "images": []} for i in ids]

    def test_first_run_embeds_all(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / "auction.parquet"
            with mock.patch.object(embed, "embed_items", side_effect=_fake_embed_items) as m:
                generate_and_write(self._items(["a", "b", "c"]), base)
            # embed_items called once with all three items
            self.assertEqual(m.call_count, 1)
            self.assertEqual([it["id"] for it in m.call_args.args[0]], ["a", "b", "c"])
            embs, ids = read_embeddings(base.with_suffix(".embeddings"))
            self.assertEqual(ids, ["a", "b", "c"])

    def test_unchanged_rerun_embeds_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / "auction.parquet"
            with mock.patch.object(embed, "embed_items", side_effect=_fake_embed_items):
                generate_and_write(self._items(["a", "b", "c"]), base)
            # Second run, identical ids → model never invoked
            with mock.patch.object(embed, "embed_items", side_effect=_fake_embed_items) as m:
                generate_and_write(self._items(["a", "b", "c"]), base)
            m.assert_not_called()
            embs, ids = read_embeddings(base.with_suffix(".embeddings"))
            self.assertEqual(ids, ["a", "b", "c"])

    def test_only_new_ids_are_embedded(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / "auction.parquet"
            with mock.patch.object(embed, "embed_items", side_effect=_fake_embed_items):
                generate_and_write(self._items(["a", "b"]), base)
            old_embs, _ = read_embeddings(base.with_suffix(".embeddings"))
            old_a = old_embs[0].copy()
            # Add "c", keep "a"/"b" → only "c" goes through the model
            with mock.patch.object(embed, "embed_items", side_effect=_fake_embed_items) as m:
                generate_and_write(self._items(["a", "b", "c"]), base)
            self.assertEqual(m.call_count, 1)
            self.assertEqual([it["id"] for it in m.call_args.args[0]], ["c"])
            embs, ids = read_embeddings(base.with_suffix(".embeddings"))
            self.assertEqual(ids, ["a", "b", "c"])
            # "a"'s reused vector is byte-identical to the original
            np.testing.assert_array_equal(embs[0], old_a)

    def test_reuse_false_forces_full_regeneration(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / "auction.parquet"
            with mock.patch.object(embed, "embed_items", side_effect=_fake_embed_items):
                generate_and_write(self._items(["a", "b"]), base)
            with mock.patch.object(embed, "embed_items", side_effect=_fake_embed_items) as m:
                generate_and_write(self._items(["a", "b"]), base, reuse=False)
            m.assert_called_once()
            self.assertEqual([it["id"] for it in m.call_args.args[0]], ["a", "b"])


if __name__ == "__main__":
    unittest.main()
