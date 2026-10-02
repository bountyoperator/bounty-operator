import hashlib
import io
import json
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from bounty_operator_kit.ai_review import AIReviewConfig, prepare_review, send_review
from bounty_operator_kit.cli import main
from bounty_operator_kit.file_io import read_text_limited, write_text
from bounty_operator_kit.sanitize import scan_report, scan_text
from bounty_operator_kit.slither_focus import format_text


class InputSafetyTests(unittest.TestCase):
    def test_generated_output_preserves_existing_file_and_failed_write_leaves_no_partial(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "notes.md"
            write_text(path, "original")
            with self.assertRaises(ValueError):
                write_text(path, "replacement")
            self.assertEqual(path.read_text(encoding="utf-8"), "original")
            write_text(path, "replacement", force=True)
            self.assertEqual(path.read_text(encoding="utf-8"), "replacement")
            incomplete = Path(tmp) / "incomplete.md"
            with self.assertRaises(UnicodeEncodeError):
                write_text(incomplete, "\ud800")
            self.assertFalse(incomplete.exists())

    def test_binary_oversize_invalid_and_missing_inputs_cannot_look_clean(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "binary.dat").write_bytes(b"a\x00b")
            (root / "large.dat").write_bytes(b"x" * 30)
            (root / "invalid.dat").write_bytes(b"\xff")
            report = scan_report([root, root / "missing"], max_bytes=20)
        self.assertFalse(report.complete)
        self.assertEqual({f.kind for f in report.findings},
                         {"binary-file", "oversized-file", "invalid-encoding", "missing-path"})

    def test_unknown_suffix_is_checked_and_ignored_directory_is_reported(self):
        secret = "sk-" + "a" * 24
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "source.custom").write_text(secret, encoding="utf-8")
            ignored = root / "node_modules"
            ignored.mkdir()
            (ignored / "private.txt").write_text(secret, encoding="utf-8")
            report = scan_report([root])
            self.assertEqual(report.files_scanned, 1)
            self.assertEqual(len(report.skipped), 1)
            self.assertFalse(report.complete)
            self.assertEqual(report.findings[0].kind, "openai-key")
            self.assertNotIn(secret, json.dumps(report.to_dict()))

    def test_sensitive_paths_templates_and_aggregate_budget(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            template = root / ".env.example"
            template.write_text("PUBLIC_SETTING=example", encoding="utf-8")
            private = root / ".env.production"
            private.write_text("PUBLIC_SETTING=example", encoding="utf-8")
            self.assertTrue(scan_report([template]).complete)
            self.assertEqual(scan_report([private]).findings[0].kind, "sensitive-path")
            a, b = root / "a", root / "b"
            a.write_text("aa", encoding="utf-8")
            b.write_text("bb", encoding="utf-8")
            report = scan_report([a, b], max_total_bytes=3)
            self.assertEqual(report.files_scanned, 1)
            self.assertEqual(report.findings[0].kind, "scan-limit")
            self.assertFalse(report.complete)

    def test_linked_input_is_not_read_or_overwritten(self):
        with TemporaryDirectory() as tmp:
            target, link = Path(tmp) / "target", Path(tmp) / "link"
            target.write_text("original", encoding="utf-8")
            try:
                link.symlink_to(target)
            except OSError:
                self.skipTest("Creating symlinks is not enabled on this host")
            with self.assertRaises(ValueError):
                read_text_limited(link)
            with self.assertRaises(ValueError):
                write_text(link, "replacement", force=True)
            self.assertEqual(target.read_text(encoding="utf-8"), "original")
            self.assertEqual(scan_report([link]).findings[0].kind, "symlink")

    def test_preview_is_network_free_and_snapshot_hash_matches_uploaded_text(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "code.py"
            path.write_text("print(1)", encoding="utf-8")
            prepared = prepare_review([path], "", AIReviewConfig())
            path.write_text("print(2)", encoding="utf-8")
            self.assertIn("print(1)", prepared.messages[1]["content"])
            self.assertNotIn("print(2)", prepared.messages[1]["content"])
            self.assertEqual(prepared.manifest[0]["sha256"], hashlib.sha256(b"print(1)").hexdigest())
            stdout = io.StringIO()
            with patch("bounty_operator_kit.ai_review._open_request", side_effect=AssertionError("Network used")), redirect_stdout(stdout):
                self.assertEqual(main(["ai-review", str(path), "--dry-run"]), 0)
            self.assertFalse(json.loads(stdout.getvalue())["network_request_sent"])

    def test_upstream_errors_and_response_shapes_do_not_echo_sensitive_body(self):
        config = AIReviewConfig(max_response_bytes=200)
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "code.py"
            path.write_text("print(1)", encoding="utf-8")
            prepared = prepare_review([path], "", config)
        secret = "sk-" + "a" * 24
        error = HTTPError("https://api.example.test", 400, "Rejected", {}, io.BytesIO(secret.encode()))
        with patch("bounty_operator_kit.ai_review._open_request", side_effect=error):
            with self.assertRaises(ValueError) as caught:
                send_review(prepared, config, "provided-key")
        self.assertNotIn(secret, str(caught.exception))
        for body in [b"x" * 201, b'{"choices":[{"message":{"content":[]}}]}']:
            with self.subTest(body_length=len(body)), patch("bounty_operator_kit.ai_review._open_request", return_value=io.BytesIO(body)):
                with self.assertRaises(ValueError):
                    send_review(prepared, config, "provided-key")

    def test_failed_scanner_and_cli_missing_file_are_errors(self):
        for data in [{"success": False, "results": {"detectors": []}}, {"results": {"detectors": {}}}]:
            with self.assertRaises(ValueError):
                format_text(data, {"unused-return"})
        with TemporaryDirectory() as tmp:
            stderr = io.StringIO()
            with redirect_stderr(stderr):
                self.assertEqual(main(["slither-focus", str(Path(tmp) / "missing")]), 2)
            self.assertNotIn("Traceback", stderr.getvalue())

    def test_stripe_and_webhook_secrets_are_flagged_without_echo(self):
        for prefix, expected in [("sk_" + "live_", "stripe-key"), ("rk_" + "live_", "stripe-key"), ("wh" + "sec_", "webhook-secret")]:
            secret = prefix + "x" * 24
            findings = scan_text(secret, honor_allow_comments=False)
            self.assertEqual(findings[0].kind, expected)
            self.assertNotIn(secret, json.dumps([f.to_dict() for f in findings]))


if __name__ == "__main__":
    unittest.main()
