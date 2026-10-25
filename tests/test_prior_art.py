import os
from pathlib import Path
import shlex
import shutil
import subprocess
from tempfile import TemporaryDirectory
import unittest

from bounty_operator_kit.prior_art import build_prior_art_checklist


def local_commands(checklist: str) -> list[list[str]]:
    block = checklist.split("```bash\n", 1)[1].split("```", 1)[0]
    return [shlex.split(line) for line in block.splitlines() if line]


class PriorArtTests(unittest.TestCase):
    def test_title_comes_from_the_first_non_empty_heading(self) -> None:
        checklist = build_prior_art_checklist(summary="\n## Rounding drains the pool ##\nbody\n", target="Vault")
        self.assertIn("Finding: Rounding drains the pool\n", checklist)

    def test_local_searches_take_the_title_and_target_literally(self) -> None:
        # As a regex, "withdraw()" misses its own text and "[" is a syntax error; a leading "-" reads as a flag.
        titles = (
            ("Reentrancy in withdraw() drains the vault", r"Reentrancy in withdraw\(\) drains the vault"),
            ("Unchecked index in balances[ overflows", r"Unchecked index in balances\[ overflows"),
            ("- missing check", "- missing check"),
            ("Owner's $fee can reach 100%", r"Owner's \$fee can reach 100%"),
        )
        for title, pattern in titles:
            with self.subTest(title=title):
                checklist = build_prior_art_checklist(summary=f"# {title}\n", target="Vault (v2)")
                rg_title, rg_target, grep, history = local_commands(checklist)
                self.assertEqual(rg_title, ["rg", "-n", "-i", "-F", "-e", title, "."])
                self.assertEqual(rg_target, ["rg", "-n", "-i", "-F", "-e", "Vault (v2)", "."])
                self.assertEqual(grep, ["git", "log", "--oneline", "--all", "-i", "-F", f"--grep={title}"])
                self.assertEqual(history, ["git", "log", "--oneline", "--all", "-i", f"-G{pattern}", "--", "."])

    @unittest.skipUnless(shutil.which("git"), "git is not installed")
    def test_history_search_finds_a_fix_that_edits_the_line_and_keeps_the_title(self) -> None:
        title = "Reentrancy in withdraw() drains the vault"
        env = {
            **os.environ,
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": "test",
            "GIT_AUTHOR_EMAIL": "test" + "@example.test",
            "GIT_COMMITTER_NAME": "test",
            "GIT_COMMITTER_EMAIL": "test" + "@example.test",
        }
        with TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            def run(argv: list[str]) -> str:
                return subprocess.run(argv, cwd=tmp, env=env, check=True, capture_output=True, text=True).stdout

            notes = Path(tmp) / "KNOWN.md"
            run(["git", "init", "-q"])
            notes.write_text(f"Open: {title}\n", encoding="utf-8")
            run(["git", "add", "KNOWN.md"])
            run(["git", "commit", "-q", "-m", "Record the issue"])
            notes.write_text(f"Fixed: {title}\n", encoding="utf-8")
            run(["git", "commit", "-q", "-am", "Close the issue"])
            history = local_commands(build_prior_art_checklist(summary=f"# {title}\n", target="Vault"))[3]
            found = run(history)
        # The fix leaves the title's count unchanged, so a count-based search (-S) would find only the first commit.
        self.assertEqual([line.split(" ", 1)[1] for line in found.splitlines()], ["Close the issue", "Record the issue"])


if __name__ == "__main__":
    unittest.main()
