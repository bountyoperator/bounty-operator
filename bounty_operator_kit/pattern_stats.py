from __future__ import annotations

import json
from importlib.resources import files
from typing import Any


DATA_FILE = "vulnerability_acceptance_rates.json"
SCOPE_NOTE = (
    "Counts are per keyword tag, and one finding can carry several tags. "
    "Duplicate risk is a separate check: run `bounty-kit prior-art`."
)


def load_pattern_stats() -> dict[str, Any]:
    resource = files("bounty_operator_kit").joinpath("data", DATA_FILE)
    with resource.open("r", encoding="utf-8") as handle:
        data = json.load(handle)

    patterns = data.get("patterns")
    if not isinstance(patterns, dict) or not patterns:
        raise ValueError("bundled pattern statistics are missing or invalid")
    for name, row in patterns.items():
        if not isinstance(name, str) or not isinstance(row, dict):
            raise ValueError("bundled pattern statistics contain an invalid row")
        required = {"acceptance_rate", "accepted", "rejected", "duplicated", "total"}
        if not required.issubset(row):
            raise ValueError(f"bundled statistics for {name!r} are incomplete")
    return data


def _select_patterns(data: dict[str, Any], requested: list[str]) -> list[tuple[str, dict[str, Any]]]:
    patterns: dict[str, dict[str, Any]] = data["patterns"]
    if requested:
        unknown = sorted(set(requested) - set(patterns))
        if unknown:
            choices = ", ".join(sorted(patterns))
            raise ValueError(f"unknown pattern(s): {', '.join(unknown)}. Available: {choices}")
        return [(name, patterns[name]) for name in requested]
    return sorted(patterns.items(), key=lambda item: (-int(item[1]["total"]), item[0]))


def format_pattern_stats(requested: list[str] | None = None) -> str:
    data = load_pattern_stats()
    selected = _select_patterns(data, requested or [])
    lines = [
        "Accepted and rejected findings by vulnerability pattern",
        "",
        (
            f"Source snapshot: {data['total_findings']} reconciled findings across "
            f"{data['contests_included']} Sherlock contests; updated {str(data['last_updated'])[:10]}."
        ),
        SCOPE_NOTE,
        "",
        "Pattern                    Accepted  Rejected  Duplicate-tagged  Total  Rate",
        "-------------------------  --------  --------  ----------------  -----  ----",
    ]
    for name, row in selected:
        rate = round(float(row["acceptance_rate"]) * 100)
        lines.append(
            f"{name:<25}  {int(row['accepted']):>8}  {int(row['rejected']):>8}  "
            f"{int(row['duplicated']):>16}  {int(row['total']):>5}  {rate:>3}%"
        )
    lines.extend(
        [
            "",
            f"Methodology: {data['methodology_url']}",
            "Tags come from keyword matching at about 65% precision.",
        ]
    )
    return "\n".join(lines)


def pattern_stats_json(requested: list[str] | None = None) -> str:
    data = load_pattern_stats()
    selected = dict(_select_patterns(data, requested or []))
    output = {
        "source": data["source"],
        "last_updated": data["last_updated"],
        "contests_included": data["contests_included"],
        "total_findings": data["total_findings"],
        "total_accepted": data["total_accepted"],
        "methodology_url": data["methodology_url"],
        "note": SCOPE_NOTE,
        "patterns": selected,
    }
    return json.dumps(output, indent=2, sort_keys=True)
