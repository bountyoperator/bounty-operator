from __future__ import annotations

import html
import json
from pathlib import Path
from typing import Any

from .file_io import read_text_limited


DEFAULT_CHECKS = {
    "arbitrary-send-erc20",
    "arbitrary-send-eth",
    "calls-loop",
    "controlled-delegatecall",
    "delegatecall-loop",
    "incorrect-equality",
    "low-level-calls",
    "reentrancy-benign",
    "reentrancy-eth",
    "reentrancy-no-eth",
    "unchecked-transfer",
    "uninitialized-local",
    "unused-return",
}


def clean_scan(data: Any) -> Any:
    """Read a successful scan with no detector results as an empty list.

    Slither leaves the "detectors" key out of "results" when a run that
    succeeded has nothing to report. That file is a clean scan. Only a file
    that says "success": true gets this reading: a failed run, or a file with
    no success flag, still has to carry results.detectors.
    """
    if not isinstance(data, dict) or data.get("success") is not True:
        return data
    results = data.get("results")
    if not isinstance(results, dict) or "detectors" in results:
        return data
    return {**data, "results": {**results, "detectors": []}}


def load_slither(path: Path) -> dict[str, Any]:
    data = clean_scan(json.loads(read_text_limited(path, 20_000_000)))
    _detectors(data, set())
    return data


def _detectors(data: dict[str, Any], checks: set[str]) -> list[dict[str, Any]]:
    if not isinstance(data, dict) or data.get("success") is False:
        raise ValueError("Slither input is invalid or the scanner failed; no clean result can be inferred")
    results = data.get("results")
    if not isinstance(results, dict) or not isinstance(results.get("detectors"), list):
        raise ValueError("Slither input must contain results.detectors as a list")
    detectors = results["detectors"]
    for detector in detectors:
        if not isinstance(detector, dict) or not isinstance(detector.get("check"), str):
            raise ValueError("Slither input contains an invalid detector")
        if not isinstance(detector.get("description", ""), str):
            raise ValueError("Slither detector description must be text")
        elements = detector.get("elements", [])
        if not isinstance(elements, list) or any(not isinstance(e, dict) for e in elements):
            raise ValueError("Slither detector elements must be objects")
        for element in elements:
            mapping = element.get("source_mapping") or {}
            if not isinstance(mapping, dict) or not isinstance(mapping.get("lines", []), list):
                raise ValueError("Slither source mapping is malformed")
    return [detector for detector in detectors if detector.get("check") in checks]


def _source_line(element: dict[str, Any]) -> str:
    source = element.get("source_mapping") or {}
    filename = source.get("filename_relative") or source.get("filename_absolute") or "?"
    lines = source.get("lines") or []
    if lines:
        line_text = ",".join(str(line) for line in lines[:4])
        return f"{filename}:{line_text}"
    return str(filename)


def _short(text: str, limit: int = 1800) -> str:
    text = " ".join(str(text or "").split())
    if len(text) <= limit:
        return text
    return text[: limit - 3].rstrip() + "..."


def _markdown(value: object) -> str:
    return html.escape(_short(str(value))).replace("`", "&#96;").replace("|", "&#124;")


def format_text(data: dict[str, Any], checks: set[str], limit: int = 8) -> str:
    if limit <= 0:
        raise ValueError("element limit must be greater than zero")
    chunks: list[str] = []
    for detector in _detectors(data, checks):
        chunks.append(
            "\n".join(
                [
                    f"=== {detector.get('check')} | impact={detector.get('impact')} | confidence={detector.get('confidence')} ===",
                    _short(detector.get("description", "")),
                ]
            )
        )
        for element in detector.get("elements", [])[:limit]:
            name = element.get("name") or element.get("type") or "?"
            chunks.append(f"  - {_source_line(element)} {name}")
    if not chunks:
        return "No matching Slither detectors found.\n"
    return "\n".join(chunks) + "\n"


def format_markdown(data: dict[str, Any], checks: set[str], limit: int = 8) -> str:
    if limit <= 0:
        raise ValueError("element limit must be greater than zero")
    chunks = ["# Slither Focus\n"]
    detectors = _detectors(data, checks)
    if not detectors:
        chunks.append("No matching Slither detectors found.\n")
        return "\n".join(chunks)

    for detector in detectors:
        chunks.append(f"## `{_markdown(detector.get('check'))}`")
        chunks.append("")
        chunks.append(f"- Impact: `{_markdown(detector.get('impact'))}`")
        chunks.append(f"- Confidence: `{_markdown(detector.get('confidence'))}`")
        chunks.append("")
        chunks.append(_markdown(detector.get("description", "")))
        chunks.append("")
        chunks.append("| Location | Element |")
        chunks.append("|---|---|")
        for element in detector.get("elements", [])[:limit]:
            name = element.get("name") or element.get("type") or "?"
            chunks.append(f"| `{_markdown(_source_line(element))}` | `{_markdown(name)}` |")
        chunks.append("")
    return "\n".join(chunks)
