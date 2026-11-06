#!/usr/bin/env python3
"""Regression test for the skill packaging allowlist.

The archive used to ship .github/workflows/test.yml because the exclusion list
was a blacklist: anything new at the repository root silently slipped in. Only
SKILL.md, references/ and project/ may ever reach the installed skill.

The temporary tree lives in the system temp dir and is removed automatically.
"""

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PACKAGE_SCRIPT = ROOT / "scripts" / "package_skill.py"


def load_packager():
    spec = importlib.util.spec_from_file_location(
        "package_skill_under_test", PACKAGE_SCRIPT
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ps = load_packager()


class TestPackageAllowlist(unittest.TestCase):
    def make_tree(self, root: Path) -> None:
        files = [
            # The installed skill.
            "SKILL.md",
            "references/tools.md",
            "references/runtime.md",
            "project/package.json",
            "project/src/cli.ts",
            # Repository scaffolding — must NOT ship.
            ".github/workflows/test.yml",
            ".codebuddy/memory.md",
            ".vscode/settings.json",
            "AGENTS.md",
            "README.md",
            "LICENSE",
            ".gitignore",
            "scripts/package_skill.py",
            # Build outputs and machine-local data inside project/.
            "project/dist/cli.js",
            "project/node_modules/dep/index.js",
            "project/.runtime/venv/pyvenv.cfg",
        ]
        for rel in files:
            path = root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("x", encoding="utf-8")

    def collect(self, root: Path) -> set[str]:
        return {p.relative_to(root).as_posix() for p in ps.collect_files(root)}

    def test_only_top_level_skill_entries_are_collected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.make_tree(root)
            got = self.collect(root)
        self.assertEqual(
            got,
            {
                "SKILL.md",
                "references/tools.md",
                "references/runtime.md",
                "project/package.json",
                "project/src/cli.ts",
            },
        )

    def test_repository_scaffolding_is_not_packaged(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.make_tree(root)
            got = self.collect(root)
        # The exact regression: .github/workflows/test.yml used to be in the zip.
        self.assertFalse(any(path.startswith(".github/") for path in got))
        for forbidden in ("AGENTS.md", "README.md", "LICENSE", ".gitignore"):
            self.assertNotIn(forbidden, got)
        self.assertFalse(any("/dist/" in path for path in got))
        self.assertFalse(any("/node_modules/" in path for path in got))


if __name__ == "__main__":
    unittest.main(verbosity=2)
