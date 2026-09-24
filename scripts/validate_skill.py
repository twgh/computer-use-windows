#!/usr/bin/env python3
"""Validate this skill directory.

Why this exists next to the generic skill-creator validator: that one reads
SKILL.md with the platform default encoding, which is GBK on a Chinese Windows
install, so it dies with UnicodeDecodeError on any non-ASCII description. Every
file here is read as UTF-8 explicitly, and the checks are the ones this skill
actually depends on.

Checks (all failures are reported, not just the first):
  * SKILL.md exists and is valid UTF-8.
  * YAML frontmatter is present and closed with `---`.
  * `name`: present, hyphen-case, equal to the directory name.
  * `description`: present, non-empty, no angle brackets.
  * Every `references/…`, `scripts/…` or `assets/…` path mentioned in SKILL.md
    resolves to a real file.

Usage:
    python validate_skill.py <skill-directory>

Exit codes: 0 valid, 1 invalid, 2 bad invocation.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

NAME_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
BUNDLED_PATH_PATTERN = re.compile(
    r"\b(?:references|scripts|assets)/[A-Za-z0-9_.-]+\.[A-Za-z0-9]+"
)
REQUIRED_FIELDS = ("name", "description")


def read_frontmatter(skill_md: Path) -> tuple[dict[str, str], list[str]]:
    """Return (top-level scalar fields, errors).

    Deliberately not a YAML parser: only flat `key: value` lines are read, which
    covers every field this skill uses and keeps the script dependency-free.
    Nested blocks and list items are skipped by indentation.
    """
    lines = skill_md.read_text(encoding="utf-8").splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, ["SKILL.md must start with a YAML frontmatter block ('---' on line 1)"]

    end = None
    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            end = index
            break
    if end is None:
        return {}, ["SKILL.md frontmatter is not closed with '---'"]

    fields: dict[str, str] = {}
    for line in lines[1:end]:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line[:1].isspace():
            continue
        key, separator, value = line.partition(":")
        if not separator:
            continue
        fields[key.strip()] = value.strip().strip('"').strip("'")
    return fields, []


def validate_skill(skill_dir: Path) -> list[str]:
    errors: list[str] = []

    skill_md = skill_dir / "SKILL.md"
    if not skill_md.is_file():
        return [f"missing required file: {skill_md}"]

    try:
        fields, frontmatter_errors = read_frontmatter(skill_md)
    except UnicodeDecodeError as exc:
        return [f"SKILL.md is not valid UTF-8 (ASCII-only skills only?): {exc}"]
    errors.extend(frontmatter_errors)

    for field in REQUIRED_FIELDS:
        if not fields.get(field):
            errors.append(f"frontmatter is missing a non-empty `{field}`")

    name = fields.get("name", "")
    if name and not NAME_PATTERN.match(name):
        errors.append(
            f"`name`: {name!r} is not hyphen-case "
            "(lowercase letters, digits and single hyphens only)"
        )
    elif name and name != skill_dir.name:
        errors.append(
            f"`name`: {name!r} does not match the directory name {skill_dir.name!r}"
        )

    description = fields.get("description", "")
    if "<" in description or ">" in description:
        errors.append("`description` must not contain angle brackets")

    # Everything SKILL.md tells an agent to open must actually ship.
    text = skill_md.read_text(encoding="utf-8")
    missing = sorted(
        {
            reference
            for reference in BUNDLED_PATH_PATTERN.findall(text)
            if not (skill_dir / reference).exists()
        }
    )
    for reference in missing:
        errors.append(f"SKILL.md references {reference!r} but no such file exists")

    return errors


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    skill_dir = Path(sys.argv[1]).resolve()
    if not skill_dir.is_dir():
        print(f"error: not a directory: {skill_dir}", file=sys.stderr)
        return 2

    errors = validate_skill(skill_dir)
    if errors:
        print(f"INVALID: {skill_dir}")
        for error in errors:
            print(f"  - {error}")
        return 1

    print(f"Skill is valid: {skill_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
