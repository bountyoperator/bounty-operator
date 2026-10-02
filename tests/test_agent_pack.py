import unittest

from bounty_operator_kit.agent_pack import build_agent_pack


class AgentPackTests(unittest.TestCase):
    def test_pack_contains_rules_and_tools(self) -> None:
        pack = build_agent_pack(target="Demo", program="Contest", tools=["Foundry", "Slither"])
        self.assertIn("Demo", pack)
        self.assertIn("Non-negotiable rules", pack)
        self.assertIn("Foundry", pack)
        self.assertIn("Slither", pack)
        self.assertIn("Duplicate-risk pass", pack)


if __name__ == "__main__":
    unittest.main()
