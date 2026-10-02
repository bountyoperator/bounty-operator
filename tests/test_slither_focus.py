import io
import json
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from bounty_operator_kit.cli import main
from bounty_operator_kit.slither_focus import DEFAULT_CHECKS, clean_scan, format_markdown, format_text, load_slither


class SlitherFocusTests(unittest.TestCase):
    def test_filters_to_selected_check(self) -> None:
        data = {
            "results": {
                "detectors": [
                    {
                        "check": "unused-return",
                        "impact": "Medium",
                        "confidence": "High",
                        "description": "Ignored return value",
                        "elements": [
                            {
                                "name": "transfer",
                                "source_mapping": {
                                    "filename_relative": "contracts/Vault.sol",
                                    "lines": [42],
                                },
                            }
                        ],
                    },
                    {
                        "check": "naming-convention",
                        "impact": "Informational",
                        "confidence": "High",
                        "description": "Style",
                        "elements": [],
                    },
                ]
            }
        }
        output = format_text(data, {"unused-return"})
        self.assertIn("unused-return", output)
        self.assertIn("contracts/Vault.sol:42", output)
        self.assertNotIn("naming-convention", output)

    def test_clean_scan_reads_as_an_empty_queue(self) -> None:
        # What Slither writes when a run succeeds and no detector fires.
        clean = {"success": True, "error": None, "results": {}}
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "slither.json"
            path.write_text(json.dumps(clean), encoding="utf-8")
            data = load_slither(path)
        self.assertEqual(data["results"]["detectors"], [])
        self.assertEqual(format_text(data, DEFAULT_CHECKS), "No matching Slither detectors found.\n")
        self.assertEqual(format_markdown(data, DEFAULT_CHECKS), "# Slither Focus\n\nNo matching Slither detectors found.\n")
        # The file's own object is left as it was read.
        self.assertEqual(clean, {"success": True, "error": None, "results": {}})

    def test_clean_scan_keeps_the_other_result_keys(self) -> None:
        data = clean_scan({"success": True, "results": {"printers": []}})
        self.assertEqual(data, {"success": True, "results": {"printers": [], "detectors": []}})
        listed = {"success": True, "results": {"detectors": [{"check": "unused-return"}]}}
        self.assertIs(clean_scan(listed), listed)

    def test_only_a_successful_run_reads_as_clean(self) -> None:
        cases = [
            {"success": False, "error": "compilation failed", "results": {}},
            {"results": {}},
            {"success": "true", "results": {}},
            {"success": True},
            {"success": True, "results": []},
            {"success": True, "results": None},
            [],
        ]
        for case in cases:
            with self.subTest(case=case), TemporaryDirectory() as tmp:
                path = Path(tmp) / "slither.json"
                path.write_text(json.dumps(case), encoding="utf-8")
                with self.assertRaises(ValueError):
                    load_slither(path)

    def test_cli_prints_an_empty_queue_for_a_clean_scan(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "slither.json"
            path.write_text('{"success": true, "error": null, "results": {}}', encoding="utf-8")
            for flags, expected in [([], "No matching Slither detectors found.\n"), (["--markdown"], "# Slither Focus\n\nNo matching Slither detectors found.\n")]:
                stdout, stderr = io.StringIO(), io.StringIO()
                with self.subTest(flags=flags), redirect_stdout(stdout), redirect_stderr(stderr):
                    self.assertEqual(main(["slither-focus", str(path), *flags]), 0)
                self.assertEqual(stdout.getvalue(), expected)
                self.assertEqual(stderr.getvalue(), "")

            failed = Path(tmp) / "failed.json"
            failed.write_text('{"success": false, "error": "compilation failed", "results": {}}', encoding="utf-8")
            stderr = io.StringIO()
            with redirect_stderr(stderr):
                self.assertEqual(main(["slither-focus", str(failed)]), 2)
            self.assertNotIn("Traceback", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
