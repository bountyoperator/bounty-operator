import json
import unittest

from bounty_operator_kit.pattern_stats import format_pattern_stats, load_pattern_stats, pattern_stats_json


class PatternStatsTests(unittest.TestCase):
    def test_bundled_data_reconciles_metadata(self) -> None:
        data = load_pattern_stats()
        self.assertEqual(data["total_findings"], 1032)
        self.assertEqual(data["contests_included"], 10)
        self.assertEqual(data["patterns"]["reentrancy"]["total"], 51)

    def test_text_output_points_to_the_duplicate_check(self) -> None:
        output = format_pattern_stats(["rounding"])
        self.assertIn("rounding", output)
        self.assertIn("bounty-kit prior-art", output)
        self.assertNotIn("reentrancy", output)

    def test_json_output_filters_patterns(self) -> None:
        output = json.loads(pattern_stats_json(["access-control"]))
        self.assertEqual(list(output["patterns"]), ["access-control"])
        self.assertIn("bounty-kit prior-art", output["note"])

    def test_unknown_pattern_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            format_pattern_stats(["not-a-real-pattern"])


if __name__ == "__main__":
    unittest.main()
