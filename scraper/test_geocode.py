import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

import geocode
from geocode import GeocodeError, normalize_key, parse_location, resolve


class NormalizeKeyTest(unittest.TestCase):
    def test_lowercases_and_trims(self):
        self.assertEqual(normalize_key("  Richmond ", "VA "), "richmond, va")

    def test_stable_across_case(self):
        self.assertEqual(
            normalize_key("MIDLOTHIAN", "va"), normalize_key("midlothian", "VA")
        )


class ParseLocationTest(unittest.TestCase):
    def test_parses_city_state(self):
        self.assertEqual(parse_location("Chesapeake, VA"), ("Chesapeake", "VA"))

    def test_extra_whitespace(self):
        self.assertEqual(parse_location("  Glen Allen ,  VA "), ("Glen Allen", "VA"))

    def test_malformed_raises(self):
        with self.assertRaises(GeocodeError):
            parse_location("Richmond")
        with self.assertRaises(GeocodeError):
            parse_location("")


class ResolveTest(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.cache_path = Path(self._tmp.name) / "geocode_cache.yml"
        self.cache_path.write_text("richmond, va:\n  lat: 37.5407\n  lng: -77.436\n")

    def tearDown(self):
        self._tmp.cleanup()

    def test_cache_hit_returns_coords(self):
        self.assertEqual(
            resolve("Richmond", "VA", cache_path=self.cache_path, online=False),
            (37.5407, -77.436),
        )

    def test_cache_hit_is_case_insensitive(self):
        lat, lng = resolve("richmond", "va", cache_path=self.cache_path, online=False)
        self.assertEqual((lat, lng), (37.5407, -77.436))

    def test_missing_city_raises(self):
        with self.assertRaises(GeocodeError):
            resolve("", "VA", cache_path=self.cache_path, online=False)

    def test_cache_miss_offline_raises(self):
        with self.assertRaises(GeocodeError):
            resolve("Nowhere", "VA", cache_path=self.cache_path, online=False)

    def test_cache_miss_online_resolves_and_appends(self):
        with mock.patch.object(
            geocode, "_nominatim_lookup", return_value=(36.85, -76.29)
        ) as look:
            coords = resolve("Norfolk", "VA", cache_path=self.cache_path, online=True)
        self.assertEqual(coords, (36.85, -76.29))
        look.assert_called_once()
        # Persisted to the cache file so a subsequent offline resolve hits.
        again = resolve("Norfolk", "VA", cache_path=self.cache_path, online=False)
        self.assertEqual(again, (36.85, -76.29))

    def test_online_gated_by_env(self):
        # online defaults from GOONERS_GEOCODE_ONLINE; unset => offline => raises.
        with mock.patch.dict("os.environ", {}, clear=False):
            import os as _os

            _os.environ.pop("GOONERS_GEOCODE_ONLINE", None)
            with self.assertRaises(GeocodeError):
                resolve("Nowhere", "VA", cache_path=self.cache_path)


if __name__ == "__main__":
    unittest.main()
