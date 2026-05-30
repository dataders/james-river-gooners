import struct
import tempfile
import unittest
from pathlib import Path

import numpy as np

from embed import read_embeddings, write_embeddings


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
        import struct
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


if __name__ == "__main__":
    unittest.main()
