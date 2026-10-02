import unittest

from bounty_operator_kit.ledger import build_ledger


class LedgerTests(unittest.TestCase):
    def test_records_deployment_and_duplicate_gates(self) -> None:
        ledger = build_ledger(
            target="Demo",
            program="Program",
            program_url="https://example.test/bounty",
            program_verified="2026-09-30 06:00 UTC",
            deployed_target="0x1234",
            deployment_evidence="verified source at commit abc123",
        )
        self.assertIn("2026-09-30 06:00 UTC", ledger)
        self.assertIn("0x1234", ledger)
        self.assertIn("Strongest Likely Rejection", ledger)
        self.assertIn("HOLD — known/duplicate risk", ledger)


if __name__ == "__main__":
    unittest.main()
