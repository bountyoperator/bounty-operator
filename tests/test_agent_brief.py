import unittest

from bounty_operator_kit.agent_brief import build_agent_brief


class AgentBriefTests(unittest.TestCase):
    def test_contains_target_and_focus(self) -> None:
        brief = build_agent_brief(
            target="Demo",
            program="Contest",
            repo="https://github.com/example/demo",
            commit="abc123",
            focus=["core accounting"],
        )
        self.assertIn("Demo", brief)
        self.assertIn("abc123", brief)
        self.assertIn("core accounting", brief)
        self.assertIn("Kill Rules", brief)
        self.assertIn("HOLD — known/duplicate risk", brief)


if __name__ == "__main__":
    unittest.main()
