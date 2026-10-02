from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from bounty_operator_kit.sanitize import scan_paths, scan_text


class SanitizeTests(unittest.TestCase):
    def test_flags_private_submission_url(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "note.md"
            url = "https://bugs." + "immunefi.com/dashboard/submission/12345"
            path.write_text(f"see {url}\n", encoding="utf-8")
            findings = scan_paths([path])
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].kind, "private-platform-url")

    def test_allows_clean_file(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "README.md"
            path.write_text("plain public docs\n", encoding="utf-8")
            findings = scan_paths([path])
        self.assertEqual(findings, [])

    def test_scan_text_checks_non_file_input(self) -> None:
        findings = scan_text("token=" + "sk-proj-" + "x" * 24, source="prompt")
        self.assertEqual(findings[0].path, "prompt")
        self.assertEqual(findings[0].kind, "openai-key")


if __name__ == "__main__":
    unittest.main()
