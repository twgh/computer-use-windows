#!/usr/bin/env python3
"""Set or verify the version across every place it is declared.

The version lives in four files that nothing links together at build time: the
vendor layer deliberately never reads package.json (no node:fs in that layer),
so the MCP `initialize` serverInfo version has to be a literal. That made
drift routine — 0.5.0 shipped with SKILL.md still saying 0.4.2.

Usage:
    python scripts/set_version.py 0.5.3        # write
    python scripts/set_version.py --check      # verify, exit 1 on drift
    python scripts/set_version.py --show       # print what each site says

Exit codes: 0 ok, 1 drift or bad invocation, 2 a site could not be found.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# (label, path, pattern used to find the current version)
SITES: list[tuple[str, Path, re.Pattern[str]]] = [
    ("SKILL.md frontmatter", ROOT / "SKILL.md", re.compile(r"(?m)^version: ([0-9][\w.\-]*)$")),
    ("package.json", ROOT / "project" / "package.json", re.compile(r'"version":\s*"([^"]+)"')),
    ("MCP serverInfo", ROOT / "project" / "src" / "vendor" / "computer-use-mcp" / "mcpServer.ts",
     re.compile(r'\{\s*name:\s*serverName,\s*version:\s*"([^"]+)"\s*\}')),
    ("README title", ROOT / "README.md", re.compile(r"(?m)^# Windows 电脑使用 Skill ([0-9][\w.\-]*)$")),
]

VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(?:-[\w.]+)?$")


def read(path: Path) -> str:
    # utf-8-sig: a BOM would break the ^ anchor on the first line of SKILL.md.
    return path.read_text(encoding="utf-8-sig")


def collect() -> list[tuple[str, Path, str | None]]:
    out: list[tuple[str, Path, str | None]] = []
    for label, path, pattern in SITES:
        if not path.exists():
            out.append((label, path, None))
            continue
        match = pattern.search(read(path))
        out.append((label, path, match.group(1) if match else None))
    return out


def main(argv: list[str]) -> int:
    if not argv or argv[0] in {"-h", "--help"}:
        print(__doc__)
        return 0 if argv else 1

    mode = argv[0]
    if mode == "--show":
        for label, _, found in collect():
            print(f"{label:24s} {found or 'NOT FOUND'}")
        return 0

    if mode == "--check":
        found = collect()
        versions = {label: v for label, _, v in found}
        missing = [label for label, v in versions.items() if v is None]
        if missing:
            print("sites with no version match: " + ", ".join(missing))
            return 2
        distinct = set(versions.values())
        if len(distinct) > 1:
            for label, v in versions.items():
                print(f"{label:24s} {v}")
            print(f"drift: {len(distinct)} different versions in use")
            return 1
        print(f"consistent: {distinct.pop()}")
        return 0

    if mode.startswith("-"):
        print(f"unknown flag: {mode}")
        return 1

    # The bare positional argument IS the new version.
    value = mode
    if not VERSION_RE.match(value):
        print(f"not a version: {value!r} (expected e.g. 0.5.3)")
        return 1

    changed = 0
    for label, path, pattern in SITES:
        text = read(path)
        match = pattern.search(text)
        if match is None:
            print(f"{label:24s} SKIPPED — pattern not found in {path.name}")
            return 2
        if match.group(1) == value:
            print(f"{label:24s} already {value}")
            continue
        # Rebuild the match with only group 1 swapped so surrounding formatting
        # (quotes, JSON commas, the README heading) survives verbatim.
        head, tail = text[: match.start(1)], text[match.end(1):]
        path.write_text(head + value + tail, encoding="utf-8")
        print(f"{label:24s} {match.group(1)} -> {value}")
        changed += 1

    print(f"\n{changed} site(s) updated. Remember: package.json and mcpServer.ts need `npm run build`.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
