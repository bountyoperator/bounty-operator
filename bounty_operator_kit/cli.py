from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from . import __version__
from .agent_brief import build_agent_brief
from .agent_pack import build_agent_pack
from .ai_review import (
    DEFAULT_MAX_OUTPUT_TOKENS,
    DEFAULT_MODEL,
    AIReviewConfig,
    ReviewResult,
    prepare_review,
    request_review,
)
from .file_io import read_text_limited, write_text
from .ledger import build_ledger
from .prior_art import build_prior_art_checklist
from .pattern_stats import format_pattern_stats, pattern_stats_json
from .sanitize import scan_report
from .slither_focus import DEFAULT_CHECKS, format_markdown, format_text, load_slither


def _positive_int(value: str) -> int:
    try:
        number = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("expected a positive integer") from exc
    if number <= 0:
        raise argparse.ArgumentTypeError("expected a positive integer")
    return number


def _output_warning(result: ReviewResult) -> str | None:
    if result.truncated:
        return (
            "the model reached the output token limit, so the review is cut short. "
            "Raise --max-output-tokens or send fewer files."
        )
    if result.filtered:
        return "the provider's content filter stopped the output, so the review is cut short."
    return None


def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="bounty-kit",
        description="CLI for Bounty Operator: scoped agent packs, evidence gates and sanitised AI source review.",
    )
    parser.add_argument("--version", action="version", version=__version__)
    subparsers = parser.add_subparsers(dest="command")

    sanitize = subparsers.add_parser("sanitize", help="scan paths for material that should not be public")
    sanitize.add_argument("paths", nargs="+", type=Path)
    output_format = sanitize.add_mutually_exclusive_group()
    output_format.add_argument("--json", action="store_true", help="emit a JSON findings list (legacy format)")
    output_format.add_argument("--json-report", action="store_true", help="emit findings, coverage counts and exclusions")
    sanitize.add_argument("--allow-email", action="store_true", help="do not flag email addresses")
    sanitize.add_argument("--max-bytes", type=_positive_int, default=2_000_000, help="maximum bytes per file; oversized files fail")
    sanitize.add_argument("--max-total-bytes", type=_positive_int, default=20_000_000)
    sanitize.add_argument("--max-paths", type=_positive_int, default=10_000)
    sanitize.add_argument("--strict", action="store_true", help="fail on any exclusion and ignore inline allow comments")
    sanitize.add_argument("--no-allow-comments", action="store_true", help="ignore inline allow comments")

    slither = subparsers.add_parser("slither-focus", help="filter Slither JSON to high-signal checks")
    slither.add_argument("json_file", type=Path)
    slither.add_argument(
        "--check",
        action="append",
        dest="checks",
        help="Slither check to include; can be repeated. Defaults to a curated set.",
    )
    slither.add_argument("--markdown", action="store_true", help="emit Markdown")
    slither.add_argument("--limit", type=_positive_int, default=8, help="max elements per detector")

    ledger = subparsers.add_parser("init-ledger", help="write a bounty hunt ledger template")
    ledger.add_argument("output", type=Path)
    ledger.add_argument("--force", action="store_true", help="replace an existing regular output file")
    ledger.add_argument("--target", required=True)
    ledger.add_argument("--program", required=True)
    ledger.add_argument("--repo", default="")
    ledger.add_argument("--commit", default="")
    ledger.add_argument("--scope-file", default="")
    ledger.add_argument("--program-url", default="")
    ledger.add_argument("--program-verified", default="")
    ledger.add_argument("--deployed-target", default="")
    ledger.add_argument("--deployment-evidence", default="")

    prior = subparsers.add_parser("prior-art", help="print a duplicate-risk checklist for a finding")
    prior.add_argument("finding", type=Path, help="finding summary file")
    prior.add_argument("--target", required=True)
    prior.add_argument("--program", default="")
    prior.add_argument("--repo", default="")

    agent = subparsers.add_parser("agent-brief", help="write a scoped work order for an AI agent")
    agent.add_argument("output", type=Path)
    agent.add_argument("--force", action="store_true", help="replace an existing regular output file")
    agent.add_argument("--target", required=True)
    agent.add_argument("--program", required=True)
    agent.add_argument("--repo", default="")
    agent.add_argument("--commit", default="")
    agent.add_argument("--scope-file", default="")
    agent.add_argument("--focus", action="append", default=[], help="area to prioritize; can be repeated")

    pack = subparsers.add_parser("agent-pack", help="write a full AI bounty-hunt operating pack")
    pack.add_argument("output", type=Path)
    pack.add_argument("--force", action="store_true", help="replace an existing regular output file")
    pack.add_argument("--target", default="Target protocol")
    pack.add_argument("--program", default="Bug bounty program")
    pack.add_argument("--tool", action="append", default=[], help="tool to include in the recommended stack")

    ai = subparsers.add_parser("ai-review", help="send selected files to an OpenAI-compatible API")
    ai.add_argument("files", nargs="+", type=Path, help="files to include in the review")
    ai.add_argument("--prompt", type=Path, help="optional prompt file")
    ai.add_argument("--model", default=None, help=f"model name; defaults to BOUNTY_KIT_AI_MODEL or {DEFAULT_MODEL}")
    ai.add_argument("--base-url", default=None, help="API base URL; defaults to BOUNTY_KIT_AI_BASE_URL")
    ai.add_argument("--api-key-env", default="BOUNTY_KIT_AI_API_KEY", help="environment variable containing the API key")
    ai.add_argument("--max-bytes", type=_positive_int, default=120_000, help="maximum bytes per input file")
    ai.add_argument("--max-total-bytes", type=_positive_int, default=240_000, help="maximum bytes across the prompt and all files")
    ai.add_argument("--max-response-bytes", type=_positive_int, default=1_000_000)
    ai.add_argument(
        "--max-output-tokens",
        type=_positive_int,
        default=DEFAULT_MAX_OUTPUT_TOKENS,
        help="output token cap sent to the provider; reasoning tokens count against it",
    )
    ai.add_argument("--timeout", type=_positive_int, default=180, help="request timeout in seconds")
    ai.add_argument("--dry-run", action="store_true", help="validate inputs and preview upload manifest without a key or network request")
    ai.add_argument(
        "--allow-sensitive",
        action="store_true",
        help="send inputs despite local sanitizer findings; review the findings first",
    )

    patterns = subparsers.add_parser(
        "pattern-stats",
        help="show accepted and rejected counts per vulnerability pattern from public contest judging",
    )
    patterns.add_argument("patterns", nargs="*", help="exact pattern names; defaults to every pattern")
    patterns.add_argument("--json", action="store_true", help="emit JSON instead of text")

    args = parser.parse_args(argv)

    if args.command == "sanitize":
        report = scan_report(
            args.paths,
            allow_email=args.allow_email,
            max_bytes=args.max_bytes,
            max_total_bytes=args.max_total_bytes,
            max_paths=args.max_paths,
            honor_allow_comments=not (args.no_allow_comments or args.strict),
        )
        if args.json:
            print(json.dumps([finding.to_dict() for finding in report.findings], indent=2))
        elif args.json_report:
            print(json.dumps(report.to_dict(), indent=2))
        else:
            print(f"Checked {report.files_scanned} text files ({report.bytes_scanned} bytes).")
            if not report.findings:
                print("No privacy patterns matched.")
            for finding in report.findings:
                print(f"{finding.path}:{finding.line}: {finding.kind}: {finding.detail}")
            for item in report.skipped:
                print(f"Excluded {item['path']}: {item['reason']}")
            if not report.complete:
                print("Coverage is incomplete; review the findings and exclusions.")
        return 1 if report.findings or (args.strict and not report.complete) else 0

    if args.command == "slither-focus":
        data = load_slither(args.json_file)
        checks = set(args.checks or DEFAULT_CHECKS)
        output = format_markdown(data, checks, args.limit) if args.markdown else format_text(data, checks, args.limit)
        sys.stdout.write(output)
        return 0

    if args.command == "init-ledger":
        body = build_ledger(
            target=args.target,
            program=args.program,
            repo=args.repo,
            commit=args.commit,
            scope_file=args.scope_file,
            program_url=args.program_url,
            program_verified=args.program_verified,
            deployed_target=args.deployed_target,
            deployment_evidence=args.deployment_evidence,
        )
        write_text(args.output, body, force=args.force)
        print(f"Wrote {args.output}")
        return 0

    if args.command == "prior-art":
        summary = read_text_limited(args.finding)
        sys.stdout.write(
            build_prior_art_checklist(
                summary=summary,
                target=args.target,
                program=args.program,
                repo=args.repo,
            )
        )
        return 0

    if args.command == "agent-brief":
        body = build_agent_brief(
            target=args.target,
            program=args.program,
            repo=args.repo,
            commit=args.commit,
            scope_file=args.scope_file,
            focus=args.focus,
        )
        write_text(args.output, body, force=args.force)
        print(f"Wrote {args.output}")
        return 0

    if args.command == "agent-pack":
        body = build_agent_pack(
            target=args.target,
            program=args.program,
            tools=args.tool,
        )
        write_text(args.output, body, force=args.force)
        print(f"Wrote {args.output}")
        return 0

    if args.command == "ai-review":
        prompt = read_text_limited(args.prompt, args.max_total_bytes) if args.prompt else ""
        config = AIReviewConfig(
            model=args.model,
            base_url=args.base_url,
            api_key_env=args.api_key_env,
            max_bytes=args.max_bytes,
            max_total_bytes=args.max_total_bytes,
            max_output_tokens=args.max_output_tokens,
            timeout=args.timeout,
            max_response_bytes=args.max_response_bytes,
            allow_sensitive=args.allow_sensitive,
        )
        prepared = prepare_review(args.files, prompt, config)
        if args.dry_run:
            print(json.dumps(prepared.preview(config), indent=2))
            return 0
        api_key = os.environ.get(config.api_key_env)
        if not api_key:
            raise ValueError(f"Missing API key. Set {config.api_key_env} before running ai-review.")
        result = request_review(prepared, config, api_key)
        sys.stdout.write(result.text)
        if not result.text.endswith("\n"):
            print()
        warning = _output_warning(result)
        if warning:
            print(f"warning: {warning}", file=sys.stderr)
        return 0

    if args.command == "pattern-stats":
        output = pattern_stats_json(args.patterns) if args.json else format_pattern_stats(args.patterns)
        print(output)
        return 0

    parser.print_help()
    return 2


def main(argv: list[str] | None = None) -> int:
    try:
        return _main(argv)
    except (ValueError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("Interrupted.", file=sys.stderr)
        return 130
