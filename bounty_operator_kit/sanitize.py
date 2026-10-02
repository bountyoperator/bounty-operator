from __future__ import annotations

import os
import re
import stat
from dataclasses import dataclass, field
from itertools import islice
from pathlib import Path
from typing import Iterable

from .file_io import InputFileError, decode_text, is_link, read_bytes_limited


SKIP_DIRS = {
    ".git",
    ".hg",
    ".svn",
    "__pycache__",
    ".pytest_cache",
    "node_modules",
    "out",
    "cache",
    "artifacts",
    "dist",
    "build",
    ".venv",
    "venv",
}

SENSITIVE_NAMES = {
    ".env", ".netrc", ".npmrc", ".pypirc", "credentials", "credentials.json",
    "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "wallet.dat", "cookies.txt",
    "cookies.json", "login data", "web data",
}
SENSITIVE_DIRS = {".ssh", ".aws", ".azure", ".kube", "browser-profiles"}  # bounty-kit: allow
SENSITIVE_SUFFIXES = {".har", ".sqlite", ".sqlite3", ".db", ".pem", ".key", ".p12", ".pfx"}
TEMPLATE_SUFFIXES = (".example", ".sample", ".template")


@dataclass(frozen=True)
class Finding:
    path: str
    line: int
    kind: str
    detail: str

    def to_dict(self) -> dict[str, object]:
        return {
            "path": self.path,
            "line": self.line,
            "kind": self.kind,
            "detail": self.detail,
        }


@dataclass
class ScanReport:
    findings: list[Finding] = field(default_factory=list)
    skipped: list[dict[str, str]] = field(default_factory=list)
    files_scanned: int = 0
    bytes_scanned: int = 0
    paths_checked: int = 0
    allow_comments_honored: bool = True

    @property
    def complete(self) -> bool:
        incomplete_kinds = {
            "missing-path", "read-error", "symlink", "not-file", "changed-file",
            "oversized-file", "binary-file", "invalid-encoding", "scan-limit", "sensitive-path",
        }
        return not self.skipped and not any(f.kind in incomplete_kinds for f in self.findings)

    def to_dict(self) -> dict[str, object]:
        return {
            "schema_version": 1,
            "findings": [finding.to_dict() for finding in self.findings],
            "files_scanned": self.files_scanned,
            "bytes_scanned": self.bytes_scanned,
            "paths_checked": self.paths_checked,
            "skipped": self.skipped,
            "complete": self.complete,
            "allow_comments_honored": self.allow_comments_honored,
        }


def path_findings(path: Path) -> list[Finding]:
    name = path.name.casefold()
    sensitive = (
        name in SENSITIVE_NAMES
        or (name.startswith(".env.") and not name.endswith(TEMPLATE_SUFFIXES))
        or name.endswith(".trace.zip")
        or path.suffix.casefold() in SENSITIVE_SUFFIXES
        or any(part.casefold() in SENSITIVE_DIRS for part in path.parts)
    )
    if sensitive:
        return [Finding(str(path), 0, "sensitive-path", "credential, browser, or private-data file")]
    return []


