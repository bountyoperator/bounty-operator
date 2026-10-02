import io
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

from bounty_operator_kit.ai_review import (
    DEFAULT_MODEL,
    AIReviewConfig,
    build_messages,
    build_payload,
    output_limit_field,
    prepare_text_review,
    request_review,
    run_ai_review,
    send_review,
    validate_base_url,
)
from bounty_operator_kit.cli import main


API_KEY = "provided-key"


def prepared_review():
    return prepare_text_review([("Vault.sol", "contract Vault {}\n")], "Review this", AIReviewConfig())


def completion(content, finish_reason="stop", **message_fields):
    message = {"role": "assistant", "content": content, **message_fields}
    body = {"model": "served-model", "choices": [{"message": message, "finish_reason": finish_reason}]}
    return io.BytesIO(json.dumps(body).encode("utf-8"))


def http_error(status, body):
    return HTTPError("https://api.example.test/v1/chat/completions", status, "Error", {}, io.BytesIO(body))


class PrepareTests(unittest.TestCase):
    def test_build_messages_includes_selected_file(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "ledger.md"
            path.write_text("# Ledger\n", encoding="utf-8")
            messages = build_messages([path], "Review this", 1000)
        self.assertEqual(messages[0]["role"], "system")
        self.assertIn("Review this", messages[1]["content"])
        self.assertIn("# Ledger", messages[1]["content"])
        self.assertIn("input-1/ledger.md", messages[1]["content"])
        self.assertNotIn(str(path.parent), messages[1]["content"])

    def test_build_messages_rejects_large_file(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "large.txt"
            path.write_text("x" * 20, encoding="utf-8")
            with self.assertRaises(ValueError):
                build_messages([path], "", 10)

    def test_build_messages_rejects_large_combined_payload(self) -> None:
        with TemporaryDirectory() as tmp:
            first = Path(tmp) / "first.txt"
            second = Path(tmp) / "second.txt"
            first.write_text("a" * 10, encoding="utf-8")
            second.write_text("b" * 10, encoding="utf-8")
            with self.assertRaises(ValueError):
                build_messages([first, second], "", 20, 15)

    def test_build_messages_rejects_binary_input(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "input.dat"
            path.write_bytes(b"text\x00binary")
            with self.assertRaises(ValueError):
                build_messages([path], "", 100)

    def test_files_are_sent_with_line_numbers_and_counted_in_the_manifest(self) -> None:
        source = "contract Vault {\r\n    uint256 total;\n}\n"
        prepared = prepare_text_review([("Vault.sol", source)], "", AIReviewConfig())
        sent = json.loads(prepared.messages[1]["content"].split("\n", 1)[1])
        self.assertEqual(sent["label"], "input-1/Vault.sol")
        self.assertEqual(sent["content"], "1| contract Vault {\n2|     uint256 total;\n3| }")
        self.assertEqual(prepared.manifest[0]["lines"], 3)

    def test_file_count_is_bounded(self) -> None:
        too_many = [(f"file-{index}.txt", "text") for index in range(51)]
        with self.assertRaisesRegex(ValueError, "between 1 and 50"):
            prepare_text_review(too_many, "", AIReviewConfig())
        with self.assertRaisesRegex(ValueError, "between 1 and 50"):
            prepare_text_review([], "", AIReviewConfig())

    def test_base_url_requires_tls_except_loopback(self) -> None:
        self.assertEqual(validate_base_url("https://api.example.test/v1/"), "https://api.example.test/v1")
        self.assertEqual(validate_base_url("http://127.0.0.1:8000/v1"), "http://127.0.0.1:8000/v1")  # bounty-kit: allow
        with self.assertRaises(ValueError):
            validate_base_url("http://api.example.test/v1")

    def test_ai_review_blocks_sensitive_input_before_api_request(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "private.txt"
            path.write_text("token=" + "sk-proj-" + "x" * 24, encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "blocked by the local sanitizer"):
                run_ai_review(files=[path], prompt="review", config=AIReviewConfig())

    def test_ai_review_blocks_sensitive_prompt_before_api_request(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "clean.txt"
            path.write_text("clean evidence", encoding="utf-8")
            secret_prompt = "review token=" + "sk-proj-" + "x" * 24
            with self.assertRaisesRegex(ValueError, "prompt:1"):
                run_ai_review(files=[path], prompt=secret_prompt, config=AIReviewConfig())

    def test_ai_review_does_not_trust_inline_sanitizer_allow_marker(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "private.txt"
            path.write_text(
                "token=" + "sk-proj-" + "x" * 24 + " # bounty-kit: allow",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "blocked by the local sanitizer"):
                run_ai_review(files=[path], prompt="review", config=AIReviewConfig())


class PayloadTests(unittest.TestCase):
    def test_output_limit_field_follows_the_provider(self) -> None:
        cases = {
            "https://api.openai.com/v1": "max_completion_tokens",
            "https://api.x.ai/v1": "max_completion_tokens",
            "https://api.groq.com/openai/v1": "max_completion_tokens",
            "https://openrouter.ai/api/v1": "max_tokens",
            "https://api.deepseek.com": "max_tokens",
            "https://api.mistral.ai/v1": "max_tokens",
            "http://localhost:11434/v1": "max_tokens",
            "https://generativelanguage.googleapis.com/v1beta/openai": None,
        }
        for base_url, expected in cases.items():
            with self.subTest(base_url=base_url):
                self.assertEqual(output_limit_field(base_url), expected)

    def test_default_request_uses_the_default_model_and_a_16000_token_cap(self) -> None:
        config = AIReviewConfig()
        with patch.dict("os.environ", {}, clear=True):
            payload = build_payload(prepared_review(), config, "https://api.openai.com/v1")
        self.assertEqual(payload["model"], DEFAULT_MODEL)
        self.assertEqual(payload["max_completion_tokens"], 16_000)
        for unsupported in ("max_tokens", "temperature", "top_p"):
            self.assertNotIn(unsupported, payload)

    def test_gemini_request_carries_no_output_cap(self) -> None:
        config = AIReviewConfig(model="gemini-3.8-flash")
        payload = build_payload(prepared_review(), config, "https://generativelanguage.googleapis.com/v1beta/openai")
        self.assertEqual(set(payload), {"model", "messages"})

    def test_request_is_posted_to_chat_completions_with_the_chosen_cap(self) -> None:
        config = AIReviewConfig(base_url="https://openrouter.ai/api/v1", model="vendor/model", max_output_tokens=2_000)
        with patch("bounty_operator_kit.ai_review._open_request", return_value=completion("# Review")) as opened:
            request_review(prepared_review(), config, API_KEY)
        request = opened.call_args.args[0]
        self.assertEqual(request.full_url, "https://openrouter.ai/api/v1/chat/completions")
        self.assertEqual(json.loads(request.data)["max_tokens"], 2_000)
        self.assertEqual(opened.call_args.args[1], config.timeout)


class ResponseTests(unittest.TestCase):
    def request(self, response, config=None):
        with patch("bounty_operator_kit.ai_review._open_request", return_value=response):
            return request_review(prepared_review(), config or AIReviewConfig(), API_KEY)

    def test_complete_review_is_returned_as_written(self) -> None:
        result = self.request(completion("# Review\nVerdict: drop\n"))
        self.assertEqual(result.text, "# Review\nVerdict: drop\n")
        self.assertFalse(result.truncated)
        self.assertFalse(result.filtered)

    def test_review_cut_at_the_output_cap_is_marked_truncated(self) -> None:
        result = self.request(completion("# Review\nF-1", finish_reason="length"))
        self.assertTrue(result.truncated)
        self.assertEqual(result.text, "# Review\nF-1")

    def test_empty_output_at_the_cap_names_the_flag_to_raise(self) -> None:
        with self.assertRaisesRegex(ValueError, "--max-output-tokens"):
            self.request(completion("", finish_reason="length"))

    def test_refusal_is_an_error(self) -> None:
        for response in (completion(None, refusal="I can't help with that."), completion("", finish_reason="content_filter")):
            with self.subTest(), self.assertRaisesRegex(ValueError, "refused"):
                self.request(response)

    def test_send_review_returns_text_only(self) -> None:
        with patch("bounty_operator_kit.ai_review._open_request", return_value=completion("# Review")):
            self.assertEqual(send_review(prepared_review(), AIReviewConfig(), API_KEY), "# Review")

    def test_cli_prints_the_review_and_warns_when_it_is_cut_short(self) -> None:
        stdout, stderr = io.StringIO(), io.StringIO()
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "Vault.sol"
            path.write_text("contract Vault {}\n", encoding="utf-8")
            with (
                patch.dict("os.environ", {"BOUNTY_KIT_AI_API_KEY": API_KEY}),
                patch("bounty_operator_kit.ai_review._open_request", return_value=completion("# Review", "length")),
                patch("sys.stdout", stdout),
                patch("sys.stderr", stderr),
            ):
                self.assertEqual(main(["ai-review", str(path)]), 0)
        self.assertEqual(stdout.getvalue(), "# Review\n")
        self.assertIn("warning: the model reached the output token limit", stderr.getvalue())


class ErrorTests(unittest.TestCase):
    def failure(self, error):
        with patch("bounty_operator_kit.ai_review._open_request", side_effect=error):
            with self.assertRaises(ValueError) as caught:
                request_review(prepared_review(), AIReviewConfig(), API_KEY)
        return str(caught.exception)

    def test_status_codes_get_specific_messages(self) -> None:
        expected = {401: "API key was rejected", 404: "not found", 429: "rate limit", 500: "HTTP 500"}
        for status, phrase in expected.items():
            with self.subTest(status=status):
                self.assertIn(phrase, self.failure(http_error(status, b"")))

    def test_provider_message_is_shown_on_one_bounded_line(self) -> None:
        body = json.dumps({"error": {"message": "Unsupported parameter:\n'max_tokens'. " + "x" * 600}}).encode()
        message = self.failure(http_error(400, body))
        self.assertIn("Unsupported parameter: 'max_tokens'.", message)
        self.assertNotIn("\n", message)
        self.assertLess(len(message), 500)

    def test_provider_message_carrying_a_secret_is_dropped(self) -> None:
        leaked = "sk-proj-" + "a" * 24
        for echoed in (leaked, API_KEY):
            body = json.dumps({"error": {"message": f"Incorrect API key provided: {echoed}"}}).encode()
            with self.subTest(echoed=echoed):
                message = self.failure(http_error(401, body))
                self.assertNotIn(echoed, message)
                self.assertNotIn("The provider said", message)

    def test_timeouts_name_the_limit(self) -> None:
        for error in (TimeoutError("timed out"), URLError(TimeoutError("timed out"))):
            with self.subTest(error=type(error).__name__):
                self.assertIn("timed out after 180 seconds", self.failure(error))

    def test_connection_failure_is_reported(self) -> None:
        self.assertIn("failed before a response arrived", self.failure(URLError("connection refused")))


if __name__ == "__main__":
    unittest.main()
