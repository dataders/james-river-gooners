import unittest

from categories import normalize_category, normalize_raw_with_description


class NormalizeCategoryFallbackTest(unittest.TestCase):
    """Precedence: raw_aliases/groups win; description inference is the fallback
    whenever the raw category resolves to no group — empty, "Other", or an
    unrecognized crumb alike."""

    def test_recognized_crumb_wins_over_description(self):
        # Crumb maps cleanly to a group; description must not override it.
        self.assertEqual(
            normalize_category("Coins & Currency", "vintage action figure lot"),
            "Coins & Currency",
        )

    def test_empty_crumb_falls_back_to_description(self):
        self.assertEqual(
            normalize_category("", "vintage action figure lot"),
            "Toys & Games",
        )

    def test_literal_other_crumb_falls_back_to_description(self):
        self.assertEqual(
            normalize_category("Other", "vintage action figure lot"),
            "Toys & Games",
        )

    def test_unrecognized_crumb_falls_back_to_description(self):
        # Regression: a non-empty but unrecognized crumb used to short-circuit
        # inference and return "Other". It must now fall through to keywords.
        self.assertEqual(
            normalize_category("Gizmos", "vintage action figure lot"),
            "Toys & Games",
        )

    def test_unrecognized_crumb_with_no_keyword_match_is_other(self):
        self.assertEqual(
            normalize_category("Gizmos", "an utterly uncategorizable widget"),
            "Other",
        )


class NormalizeRawWithDescriptionTest(unittest.TestCase):
    def test_recognized_crumb_returns_canonical(self):
        self.assertEqual(
            normalize_raw_with_description("Coins & Currency", ""),
            "Coins & Currency",
        )

    def test_empty_crumb_infers_raw_from_description(self):
        self.assertEqual(
            normalize_raw_with_description("", "vintage action figure lot"),
            "Toys & Games",
        )


if __name__ == "__main__":
    unittest.main()
