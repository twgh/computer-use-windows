#!/usr/bin/env python3
"""Regression test for the skill packaging allowlist.

The archive used to ship .github/workflows/test.yml because the exclusion list
was a blacklist: anything new at the repository root silently slipped in. Only
SKILL.md, references/ and project/ may ever reach the installed skill.

The second regression is subtler: an automatic skill upgrade only overwrites
files carried by the zip. dist/, node_modules/ and .runtime/ are machine-local
state, so excluding dist/ wholesale left the old locally built cli.js running
forever under a fixed MCP config path. The shipped entry must be in the zip,
and must be a self-contained bundle with no runtime imports from node_modules.

The third regression: project/src/ (plus tsconfig.json and the lockfile) used to
ship even though the entry is a self-contained bundle. Those files have no
runtime use at all, and an in-place upgrade would leave stale sources lying
around next to a newer executable. project/ now has an exact runtime allowlist.

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
            # The installed skill: runtime files only.
            "SKILL.md",
            "references/tools.md",
            "references/runtime.md",
            "references/mcp-config.json",
            "project/package.json",
            "project/dist/cli.js",  # the shipped, self-contained MCP entry
            "project/runtime/windows_helper.py",
            "project/runtime/requirements.txt",
            # Repository scaffolding — must NOT ship.
            ".github/workflows/test.yml",
            ".codebuddy/memory.md",
            ".vscode/settings.json",
            "AGENTS.md",
            "README.md",
            "LICENSE",
            ".gitignore",
            "scripts/package_skill.py",
            # Development-only files under project/ — must NOT ship.
            "project/src/cli.ts",
            "project/src/server.ts",
            "project/tsconfig.json",
            "project/package-lock.json",
            "project/scripts/bundle.mjs",
            "project/dist/server.js",
            "project/dist/computer-use/pythonBridge.js",
            "project/dist/cli.js.map",
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
                "references/mcp-config.json",
                "project/package.json",
                "project/dist/cli.js",
                "project/runtime/windows_helper.py",
                "project/runtime/requirements.txt",
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
        self.assertFalse(any("/node_modules/" in path for path in got))
        self.assertFalse(any("/.runtime/" in path for path in got))
        self.assertFalse(any("project/dist/" in path and path != "project/dist/cli.js" for path in got))

    def test_bundled_entry_ships_with_every_release(self):
        # The real upgrade bug: excluding dist/ wholesale meant the zip never
        # replaced the locally built cli.js that the MCP config points at.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.make_tree(root)
            got = self.collect(root)
        self.assertIn("project/dist/cli.js", got)

    def test_typescript_sources_and_dev_config_do_not_ship(self):
        # The bundle is self-contained; src/ has no runtime use, and an
        # in-place upgrade would leave stale sources next to a newer binary.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.make_tree(root)
            got = self.collect(root)
        self.assertFalse(any(path.startswith("project/src/") for path in got))
        self.assertNotIn("project/tsconfig.json", got)
        self.assertNotIn("project/package-lock.json", got)
        self.assertNotIn("project/scripts/bundle.mjs", got)

    def test_all_runtime_files_ship(self):
        # A whitelist that drops a Python helper or requirements.txt would
        # produce an archive that only fails after installation.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.make_tree(root)
            got = self.collect(root)
        expected = {f"project/{rel}" for rel in ps.PROJECT_RUNTIME_ENTRIES}
        self.assertEqual(expected & got, expected)

    def test_mcp_config_template_ships(self):
        # SKILL.md tells an agent to read this file to self-register the MCP
        # server. If packaging drops it, a first-time install cannot be
        # onboarded from the installed skill itself.
        got = {p.relative_to(ROOT).as_posix() for p in ps.collect_files(ROOT)}
        self.assertIn("references/mcp-config.json", got)

    def test_packager_rejects_a_missing_bundle_entry(self):
        with tempfile.TemporaryDirectory() as tmp:
            errors = ps.validate_bundle_entry(Path(tmp))
        self.assertTrue(any("missing project/dist/cli.js" in e for e in errors))

    def test_packager_rejects_a_stale_bundle(self):
        # Bumping the version without rebuilding leaves serverInfo.version
        # compiled into the old bundle; initialize would report the old version.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "SKILL.md").write_text(
                "---\nversion: 0.7.0\n---\n", encoding="utf-8"
            )
            entry = root.joinpath(*ps.DIST_ENTRY)
            entry.parent.mkdir(parents=True, exist_ok=True)
            entry.write_text('version: "0.6.0"', encoding="utf-8")
            errors = ps.validate_bundle_entry(root)
        self.assertTrue(any("built for a different version" in e for e in errors))

    def test_packager_rejects_external_runtime_imports(self):
        # An upgraded install has no node_modules; any surviving import would
        # fail at startup instead of reaching the new server code.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            entry = root.joinpath(*ps.DIST_ENTRY)
            entry.parent.mkdir(parents=True, exist_ok=True)
            entry.write_text(
                'import { Server } from "@modelcontextprotocol/sdk/server/index.js";\n'
                'import { homedir } from "node:os";\n',
                encoding="utf-8",
            )
            errors = ps.validate_bundle_entry(root)
        self.assertTrue(any("imports from node_modules" in e for e in errors))

    def test_repository_bundle_entry_is_current_and_self_contained(self):
        # `npm test` builds first. This is the gate that stops a release whose
        # zip would ship a stale or non-self-contained entry.
        self.assertEqual(ps.validate_bundle_entry(ROOT), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
