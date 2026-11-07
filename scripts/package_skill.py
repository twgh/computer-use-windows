#!/usr/bin/env python3
"""Package the computer-use-windows skill into a distributable zip.

Only SKILL.md, references/ and project/ are packaged (top-level allowlist);
everything else at the repository root is development scaffolding (CI config,
agent rules, docs, editor metadata) and must never ship. Under project/, an
exact allowlist keeps only the files the runtime needs: package.json, the
bundled MCP entry and the two Python runtime files. TypeScript sources,
tsconfig.json, package-lock.json, build scripts, dev-only tsc output and
machine-local state are unused once the bundle exists, so they stay out.

The one build output that IS shipped is project/dist/cli.js: an automatic skill
upgrade only overwrites files carried by the zip, so a locally built dist/
would otherwise keep serving stale code forever (MCP config points at that
fixed path). It is a self-contained esbuild bundle with no node_modules
dependency. Zip entries live at the archive root (no wrapping directory).

Usage:
    python package_skill.py                # -> ./computer-use-windows.zip
    python package_skill.py -o out.zip     # custom output path
"""

from __future__ import annotations

import argparse
import re
import sys
import zipfile
from pathlib import Path

SKILL_NAME = "computer-use-windows"

# Top-level allowlist: the installed skill consists of exactly these entries.
# A blacklist silently ships anything new that appears at the repository root
# (.github, .codebuddy, .vscode, ...) — that is how .github/workflows/test.yml
# ended up in earlier archives.
TOP_LEVEL_ENTRIES = {"SKILL.md", "references", "project"}

# Generic exclusions anywhere in the tree (defence in depth; project/ is
# additionally governed by PROJECT_RUNTIME_ENTRIES).
EXCLUDED_DIRS = {
    "__pycache__",
    ".git",
    ".workbuddy",     # local workspace memory, machine-local
    ".runtime",       # self-bootstrapped venv + local test clients
    "node_modules",   # npm dependency tree; the shipped bundle needs none
    "scripts",        # packaging/dev scripts, not needed by the installed skill
}

# The only build output allowed in the archive. An upgrade replaces this entry
# in place, so the new code actually reaches the running server.
DIST_ENTRY = ("project", "dist", "cli.js")

# Exact runtime contents of project/. src/ is TypeScript source with no runtime
# use once the bundle is built, and an upgrade that only overwrites zip members
# would otherwise leave stale sources behind. A whitelist (like the top-level
# one) keeps any new dev file out of the archive by default.
PROJECT_RUNTIME_ENTRIES = {
    "package.json",               # "type": "module" + project-root anchor
    "/".join(DIST_ENTRY[1:]),     # self-contained MCP entry, replaced on upgrade
    "runtime/windows_helper.py",  # Python desktop backend
    "runtime/requirements.txt",   # hash key for venv bootstrapping
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
    "ARCHITECTURE.md",  # maintainer-only source map; points at files the zip lacks
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
        if rel.parts[0] not in TOP_LEVEL_ENTRIES:
            continue
        if any(is_excluded_dir(part) for part in rel.parts[:-1]):
            continue
        if is_excluded_file(path.name):
            continue
        # project/ is a runtime-only copy. src/, tsconfig.json, the lockfile,
        # build scripts and dev-only tsc output are never loaded by the bundle.
        if rel.parts[0] == "project":
            if "/".join(rel.parts[1:]) not in PROJECT_RUNTIME_ENTRIES:
                continue
        files.append(path)
    return files


STATIC_IMPORT_RE = re.compile(r"""(?m)^import\s+(?:[^"'\n]*?\sfrom\s*)?["']([^"']+)["']""")
VERSION_RE = re.compile(r"(?m)^version: (\S+)$")


def skill_version(skill_root: Path) -> str | None:
    """The SKILL.md frontmatter version, i.e. what `initialize` must report."""
    try:
        text = (skill_root / "SKILL.md").read_text(encoding="utf-8-sig")
    except (OSError, UnicodeDecodeError):
        return None
    match = VERSION_RE.search(text)
    return match.group(1) if match else None


def validate_bundle_entry(skill_root: Path) -> list[str]:
    """Refuse to ship a missing, stale or non-self-contained entry.

    Three real failures this blocks:
      * packaging before `npm run build` — dist/cli.js is absent or the old
        thin `tsc` shim, so upgrades would keep running old code;
      * bumping the version without rebuilding — serverInfo.version is a
        literal compiled into the bundle and would still report the old one;
      * an esbuild config that leaves runtime imports external — the upgraded
        skill has no node_modules to resolve them from.
    """
    entry = skill_root.joinpath(*DIST_ENTRY)
    label = "/".join(DIST_ENTRY)
    if not entry.is_file():
        return [f"missing {label}: run `cd project && npm run build` before packaging"]
    try:
        source = entry.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return [f"cannot read {label}: {exc}"]

    errors: list[str] = []
    version = skill_version(skill_root)
    if version and f'version: "{version}"' not in source:
        errors.append(
            f"{label} was built for a different version than SKILL.md ({version}): "
            "run `cd project && npm run build`"
        )
    external = sorted(
        {
            target
            for target in STATIC_IMPORT_RE.findall(source)
            if not target.startswith("node:")
        }
    )
    if external:
        errors.append(
            f"{label} still imports from node_modules: {', '.join(external)}; "
            "the bundle must be self-contained"
        )
    return errors


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

    bundle_errors = validate_bundle_entry(skill_root)
    if bundle_errors:
        for message in bundle_errors:
            print(f"error: {message}", file=sys.stderr)
        return 1

    files = collect_files(skill_root)
    if not files:
        print("error: no files to package", file=sys.stderr)
        return 1

    shipped = {p.relative_to(skill_root).as_posix() for p in files}
    missing = sorted(
        f"project/{rel}"
        for rel in PROJECT_RUNTIME_ENTRIES
        if f"project/{rel}" not in shipped
    )
    if missing:
        print(f"error: runtime files missing from archive: {', '.join(missing)}", file=sys.stderr)
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
