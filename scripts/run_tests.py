#!/usr/bin/env python3
"""One entry point for every check this skill has.

    python scripts/run_tests.py            # everything
    python scripts/run_tests.py --quick    # skip the stdio integration test
    python scripts/run_tests.py --list     # show the stages

Stages run in order and the process exits non-zero if any of them fails, so
this is usable as a pre-release gate. Nothing here moves the cursor, injects
input into a user window, or writes inside the skill tree — the stdio stage
does take the desktop session lock briefly, and skips rather than fails if
another agent session holds it.

Layout:
    scripts/tests/test_windows_helper.py   pure logic in the Python helper
    scripts/tests/units.test.mjs           pure logic in the vendored TS layer
    scripts/tests/stdio.test.mjs           real MCP handshake over stdio
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENV_PY = ROOT / "project" / ".runtime" / "venv" / "Scripts" / "python.exe"
NODE_TESTS = [
    ROOT / "scripts" / "tests" / "units.test.mjs",
    ROOT / "scripts" / "tests" / "stdio.test.mjs",
]


def npm(*args: str) -> list[str]:
    # npm on Windows is npm.cmd; CreateProcess needs the extension.
    return ["npm.cmd" if os.name == "nt" else "npm", *args]


def python_for_helper() -> tuple[Path | str, str | None]:
    """The helper imports pywin32 / mss / pyautogui, so it needs the runtime
    venv. A fresh clone has none until the server self-bootstraps once."""
    if VENV_PY.exists():
        return VENV_PY, None
    return sys.executable, (
        f"{VENV_PY} not found — call any computer-use tool once to bootstrap it, "
        "or `cd project && npm install`. Falling back to the invoking interpreter."
    )


def stages(quick: bool) -> list[tuple[str, list[str], str]]:
    helper_python, helper_warn = python_for_helper()
    out: list[tuple[str, list[str], str]] = [
        ("build            (tsc -> dist)", npm("run", "build"), "project"),
        ("typecheck        (tsc --noEmit)", npm("run", "check"), "project"),
        ("skill structure", [sys.executable, "scripts/validate_skill.py", "."], "."),
        ("version sites consistent", [sys.executable, "scripts/set_version.py", "--check"], "."),
        (
            "helper unit tests (Python)",
            [str(helper_python), "scripts/tests/test_windows_helper.py"],
            ".",
        ),
        (
            "package allowlist   (Python)",
            [str(helper_python), "scripts/tests/test_package_skill.py"],
            ".",
        ),
        (
            "TS layer unit tests",
            ["node", "--test", str(NODE_TESTS[0])],
            ".",
        ),
    ]
    if not quick:
        out.append(
            (
                "MCP stdio integration",
                ["node", "--test", str(NODE_TESTS[1])],
                ".",
            )
        )
    if helper_warn:
        print(f"note: {helper_warn}")
    return out


def main(argv: list[str]) -> int:
    quick = "--quick" in argv
    if "--list" in argv:
        for name, cmd, _cwd in stages(quick):
            print(f"{name}  ::  {' '.join(cmd)}")
        return 0

    results: list[tuple[str, float, bool]] = []
    for name, cmd, cwd in stages(quick):
        workdir = ROOT / ("project" if cwd == "project" else ".")
        started = time.monotonic()
        proc = subprocess.run(
            cmd,
            cwd=str(workdir),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        elapsed = time.monotonic() - started
        ok = proc.returncode == 0
        results.append((name, elapsed, ok))
        print(f"{'PASS' if ok else 'FAIL'}  {name}  ({elapsed:.1f}s)")
        if not ok:
            # Surface enough to act on without burying the summary.
            tail = "\n".join((proc.stdout + "\n" + proc.stderr).strip().splitlines()[-25:])
            print(tail)
            break

    print()
    failed = [name for name, _, ok in results if not ok]
    for name, elapsed, ok in results:
        print(f"  {'ok ' if ok else 'BAD'}  {name}  {elapsed:.1f}s")
    total = sum(e for _, e, _ in results)
    if failed:
        print(f"\nFAILED: {failed[0]}  ({len(results) - 1} stage(s) not run)")
        return 1
    print(f"\nAll {len(results)} stages passed in {total:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