def _patterns(allow_email: bool) -> list[tuple[str, re.Pattern[str], str]]:
    patterns: list[tuple[str, re.Pattern[str], str]] = [
        ("private-key", re.compile(r"BEGIN [A-Z ]*PRIVATE KEY"), "private key block"),  # bounty-kit: allow
        ("openai-key", re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b"), "OpenAI-style key"),  # bounty-kit: allow
        ("stripe-key", re.compile(r"\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b"), "Stripe secret or restricted key"),
        ("webhook-secret", re.compile(r"\bwhsec_[A-Za-z0-9]{20,}\b"), "webhook signing secret"),
        ("ai-connection-secret", re.compile(r"\bbok_[A-Za-z0-9_-]{43}\b"), "Bounty Operator AI connection secret"),
        ("github-token", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b"), "GitHub token"),
        ("github-token", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{40,}\b"), "GitHub fine-grained token"),
        ("slack-token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b"), "Slack token"),
        ("aws-access-key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"), "AWS access key"),
        ("url-credentials", re.compile(r"https?://[^/\s:@]+:[^/\s@]+@", re.IGNORECASE), "credentials in URL"),
        ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"), "JWT"),
        (
            "evm-private-key",
            re.compile(r"(?i)(private[_ -]?key|secret[_ -]?key|wallet[_ -]?key).{0,40}\b0x[a-f0-9]{64}\b"),
            "possible EVM private key",  # bounty-kit: allow
        ),
        (
            "private-platform-url",
            re.compile(r"https?://bugs\.immunefi\.com/dashboard/submission/\d+", re.IGNORECASE),
            "private Immunefi submission URL",
        ),
        (
            "private-platform-url",
            re.compile(r"https?://cantina\.xyz/code/[^ \n)]+/findings/[0-9]+", re.IGNORECASE),
            "private Cantina finding URL",
        ),
        (
            "private-platform-url",
            re.compile(r"https?://audits\.sherlock\.xyz/contests/[0-9]+/(?:voting|issues)/[0-9]+", re.IGNORECASE),
            "private Sherlock issue URL",
        ),
        ("browser-profile", re.compile(r"(?i)(user data|browser-profiles|profiles[/\\](Default|Profile))"), "browser profile path"),  # bounty-kit: allow
        ("local-vps", re.compile(r"\b(?:root@)?\d{1,3}(?:\.\d{1,3}){3}\b"), "raw IP address"),
    ]
    if not allow_email:
        patterns.append(
            (
                "email",
                re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
                "email address",
            )
        )
    return patterns


def scan_text(
    text: str,
    *,
    source: str = "<text>",
    allow_email: bool = False,
    honor_allow_comments: bool = True,
) -> list[Finding]:
    findings: list[Finding] = []
    patterns = _patterns(allow_email)
    for line_no, line in enumerate(text.splitlines(), start=1):
        if honor_allow_comments and "bounty-kit: allow" in line:
            continue
        matched_kinds: set[str] = set()
        for kind, pattern, detail in patterns:
            if kind not in matched_kinds and pattern.search(line):
                findings.append(Finding(source, line_no, kind, detail))
                matched_kinds.add(kind)
    return findings


def scan_report(
    paths: Iterable[Path],
    *,
    allow_email: bool = False,
    max_bytes: int = 2_000_000,
    max_total_bytes: int = 20_000_000,
    max_paths: int = 10_000,
    honor_allow_comments: bool = True,
) -> ScanReport:
    if min(max_bytes, max_total_bytes, max_paths) <= 0:
        raise ValueError("scan limits must be greater than zero")
    report = ScanReport(allow_comments_honored=honor_allow_comments)
    stack = [(Path(path), True) for path in reversed(list(paths))]
    seen: set[str] = set()
    bytes_read = 0
    while stack:
        path, explicit = stack.pop()
        key = os.path.normcase(os.path.abspath(path))
        if key in seen:
            continue
        seen.add(key)
        if report.paths_checked >= max_paths:
            report.findings.append(Finding(str(path), 0, "scan-limit", "path limit reached; scan is incomplete"))
            break
        report.paths_checked += 1
        try:
            info = path.lstat()
        except FileNotFoundError:
            report.findings.append(Finding(str(path), 0, "missing-path", "path does not exist"))
            continue
        except OSError as exc:
            report.findings.append(Finding(str(path), 0, "read-error", exc.strerror or "cannot inspect path"))
            continue
        if is_link(info):
            report.findings.append(Finding(str(path), 0, "symlink", "linked paths are not followed"))
            continue
        blocked = path_findings(path)
        if blocked:
            report.findings.extend(blocked)
            continue
        if stat.S_ISDIR(info.st_mode):
            if not explicit and path.name in SKIP_DIRS:
                report.skipped.append({"path": str(path), "reason": "generated or version-control directory"})
                continue
            try:
                with os.scandir(path) as entries:
                    children = list(islice(entries, max_paths + 1))
                if len(children) > max_paths:
                    report.findings.append(Finding(str(path), 0, "scan-limit", "directory exceeds path limit; scan is incomplete"))
                    continue
                stack.extend((Path(child.path), False) for child in sorted(children, key=lambda e: e.name, reverse=True))
            except OSError as exc:
                report.findings.append(Finding(str(path), 0, "read-error", exc.strerror or "cannot read directory"))
            continue
        if not stat.S_ISREG(info.st_mode):
            report.findings.append(Finding(str(path), 0, "not-file", "not a regular file; not read"))
            continue
        if info.st_size <= max_bytes and bytes_read + info.st_size > max_total_bytes:
            report.findings.append(Finding(str(path), 0, "scan-limit", "total byte limit reached; scan is incomplete"))
            break
        if bytes_read >= max_total_bytes:
            report.findings.append(Finding(str(path), 0, "scan-limit", "total byte limit reached; scan is incomplete"))
            break
        try:
            data = read_bytes_limited(path, min(max_bytes, max_total_bytes - bytes_read))
            bytes_read += len(data)
            text = decode_text(data, path)
        except InputFileError as exc:
            report.findings.append(Finding(str(path), 0, exc.kind, str(exc).removeprefix(f"{path}: ")))
            continue
        except OSError as exc:
            report.findings.append(Finding(str(path), 0, "read-error", exc.strerror or "cannot read file"))
            continue
        report.files_scanned += 1
        report.bytes_scanned += len(data)
        report.findings.extend(scan_text(text, source=str(path), allow_email=allow_email, honor_allow_comments=honor_allow_comments))
    return report


def scan_paths(
    paths: Iterable[Path],
    *,
    allow_email: bool = False,
    max_bytes: int = 2_000_000,
    honor_allow_comments: bool = True,
) -> list[Finding]:
    """Compatibility wrapper. Use scan_report when coverage matters."""
    return scan_report(paths, allow_email=allow_email, max_bytes=max_bytes, honor_allow_comments=honor_allow_comments).findings
