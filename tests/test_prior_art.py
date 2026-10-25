import shlex
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
            "Reentrancy in withdraw() drains the vault",
            "Unchecked index in balances[ overflows",
            "- missing check",
            "Owner's $fee can reach 100%",
        )
        for title in titles:
            with self.subTest(title=title):
                checklist = build_prior_art_checklist(summary=f"# {title}\n", target="Vault (v2)")
                rg_title, rg_target, grep, pickaxe = local_commands(checklist)
                self.assertEqual(rg_title, ["rg", "-n", "-i", "-F", "-e", title, "."])
                self.assertEqual(rg_target, ["rg", "-n", "-i", "-F", "-e", "Vault (v2)", "."])
                self.assertEqual(grep, ["git", "log", "--oneline", "--all", "-i", "-F", f"--grep={title}"])
                self.assertEqual(pickaxe, ["git", "log", "--oneline", "--all", "-i", f"-S{title}", "--", "."])


if __name__ == "__main__":
    unittest.main()
