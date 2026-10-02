"""Bounded local reads and explicit, non-destructive output writes."""

from __future__ import annotations

import os
import stat
import tempfile
from pathlib import Path


class InputFileError(ValueError):
    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind


def is_link(info: os.stat_result) -> bool:
    """Include Windows junctions and other reparse points, not only symlinks."""
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0)
        & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    )


def read_bytes_limited(path: Path, max_bytes: int) -> bytes:
    if max_bytes <= 0:
        raise ValueError("maximum file size must be greater than zero")
    info = path.lstat()
    if is_link(info):
        raise InputFileError("symlink", f"{path}: linked inputs are not read")
    if not stat.S_ISREG(info.st_mode):
        raise InputFileError("not-file", f"{path}: expected a regular file")
    if info.st_size > max_bytes:
        raise InputFileError("oversized-file", f"{path}: exceeds the {max_bytes}-byte file limit")

    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    with os.fdopen(os.open(path, flags), "rb") as handle:
        opened = os.fstat(handle.fileno())
        if not stat.S_ISREG(opened.st_mode) or is_link(opened):
            raise InputFileError("not-file", f"{path}: expected a regular file")
        if (info.st_dev, info.st_ino) != (opened.st_dev, opened.st_ino):
            raise InputFileError("changed-file", f"{path}: input changed while being opened; retry")
        data = handle.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise InputFileError("oversized-file", f"{path}: exceeds the {max_bytes}-byte file limit")
    return data


def decode_text(data: bytes, path: Path) -> str:
    if b"\x00" in data:
        raise InputFileError("binary-file", f"{path}: binary input cannot be checked as text")
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise InputFileError("invalid-encoding", f"{path}: expected UTF-8 text") from exc


def read_text_limited(path: Path, max_bytes: int = 2_000_000) -> str:
    return decode_text(read_bytes_limited(path, max_bytes), path)


def write_text(path: Path, text: str, *, force: bool = False) -> None:
    """Never overwrite by default; replace a regular file atomically with --force."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if not force:
        owned = None
        try:
            with path.open("x", encoding="utf-8", newline="\n") as handle:
                owned = os.fstat(handle.fileno())
                handle.write(text)
                handle.flush()
                os.fsync(handle.fileno())
        except FileExistsError as exc:
            raise ValueError(f"{path} already exists; choose a new path or use --force") from exc
        except BaseException:
            if owned is not None:
                try:
                    current = path.lstat()
                    if (current.st_dev, current.st_ino) == (owned.st_dev, owned.st_ino):
                        path.unlink()
                except OSError:
                    pass
            raise
        return

    mode = None
    try:
        info = path.lstat()
    except FileNotFoundError:
        pass
    else:
        if is_link(info) or not stat.S_ISREG(info.st_mode):
            raise ValueError(f"{path}: --force only replaces regular files")
        mode = stat.S_IMODE(info.st_mode)

    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        if mode is not None:
            os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
