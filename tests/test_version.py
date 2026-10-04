import json
import re
from pathlib import Path
import unittest

import bounty_operator_kit

ROOT = Path(__file__).resolve().parent.parent
RELEASE = "0.7.4"


def _read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


class VersionTests(unittest.TestCase):
    def test_the_package_reports_the_release(self) -> None:
        self.assertEqual(bounty_operator_kit.__version__, RELEASE)

    def test_pyproject_carries_the_same_version_and_the_public_repository(self) -> None:
        pyproject = _read("pyproject.toml")
        match = re.search(r'^version = "([^"]+)"$', pyproject, re.MULTILINE)
        self.assertIsNotNone(match)
        self.assertEqual(match.group(1), bounty_operator_kit.__version__)
        urls = re.findall(r'^(\w+) = "(https://[^"]+)"$', pyproject, re.MULTILINE)
        self.assertEqual(dict(urls)["Homepage"], "https://bountyoperator.com/")
        for name in ("Documentation", "Changelog", "Repository", "Issues"):
            self.assertTrue(dict(urls)[name].startswith("https://github.com/bountyoperator/bounty-operator"), name)

    def test_every_package_in_the_repository_is_on_the_same_version(self) -> None:
        # The files exist in a checkout. An installed wheel carries the Python package only.
        versions = {}
        for relative, pick in [
            ("mcp/package.json", lambda data: data["version"]),
            ("mcp/server.json", lambda data: data["version"]),
            ("mcp/server.json#package", lambda data: data["packages"][0]["version"]),
            ("web/package.json", lambda data: data["version"]),
        ]:
            path = ROOT / relative.split("#")[0]
            if path.is_file():
                versions[relative] = pick(json.loads(path.read_text(encoding="utf-8")))
        for relative, version in versions.items():
            self.assertEqual(version, RELEASE, relative)

        worker = ROOT / "web" / "src" / "env.ts"
        if worker.is_file():
            self.assertIn(f"export const VERSION = '{RELEASE}';", worker.read_text(encoding="utf-8"))

        changelog = ROOT / "CHANGELOG.md"
        if changelog.is_file():
            first = re.search(r"^## (\S+) ", changelog.read_text(encoding="utf-8"), re.MULTILINE)
            self.assertIsNotNone(first)
            self.assertEqual(first.group(1), RELEASE)

    def test_install_lines_name_the_release_tag_of_the_public_repository(self) -> None:
        readme = ROOT / "README.md"
        if not readme.is_file():
            self.skipTest("README.md is not part of an installed package")
        text = readme.read_text(encoding="utf-8")
        self.assertIn(f'pip install "git+https://github.com/bountyoperator/bounty-operator@v{RELEASE}"', text)
        self.assertNotIn("bounty-operator-kit@", text)
        # Every link to this project's repository names the public organisation.
        owners = set(re.findall(r"github\.com/([^/\s\"'<>)]+)/bounty-operator(?:-kit)?(?![\w-])", text))
        self.assertEqual(owners, {"bountyoperator"})


if __name__ == "__main__":
    unittest.main()
