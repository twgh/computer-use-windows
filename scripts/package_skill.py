#!/usr/bin/env python3
"""Package the computer-use-windows skill into a distributable zip.

Only skill-related files are included. Build outputs, dependency trees,
machine-local runtime data and scratch files are excluded. Zip entries live
at the archive root (no wrapping directory).

Usage:
    python package_skill.py                # -> ./computer-use-windows.zip
    python package_skill.py -o out.zip     # custom output path
"""

from __future__ import annotations

import argparse
import sys
import zipfile
from pathlib import Path

SKILL_NAME = "computer-use-windows"

# Directories excluded anywhere in the tree.
EXCLUDED_DIRS = {
    "__pycache__",
    ".git",
    ".workbuddy",     # local workspace memory, machine-local
    ".runtime",       # self-bootstrapped venv + local test clients
    "node_modules",   # npm dependency tree, restored via npm install
    "dist",           # TypeScript build output, rebuilt via npm run build
    "scripts",        # packaging/dev scripts, not needed by the installed skill
}

# File patterns excluded anywhere in the tree.
EXCLUDED_FILE_PATTERNS = {
    "*.pyc",
    "*.pyo",
    ".DS_Store",
    "Thumbs.db",
}

# Exact file names excluded anywhere in the tree.
EXCLUDED_FILE_NAMES = {
    "README.md",
    "AGENTS.md",     # dev-time agent rules, not part of the installed skill
    ".gitattributes",
    ".gitignore",
    "LICENSE",
}


def is_excluded_dir(name: str) -> bool:
    return name in EXCLUDED_DIRS


def is_excluded_file(name: str) -> bool:
    return name in EXCLUDED_FILE_NAMES or any(
        Path(name).match(pat) for pat in EXCLUDED_FILE_PATTERNS
    )


def collect_files(skill_root: Path) -> list[Path]:
    files: list[Path] = []
    for path in sorted(skill_root.rglob("*")):
        if path.is_dir():
            continue
        rel = path.relative_to(skill_root)
        if any(is_excluded_dir(part) for part in rel.parts[:-1]):
            continue
        if is_excluded_file(path.name):
            continue
        files.append(path)
    return files


def main() -> int:
    script_dir = Path(__file__).resolve().parent
    skill_root = script_dir.parent

    parser = argparse.ArgumentParser(description="Package the computer-use-windows skill.")
    parser.add_argument(
        "-o",
        "--output",
        default=f"{SKILL_NAME}.zip",
        help="output zip path (default: ./%(default)s)",
    )
    args = parser.parse_args()

    output = Path(args.output).resolve()
    if not skill_root.is_dir():
        print(f"error: skill root not found: {skill_root}", file=sys.stderr)
        return 1

    files = collect_files(skill_root)
    if not files:
        print("error: no files to package", file=sys.stderr)
        return 1

    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for path in files:
            zf.write(path, path.relative_to(skill_root).as_posix())

    total = output.stat().st_size
    print(f"packaged {len(files)} files -> {output}")
    print(f"archive size: {total / 1024:.1f} KiB")

    # Show the top-level layout for a quick sanity check.
    tops: dict[str, int] = {}
    for path in files:
        key = "/".join(path.relative_to(skill_root).parts[:2])
        tops[key] = tops.get(key, 0) + 1
    for key, count in sorted(tops.items()):
        print(f"  {key}: {count} file(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
